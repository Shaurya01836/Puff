// The three harness adapters. Each builds a headless command line from the project's config plus
// role-specific permissions, sends the prompt on stdin, and normalises what comes back.
import type { AgentName, Role } from '@puff/shared';
import type { HarnessConfig, PuffConfig } from '../config';
import { parsePuffReport } from '../memory/report';
import { parseClaude, parseCodex, parseOpenCode, type Parsed } from './parse';
import { resolveExecutable, runProcess } from './spawn';
import { WRITES_FILES, type HarnessAdapter, type HarnessResult, type RunOptions } from './types';

/** Claude Code: what each role may do. Bash is limited to running tests and reading git state. */
const CLAUDE_READ = [
  'Read',
  'Glob',
  'Grep',
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(git log:*)',
];
const CLAUDE_WRITE = [
  ...CLAUDE_READ,
  'Edit',
  'Write',
  'MultiEdit',
  'Bash(npm test:*)',
  'Bash(npm run test:*)',
  'Bash(npx vitest:*)',
  'Bash(npx jest:*)',
];

interface Spec {
  /** Arguments after the configured base args */
  args(opts: RunOptions, cfg: HarnessConfig): string[];
  parse(stdout: string): Parsed;
  /** Environment for the process */
  env?(opts: RunOptions): Record<string, string | undefined>;
}

const SPECS: Record<AgentName, Spec> = {
  'claude-code': {
    args: ({ role, model }) => [
      '--permission-mode',
      WRITES_FILES[role] ? 'acceptEdits' : 'default',
      '--allowedTools',
      (WRITES_FILES[role] ? CLAUDE_WRITE : CLAUDE_READ).join(','),
      ...(model ? ['--model', model] : []),
    ],
    parse: parseClaude,
  },
  codex: {
    // The prompt is read from stdin ("-"), which must come last.
    args: ({ role, model, cwd }) => [
      '-s',
      WRITES_FILES[role] ? 'workspace-write' : 'read-only',
      '-C',
      cwd,
      ...(model ? ['-m', model] : []),
      '-',
    ],
    parse: parseCodex,
  },
  opencode: {
    args: ({ role, model, cwd }) => [
      '--dir',
      cwd,
      // OpenCode's built-in "plan" agent cannot edit; "build" can.
      '--agent',
      WRITES_FILES[role] ? 'build' : 'plan',
      ...(model ? ['-m', model] : []),
    ],
    parse: parseOpenCode,
  },
};

export function createAdapter(name: AgentName, cfg: HarnessConfig): HarnessAdapter {
  const spec = SPECS[name];
  return {
    name,

    async available() {
      const exe = resolveExecutable(cfg.command);
      if (!exe) return { ok: false, detail: `"${cfg.command}" is not installed or not on PATH` };
      const probe = await runProcess({
        command: cfg.command,
        args: ['--version'],
        cwd: process.cwd(),
        timeoutMs: 20_000,
      });
      if (probe.spawnError || probe.exitCode !== 0) {
        return {
          ok: false,
          detail:
            probe.spawnError ??
            (probe.stderr.trim() || `exit code ${probe.exitCode}`).slice(0, 200),
        };
      }
      return { ok: true, detail: probe.stdout.trim().split('\n')[0]!.slice(0, 80) };
    },

    async run(opts: RunOptions): Promise<HarnessResult> {
      const proc = await runProcess({
        command: cfg.command,
        args: [...cfg.args, ...spec.args(opts, cfg)],
        cwd: opts.cwd,
        stdin: opts.prompt,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        env: { NO_COLOR: '1', ...spec.env?.(opts) },
      });
      const base = {
        exitCode: proc.exitCode,
        durationMs: proc.durationMs,
        raw: proc.stdout.slice(-20_000),
      };

      if (proc.spawnError)
        return { ...base, output: '', error: { kind: 'unavailable', message: proc.spawnError } };
      if (proc.aborted)
        return { ...base, output: '', error: { kind: 'aborted', message: 'Stopped by the user' } };
      if (proc.timedOut) {
        return {
          ...base,
          output: '',
          error: {
            kind: 'timeout',
            message: `No result within ${Math.round(opts.timeoutMs / 1000)} s`,
          },
        };
      }

      const parsed = spec.parse(proc.stdout);
      let error = parsed.error;
      if (!error && proc.exitCode !== 0) {
        error = {
          kind: 'crash',
          message: (proc.stderr.trim() || `${cfg.command} exited with code ${proc.exitCode}`).slice(
            0,
            500,
          ),
        };
      }
      if (!error && !parsed.output.trim()) {
        error = { kind: 'crash', message: 'The agent finished without saying anything' };
      }
      const { report, error: reportError } = parsePuffReport(parsed.output);
      return {
        ...base,
        output: parsed.output,
        report,
        reportError,
        filesRead: parsed.filesRead,
        tokensIn: parsed.tokensIn,
        cachedIn: parsed.cachedIn,
        tokensOut: parsed.tokensOut,
        costUsd: parsed.costUsd,
        error,
      };
    },
  };
}

export type Adapters = Partial<Record<AgentName, HarnessAdapter>>;

/** One adapter per harness named in the config. */
export function createAdapters(config: PuffConfig): Adapters {
  const out: Adapters = {};
  for (const [name, cfg] of Object.entries(config.harnesses)) {
    if (name in SPECS) out[name as AgentName] = createAdapter(name as AgentName, cfg);
  }
  return out;
}

/** The role an agent plays for a task type. */
export const ROLE_FOR_TYPE: Record<'plan' | 'implement' | 'verify' | 'chore', Role> = {
  plan: 'planner',
  implement: 'coder',
  verify: 'verifier',
  chore: 'chore',
};
