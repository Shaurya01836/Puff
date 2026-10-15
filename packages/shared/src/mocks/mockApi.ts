// In-memory PuffApi backed by fixtures. Used by the UI until the real backend lands,
// and by `npm run dev:web` so the renderer runs in a plain browser.
import type { PuffApi } from '../api';
import type { MemoryEvent, PuffEvent, Task, TaskStatus } from '../types';
import {
  MOCK_PROJECT_ID,
  mockAgents,
  mockContextPack,
  mockMemoryEvents,
  mockSavings,
  mockSessions,
  mockTasks,
  mockWhy,
} from './fixtures';
import { mockGraph, neighbourhood } from './graph';

/** Next status in the happy path, used by the live simulation after `start()` */
const NEXT_STATUS: Partial<Record<TaskStatus, TaskStatus>> = {
  planned: 'ready',
  ready: 'running',
  running: 'verifying',
  verifying: 'done',
  failed: 'retrying',
  retrying: 'running',
  escalated: 'running',
};

const clone = <T>(v: T): T => structuredClone(v);

export interface MockApiOptions {
  /** Milliseconds between simulated events after `start()` (default 2500) */
  tickMs?: number;
}

export function createMockApi(opts: MockApiOptions = {}): PuffApi {
  const tickMs = opts.tickMs ?? 2500;
  const tasks = clone(mockTasks);
  const feed = clone(mockMemoryEvents);
  const listeners = new Set<(e: PuffEvent) => void>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let seq = 100;

  const emit = (e: PuffEvent) => listeners.forEach((cb) => cb(e));
  const findTask = (id: string) => {
    const t = tasks.find((x) => x.id === id);
    if (!t) throw new Error(`Unknown task ${id}`);
    return t;
  };
  const newTask = (p: Partial<Task>): Task => {
    const now = Date.now();
    return {
      id: `task_${++seq}`,
      title: p.title ?? 'Untitled task',
      type: p.type ?? 'implement',
      complexity: p.complexity ?? 'medium',
      status: 'planned',
      targets: p.targets ?? [],
      dependsOn: p.dependsOn ?? [],
      createdAt: now,
      updatedAt: now,
      ...p,
    };
  };

  const tick = () => {
    const candidates = tasks.filter((t) => NEXT_STATUS[t.status]);
    const t = candidates[Math.floor(Math.random() * candidates.length)];
    if (!t) return;
    t.status = NEXT_STATUS[t.status]!;
    t.updatedAt = Date.now();
    if (t.status === 'ready') delete t.blockedBy;
    emit({ type: 'task:update', task: clone(t) });
    if (t.status === 'done') {
      const event: MemoryEvent = {
        id: `evt_${++seq}`,
        at: Date.now(),
        type: 'memory_stale',
        text: `Re-indexed files changed by ${t.id}`,
        refs: [t.id],
      };
      feed.unshift(event);
      emit({ type: 'memory', event });
    }
  };

  return {
    async getBackendInfo() {
      return {
        mode: 'mock',
        projectId: MOCK_PROJECT_ID,
        projectName: 'shop-api',
        mockParts: ['everything'],
      };
    },
    async openProject() {
      return { projectId: MOCK_PROJECT_ID };
    },
    async indexProject() {
      const symbols = mockGraph.nodes.filter((n) => n.kind === 'Symbol').length;
      const files = mockGraph.nodes.filter((n) => n.kind === 'File').length;
      const calls = mockGraph.edges.filter((e) => e.type === 'CALLS').length;
      return { files, symbols, calls };
    },
    async listTasks() {
      return clone(tasks);
    },
    async createGoal(_projectId, goal) {
      const plan = newTask({
        title: `Plan: ${goal}`,
        type: 'plan',
        complexity: 'high',
        role: 'planner',
      });
      const impl = newTask({ title: `Implement: ${goal}`, dependsOn: [plan.id], role: 'coder' });
      const verify = newTask({
        title: `Verify: ${goal}`,
        type: 'verify',
        dependsOn: [impl.id],
        role: 'verifier',
      });
      const created = [plan, impl, verify];
      tasks.push(...created);
      created.forEach((task) => emit({ type: 'task:update', task: clone(task) }));
      return clone(created);
    },
    async createTask(_projectId, t) {
      const task = newTask(t);
      tasks.push(task);
      emit({ type: 'task:update', task: clone(task) });
      return clone(task);
    },
    async getTask(taskId) {
      return {
        task: clone(findTask(taskId)),
        sessions: clone(mockSessions.filter((s) => s.taskId === taskId)),
      };
    },
    async getContextPack(sessionId) {
      return { ...clone(mockContextPack), sessionId };
    },
    async getWhy() {
      return clone(mockWhy);
    },
    async getGraph(_projectId, focusId, depth) {
      return clone(focusId ? neighbourhood(mockGraph, focusId, depth) : mockGraph);
    },
    async getMemoryFeed(_projectId, limit = 50) {
      return clone(feed.slice(0, limit));
    },
    async listAgents() {
      return clone(mockAgents);
    },
    async getSavings() {
      return clone(mockSavings);
    },
    async start() {
      if (!timer) timer = setInterval(tick, tickMs);
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
