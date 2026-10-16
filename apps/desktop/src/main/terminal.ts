// Real terminals inside the app: an agent's own CLI (Claude Code, Codex, OpenCode) or a shell, running in a task's
// working folder, shown by xterm.js in the window. The renderer can choose only WHICH of these to open (never a
// command line or a folder): the program comes from Puff's own configuration and the folder from the task.
import * as pty from '@lydell/node-pty';
import type { IPty } from '@lydell/node-pty';
import { launchTarget, resolveExecutable } from '@puff/core';
import type { PuffEvent, TerminalCli } from '@puff/shared';

const MAX_TERMINALS = 6;

export interface OpenTerminal {
  /** The task this terminal belongs to */
  taskId: string;
  cwd: string;
  cli: TerminalCli;
  /** The configured command for an agent CLI (e.g. "claude"); ignored for a shell */
  command?: string;
  /** What to say first to an agent CLI */
  brief?: string;
}

/** The program and arguments to run, from our own configuration. Throws a readable error when it is missing. */
export function terminalProgram(spec: OpenTerminal): { file: string; args: string[] } {
  if (spec.cli === 'shell') {
    return process.platform === 'win32'
      ? { file: 'powershell.exe', args: ['-NoLogo'] }
      : { file: process.env.SHELL ?? '/bin/bash', args: [] };
  }
  const command = spec.command ?? spec.cli.replace('-code', '');
  const exe = resolveExecutable(command);
  if (!exe) throw new Error(`"${command}" was not found on PATH. Is ${spec.cli} installed?`);
  const target = launchTarget(exe);
  // No first message is passed: the CLI opens idle, and nothing is sent to a model until the person types
  return { file: target.command, args: [...target.prefix] };
}

/** What each terminal has printed (the end of it), so a window that opens late can catch up */
const BUFFER_CHARS = 300_000;

export class TerminalHost {
  private readonly terminals = new Map<string, IPty>();
  private readonly buffers = new Map<string, { text: string; end: number }>();
  private readonly owners = new Map<string, string>();
  private counter = 0;

  constructor(private readonly emit: (e: PuffEvent) => void) {}

  open(spec: OpenTerminal, cols = 110, rows = 32): string {
    if (this.terminals.size >= MAX_TERMINALS)
      throw new Error(`${MAX_TERMINALS} terminals are open. Close one first.`);
    const { file, args } = terminalProgram(spec);
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<
      string,
      string
    >;
    delete env.ELECTRON_RUN_AS_NODE;
    const term = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd: spec.cwd, env });
    const id = `term_${Date.now().toString(36)}${++this.counter}`;
    this.terminals.set(id, term);
    this.buffers.set(id, { text: '', end: 0 });
    this.owners.set(id, spec.taskId);
    term.onData((data) => {
      const b = this.buffers.get(id);
      if (!b) return;
      b.end += data.length;
      b.text = (b.text + data).slice(-BUFFER_CHARS);
      this.emit({ type: 'terminal', id, data, end: b.end });
    });
    term.onExit(({ exitCode }) => {
      this.terminals.delete(id);
      this.emit({ type: 'terminal:exit', id, code: exitCode });
    });
    return id;
  }

  /** Everything printed so far, and the offset it ends at */
  attach(id: string): { data: string; end: number } {
    const b = this.buffers.get(id);
    return { data: b?.text ?? '', end: b?.end ?? 0 };
  }

  write(id: string, data: string): void {
    this.terminals.get(id)?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const term = this.terminals.get(id);
    if (!term || cols < 2 || rows < 2) return;
    try {
      term.resize(Math.floor(cols), Math.floor(rows));
    } catch {
      // the program has just ended
    }
  }

  close(id: string): void {
    const term = this.terminals.get(id);
    this.terminals.delete(id);
    try {
      term?.kill();
    } catch {
      // already gone
    }
  }

  /** Close every terminal of a task (a terminal sitting in a folder stops Windows from deleting it) */
  closeForTask(taskId: string): void {
    for (const [id, owner] of [...this.owners]) if (owner === taskId) this.close(id);
  }

  closeAll(): void {
    for (const id of [...this.terminals.keys()]) this.close(id);
  }
}
