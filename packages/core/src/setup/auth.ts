// Signing in to the agent CLIs from inside Puff. Puff only starts the CLI's own sign-in command, which
// opens the browser on the provider's page; the person approves there. Puff never sees a password or a
// token. Some flows end with a one-time code shown in the browser that the CLI asks for: `submitCode`
// hands it to the waiting process (and nothing keeps it).
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { AgentName, PuffEvent, SignInState } from '@puff/shared';
import { launchTarget, resolveExecutable, runProcess } from '../agents/spawn';

/** The agents Puff can start a sign-in for, and what each one is called */
export const SIGN_IN_AGENTS: Partial<Record<AgentName, { label: string; args: string[] }>> = {
  'claude-code': { label: 'Claude Code', args: ['auth', 'login'] },
  codex: { label: 'Codex', args: ['login'] },
};

const STATUS_ARGS: Partial<Record<AgentName, string[]>> = {
  'claude-code': ['auth', 'status'],
  codex: ['login', 'status'],
};

/** Only a login page on one of these hosts is ever shown as a link */
const LOGIN_HOSTS = ['claude.com', 'claude.ai', 'anthropic.com', 'openai.com', 'chatgpt.com'];

export function isLoginUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      LOGIN_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`))
    );
  } catch {
    return false;
  }
}

/** Is the agent signed in? Asked of the CLI itself. Agents with no cheap check are "unknown". */
export async function signInState(agent: AgentName, command: string): Promise<SignInState> {
  const args = STATUS_ARGS[agent];
  if (!args) return 'unknown';
  const res = await runProcess({ command, args, cwd: tmpdir(), timeoutMs: 20_000 });
  if (res.spawnError || res.timedOut) return 'unknown';
  const text = `${res.stdout}\n${res.stderr}`;
  if (agent === 'claude-code') {
    try {
      const status = JSON.parse(res.stdout.trim()) as { loggedIn?: unknown };
      return status.loggedIn === true ? 'signed-in' : 'signed-out';
    } catch {
      return 'unknown';
    }
  }
  if (/not logged in/i.test(text)) return 'signed-out';
  return res.exitCode === 0 ? 'signed-in' : 'unknown';
}

export interface SignInResult {
  ok: boolean;
  message: string;
}

export interface SignInStart {
  agent: AgentName;
  /** The page to open if the browser did not open by itself (only a known login host) */
  url?: string;
  /** Resolves when the sign-in ends, either way */
  done: Promise<SignInResult>;
}

const URL_PATTERN = /https:\/\/[^\s"'<>]+/;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * One sign-in at a time. Starting another cancels the first. Events: `signin` when one ends, so the
 * screens that offered the button can refresh.
 */
export class SignInManager {
  private child?: ChildProcess;
  private active?: AgentName;
  private readonly cancelled = new WeakSet<ChildProcess>();

  constructor(
    private readonly commandFor: (agent: AgentName) => string | undefined,
    private readonly emit?: (e: PuffEvent) => void,
    private readonly timeoutMs = 10 * 60_000,
    /** How long to wait for the login link to be printed before handing control back */
    private readonly urlWaitMs = 15_000,
  ) {}

  /** The agent being signed in right now, if any */
  get signingIn(): AgentName | undefined {
    return this.active;
  }

  async start(agent: AgentName): Promise<SignInStart> {
    const spec = SIGN_IN_AGENTS[agent];
    const command = this.commandFor(agent);
    if (!spec || !command)
      throw new Error(
        `Puff cannot sign in to ${agent} for you. Sign in with its own command in a terminal.`,
      );
    this.cancel();

    const exe = resolveExecutable(command);
    if (!exe) throw new Error(`"${command}" was not found on PATH. Is ${spec.label} installed?`);
    const target = launchTarget(exe);
    const child = spawn(target.command, [...target.prefix, ...spec.args], {
      cwd: tmpdir(),
      env: { ...target.env, NO_COLOR: '1' } as NodeJS.ProcessEnv,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.active = agent;

    let url: string | undefined;
    let tail = '';
    let sawUrl!: () => void;
    const urlSeen = new Promise<void>((r) => (sawUrl = r));
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8').replace(ANSI, '');
      tail = `${tail}${text}`.slice(-800);
      if (!url) {
        const found = URL_PATTERN.exec(text)?.[0];
        if (found && isLoginUrl(found)) {
          url = found;
          sawUrl();
        }
      }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.stdin!.on('error', () => {});

    const done = new Promise<SignInResult>((resolve) => {
      let finished = false;
      const finish = async (exitCode: number | null, why?: string) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (this.cancelled.has(child)) return resolve({ ok: false, message: 'Cancelled.' });
        if (this.child === child) {
          this.child = undefined;
          this.active = undefined;
        }
        sawUrl();
        const state = await signInState(agent, command);
        const ok = state === 'signed-in' || (state === 'unknown' && exitCode === 0);
        const message = ok
          ? `Signed in to ${spec.label}.`
          : `Sign-in to ${spec.label} did not finish${why ? ` (${why})` : ''}. Try again, or sign in with \`${command}\` in a terminal.`;
        const result = { ok, message };
        this.emit?.({ type: 'signin', agent, ok, message });
        resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill();
        void finish(null, 'no answer within 10 minutes');
      }, this.timeoutMs);
      child.on('error', (e) => void finish(null, e.message));
      child.on(
        'close',
        (code) =>
          void finish(code, code === 0 ? undefined : tail.trim().split('\n').pop()?.slice(0, 160)),
      );
    });

    // The link is printed within a moment of starting; do not wait forever for it
    await Promise.race([urlSeen, new Promise((r) => setTimeout(r, this.urlWaitMs))]);
    return { agent, url, done };
  }

  /** The one-time code the browser showed, for the waiting sign-in. False when none is waiting. */
  submitCode(code: string): boolean {
    const child = this.child;
    const clean = code.trim();
    if (!child || !clean) return false;
    child.stdin!.write(`${clean}\n`);
    return true;
  }

  cancel(): void {
    const child = this.child;
    this.child = undefined;
    this.active = undefined;
    if (child) {
      this.cancelled.add(child);
      child.kill();
    }
  }
}
