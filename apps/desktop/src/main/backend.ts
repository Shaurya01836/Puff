import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { BackendInfo, GraphData, PuffApi, PuffEvent } from '@puff/shared';
import { neighbourhood } from '@puff/shared';
import { createMockApi } from '@puff/shared/mocks';
import {
  Orchestrator,
  agentProfiles,
  connect,
  createRunDeps,
  createTask,
  exportGraph,
  getContextPack,
  getMemoryFeed,
  getTask,
  getTeamTimeline,
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
  type OrchestratorDeps,
  type ProjectInfo,
  type PuffConfig,
  type TaskRunResult,
} from '@puff/core';
import type { FalkorDB, Graph } from 'falkordb';

/** Parts of the API still served from mocks in live mode. The benchmark (P6) replaces the last one. */
const STILL_MOCKED = ['savings'];

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

/** One line describing how a run ended, and whether it went well. */
function summarizeRun(results: TaskRunResult[]): {
  message: string;
  tone: 'good' | 'warn' | 'bad';
} {
  if (results.length === 0) return { message: 'Nothing to run: no ready tasks.', tone: 'warn' };
  const done = results.filter((r) => r.status === 'done').length;
  const failed = results.filter((r) => r.status === 'failed');
  const attempts = results.reduce((n, r) => n + r.attempts.length, 0);
  const base = `${done}/${results.length} task(s) done in ${attempts} agent run(s)`;
  if (failed.length === 0) return { message: base, tone: 'good' };
  return {
    message: `${base}. Failed: ${failed[0]!.reason ?? 'see the board'}`,
    tone: done ? 'warn' : 'bad',
  };
}

/**
 * The PuffApi the main process serves over IPC.
 * Phase P3: everything is live from FalkorDB, and Run team really runs the agents. Only the
 * savings numbers are still mock data (P6). If FalkorDB is unreachable the whole API falls back
 * to mocks and says why.
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

  // Agents can only run when the project is its own git repository; say why if it is not.
  let runDeps: OrchestratorDeps | undefined;
  let runBlocked: string | undefined;
  let orchestrator: Orchestrator | undefined;
  const prepareRun = async () => {
    runDeps = undefined;
    runBlocked = undefined;
    orchestrator = undefined;
    try {
      runDeps = await createRunDeps({
        graph,
        project,
        config,
        emit,
        log: (line) => console.log(`[puff] ${line}`),
      });
    } catch (err) {
      runBlocked = (err as Error).message;
    }
  };
  await prepareRun();

  return {
    // The savings numbers stay mock until the benchmark (P6).
    ...mock,

    async getBackendInfo(): Promise<BackendInfo> {
      return {
        mode: 'live',
        projectId: project.slug,
        projectName: project.name,
        repoPath: project.repoPath,
        graphName: graphName(project.slug),
        mockParts: STILL_MOCKED,
        runBlocked,
        seeded: await isSeeded(graph),
      };
    },

    async openProject(repoPath: string) {
      const abs = resolve(repoPath);
      project = { slug: slugify(basename(abs)), name: basename(abs), repoPath: abs };
      graph = await initProjectGraph(db, project, config);
      await prepareRun();
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
        preferredAgent: t.preferredAgent,
        model: t.model,
      });
      emit({ type: 'task:update', task });
      return task;
    },
    /** A goal becomes a planning task; when the team runs, the planner agent splits it into tasks. */
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
    async getTeamTimeline(_projectId, limit) {
      return getTeamTimeline(graph, limit);
    },

    /** Run the ready tasks. Returns at once; progress arrives as events, and a `run` event says how it ended. */
    async start() {
      if (!runDeps) throw new Error(runBlocked ?? 'Agents cannot run for this project');
      if (orchestrator?.running) return;
      const o = (orchestrator = new Orchestrator(runDeps));
      emit({ type: 'run', running: true });
      o.start().then(
        (results) => emit({ type: 'run', running: false, ...summarizeRun(results) }),
        (err: Error) => emit({ type: 'run', running: false, message: err.message, tone: 'bad' }),
      );
    },
    async stop() {
      await orchestrator?.stop();
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
