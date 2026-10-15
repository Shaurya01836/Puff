import type {
  AgentProfile,
  BackendInfo,
  ContextPack,
  GraphData,
  MemoryEvent,
  PuffEvent,
  Savings,
  SessionInfo,
  Task,
  WhyPath,
} from './types';

/**
 * The API the UI talks to. In Electron it is exposed by the preload script as `window.puff`;
 * in the browser-only dev mode (`npm run dev:web`) the renderer falls back to the mock implementation.
 */
export interface PuffApi {
  /** Live or mock, current project, and which parts are still mocked */
  getBackendInfo(): Promise<BackendInfo>;
  openProject(repoPath: string): Promise<{ projectId: string }>;
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
  'openProject',
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
