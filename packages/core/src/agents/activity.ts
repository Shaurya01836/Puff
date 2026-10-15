// What an agent is doing, read from the events its CLI prints while it works. Pure functions, tested
// against output captured from the real CLIs (codex and opencode) and the documented stream of Claude Code.
// One CLI event can be zero, one or several steps; events that say nothing a person needs are dropped.
import type { ActivityKind, AgentName } from '@puff/shared';

/** A step before Puff has given it an id, a task and a time */
export interface ActivityDraft {
  kind: ActivityKind;
  text: string;
  path?: string;
  ok?: boolean;
}

const MAX_TEXT = 240;

/** What a model says, without the machine-readable report block and the reasoning tags some print. */
export function said(s: string): string {
  return s
    .replace(/<puff-report>[\s\S]*?(?:<\/puff-report>|$)/g, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '');
}

const clip = (s: string, max = MAX_TEXT): string => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** An agent's own words as a step; nothing if only the report block or reasoning tags were there. */
const message = (text: string): ActivityDraft[] => {
  const t = clip(said(text));
  return t ? [{ kind: 'message', text: t }] : [];
};

/** A path as a person wants to see it: relative to the worktree, with forward slashes. */
export function relativePath(file: string, cwd?: string): string {
  const f = file.replaceAll('\\', '/');
  const base = cwd?.replaceAll('\\', '/').replace(/\/+$/, '');
  if (base && f.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return f.slice(base.length + 1);
  return f;
}

/**
 * The command an agent wrote, without the shell it was wrapped in. Codex on Windows runs everything
 * as `powershell.exe -Command "..."`, and on Linux as `bash -lc '...'`; nobody wants to read that.
 */
export function unwrapShell(command: string): string {
  const ps = /^"?[^"]*?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-\w+\s+)*-Command\s+([\s\S]+)$/i.exec(
    command.trim(),
  );
  const sh = /^(?:\S*\/)?(?:bash|sh|zsh)\s+-l?c\s+([\s\S]+)$/.exec(command.trim());
  const inner = ps?.[1] ?? sh?.[1];
  if (inner === undefined) return command.trim();
  // Codex prints the Windows command with every backslash doubled
  const plain = ps ? inner.replace(/\\\\/g, '\\') : inner;
  const quoted = /^(['"])([\s\S]*)\1$/.exec(plain.trim());
  if (!quoted) return plain.trim();
  return quoted[1] === '"' ? quoted[2]!.replace(/\\"/g, '"') : quoted[2]!;
}

type Json = Record<string, any>;

function parseLine(line: string): Json | undefined {
  const t = line.trim();
  if (!t.startsWith('{')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Codex: command runs and file changes arrive as items; commands are shown when they start. */
function codex(ev: Json, cwd?: string): ActivityDraft[] {
  const item = ev.item as Json | undefined;
  if (ev.type === 'error' || ev.type === 'turn.failed') {
    return [
      {
        kind: 'message',
        text: clip(String(ev.message ?? ev.error?.message ?? 'Error')),
        ok: false,
      },
    ];
  }
  if (!item) return [];
  if (ev.type === 'item.started' && item.type === 'command_execution') {
    return [{ kind: 'command', text: `Ran ${clip(unwrapShell(String(item.command ?? '')), 160)}` }];
  }
  if (ev.type === 'item.completed' && item.type === 'command_execution') {
    // The start step already said what ran; only a failure is news
    return typeof item.exit_code === 'number' && item.exit_code !== 0
      ? [{ kind: 'command', text: `That command exited with code ${item.exit_code}`, ok: false }]
      : [];
  }
  if (ev.type === 'item.completed' && item.type === 'file_change') {
    return ((item.changes as Json[] | undefined) ?? []).map((c) => {
      const path = relativePath(String(c.path ?? ''), cwd);
      const verb = c.kind === 'add' ? 'Created' : c.kind === 'delete' ? 'Deleted' : 'Edited';
      return { kind: 'edit' as const, text: `${verb} ${path}`, path };
    });
  }
  if (ev.type === 'item.completed' && item.type === 'agent_message' && str(item.text)) {
    return message(item.text);
  }
  if (ev.type === 'item.completed' && item.type === 'error') {
    return [{ kind: 'message', text: clip(String(item.message ?? 'Error')), ok: false }];
  }
  return [];
}

/** OpenCode: every tool call arrives once, when it has finished, with its input. */
function opencode(ev: Json, cwd?: string): ActivityDraft[] {
  if (ev.type === 'text' && str(ev.part?.text)) return message(ev.part.text);
  if (ev.type === 'error') {
    const message = ev.error?.data?.message ?? ev.error?.message ?? ev.message ?? 'Error';
    return [{ kind: 'message', text: clip(String(message)), ok: false }];
  }
  if (ev.type !== 'tool_use' || ev.part?.type !== 'tool') return [];
  const tool = String(ev.part.tool ?? '');
  const input = (ev.part.state?.input ?? {}) as Json;
  const file = str(input.filePath) ?? str(input.path);
  const path = file ? relativePath(file, cwd) : undefined;
  switch (tool) {
    case 'read':
      return [{ kind: 'read', text: `Read ${path ?? 'a file'}`, path }];
    case 'edit':
    case 'patch':
    case 'multiedit':
      return [{ kind: 'edit', text: `Edited ${path ?? 'a file'}`, path }];
    case 'write':
      return [{ kind: 'edit', text: `Wrote ${path ?? 'a file'}`, path }];
    case 'bash': {
      const exit = ev.part.state?.metadata?.exit;
      return [
        {
          kind: 'command',
          text: `Ran ${clip(str(input.command) ?? 'a command', 160)}`,
          ok: typeof exit === 'number' ? exit === 0 : undefined,
        },
      ];
    }
    case 'grep':
    case 'glob':
    case 'list':
      return [
        {
          kind: 'search',
          text: `Searched ${clip(str(input.pattern) ?? str(input.path) ?? tool, 120)}`,
        },
      ];
    default:
      return [{ kind: 'tool', text: `Used ${tool || 'a tool'}` }];
  }
}

/** Claude Code (`--output-format stream-json`): the assistant's messages carry text and tool calls. */
function claude(ev: Json, cwd?: string): ActivityDraft[] {
  if (ev.type !== 'assistant') return [];
  const out: ActivityDraft[] = [];
  for (const block of (ev.message?.content as Json[] | undefined) ?? []) {
    if (block.type === 'text' && str(block.text)) {
      out.push(...message(block.text));
    } else if (block.type === 'tool_use') {
      const input = (block.input ?? {}) as Json;
      const file = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
      const path = file ? relativePath(file, cwd) : undefined;
      switch (block.name) {
        case 'Read':
          out.push({ kind: 'read', text: `Read ${path ?? 'a file'}`, path });
          break;
        case 'Edit':
        case 'MultiEdit':
        case 'NotebookEdit':
          out.push({ kind: 'edit', text: `Edited ${path ?? 'a file'}`, path });
          break;
        case 'Write':
          out.push({ kind: 'edit', text: `Wrote ${path ?? 'a file'}`, path });
          break;
        case 'Bash':
        case 'PowerShell':
          out.push({
            kind: 'command',
            text: `Ran ${clip(str(input.command) ?? 'a command', 160)}`,
          });
          break;
        case 'Grep':
        case 'Glob':
          out.push({
            kind: 'search',
            text: `Searched ${clip(str(input.pattern) ?? 'the code', 120)}`,
          });
          break;
        default:
          out.push({ kind: 'tool', text: `Used ${block.name ?? 'a tool'}` });
      }
    }
  }
  return out;
}

/** The steps one line of an agent's output stands for. Anything that is not a JSON event gives none. */
export function activityFromLine(agent: AgentName, line: string, cwd?: string): ActivityDraft[] {
  const ev = parseLine(line);
  if (!ev) return [];
  if (agent === 'codex') return codex(ev, cwd);
  if (agent === 'opencode') return opencode(ev, cwd);
  return claude(ev, cwd);
}
