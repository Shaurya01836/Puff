// Puff shared domain types. This file is the frozen contract between core and UI:
// change it only by team agreement, then update mocks and both sides together.

export type AgentName = 'claude-code' | 'codex' | 'opencode';
/** Who did a piece of work: one of the agents, or the person (a manual change landed through Puff) */
export type Actor = AgentName | 'you';
export type Role = 'planner' | 'coder' | 'verifier' | 'chore';
export type TaskType = 'plan' | 'implement' | 'verify' | 'chore';
export type Complexity = 'low' | 'medium' | 'high';
export type TaskStatus =
  'planned' | 'ready' | 'running' | 'verifying' | 'failed' | 'retrying' | 'escalated' | 'done';
export type MemoryKind = 'Failure' | 'Solution' | 'Decision' | 'Procedure' | 'Symbol' | 'Handoff';
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
  /** How many agent-created steps sit between a person and this task (0 = created by a person) */
  depth?: number;
  /** The agent the person chose for this task; Auto-routing when absent */
  preferredAgent?: AgentName;
  /** Provider model override for this task */
  model?: string;
  /** Names the planner gave that are not in the graph yet (new code), kept as a hint for the agent */
  hints?: string[];
  worktree?: string;
  /** Running task ids whose code overlaps with this one (scheduler Q8) */
  blockedBy?: string[];
  tokens?: { in: number; out: number };
  testSummary?: { passed: number; total: number };
  /** Who has worked on this task, in order, so a card can say "OpenCode stalled, then Claude Code took over" */
  trail?: TrailEntry[];
  /** When the running agent was last silent for too long (cleared when it speaks again) */
  stalledAt?: number;
  /** A note from the person that the next attempt is told to follow */
  note?: string;
  /** Marked done by the person, not by an agent's verified work */
  doneByHand?: boolean;
  /**
   * How load-bearing the riskiest target is (Q20): 0 to 1, the share of the project's functions that
   * score lower by PageRank and betweenness over CALLS. 0.9 and up counts as risky by default.
   */
  risk?: number;
  createdAt: number;
  updatedAt: number;
}

/** One attempt on a task */
export interface TrailEntry {
  agent: Actor;
  outcome: 'running' | 'success' | 'failure' | 'error' | 'stopped' | 'stalled';
  /** When the attempt started */
  at: number;
  /** Why it ended the way it did, in a few words */
  detail?: string;
}

/**
 * What a step was.
 * `phase` steps are Puff's own (running the tests, merging, re-testing the combined result);
 * the others are what the agent did.
 */
export type ActivityKind = 'read' | 'edit' | 'command' | 'search' | 'message' | 'tool' | 'phase';

/** One step of a session, in the order it happened. */
export interface ActivityStep {
  id: string;
  taskId: string;
  sessionId: string;
  at: number;
  kind: ActivityKind;
  /** One line a person can read: "Edited src/auth.ts", "Ran npm test" */
  text: string;
  /** The file the step is about, relative to the project, when it has one */
  path?: string;
  /** false when the step failed (a command that exited non-zero, tests that failed) */
  ok?: boolean;
}

export interface SessionInfo {
  id: string;
  taskId: string;
  agent: Actor;
  role: Role;
  outcome: SessionOutcome;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
  changedFiles: string[];
  output?: string;
  startedAt: number;
  /** What the agent and Puff did during this session, oldest first. Kept after the session ends. */
  activity?: ActivityStep[];
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
  /** Built with the graph switched off (PUFF_GRAPH=off): the task and its target files only */
  graphOff?: boolean;
}

/** A decision Puff makes by asking the graph */
export type TraceKind = 'route' | 'context' | 'schedule' | 'stale' | 'locate';

/** One query a decision ran */
export interface TraceStep {
  cypher: string;
  /** Parameter names only, never their values */
  params: string[];
  ms: number;
  rows: number;
}

/** The queries behind one decision, and the decision in words */
export interface GraphTrace {
  id: string;
  kind: TraceKind;
  reason: string;
  steps: TraceStep[];
  /** Queries run, including any not kept in steps */
  queries: number;
  ms: number;
  rows: number;
  graphOff?: boolean;
  at: number;
  /** The session it was made for, when it belongs to one attempt */
  sessionId?: string;
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

export type TeamEventKind =
  /** An agent worked on a task */
  | 'session'
  /** An agent left a note for whoever works next */
  | 'handoff'
  /** An agent created follow-up work */
  | 'spawned'
  /** The same task moved up to a different agent after a failure */
  | 'escalated'
  /** The same agent tried again, now with what the failure taught */
  | 'retried';

/** One step in the story of who did what and who passed what to whom. */
export interface TeamEvent {
  id: string;
  at: number;
  kind: TeamEventKind;
  agent?: Actor;
  role?: Role;
  taskId: string;
  taskTitle: string;
  outcome?: SessionOutcome;
  /** Handoffs and escalations: who it went to */
  toAgent?: AgentName;
  /** Handoffs: the role it was addressed to */
  toRole?: string;
  /** Spawned work: the new task */
  toTaskId?: string;
  toTaskTitle?: string;
  text: string;
}

export interface AgentProfile {
  name: AgentName;
  instances: number;
  busy: number;
  strengths: string[];
  stats: { runs: number; wins: number; successRate: number; avgTokens?: number };
}

export interface SavingsArm {
  /** Average input + output tokens per run */
  tokens: number;
  /** Average distinct files opened per run; 0 when the harness does not report it */
  filesRead: number;
  firstTryPassRate: number;
  /** Average wall time per run */
  durationMs?: number;
  /** Runs this arm is averaged over */
  runs?: number;
}

/** One task in a measured benchmark: how each arm did on it, averaged over its runs. */
export interface SavingsTask {
  id: string;
  plain: { passed: number; runs: number; tokens: number };
  puff: { passed: number; runs: number; tokens: number };
}

/** Present when the numbers come from a real benchmark run (bench/results.json). */
export interface SavingsMeasured {
  agent: string;
  model: string;
  runsPerArm: number;
  generatedAt: string;
  /** Whether the harness reported files read at all */
  filesReadReported: boolean;
  perTask: SavingsTask[];
  /** The limits of this measurement, in plain words */
  notes: string[];
}

export interface Savings {
  tasks: number;
  withPuff: SavingsArm;
  baseline: SavingsArm;
  measured?: SavingsMeasured;
}

export type PuffEvent =
  | { type: 'task:update'; task: Task }
  /** A task that never ran was deleted */
  | { type: 'task:removed'; taskId: string }
  | { type: 'session:update'; session: SessionInfo }
  | { type: 'memory'; event: MemoryEvent }
  /** The team started or stopped working; `message` summarises how a run ended or why it could not start */
  | { type: 'run'; running: boolean; message?: string; tone?: 'good' | 'warn' | 'bad' }
  /** The active project changed (added, switched, removed or its settings changed): reload everything */
  | { type: 'project'; projectId: string }
  /** A chat message was added or changed (an approval was answered): upsert it by id */
  | { type: 'chat'; message: ChatMessage }
  /** One thing an agent (or Puff) just did on a task: a file read, an edit, a command, a test run */
  | { type: 'activity'; step: ActivityStep }
  /** Output of a terminal the person opened (a real CLI in a task's working folder) */
  | { type: 'terminal'; id: string; data: string; end: number }
  /** That terminal's program ended */
  | { type: 'terminal:exit'; id: string; code: number | null }
  /** A sign-in that Puff started has ended (the person finished it in the browser, or it failed) */
  | { type: 'signin'; agent: AgentName; ok: boolean; message: string };

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
  /** Why agents cannot be run yet (e.g. the project is not a git repository). Absent when Run team works. */
  runBlocked?: string;
  /** True when the graph holds sample tasks and memory written by `puff seed`, not real agent runs */
  seeded?: boolean;
  /** Why live mode is unavailable, when mode is mock */
  error?: string;
  /** Live, but no project has been added yet: the app shows its welcome screen */
  noProject?: boolean;
  /** The database is not reachable: the app shows its setup screen (see getSetupStatus) */
  needsSetup?: boolean;
}

/** One agent CLI Puff can drive, and whether it is installed on this computer */
export interface AgentCliStatus {
  id: string;
  command: string;
  installed: boolean;
  version?: string;
  /** How to install it (and sign in), shown when it is missing */
  installHint: string;
  /** Whether it is signed in, asked of the CLI itself. Only set for an installed agent. */
  signedIn?: SignInState;
  /** Puff can start this agent's sign-in (opens the browser) */
  canSignIn?: boolean;
}

/** signed-in / signed-out as the CLI says; unknown when the CLI has no cheap way to tell */
export type SignInState = 'signed-in' | 'signed-out' | 'unknown';

/** Which program a terminal runs: one of the agents' own CLIs, or a plain shell */
export type TerminalCli = AgentName | 'shell';

/** A terminal opened in a task's working folder */
export interface TerminalInfo {
  id: string;
  taskId: string;
  cli: TerminalCli;
  title: string;
  /** The working folder (a git worktree of the project) */
  cwd: string;
  /** Where the folder started: the agent's last attempt, or the current code */
  startedFrom: string;
  /** The folder was already there from an earlier take-over and holds the person's own work */
  reused: boolean;
  /** A short message saying what the task is and what was tried, to paste into the CLI if the person wants to */
  brief: string;
}

/** What happened when the person's own changes were checked and merged */
export interface ManualResult {
  status: 'done' | 'failed';
  message: string;
}

/** What the first-run setup screen shows */
export interface SetupStatus {
  databaseOk: boolean;
  databaseUrl: string;
  databaseError?: string;
  /** missing = no docker command, stopped = Docker is installed but not running, ready = Puff can start the database */
  docker: 'missing' | 'stopped' | 'ready';
  agents: AgentCliStatus[];
  /** Where Puff keeps its files (projects, settings) */
  homePath: string;
}

export type ChatRole = 'user' | 'assistant' | 'system' | 'action' | 'approval';

/** Something the orchestrator asks the person to approve before it happens (running the team spends tokens). */
export interface ChatApproval {
  id: string;
  summary: string;
  state: 'pending' | 'approved' | 'declined';
}

/** One line of the conversation with the orchestrator. */
export interface ChatMessage {
  id: string;
  at: number;
  /** `action` is something the orchestrator did with a tool, shown as a card; `system` is a slash command's answer */
  role: ChatRole;
  text: string;
  /** For an action or a command: whether it worked */
  ok?: boolean;
  /** The tool behind an action */
  tool?: string;
  /** Tokens the agent spent on this reply */
  tokens?: { in: number; out: number };
  approval?: ChatApproval;
}

/** What the chat is powered by, and whether it can answer plain sentences right now. */
export interface ChatInfo {
  /** The agent behind plain sentences, e.g. "Claude Code" */
  brain: string;
  /** Slash commands always work; this says whether the agent can be asked (it is installed) */
  ready: boolean;
  note?: string;
  /** The agent is installed but not signed in: the chat offers a Sign in button */
  needsSignIn?: boolean;
  /** Runs the orchestrator asks for start without asking the person first */
  autoApprove: boolean;
  /** Which agent is answering (absent in a bare test session) */
  agent?: AgentName;
  /** The agents to choose from */
  choices?: ChatChoice[];
}

/** One agent the person can pick to talk to in Ask Puff */
export interface ChatChoice {
  id: AgentName;
  label: string;
  installed: boolean;
}

/** What a person can change about a task that is not being worked on. */
export interface TaskEditInput {
  title?: string;
  complexity?: Complexity;
  /** `null` goes back to routing by strengths and past results */
  preferredAgent?: AgentName | null;
  /** `null` uses the agent's own model */
  model?: string | null;
  /** Symbol ids or unique function names; replaces the current targets */
  targets?: string[];
}

/** What a task changed, read from git. */
export interface TaskDiffInfo {
  /** `merge`: the commit that landed it. `attempt`: the newest attempt that was kept, never merged. */
  source: 'merge' | 'attempt';
  ref: string;
  label: string;
  files: string[];
  diff: string;
}

/** A project Puff knows about: a repository, its graph, and the settings that differ per project. */
export interface ProjectSummary {
  /** The slug: also the graph name suffix (`puff_<id>`) */
  id: string;
  name: string;
  repoPath: string;
  active: boolean;
  /** The folder no longer exists */
  missing: boolean;
  /** Overrides the default test command for this project */
  testCommand?: string;
  /** Overrides which folders are linked into task worktrees */
  linkDirs?: string[];
  addedAt: number;
  /** Counts from the project's graph; absent when it could not be read */
  files?: number;
  symbols?: number;
  tasks?: number;
}

/** What Puff found out about a folder before it is added as a project. */
export interface RepoInspection {
  /** Absolute path that was inspected */
  path: string;
  /** Folder name, the default project name */
  name: string;
  exists: boolean;
  isDirectory: boolean;
  git: {
    isRepo: boolean;
    /** The folder is the top of its own repository (needed for agent runs) */
    isRoot: boolean;
    /** The top of the repository the folder is inside, when it is inside one */
    root?: string;
    hasCommits: boolean;
    /** Uncommitted changes in the main checkout: a task merge would be refused */
    dirty: boolean;
    branch?: string;
  };
  /** From package.json: what verification would run */
  testCommand?: string;
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
  /** The folder holding the app's package.json, relative to the project ('' when it is the project itself) */
  appDir?: string;
  /** Dependency folders to link into agents' worktrees when the app is in a subfolder */
  linkDirs?: string[];
  hasNodeModules: boolean;
  files: {
    /** Source files Puff can read (TypeScript and JavaScript) */
    supported: number;
    /** Files in languages Puff cannot read yet, by extension (e.g. py, go) */
    unsupported: Record<string, number>;
  };
  /** Stops the folder from being added */
  problems: string[];
  /** Allows adding, but agents cannot run until it is fixed */
  runBlockers: string[];
  warnings: string[];
  /** Puff can run `git init` and make a first commit here if the person agrees */
  canInitGit: boolean;
}

/** A task proposed by the planner, or requested by any agent that noticed more work is needed. */
export interface PlannedTask {
  title: string;
  /** Defaults to implement */
  type?: TaskType;
  complexity?: Complexity;
  /** Function names from the code map, or `path::name` symbol ids */
  targets?: string[];
  /** 0-based positions of EARLIER tasks in the same list that must finish first */
  dependsOn?: number[];
}

/** Structured block agents append to their final answer: <puff-report>{...}</puff-report> */
export interface PuffReport {
  decisions?: { symbol: string; text: string; supersedes?: string }[];
  notes?: string;
  /** A plan (from the planner) or follow-up work (from any agent). Puff creates the tasks. */
  tasks?: PlannedTask[];
  /** Notes for whoever works next on this task or the tasks that depend on it */
  handoffs?: { toRole?: string; summary: string }[];
}
