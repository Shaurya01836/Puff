import type { AgentName, TaskStatus } from '@puff/shared';

export const AGENT_META: Record<AgentName, { label: string; color: string; text: string }> = {
  'claude-code': { label: 'Claude Code', color: '#ff9a3c', text: 'text-claude' },
  codex: { label: 'Codex', color: '#3ddc84', text: 'text-codex' },
  opencode: { label: 'OpenCode', color: '#4aa8ff', text: 'text-opencode' },
};

export const STATUS_META: Record<TaskStatus, { label: string; dot: string }> = {
  planned: { label: 'Planned', dot: 'bg-muted' },
  ready: { label: 'Ready', dot: 'bg-puff' },
  running: { label: 'Running', dot: 'bg-warn animate-pulse' },
  verifying: { label: 'Verifying', dot: 'bg-opencode animate-pulse' },
  failed: { label: 'Failed', dot: 'bg-fail' },
  retrying: { label: 'Retrying', dot: 'bg-warn' },
  escalated: { label: 'Escalated', dot: 'bg-claude' },
  done: { label: 'Done', dot: 'bg-ok' },
};

/** Graph node colours by label, shared by the memory graph and the Why view. */
export const NODE_COLORS: Record<string, string> = {
  File: '#5b5480',
  Symbol: '#a48bf5',
  Task: '#ece8ff',
  Session: '#7d74a8',
  Agent: '#ff9a3c',
  Capability: '#c48bff',
  Technology: '#4aa8ff',
  Failure: '#ff5c7a',
  Solution: '#3ddc84',
  Decision: '#ffc53d',
  Procedure: '#4dd4c6',
  ContextPack: '#9a92bf',
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
