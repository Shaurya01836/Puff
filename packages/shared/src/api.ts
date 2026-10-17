import type {
  AgentName,
  AgentProfile,
  BackendInfo,
  ChatInfo,
  ChatMessage,
  ContextPack,
  GraphData,
  GraphTrace,
  MergePreview,
  PlanPreview,
  ManualResult,
  MemoryEvent,
  MemoryItem,
  ProjectSummary,
  PuffEvent,
  RepoInspection,
  Savings,
  SetupStatus,
  SessionInfo,
  Task,
  TaskDiffInfo,
  TaskEditInput,
  TeamEvent,
  TerminalCli,
  TerminalInfo,
  WhyPath,
} from './types';

/**
 * The API the UI talks to. In Electron it is exposed by the preload script as `window.puff`;
 * in the browser-only dev mode (`npm run dev:web`) the renderer falls back to the mock implementation.
 */
export interface PuffApi {
  /** Live or mock, current project, and which parts are still mocked */
  getBackendInfo(): Promise<BackendInfo>;
  /** What Puff needs to run (database, Docker, agent CLIs) and which of it is in place */
  getSetupStatus(): Promise<SetupStatus>;
  /** Start FalkorDB in Docker (the person pressed the button), then connect. Rejects with a readable reason. */
  startDatabase(): Promise<SetupStatus>;
  /** Try to connect again, for example after the person started the database themselves */
  retrySetup(): Promise<SetupStatus>;
  /**
   * Start an agent's own sign-in: it opens the browser on the provider's login page. Puff never sees the
   * password. The result says where to go if the browser did not open; the end arrives as a `signin` event.
   */
  startSignIn(agent: AgentName): Promise<{ url?: string }>;
  /** The one-time code some sign-ins show in the browser, given to the sign-in that is waiting for it */
  submitSignInCode(code: string): Promise<void>;
  /** Every project Puff knows about, the active one marked */
  listProjects(): Promise<ProjectSummary[]>;
  /** What Puff finds in a folder, before it is added: problems, what blocks agents, warnings */
  inspectProject(repoPath: string): Promise<RepoInspection>;
  /**
   * Add a folder as a project, index it, and make it the active project. With `initGit`, a folder that is
   * not a git repository (or has no commits) first gets `git init` and a first commit: the person agreed.
   */
  addProject(input: {
    repoPath: string;
    name?: string;
    testCommand?: string;
    initGit?: boolean;
  }): Promise<ProjectSummary>;
  /** Make another project the active one. Refused while agents are running. */
  switchProject(projectId: string): Promise<void>;
  updateProject(
    projectId: string,
    patch: { name?: string; testCommand?: string | null; linkDirs?: string[] | null },
  ): Promise<ProjectSummary>;
  /** Forget a project; its folder is never touched. `deleteMemory` also deletes its graph. */
  removeProject(projectId: string, opts?: { deleteMemory?: boolean }): Promise<void>;
  /** Ask the person for a folder (the system dialog). Undefined when they cancel or there is no dialog. */
  pickDirectory(): Promise<string | undefined>;
  indexProject(projectId: string): Promise<{ files: number; symbols: number; calls: number }>;
  listTasks(projectId: string): Promise<Task[]>;
  /** Planner splits a goal into tasks */
  createGoal(projectId: string, goal: string): Promise<Task[]>;
  createTask(projectId: string, t: Partial<Task>): Promise<Task>;
  getTask(taskId: string): Promise<{ task: Task; sessions: SessionInfo[] }>;
  /** Put a failed task back in the queue; its earlier attempts stay in its history */
  retryTask(taskId: string): Promise<Task>;
  /** Change a planned, ready or failed task */
  editTask(taskId: string, edit: TaskEditInput): Promise<Task>;
  /** Delete a task that never ran; a task with history, or that others wait for, stays */
  removeTask(taskId: string): Promise<void>;
  /** What a task changed: the commit that merged it, or its newest kept attempt. Undefined if it changed nothing yet. */
  getTaskDiff(taskId: string): Promise<TaskDiffInfo | undefined>;
  getContextPack(sessionId: string): Promise<ContextPack | undefined>;
  getWhy(taskId: string): Promise<WhyPath>;
  /** The queries behind each decision Puff made for this task (route, context, schedule, stale, locate), newest first */
  getTraces(taskId: string): Promise<GraphTrace[]>;
  /** What merging this task would change in the graph, found on a copy before the merge */
  getMergePreview(taskId: string): Promise<MergePreview | undefined>;
  /** For a plan: how its tasks would run (which start together, which wait and why), on a copy */
  getPlanPreview(taskId: string): Promise<PlanPreview | undefined>;
  getGraph(projectId: string, focusId?: string, depth?: number): Promise<GraphData>;
  getMemoryFeed(projectId: string, limit?: number): Promise<MemoryEvent[]>;
  /** Everything the team learned (failures, fixes, decisions, procedures), newest first, with state and trust */
  listMemory(projectId: string): Promise<MemoryItem[]>;
  listAgents(projectId: string): Promise<AgentProfile[]>;
  /** Who worked on what, who handed what to whom, which agent asked for which task. Newest first. */
  getTeamTimeline(projectId: string, limit?: number): Promise<TeamEvent[]>;
  getSavings(projectId: string): Promise<Savings>;
  /** What the chat is powered by, and whether plain sentences can be answered */
  chatInfo(): Promise<ChatInfo>;
  /** The conversation so far, oldest first */
  chatHistory(): Promise<ChatMessage[]>;
  /**
   * Say something. A slash command answers at once; anything else goes to the orchestrator agent.
   * Resolves when the reply is complete; every message also arrives as a `chat` event as it happens.
   */
  chatSend(text: string): Promise<void>;
  /** Answer a request the orchestrator made, such as running the team */
  chatApprove(approvalId: string, approve: boolean): Promise<void>;
  /** Start a fresh conversation */
  chatReset(): Promise<void>;
  /** Talk to a different agent in Ask Puff (remembered for next time). Starts a fresh conversation. */
  chatSetAgent(agent: AgentName): Promise<ChatInfo>;
  /** Stop one task: its agent is killed and it shows as failed, ready to retry. The rest of the team goes on. */
  stopTask(taskId: string): Promise<Task>;
  /** Give a task to another agent (and model): stops it if it runs, puts it back in the queue */
  reassignTask(taskId: string, agent: AgentName, model?: string): Promise<Task>;
  /** The person did this task themselves: mark it done so what waits for it can go on */
  markTaskDone(taskId: string, note?: string): Promise<Task>;
  /** A note the next attempt on this task must follow. An empty note removes it. */
  addTaskNote(taskId: string, note: string): Promise<Task>;
  /** Finish the tasks that are running, start nothing new. False when the team is not running. */
  pauseTeam(): Promise<boolean>;
  /**
   * Take a task over: its agent is stopped, and a real terminal opens in a working folder that starts from the
   * agent's last attempt, running that agent's own CLI (or a shell). Output arrives as `terminal` events.
   */
  openTerminal(input: {
    taskId: string;
    cli: TerminalCli;
    /**
     * Start the program on the task straight away: its first message is the task brief, so it begins working in
     * its own screen (and spends tokens). Without it the program opens idle and waits for the person.
     */
    start?: boolean;
  }): Promise<TerminalInfo>;
  terminalWrite(id: string, data: string): Promise<void>;
  terminalResize(id: string, cols: number, rows: number): Promise<void>;
  /** What a terminal has printed so far (a window that opens late catches up), and where that ends. Events with an `end` at or before it are already in it. */
  terminalAttach(id: string): Promise<{ data: string; end: number }>;
  closeTerminal(id: string): Promise<void>;
  /** Show the person's working folder for a task in the file explorer */
  openTaskFolder(taskId: string): Promise<void>;
  /** Check the person's own changes with the project's tests, merge them, re-test the combined result */
  landManualChanges(taskId: string): Promise<ManualResult>;
  start(projectId: string): Promise<void>;
  stop(projectId: string): Promise<void>;
  /** Subscribe to live events; returns an unsubscribe function */
  onEvent(cb: (e: PuffEvent) => void): () => void;
}

/** Request/response methods of PuffApi (everything except the event subscription). */
export type PuffInvokeMethod = Exclude<keyof PuffApi, 'onEvent'>;

/** Every invoke method, used by preload and main to wire IPC without listing channels twice. */
export const PUFF_INVOKE_METHODS = [
  'getBackendInfo',
  'getSetupStatus',
  'startDatabase',
  'retrySetup',
  'startSignIn',
  'submitSignInCode',
  'listProjects',
  'inspectProject',
  'addProject',
  'switchProject',
  'updateProject',
  'removeProject',
  'pickDirectory',
  'indexProject',
  'listTasks',
  'createGoal',
  'createTask',
  'getTask',
  'retryTask',
  'editTask',
  'removeTask',
  'getTaskDiff',
  'getContextPack',
  'getWhy',
  'getTraces',
  'getMergePreview',
  'getPlanPreview',
  'getGraph',
  'getMemoryFeed',
  'listMemory',
  'listAgents',
  'getTeamTimeline',
  'getSavings',
  'chatInfo',
  'chatHistory',
  'chatSend',
  'chatApprove',
  'chatReset',
  'chatSetAgent',
  'stopTask',
  'reassignTask',
  'markTaskDone',
  'addTaskNote',
  'pauseTeam',
  'openTerminal',
  'terminalWrite',
  'terminalResize',
  'terminalAttach',
  'closeTerminal',
  'openTaskFolder',
  'landManualChanges',
  'start',
  'stop',
] as const satisfies readonly PuffInvokeMethod[];

// Compile-time check that the list above covers every invoke method.
type _MissingMethods = Exclude<PuffInvokeMethod, (typeof PUFF_INVOKE_METHODS)[number]>;
const _allMethodsListed: _MissingMethods extends never ? true : _MissingMethods = true;
void _allMethodsListed;

export const IPC_PREFIX = 'puff:';
export const IPC_EVENT_CHANNEL = 'puff:event';
export const ipcChannel = (method: PuffInvokeMethod): string => `${IPC_PREFIX}${method}`;
