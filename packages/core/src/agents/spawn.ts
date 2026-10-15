// Run external programs without a shell. Agent prompts are untrusted text, so they travel on stdin
// and are never interpolated into a command line. On Windows, CLIs installed with npm are `.cmd`
// shims that Node refuses to spawn directly; we read the shim and launch what it wraps instead.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';

export interface ProcessOptions {
  command: string;
  args?: string[];
  cwd: string;
  /** Written to the process's stdin, which is then closed */
  stdin?: string;
  timeoutMs: number;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
  /**
   * Run `command` through the system shell. Only for command lines the user configured themselves
   * (the test command), never for anything derived from model output.
   */
  shell?: boolean;
  /** Keep at most this many bytes per stream (the end is kept: failures print last) */
  maxBytes?: number;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  /** The program could not be started at all (not found, not executable) */
  spawnError?: string;
}

const WINDOWS = process.platform === 'win32';
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/** Find an executable on PATH, trying PATHEXT on Windows. Returns an absolute path or undefined. */
export function resolveExecutable(
  command: string,
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): string | undefined {
  const exts = WINDOWS
    ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())]
    : [''];
  const hasDir = /[\\/]/.test(command);
  const dirs = hasDir ? [''] : (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = hasDir ? resolve(cwd, command + ext) : join(dir, command + ext);
      if (existsSync(candidate) && extname(candidate) !== '') return candidate;
      if (!WINDOWS && existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** `node`, even when we are running inside Electron (where process.execPath is the Electron binary). */
function nodeLauncher(env: Record<string, string | undefined>): {
  command: string;
  env: Record<string, string | undefined>;
} {
  if (!process.versions.electron) return { command: process.execPath, env };
  const node = resolveExecutable('node', env);
  if (node) return { command: node, env };
  return { command: process.execPath, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
}

/**
 * The file an npm `.cmd` shim launches, relative to the shim. Shims mention `%dp0%\node.exe` first
 * (a "use the bundled node if it exists" check); the real target is the last quoted path, and it is
 * never node itself.
 */
export function shimTarget(shimText: string): string | undefined {
  const found = [...shimText.matchAll(/"%~?dp0%?\\([^"]+?\.(?:exe|js))"/gi)]
    .map((m) => m[1]!)
    .filter((p) => !/^node\.exe$/i.test(p));
  return found.at(-1);
}

/**
 * Turn a resolved path into something we can spawn without a shell. `.exe` files run as they are;
 * a `.cmd` shim is unwrapped to the `.exe` or `.js` file it launches.
 */
export function launchTarget(
  path: string,
  env: Record<string, string | undefined> = process.env,
): { command: string; prefix: string[]; env: Record<string, string | undefined> } {
  const ext = extname(path).toLowerCase();
  if (!WINDOWS || ext === '.exe' || ext === '.com' || ext === '')
    return { command: path, prefix: [], env };
  if (ext === '.cmd' || ext === '.bat') {
    const relative = shimTarget(readFileSync(path, 'utf8'));
    if (relative) {
      const target = join(path, '..', relative);
      if (target.toLowerCase().endsWith('.js')) {
        const node = nodeLauncher(env);
        return { command: node.command, prefix: [target], env: node.env };
      }
      return { command: target, prefix: [], env };
    }
    throw new Error(
      `${path} is a batch shim Puff cannot launch without a shell. Install the CLI so it has an .exe or .js entry point.`,
    );
  }
  return { command: path, prefix: [], env };
}

/** Kill a process and everything it started (agents spawn their own children). */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (WINDOWS) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    }).on('error', () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function capped(max: number) {
  let text = '';
  return {
    push(chunk: Buffer) {
      text += chunk.toString('utf8');
      if (text.length > max)
        text = `[… earlier output dropped …]\n${text.slice(text.length - max)}`;
    },
    get: () => text,
  };
}

export function runProcess(opts: ProcessOptions): Promise<ProcessResult> {
  const started = Date.now();
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const baseEnv = { ...process.env, ...opts.env };

  return new Promise((resolvePromise) => {
    let command = opts.command;
    let args = opts.args ?? [];
    let env = baseEnv;
    if (!opts.shell) {
      const exe = isAbsolute(opts.command)
        ? opts.command
        : resolveExecutable(opts.command, baseEnv, opts.cwd);
      if (!exe) {
        return resolvePromise({
          exitCode: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          aborted: false,
          durationMs: 0,
          spawnError: `"${opts.command}" was not found on PATH`,
        });
      }
      try {
        const target = launchTarget(exe, baseEnv);
        command = target.command;
        args = [...target.prefix, ...args];
        env = target.env;
      } catch (err) {
        return resolvePromise({
          exitCode: null,
          stdout: '',
          stderr: '',
          timedOut: false,
          aborted: false,
          durationMs: 0,
          spawnError: (err as Error).message,
        });
      }
    }

    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: env as NodeJS.ProcessEnv,
      shell: opts.shell ?? false,
      windowsHide: true,
      detached: !WINDOWS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const out = capped(maxBytes);
    const err = capped(maxBytes);
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let spawnError: string | undefined;

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolvePromise({
        exitCode,
        stdout: out.get(),
        stderr: err.get(),
        timedOut,
        aborted,
        durationMs: Date.now() - started,
        spawnError,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout!.on('data', (c: Buffer) => out.push(c));
    child.stderr!.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) => {
      spawnError = e.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
    // The process may exit before reading stdin; that is not our error.
    child.stdin!.on('error', () => {});
    child.stdin!.end(opts.stdin ?? '');
  });
}
