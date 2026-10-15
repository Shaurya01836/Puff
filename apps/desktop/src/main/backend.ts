import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  BackendInfo,
  GraphData,
  ProjectSummary,
  PuffApi,
  PuffEvent,
  RepoInspection,
} from '@puff/shared';
import { neighbourhood } from '@puff/shared';
import { createMockApi } from '@puff/shared/mocks';
import {
  Orchestrator,
  activeProject,
  addProject as addToRegistry,
  agentProfiles,
  applyProject,
  connect,
  createRunDeps,
  createTask,
  deleteProjectMemory,
  exportGraph,
  findConfigFile,
  getContextPack,
  getMemoryFeed,
  getTask,
  getTeamTimeline,
  getWhy,
  graphName,
  indexRepo,
  initRepo,
  inspectRepo,
  isSeeded,
  listSessions,
  listTasks,
  loadBenchResults,
  loadConfig,
  loadDotEnv,
  loadRegistry,
  openProject,
  projectCounts,
  removeProject as removeFromRegistry,
  savingsFromBench,
  setActiveProject,
  updateProject as updateInRegistry,
  type OrchestratorDeps,
  type ProjectEntry,
  type ProjectInfo,
  type PuffConfig,
  type TaskRunResult,
} from '@puff/core';
import type { FalkorDB, Graph } from 'falkordb';

/** Parts of the API served from mocks in live mode: the savings, until bench/results.json exists. */
const benchPath = (root: string) => join(root, process.env.PUFF_BENCH ?? 'bench/results.json');

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

/** What only the Electron main process can do. */
export interface BackendHooks {
  /** Show the system "choose a folder" dialog */
  pickDirectory?: () => Promise<string | undefined>;
}

/** The project that is open: its graph, its settings on top of the shared config, and how agents run on it. */
interface OpenProject {
  entry: ProjectEntry;
  project: ProjectInfo;
  graph: Graph;
  config: PuffConfig;
  runDeps?: OrchestratorDeps;
  runBlocked?: string;
  orchestrator?: Orchestrator;
}

const NO_PROJECT = 'No project is open. Add one first.';

/**
 * The PuffApi the main process serves over IPC.
 * Everything is live from FalkorDB, and Run team really runs the agents. The savings numbers
 * are real once `puff bench` has written bench/results.json, and mock data until then. If FalkorDB
 * is unreachable the whole API falls back to mocks and says why.
 *
 * Projects come from ~/.puff/projects.json (shared with the `puff` CLI). One is active at a time;
 * switching is refused while agents are running.
 */
export async function createBackend(appDir: string, hooks: BackendHooks = {}): Promise<PuffApi> {
  const mock = createMockApi();
  const root = findRoot(appDir);
  loadDotEnv(join(root, '.env'));

  const listeners = new Set<(e: PuffEvent) => void>();
  const emit = (e: PuffEvent) => listeners.forEach((cb) => cb(e));

  let db: FalkorDB;
  let userConfig: PuffConfig;
  let current: OpenProject | undefined;

  /** Agents can only run when the project is its own git repository; say why if it is not. */
  const prepareRun = async (p: OpenProject) => {
    p.runDeps = undefined;
    p.runBlocked = undefined;
    p.orchestrator = undefined;
    try {
      p.runDeps = await createRunDeps({
        graph: p.graph,
        project: p.project,
        config: p.config,
        emit,
        log: (line) => console.log(`[puff] ${line}`),
      });
    } catch (err) {
      p.runBlocked = (err as Error).message;
    }
  };

  const open = async (entry: ProjectEntry): Promise<OpenProject> => {
    if (!existsSync(entry.repoPath))
      throw new Error(
        `The folder ${entry.repoPath} no longer exists. Remove the project or restore the folder.`,
      );
    const opened = await openProject(db, entry, userConfig);
    const next: OpenProject = {
      entry,
      project: opened.project,
      graph: opened.graph,
      config: opened.config,
    };
    await prepareRun(next);
    return next;
  };

  /**
   * The project to start on: the one the person last used. When there is none, a development
   * checkout of Puff starts on $PUFF_REPO or its bundled demo; an installed app starts empty.
   */
  const startingProject = async (): Promise<ProjectEntry | undefined> => {
    const active = activeProject(await loadRegistry());
    if (active) return active;
    const seed = process.env.PUFF_REPO
      ? resolve(root, process.env.PUFF_REPO)
      : join(root, 'demo/shop-api');
    if (!existsSync(join(seed, 'package.json'))) return undefined;
    const info = await inspectRepo(seed);
    const { entry } = await addToRegistry({
      repoPath: seed,
      name: process.env.PUFF_PROJECT,
      testCommand: info.testCommand,
    });
    return entry;
  };

  try {
    const configFile = findConfigFile([root, appDir, process.cwd()]);
    if (!configFile)
      throw new Error('No Puff configuration found (puff.config.yaml or ~/.puff/config.yaml)');
    userConfig = await loadConfig(configFile);
    db = await connect();
    const entry = await startingProject();
    current = entry ? await open(entry) : undefined;
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

  const need = (): OpenProject => {
    if (!current) throw new Error(NO_PROJECT);
    return current;
  };

  const refuseWhileRunning = (action: string) => {
    if (current?.orchestrator?.running)
      throw new Error(`Agents are running. Stop them before you ${action}.`);
  };

  const summary = async (entry: ProjectEntry, activeSlug?: string): Promise<ProjectSummary> => ({
    id: entry.slug,
    name: entry.name,
    repoPath: entry.repoPath,
    active: entry.slug === activeSlug,
    missing: !existsSync(entry.repoPath),
    testCommand: entry.testCommand,
    linkDirs: entry.linkDirs,
    addedAt: entry.addedAt,
    ...(await projectCounts(db, entry.slug)),
  });

  /** Make `entry` the open project and remember it for next time. */
  const activate = async (entry: ProjectEntry) => {
    refuseWhileRunning('switch projects');
    current = await open(entry);
    await setActiveProject(entry.slug);
    emit({ type: 'project', projectId: entry.slug });
  };

  return {
    // Everything not overridden below is a mock; the savings are real once `puff bench` has run.
    ...mock,

    async getSavings() {
      const results = await loadBenchResults(benchPath(root));
      return results ? savingsFromBench(results) : mock.getSavings('');
    },

    async getBackendInfo(): Promise<BackendInfo> {
      const mockParts = (await loadBenchResults(benchPath(root))) ? [] : ['savings'];
      if (!current)
        return { mode: 'live', projectId: '', projectName: '', mockParts, noProject: true };
      return {
        mode: 'live',
        projectId: current.entry.slug,
        projectName: current.entry.name,
        repoPath: current.entry.repoPath,
        graphName: graphName(current.entry.slug),
        mockParts,
        runBlocked: current.runBlocked,
        seeded: await isSeeded(current.graph),
      };
    },

    // ---- projects ----------------------------------------------------------------------------
    async listProjects() {
      const reg = await loadRegistry();
      return Promise.all(reg.projects.map((p) => summary(p, current?.entry.slug ?? reg.active)));
    },
    async inspectProject(repoPath: string): Promise<RepoInspection> {
      return inspectRepo(repoPath);
    },
    async addProject({ repoPath, name, testCommand, initGit }) {
      let info = await inspectRepo(repoPath);
      if (info.problems.length) throw new Error(info.problems[0]);
      refuseWhileRunning('add a project');
      if (initGit && info.canInitGit) {
        await initRepo(repoPath);
        info = await inspectRepo(repoPath);
      }
      const { entry } = await addToRegistry({
        repoPath,
        name: name?.trim() || undefined,
        testCommand: testCommand?.trim() || info.testCommand,
      });
      await activate(entry);
      return summary(entry, entry.slug);
    },
    async switchProject(projectId: string) {
      const entry = (await loadRegistry()).projects.find((p) => p.slug === projectId);
      if (!entry) throw new Error(`Unknown project ${projectId}`);
      if (current?.entry.slug === projectId) return;
      await activate(entry);
    },
    async updateProject(projectId, patch) {
      const entry = await updateInRegistry(projectId, patch);
      if (current?.entry.slug === projectId && !current.orchestrator?.running) {
        current.entry = entry;
        current.config = applyProject(userConfig, entry);
        await prepareRun(current);
        emit({ type: 'project', projectId });
      }
      return summary(entry, current?.entry.slug);
    },
    async removeProject(projectId, opts) {
      const reg = await loadRegistry();
      if (!reg.projects.some((p) => p.slug === projectId))
        throw new Error(`Unknown project ${projectId}`);
      const isOpen = current?.entry.slug === projectId;
      if (isOpen) refuseWhileRunning('remove this project');
      await removeFromRegistry(projectId);
      if (opts?.deleteMemory) await deleteProjectMemory(db, projectId);
      if (isOpen) {
        const next = activeProject(await loadRegistry());
        current = next ? await open(next) : undefined;
        emit({ type: 'project', projectId: current?.entry.slug ?? '' });
      }
    },
    async pickDirectory() {
      return hooks.pickDirectory?.();
    },

    // ---- the open project ----------------------------------------------------------------------
    async indexProject() {
      const p = need();
      const s = await indexRepo(p.graph, p.project);
      return { files: s.files, symbols: s.symbols, calls: s.calls };
    },
    async getGraph(_projectId, focusId, depth): Promise<GraphData> {
      if (!current) return { nodes: [], edges: [] };
      const full = await exportGraph(current.graph);
      return focusId ? neighbourhood(full, focusId, depth) : full;
    },

    async listTasks() {
      return current ? listTasks(current.graph) : [];
    },
    async createTask(_projectId, t) {
      const p = need();
      const task = await createTask(p.graph, p.project.slug, p.config, {
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
      const p = need();
      const task = await createTask(p.graph, p.project.slug, p.config, {
        title: `Plan: ${goal}`,
        type: 'plan',
        complexity: 'high',
      });
      emit({ type: 'task:update', task });
      return [task];
    },
    async getTask(taskId) {
      const p = need();
      const task = await getTask(p.graph, taskId);
      if (!task) throw new Error(`Unknown task ${taskId}`);
      return { task, sessions: await listSessions(p.graph, taskId) };
    },
    async getContextPack(sessionId) {
      const pack = await getContextPack(need().graph, sessionId);
      if (!pack) throw new Error('No context was recorded for this session');
      return pack;
    },
    async getWhy(taskId) {
      return getWhy(need().graph, taskId);
    },
    async getMemoryFeed(_projectId, limit) {
      return current ? getMemoryFeed(current.graph, limit) : [];
    },
    async listAgents() {
      return current ? agentProfiles(current.graph, current.config) : [];
    },
    async getTeamTimeline(_projectId, limit) {
      return current ? getTeamTimeline(current.graph, limit) : [];
    },

    /** Run the ready tasks. Returns at once; progress arrives as events, and a `run` event says how it ended. */
    async start() {
      const p = need();
      if (!p.runDeps) throw new Error(p.runBlocked ?? 'Agents cannot run for this project');
      if (p.orchestrator?.running) return;
      const o = (p.orchestrator = new Orchestrator(p.runDeps));
      emit({ type: 'run', running: true });
      o.start().then(
        (results) => emit({ type: 'run', running: false, ...summarizeRun(results) }),
        (err: Error) => emit({ type: 'run', running: false, message: err.message, tone: 'bad' }),
      );
    },
    async stop() {
      await current?.orchestrator?.stop();
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
