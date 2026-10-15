// Puff shared domain types. This file is the frozen contract between core and UI:
// change it only by team agreement, then update mocks and both sides together.

export type AgentName = 'claude-code' | 'codex' | 'opencode';
export type Role = 'planner' | 'coder' | 'verifier' | 'chore';
export type TaskType = 'plan' | 'implement' | 'verify' | 'chore';
export type Complexity = 'low' | 'medium' | 'high';
export type TaskStatus =
  'planned' | 'ready' | 'running' | 'verifying' | 'failed' | 'retrying' | 'escalated' | 'done';
export type MemoryKind = 'Failure' | 'Solution' | 'Decision' | 'Procedure' | 'Symbol';
export type FailureKind = 'test' | 'type' | 'lint' | 'runtime' | 'review';
export type SessionOutcome = 'running' | 'success' | 'failure' | 'error';

export const AGENT_NAMES: readonly AgentName[] = ['claude-code', 'codex', 'opencode'];
export const TASK_STATUSES: readonly TaskStatus[] = [
  'planned',
  'ready',
  'running',
  'verifying',
  'failed',
  'retrying',
  'escalated',
  'done',
];

export interface Task {
  id: string;
  title: string;
  type: TaskType;
  complexity: Complexity;
  status: TaskStatus;
  assignedAgent?: AgentName;
  role?: Role;
  /** Symbol ids, e.g. `src/auth/login.ts::login` */
  targets: string[];
  /** Task ids this task waits for */
  dependsOn: string[];
  worktree?: string;
  /** Running task ids whose code overlaps with this one (scheduler Q8) */
  blockedBy?: string[];
  tokens?: { in: number; out: number };
  testSummary?: { passed: number; total: number };
  createdAt: number;
  updatedAt: number;
}

export interface SessionInfo {
  id: string;
  taskId: string;
  agent: AgentName;
  role: Role;
  outcome: SessionOutcome;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
  changedFiles: string[];
  output?: string;
  startedAt: number;
}

export interface ContextItem {
  kind: MemoryKind;
  id: string;
  text: string;
  /** Why the context compiler included this item (stored on the INCLUDED edge) */
  reason: string;
  stale?: boolean;
}

export interface ContextPack {
  id: string;
  sessionId: string;
  tokenEstimate: number;
  items: ContextItem[];
  prompt: string;
}

export interface GraphNode {
  id: string;
  label: string;
  /** Graph label: File, Symbol, Task, Session, Failure, Decision, ... */
  kind: string;
  props?: Record<string, unknown>;
  highlight?: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** Relationship type: DEFINES, CALLS, TARGETS, HIT, IN, ... */
  type: string;
  props?: Record<string, unknown>;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface WhyPath extends GraphData {
  summary: string;
}

export type MemoryEventType =
  | 'failure_recorded'
  | 'solution_recorded'
  | 'decision_recorded'
  | 'decision_superseded'
  | 'memory_stale'
  | 'handoff'
  | 'context_compiled';

export interface MemoryEvent {
  id: string;
  at: number;
  type: MemoryEventType;
  text: string;
  /** Ids of graph nodes this event is about */
  refs: string[];
}

export interface AgentProfile {
  name: AgentName;
  instances: number;
  busy: number;
  strengths: string[];
  stats: { runs: number; wins: number; successRate: number; avgTokens?: number };
}

export interface SavingsArm {
  tokens: number;
  filesRead: number;
  firstTryPassRate: number;
}

export interface Savings {
  tasks: number;
  withPuff: SavingsArm;
  baseline: SavingsArm;
}

export type PuffEvent =
  | { type: 'task:update'; task: Task }
  | { type: 'session:update'; session: SessionInfo }
  | { type: 'memory'; event: MemoryEvent };

/** Where the API gets its data. Lets the UI say honestly what is live and what is mock. */
export interface BackendInfo {
  /** live = graph comes from FalkorDB; mock = everything comes from fixtures */
  mode: 'live' | 'mock';
  projectId: string;
  projectName: string;
  repoPath?: string;
  graphName?: string;
  /** Parts of the API that still return mock data in live mode */
  mockParts: string[];
  /** Why live mode is unavailable, when mode is mock */
  error?: string;
}

/** Structured block agents append to their final answer: <puff-report>{...}</puff-report> */
export interface PuffReport {
  decisions?: { symbol: string; text: string; supersedes?: string }[];
  notes?: string;
}
