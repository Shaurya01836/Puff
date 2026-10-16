// The conversation with the orchestrator.
//
// A person types. A slash command answers at once, in words, for free. Anything else goes to an agent
// (Claude Code) that has no tools of its own except Puff's: it looks at the board, adds and changes
// tasks, adds goals for the planner, reads the project's memory, and can ASK to run the team. Those
// tools are served by this very process over a local, token-protected HTTP endpoint, so the agent
// drives the same controller (and the same running team) as the app's buttons.
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  SIGN_IN_AGENTS,
  parseClaude,
  resolveExecutable,
  runProcess,
  runSlashCommand,
  signInState,
  type ProjectController,
  type ProjectHooks,
  type SignInManager,
} from '@puff/core';
import {
  parseSlashCommand,
  type AgentName,
  type ChatChoice,
  type ChatInfo,
  type ChatMessage,
  type PuffEvent,
} from '@puff/shared';
import { registerControlTools, type ChatAction } from './control';
import { hostMcp, type McpHost } from './http';
import { createPuffServer } from './tools';

// ---------------------------------------------------------------------------------------------
// Brains: what answers plain sentences
// ---------------------------------------------------------------------------------------------

export interface BrainInput {
  message: string;
  /** Puff's tools, served locally */
  mcp: { url: string; token: string };
  systemPrompt: string;
  /** Continue the conversation this id names (from the previous reply) */
  sessionId?: string;
  model?: string;
  /** Where the agent runs (the project folder) */
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface BrainReply {
  text: string;
  sessionId?: string;
  tokens?: { in: number; out: number };
  error?: { kind: string; message: string };
}

export interface ChatBrain {
  /** Shown to the person: "Claude Code" */
  readonly name: string;
  /** Is it installed? (Whether it is signed in only shows when it is asked.) */
  available(): Promise<{ ok: boolean; note?: string }>;
  send(input: BrainInput): Promise<BrainReply>;
}

/** The command line for one turn. Built apart so it can be checked without running anything. */
export function claudeArgs(input: BrainInput, mcpConfigFile: string): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    // Only Puff's tools: nothing from the user's own Claude settings, and none of the built-in tools
    // (no file edits, no shell). The orchestrator talks and delegates; it does not code.
    '--mcp-config',
    mcpConfigFile,
    '--strict-mcp-config',
    '--tools',
    '',
    '--allowedTools',
    'mcp__puff__*',
    '--append-system-prompt',
    input.systemPrompt,
    ...(input.model ? ['--model', input.model] : []),
    ...(input.sessionId ? ['--resume', input.sessionId] : []),
  ];
}

export class ClaudeCodeBrain implements ChatBrain {
  readonly name = 'Claude Code';
  constructor(
    private readonly command = 'claude',
    private readonly extraEnv: Record<string, string | undefined> = {},
  ) {}

  async available() {
    return resolveExecutable(this.command)
      ? { ok: true }
      : {
          ok: false,
          note: 'Claude Code is not installed (the `claude` command was not found). Slash commands still work.',
        };
  }

  async send(input: BrainInput): Promise<BrainReply> {
    const file = join(tmpdir(), `puff-chat-${process.pid}-${randomBytes(4).toString('hex')}.json`);
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: {
          puff: {
            type: 'http',
            url: input.mcp.url,
            headers: { Authorization: `Bearer ${input.mcp.token}` },
          },
        },
      }),
    );
    try {
      const proc = await runProcess({
        command: this.command,
        args: claudeArgs(input, file),
        cwd: existsSync(input.cwd) ? input.cwd : tmpdir(),
        stdin: input.message,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        env: { NO_COLOR: '1', ...this.extraEnv },
      });
      if (proc.spawnError)
        return { text: '', error: { kind: 'unavailable', message: proc.spawnError } };
      if (proc.aborted) return { text: '', error: { kind: 'aborted', message: 'Stopped.' } };
      if (proc.timedOut)
        return {
          text: '',
          error: {
            kind: 'timeout',
            message: `No answer within ${Math.round(input.timeoutMs / 1000)} seconds.`,
          },
        };
      const parsed = parseClaude(proc.stdout);
      let sessionId: string | undefined;
      try {
        const j = JSON.parse(proc.stdout.trim()) as { session_id?: unknown };
        if (typeof j.session_id === 'string') sessionId = j.session_id;
      } catch {
        // not JSON: parseClaude already reported it as an error
      }
      if (parsed.error) return { text: parsed.output, sessionId, error: parsed.error };
      if (proc.exitCode !== 0)
        return {
          text: '',
          error: {
            kind: 'crash',
            message: (proc.stderr.trim() || `claude exited with code ${proc.exitCode}`).slice(
              0,
              400,
            ),
          },
        };
      return {
        text: parsed.output.trim(),
        sessionId,
        tokens: { in: parsed.tokensIn ?? 0, out: parsed.tokensOut ?? 0 },
      };
    } finally {
      await rm(file, { force: true });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The instructions the orchestrator is given
// ---------------------------------------------------------------------------------------------

export function orchestratorPrompt(project: string): string {
  return [
    `You are the orchestrator of Puff, working on the project "${project}" with the person who owns it.`,
    'Puff runs a team of coding agents (Claude Code, Codex, OpenCode) on one repository and gives them one shared memory of the code and of what went wrong before. You manage that team for the person. You do not write or edit code yourself, and you have no tool that does.',
    '',
    'How to work:',
    '- Look before you act. Use team_status, list_tasks and task_details instead of guessing what is on the board.',
    '- A request that spans several steps: use create_goal (the planner will split it). A single, clear change: use create_task. Use find_symbols to give create_task real function names as targets.',
    '- Tasks never run until the team runs. To run, call request_run. It only ASKS the person (running spends their tokens). Do not say the team started unless the tool answer says it started.',
    '- You cannot delete tasks or memory. If asked to, say that is done in the app.',
    '- Refer to tasks by the short ids the tools print. Never invent an id or claim something happened that a tool did not report.',
    '- If a tool fails, say what failed and why, in plain words, and what the person can do.',
    '- When a request is vague (no clear outcome, no idea which code it touches, or very large), do not create anything yet: ask the person one to three short, specific questions, offering options where you can, and wait for the answers. Once it is clear, act.',
    '- Be brief. Plain sentences, no headings. Say what you did and what is next.',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------------------------

export interface ChatSessionOptions {
  controller: ProjectController;
  brain: ChatBrain;
  /** Lets slash commands list and switch projects (the app knows how; a plain CLI chat does not) */
  projects?: ProjectHooks;
  /** Starts the agents' own sign-in for /login and /code. Without it those commands say they are unavailable. */
  signIn?: Pick<SignInManager, 'start' | 'submitCode'>;
  /** Which agent the brain is, and the agents to choose from (for the picker and for signing in) */
  brainId?: AgentName;
  choices?: () => ChatChoice[];
  /** Model for the orchestrator agent; default: the agent's own */
  model?: string;
  /** Runs the orchestrator asks for start without asking the person first */
  autoApprove?: boolean;
  /** Most tool calls the agent may make to answer one message */
  toolCallLimit?: number;
  timeoutMs?: number;
  /** Every message, as it happens (also an upsert when an approval is answered) */
  emit?: (e: PuffEvent) => void;
}

const HISTORY_LIMIT = 300;

/** What to tell the person when the agent itself could not answer. */
export function describeBrainError(
  brain: string,
  error: { kind: string; message: string },
): string {
  if (error.kind === 'auth')
    return `${brain} is not signed in. Type /login here (it opens your browser), then try again. Slash commands work meanwhile. (${error.message})`;
  if (error.kind === 'unavailable')
    return `${brain} could not be started: ${error.message}. Slash commands still work.`;
  if (error.kind === 'timeout' || error.kind === 'aborted') return error.message;
  return `${brain} could not answer: ${error.message}`;
}

export class ChatSession {
  private messages: ChatMessage[] = [];
  private host?: McpHost;
  private sessionId?: string;
  private busy = false;
  private turn = { calls: 0, limit: 20 };
  private counter = 0;
  private abort = new AbortController();

  constructor(private readonly opts: ChatSessionOptions) {}

  get history(): ChatMessage[] {
    return this.messages.map((m) => structuredClone(m));
  }

  async info(): Promise<ChatInfo> {
    const status = await this.opts.brain.available();
    // Installed is not the same as signed in: ask the CLI, so the panel can offer the Sign in button
    let note = status.note;
    let needsSignIn = false;
    const id = this.opts.brainId;
    if (status.ok && this.opts.signIn && id && id in SIGN_IN_AGENTS) {
      const command = this.opts.controller.config.harnesses[id]?.command ?? id;
      if ((await signInState(id, command)) === 'signed-out') {
        needsSignIn = true;
        note = `${this.opts.brain.name} is not signed in. Press Sign in (or type /login); it opens your browser. Slash commands work meanwhile.`;
      }
    }
    return {
      brain: this.opts.brain.name,
      ready: status.ok,
      note,
      needsSignIn,
      autoApprove: this.opts.autoApprove === true,
      agent: this.opts.brainId,
      choices: this.opts.choices?.(),
    };
  }

  private push(m: Omit<ChatMessage, 'id' | 'at'>): ChatMessage {
    const message: ChatMessage = {
      id: `msg_${Date.now().toString(36)}${++this.counter}`,
      at: Date.now(),
      ...m,
    };
    this.messages.push(message);
    if (this.messages.length > HISTORY_LIMIT)
      this.messages.splice(0, this.messages.length - HISTORY_LIMIT);
    this.opts.emit?.({ type: 'chat', message: structuredClone(message) });
    return message;
  }

  /** Tools for one request: Puff's memory tools (read only) plus the control tools. */
  private buildServer(): McpServer {
    const { controller } = this.opts;
    const server = createPuffServer({
      graph: controller.graph,
      config: controller.config,
      readOnly: true,
    });
    registerControlTools(server, {
      controller,
      turn: this.turn,
      onAction: (a: ChatAction) =>
        this.push({ role: 'action', tool: a.tool, ok: a.ok, text: a.text }),
      onRunRequest: (reason) => this.requestRun(reason),
    });
    return server;
  }

  /** The orchestrator asks to run the team. Returns what it should tell the person. */
  private async requestRun(reason?: string): Promise<string> {
    const { controller } = this.opts;
    if (controller.running) return 'The team is already running.';
    if (controller.runBlocked) return `The team cannot run here: ${controller.runBlocked}`;
    if (this.opts.autoApprove) {
      await controller.start();
      this.push({ role: 'action', tool: 'request_run', ok: true, text: 'Started the team' });
      return 'The team started. Progress shows on the board.';
    }
    if (this.messages.some((m) => m.approval?.state === 'pending'))
      return 'A run is already waiting for the person to approve it.';
    this.push({
      role: 'approval',
      text: 'Run the team?',
      approval: {
        id: `apr_${randomBytes(4).toString('hex')}`,
        summary: reason?.trim() || 'Run the ready tasks. This spends agent tokens.',
        state: 'pending',
      },
    });
    return 'Asked the person to approve the run. It has NOT started. Tell them it is waiting for their approval.';
  }

  /** Answer the request the orchestrator made. */
  async approve(approvalId: string, approve: boolean): Promise<void> {
    const message = this.messages.find((m) => m.approval?.id === approvalId);
    if (!message?.approval || message.approval.state !== 'pending')
      throw new Error('That request is no longer waiting.');
    message.approval.state = approve ? 'approved' : 'declined';
    this.opts.emit?.({ type: 'chat', message: structuredClone(message) });
    if (!approve) return;
    try {
      const started = await this.opts.controller.start();
      this.push({
        role: 'system',
        ok: true,
        text: started ? 'The team is running.' : 'The team was already running.',
      });
    } catch (err) {
      this.push({ role: 'system', ok: false, text: (err as Error).message });
    }
  }

  /** /login [agent]: open the provider's login page. The end of the sign-in arrives as its own message. */
  private async startSignIn(args: string): Promise<void> {
    const manager = this.opts.signIn;
    if (!manager)
      return void this.push({
        role: 'system',
        ok: false,
        text: 'Signing in is not available here. Run the agent (for example `claude`) in a terminal and sign in there.',
      });
    const word = args.trim().toLowerCase();
    const agent: AgentName | undefined =
      word === ''
        ? this.opts.brainId && this.opts.brainId in SIGN_IN_AGENTS
          ? this.opts.brainId
          : 'claude-code'
        : word === 'claude' || word === 'claude-code'
          ? 'claude-code'
          : word === 'codex'
            ? 'codex'
            : undefined;
    if (!agent)
      return void this.push({
        role: 'system',
        ok: false,
        text: `I can sign in to claude-code or codex, not "${args.trim()}". Sign in to other agents with their own command in a terminal.`,
      });
    try {
      const started = await manager.start(agent);
      this.push({
        role: 'system',
        ok: true,
        text: [
          `Opening your browser to sign in to ${SIGN_IN_AGENTS[agent]!.label}. Approve it there.`,
          started.url ? `If it did not open, go to: ${started.url}` : '',
          'If the page shows a one-time code, type it here as /code <the code>. Puff does not keep it.',
        ]
          .filter(Boolean)
          .join('\n'),
      });
      void started.done.then((r) => this.push({ role: 'system', ok: r.ok, text: r.message }));
    } catch (err) {
      this.push({ role: 'system', ok: false, text: (err as Error).message });
    }
  }

  /** /code <code>: hand the one-time code to the sign-in that is waiting for it */
  private submitCode(code: string): void {
    const sent = this.opts.signIn?.submitCode(code) ?? false;
    this.push({
      role: 'system',
      ok: sent,
      text: sent
        ? 'Code sent. Waiting for the sign-in to finish…'
        : code.trim()
          ? 'No sign-in is waiting for a code. Type /login first.'
          : 'Type the code after the command: /code <the code>.',
    });
  }

  async send(text: string): Promise<void> {
    const said = text.trim();
    if (!said) return;
    if (this.busy) throw new Error('Still working on your last message.');
    const command = parseSlashCommand(said);
    // A one-time sign-in code is not kept in the conversation
    this.push({ role: 'user', text: command?.name === 'code' ? '/code ••••••' : said });

    if (command?.name === 'login') return this.startSignIn(command.args);
    if (command?.name === 'code') return this.submitCode(command.args);

    // Slash commands: instant and free, and they never reach the agent.
    if (command) {
      const r = await runSlashCommand(this.opts.controller, said, this.opts.projects);
      this.push({ role: 'system', ok: r.ok, text: r.text });
      return;
    }

    this.busy = true;
    try {
      this.host ??= await hostMcp(() => this.buildServer());
      this.turn.calls = 0;
      this.turn.limit = this.opts.toolCallLimit ?? 20;
      const { controller } = this.opts;
      const reply = await this.opts.brain.send({
        message: said,
        mcp: { url: this.host.url, token: this.host.token },
        systemPrompt: orchestratorPrompt(controller.project.name),
        sessionId: this.sessionId,
        model: this.opts.model,
        cwd: controller.project.repoPath,
        timeoutMs: this.opts.timeoutMs ?? 300_000,
        signal: this.abort.signal,
      });
      if (reply.sessionId) this.sessionId = reply.sessionId;
      if (reply.error)
        this.push({
          role: 'system',
          ok: false,
          text: describeBrainError(this.opts.brain.name, reply.error),
        });
      else
        this.push({ role: 'assistant', text: reply.text || '(No answer.)', tokens: reply.tokens });
    } catch (err) {
      this.push({ role: 'system', ok: false, text: (err as Error).message });
    } finally {
      this.busy = false;
    }
  }

  /** Forget the conversation (the agent starts fresh too). */
  reset(): void {
    this.messages = [];
    this.sessionId = undefined;
  }

  /** Stop listening and stop any answer in progress. */
  async close(): Promise<void> {
    this.abort.abort();
    await this.host?.close();
    this.host = undefined;
  }
}
