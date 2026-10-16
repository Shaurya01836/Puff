import type { Actor, MemoryEventType, TaskStatus } from '@puff/shared';

/** Validated categorical palette (see styles.css). Keep in sync with --color-claude/codex/opencode. */
export const AGENT_META: Record<
  Actor,
  { label: string; short: string; color: string; text: string; tagline: string; roles?: string }
> = {
  'claude-code': {
    label: 'Claude Code',
    short: 'CC',
    color: '#d97757',
    text: 'text-claude',
    tagline: 'Plans, reasons and verifies',
    roles: 'PLAN · VERIFY · REVIEW',
  },
  codex: {
    label: 'Codex',
    short: 'CX',
    color: '#10a37f',
    text: 'text-codex',
    tagline: 'Fast implementation and refactors',
    roles: 'IMPLEMENTATION · REFACTOR',
  },
  opencode: {
    label: 'OpenCode',
    short: 'OC',
    color: '#9d7cd8',
    text: 'text-opencode',
    tagline: 'Cheap edits, docs and boilerplate',
    roles: 'DOCS · FORMATTING',
  },
  // Work the person did by hand (a manual change landed through Puff)
  you: {
    label: 'You',
    short: 'ME',
    color: '#a3b0c8',
    text: 'text-ink-2',
    tagline: 'Changes you made yourself',
  },
};

export type StatusTone = 'neutral' | 'brand' | 'info' | 'good' | 'warn' | 'bad';

export const TONE_COLOR: Record<StatusTone, string> = {
  neutral: '#64748b',
  brand: '#00d492',
  info: '#38bdf8',
  good: '#34d399',
  warn: '#fbbf24',
  bad: '#f43f5e',
};

export const STATUS_META: Record<TaskStatus, { label: string; tone: StatusTone; live?: boolean }> =
  {
    planned: { label: 'Planned', tone: 'neutral' },
    ready: { label: 'Ready', tone: 'brand' },
    running: { label: 'Running', tone: 'info', live: true },
    verifying: { label: 'Verifying', tone: 'brand', live: true },
    failed: { label: 'Failed', tone: 'bad' },
    retrying: { label: 'Retrying', tone: 'warn', live: true },
    escalated: { label: 'Escalated', tone: 'warn' },
    done: { label: 'Done', tone: 'good' },
  };

/** Graph node groups: what the filter chips toggle. */
export const NODE_GROUPS: Record<string, 'code' | 'work' | 'memory'> = {
  File: 'code',
  Symbol: 'code',
  Technology: 'code',
  Task: 'work',
  Session: 'work',
  Agent: 'work',
  Capability: 'work',
  Failure: 'memory',
  Solution: 'memory',
  Decision: 'memory',
  Procedure: 'memory',
  ContextPack: 'memory',
  Handoff: 'memory',
};

/** Graph node colours by label. Memory kinds reuse the meaning of the status colours. */
export const NODE_COLORS: Record<string, string> = {
  File: '#3a4766',
  Symbol: '#8b7cf6',
  Technology: '#6b7894',
  Task: '#e7ecf6',
  Session: '#4b5878',
  Agent: '#b4a5ff',
  Capability: '#7c6fd0',
  Failure: '#f45d6d',
  Solution: '#4ade80',
  Decision: '#f5b83d',
  Procedure: '#2dd4e0',
  ContextPack: '#2dd4e0',
  Handoff: '#2dd4e0',
};

export const MEMORY_EVENT_META: Record<MemoryEventType, { label: string; color: string }> = {
  failure_recorded: { label: 'Failure recorded', color: '#f45d6d' },
  solution_recorded: { label: 'Fix recorded', color: '#4ade80' },
  decision_recorded: { label: 'Decision', color: '#f5b83d' },
  decision_superseded: { label: 'Decision superseded', color: '#f5b83d' },
  memory_stale: { label: 'Memory marked stale', color: '#a9b4cc' },
  memory_downgraded: { label: 'Lessons downgraded', color: '#fb923c' },
  handoff: { label: 'Handoff', color: '#b4a5ff' },
  context_compiled: { label: 'Context compiled', color: '#2dd4e0' },
};

export const formatTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

export const timeAgo = (at: number, now = Date.now()): string => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return new Date(at).toLocaleDateString();
};
