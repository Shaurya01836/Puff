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
    color: '#a4a4ad',
    text: 'text-ink-2',
    tagline: 'Changes you made yourself',
  },
};

/** Four tones, no more: idle, live, needs a person, failed. */
export type StatusTone = 'neutral' | 'brand' | 'good' | 'warn' | 'bad';

export const TONE_COLOR: Record<StatusTone, string> = {
  neutral: '#77777f',
  brand: '#34d399',
  good: '#34d399',
  warn: '#d29922',
  bad: '#f85149',
};

export const STATUS_META: Record<TaskStatus, { label: string; tone: StatusTone; live?: boolean }> =
  {
    planned: { label: 'Planned', tone: 'neutral' },
    ready: { label: 'Ready', tone: 'neutral' },
    running: { label: 'Running', tone: 'brand', live: true },
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

/** Graph node colours: neutral structure, colour only where it carries meaning. */
export const NODE_COLORS: Record<string, string> = {
  File: '#4a4a55',
  Symbol: '#8a8a96',
  Technology: '#3d3d46',
  Task: '#e6e6ea',
  Session: '#6e6e78',
  Agent: '#a4a4ad',
  Capability: '#6e6e78',
  Failure: '#f85149',
  Solution: '#34d399',
  Decision: '#d29922',
  Procedure: '#8a8a96',
  ContextPack: '#8a8a96',
  Handoff: '#8a8a96',
};

export const MEMORY_EVENT_META: Record<MemoryEventType, { label: string; color: string }> = {
  failure_recorded: { label: 'Failure recorded', color: '#f85149' },
  solution_recorded: { label: 'Fix recorded', color: '#34d399' },
  decision_recorded: { label: 'Decision', color: '#d29922' },
  decision_superseded: { label: 'Decision superseded', color: '#d29922' },
  memory_stale: { label: 'Memory marked stale', color: '#77777f' },
  memory_downgraded: { label: 'Lessons downgraded', color: '#d29922' },
  handoff: { label: 'Handoff', color: '#a4a4ad' },
  context_compiled: { label: 'Context compiled', color: '#a4a4ad' },
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
