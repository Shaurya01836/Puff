import type {
  AgentProfile,
  BackendInfo,
  ContextPack,
  GraphData,
  MemoryEvent,
  ProjectSummary,
  PuffEvent,
  RepoInspection,
  Savings,
  SessionInfo,
  Task,
  TeamEvent,
  WhyPath,
} from './types';

/**
 * The API the UI talks to. In Electron it is exposed by the preload script as `window.puff`;
 * in the browser-only dev mode (`npm run dev:web`) the renderer falls back to the mock implementation.
 */
export interface PuffApi {
  /** Live or mock, current project, and which parts are still mocked */
  getBackendInfo(): Promise<BackendInfo>;
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
  getContextPack(sessionId: string): Promise<ContextPack>;
  getWhy(taskId: string): Promise<WhyPath>;
  getGraph(projectId: string, focusId?: string, depth?: number): Promise<GraphData>;
  getMemoryFeed(projectId: string, limit?: number): Promise<MemoryEvent[]>;
  listAgents(projectId: string): Promise<AgentProfile[]>;
  /** Who worked on what, who handed what to whom, which agent asked for which task. Newest first. */
  getTeamTimeline(projectId: string, limit?: number): Promise<TeamEvent[]>;
  getSavings(projectId: string): Promise<Savings>;
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
  'getContextPack',
  'getWhy',
  'getGraph',
  'getMemoryFeed',
  'listAgents',
  'getTeamTimeline',
  'getSavings',
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
