import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { BackendInfo, GraphData, PuffApi, PuffEvent } from '@puff/shared';
import { neighbourhood } from '@puff/shared';
import { createMockApi } from '@puff/shared/mocks';
import {
  agentProfiles,
  connect,
  createTask,
  exportGraph,
  getContextPack,
  getMemoryFeed,
  getTask,
  getWhy,
  graphName,
  indexRepo,
  initProjectGraph,
  isSeeded,
  listSessions,
  listTasks,
  loadConfig,
  loadDotEnv,
  read,
  slugify,
  type ProjectInfo,
  type PuffConfig,
} from '@puff/core';
import type { FalkorDB, Graph } from 'falkordb';

/**
 * Parts of the API still served from mocks in live mode. Shrinks phase by phase:
 * P3 brings the orchestrator (agents actually run), P6 the benchmark behind the savings numbers.
 */
const STILL_MOCKED = ['orchestrator: agents start running in P3', 'savings'];

/** The Puff repo root: the nearest folder (from cwd or the app) that holds puff.config.yaml. */
function findRoot(appDir: string): string {
  for (const start of [process.cwd(), appDir]) {
    for (let dir = resolve(start); ; dir = dirname(dir)) {
      if (existsSync(join(dir, 'puff.config.yaml'))) return dir;
      if (dirname(dir) === dir) break;
    }
  }
  return process.cwd();
}

/**
 * The PuffApi the main process serves over IPC.
 * Phase P2: the code graph, tasks, sessions, memory, context packs and "Why?" are live from
 * FalkorDB. Agents do not run yet (P3), so Start is disabled in the UI and savings are mocked.
 * If FalkorDB is unreachable the whole API falls back to mocks and says why.
 */
export async function createBackend(appDir: string): Promise<PuffApi> {
  const mock = createMockApi();
  const root = findRoot(appDir);
  loadDotEnv(join(root, '.env'));

  let db: FalkorDB;
  let graph: Graph;
  let project: ProjectInfo;
  let config: PuffConfig;
  try {
    config = await loadConfig(join(root, process.env.PUFF_CONFIG ?? 'puff.config.yaml'));
    const repoPath = resolve(root, process.env.PUFF_REPO ?? 'demo/shop-api');
    project = {
      slug: slugify(process.env.PUFF_PROJECT ?? basename(repoPath)),
      name: basename(repoPath),
      repoPath,
    };
    db = await connect();
    graph = await initProjectGraph(db, project, config);
    const rows = await read<{ files: number }>(graph, 'MATCH (f:File) RETURN count(f) AS files');
    if ((rows[0]?.files ?? 0) === 0) await indexRepo(graph, project);
  } catch (err) {
    const error = (err as Error).message;
    console.error(`[puff] live backend unavailable, using mocks: ${error}`);
    return {
      ...mock,
      async getBackendInfo(): Promise<BackendInfo> {
        return { ...(await mock.getBackendInfo()), error };
      },
    };
  }

  const listeners = new Set<(e: PuffEvent) => void>();
  const emit = (e: PuffEvent) => listeners.forEach((cb) => cb(e));

  return {
    // Mock-backed until the orchestrator lands: createGoal's planner, start/stop, savings.
    ...mock,

    async getBackendInfo(): Promise<BackendInfo> {
      return {
        mode: 'live',
        projectId: project.slug,
        projectName: project.name,
        repoPath: project.repoPath,
        graphName: graphName(project.slug),
        mockParts: STILL_MOCKED,
        seeded: await isSeeded(graph),
      };
    },

    async openProject(repoPath: string) {
      const abs = resolve(repoPath);
      project = { slug: slugify(basename(abs)), name: basename(abs), repoPath: abs };
      graph = await initProjectGraph(db, project, config);
      return { projectId: project.slug };
    },
    async indexProject() {
      const s = await indexRepo(graph, project);
      return { files: s.files, symbols: s.symbols, calls: s.calls };
    },
    async getGraph(_projectId, focusId, depth): Promise<GraphData> {
      const full = await exportGraph(graph);
      return focusId ? neighbourhood(full, focusId, depth) : full;
    },

    async listTasks() {
      return listTasks(graph);
    },
    async createTask(_projectId, t) {
      const task = await createTask(graph, project.slug, config, {
        title: t.title ?? 'Untitled task',
        type: t.type,
        complexity: t.complexity,
        targets: t.targets,
        dependsOn: t.dependsOn,
      });
      emit({ type: 'task:update', task });
      return task;
    },
    /** Until the planner agent exists (P4), a goal becomes one planning task. */
    async createGoal(_projectId, goal) {
      const task = await createTask(graph, project.slug, config, {
        title: `Plan: ${goal}`,
        type: 'plan',
        complexity: 'high',
      });
      emit({ type: 'task:update', task });
      return [task];
    },
    async getTask(taskId) {
      const task = await getTask(graph, taskId);
      if (!task) throw new Error(`Unknown task ${taskId}`);
      return { task, sessions: await listSessions(graph, taskId) };
    },
    async getContextPack(sessionId) {
      const pack = await getContextPack(graph, sessionId);
      if (!pack) throw new Error('No context was recorded for this session');
      return pack;
    },
    async getWhy(taskId) {
      return getWhy(graph, taskId);
    },
    async getMemoryFeed(_projectId, limit) {
      return getMemoryFeed(graph, limit);
    },
    async listAgents() {
      return agentProfiles(graph, config);
    },

    // Agents do not run yet, so there is nothing to start or stop.
    async start() {},
    async stop() {},
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
