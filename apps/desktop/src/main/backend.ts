import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  BackendInfo,
  GraphData,
  ProjectSummary,
  PuffApi,
  PuffEvent,
  RepoInspection,
  SetupStatus,
} from '@puff/shared';
import { PUFF_INVOKE_METHODS, neighbourhood } from '@puff/shared';
import { createMockApi } from '@puff/shared/mocks';
import {
  ProjectController,
  activeProject,
  addProject as addToRegistry,
  agentProfiles,
  applyProject,
  checkSetup,
  connect,
  deleteProjectMemory,
  exportGraph,
  findConfigFile,
  findProject,
  getContextPack,
  getMemoryFeed,
  listMemory,
  ensureModel,
  getEmbedder,
  embedFailures,
  getTask,
  getTeamTimeline,
  getWhy,
  listTraces,
  getMergePreview,
  graphOff,
  planPreviewFor,
  graphName,
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
  saveUserEnv,
  setWasmDirectory,
  SignInManager,
  startDatabase,
  updateProject as updateInRegistry,
  withDetectedSettings,
  userEnvPath,
  type ProjectEntry,
  type ProjectHooks,
  type ProjectInfo,
  type PuffConfig,
} from '@puff/core';
import { ChatSession, brainChoices, createBrain, pickBrain } from '@puff/mcp';
import { TerminalHost } from './terminal';
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

/** What only the Electron main process can do. */
export interface BackendHooks {
  /** Show the system "choose a folder" dialog */
  pickDirectory?: () => Promise<string | undefined>;
  /** Show a folder in the file explorer */
  openPath?: (path: string) => Promise<void>;
  /** Run `cb` when the app is quitting (terminals are closed then) */
  onShutdown?: (cb: () => void) => void;
  /**
   * Set when this is the installed app: the folder holding what ships with it (the default
   * puff.config.yaml and bench/results.json). There is then no checkout of Puff to look around in.
   */
  resourcesDir?: string;
}

/** The project that is open: its graph, its settings on top of the shared config, and how agents run on it. */
interface OpenProject {
  entry: ProjectEntry;
  project: ProjectInfo;
  graph: Graph;
  config: PuffConfig;
  /** Everything done to the project goes through this: tasks, runs, indexing */
  controller: ProjectController;
  /** The conversation with the orchestrator agent for this project */
  chat: ChatSession;
}

const NO_PROJECT = 'No project is open. Add one first.';

const TERMINAL_LABEL = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  shell: 'Shell',
} as const;

/** The agents Puff knows how to drive, for the setup check when no configuration could be read */
const DEFAULT_HARNESSES = {
  'claude-code': { command: 'claude' },
  codex: { command: 'codex' },
  opencode: { command: 'opencode' },
};

/**
 * The PuffApi the main process serves over IPC.
 * Everything is live from FalkorDB, and Run team really runs the agents. The savings numbers
 * are real once `puff bench` has written bench/results.json, and mock data until then.
 *
 * If FalkorDB is unreachable the app is "in setup": the data calls answer from mocks, getBackendInfo
 * says `needsSetup` so the UI shows its setup screen, and startDatabase / retrySetup bring the real
 * backend up without restarting the app.
 *
 * Projects come from ~/.puff/projects.json (shared with the `puff` CLI). One is active at a time;
 * switching is refused while agents are running.
 */
export async function createBackend(appDir: string, hooks: BackendHooks = {}): Promise<PuffApi> {
  const listeners = new Set<(e: PuffEvent) => void>();
  const emit = (e: PuffEvent) => listeners.forEach((cb) => cb(e));
  const mock = createMockApi();

  let live: Omit<PuffApi, 'onEvent'> | undefined;
  let error: string | undefined;
  let harnesses: Record<string, { command: string }> = DEFAULT_HARNESSES;
  // Signing in to the agent CLIs (the buttons and the chat's /login share this one)
  const signIn = new SignInManager((agent) => harnesses[agent]?.command, emit);
  // Real terminals the person opens in a task's working folder
  const terminals = new TerminalHost(emit);
  hooks.onShutdown?.(() => terminals.closeAll());

  const connectLive = async () => {
    // A database port remembered by an earlier setup (~/.puff/.env) is picked up here
    loadDotEnv(userEnvPath());
    try {
      const built = await buildLive(appDir, hooks, emit, signIn, terminals);
      live = built.api;
      harnesses = built.harnesses;
      error = undefined;
    } catch (err) {
      error = (err as Error).message;
      console.error(`[puff] live backend unavailable: ${error}`);
    }
  };
  await connectLive();

  const setupStatus = async (): Promise<SetupStatus> => {
    const status = await checkSetup(harnesses);
    // Something other than the database is wrong (no configuration found): say that, not "database ok"
    return !live && error && status.databaseOk
      ? { ...status, databaseOk: false, databaseError: error }
      : status;
  };
  const retrySetup = async () => {
    if (!live) {
      await connectLive();
      if (live) emit({ type: 'project', projectId: '' });
    }
    return setupStatus();
  };

  const offline: PuffApi = {
    ...mock,
    async getBackendInfo(): Promise<BackendInfo> {
      return { ...(await mock.getBackendInfo()), error, needsSetup: true };
    },
  };

  const api = { ...offline } as PuffApi;
  for (const method of PUFF_INVOKE_METHODS) {
    (api as unknown as Record<string, unknown>)[method] = (...args: unknown[]) =>
      ((live ?? offline) as unknown as Record<string, (...a: unknown[]) => unknown>)[method]!(
        ...args,
      );
  }
  api.getSetupStatus = setupStatus;
  api.retrySetup = retrySetup;
  api.startSignIn = async (agent) => {
    const started = await signIn.start(agent);
    return { url: started.url };
  };
  api.submitSignInCode = async (code) => {
    if (!signIn.submitCode(code)) throw new Error('No sign-in is waiting for a code.');
  };
  api.startDatabase = async () => {
    await startDatabase((line) => console.log(`[puff] ${line}`));
    return retrySetup();
  };
  api.onEvent = (cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };
  return api;
}

/** Connect to the database and open the starting project. Throws if that is not possible. */
async function buildLive(
  appDir: string,
  hooks: BackendHooks,
  emit: (e: PuffEvent) => void,
  signIn: SignInManager,
  terminals: TerminalHost,
): Promise<{ api: Omit<PuffApi, 'onEvent'>; harnesses: Record<string, { command: string }> }> {
  const mock = createMockApi();
  const packaged = hooks.resourcesDir !== undefined;
  const root = hooks.resourcesDir ?? findRoot(appDir);
  loadDotEnv(join(root, '.env'));
  // The installed app carries its three grammar files with it instead of a node_modules folder
  if (packaged) setWasmDirectory(join(root, 'wasm'));

  let db: FalkorDB;
  let userConfig: PuffConfig;
  let current: OpenProject | undefined;

  /** Agents can only run when the project is its own git repository; the controller says why if it is not. */
  const makeController = (project: ProjectInfo, graph: Graph, config: PuffConfig) =>
    ProjectController.create({
      graph,
      project,
      config,
      emit,
      log: (line) => console.log(`[puff] ${line}`),
    });

  /**
   * The chat: slash commands answer at once; plain sentences go to Claude Code, which can only use
   * Puff's tools. Set PUFF_CHAT_AUTO_APPROVE=1 to let it start runs without asking first.
   */
  const makeChat = async (controller: ProjectController) => {
    // Whichever agent the person chose (remembered), else the first installed one that is not signed out:
    // a teammate with only Codex or OpenCode gets a working Ask Puff
    const brainId = await pickBrain(controller.config, process.env.PUFF_CHAT_AGENT);
    const projects: ProjectHooks = {
      list: async () => {
        const reg = await loadRegistry();
        return reg.projects.map((p) => ({
          id: p.slug,
          name: p.name,
          repoPath: p.repoPath,
          active: p.slug === current?.entry.slug,
        }));
      },
      switchTo: async (ref) => {
        const reg = await loadRegistry();
        const entry = findProject(reg, ref);
        if (!entry) throw new Error(`No project "${ref}". Type /projects to see them.`);
        refuseWhileRunning('switch projects');
        // Switch after this reply has been delivered, so it lands in the conversation it belongs to.
        setTimeout(() => {
          activate(entry).catch((err: Error) =>
            emit({ type: 'run', running: false, message: err.message, tone: 'bad' }),
          );
        }, 0);
        return entry.name;
      },
    };
    return new ChatSession({
      controller,
      brain: createBrain(brainId, controller.config),
      brainId,
      choices: () => brainChoices(controller.config),
      projects,
      signIn,
      model: controller.config.harnesses[brainId]?.model,
      autoApprove: process.env.PUFF_CHAT_AUTO_APPROVE === '1',
      emit,
    });
  };

  /** The embedding model download, started once */
  let modelFetch: Promise<unknown> | undefined;

  const open = async (entry: ProjectEntry): Promise<OpenProject> => {
    if (!existsSync(entry.repoPath))
      throw new Error(
        `The folder ${entry.repoPath} no longer exists. Remove the project or restore the folder.`,
      );
    const opened = await openProject(db, entry, userConfig);
    // Q32: the embedding model for the vector index, downloaded once in the background (30 MB);
    // until it is on disk, similar failures are found by full-text search alone
    if (process.env.PUFF_EMBED !== 'off') {
      modelFetch ??= ensureModel().catch((err: Error) => {
        console.warn('[puff] embedding model not downloaded:', err.message);
        modelFetch = undefined;
      });
      void modelFetch.then(() => {
        const embedder = getEmbedder();
        if (embedder) void embedFailures(opened.graph, embedder).catch(() => {});
      });
    }
    const controller = await makeController(opened.project, opened.graph, opened.config);
    return {
      entry,
      project: opened.project,
      graph: opened.graph,
      config: opened.config,
      controller,
      chat: await makeChat(controller),
    };
  };

  /**
   * The project to start on: the one the person last used. When there is none, a development
   * checkout of Puff starts on $PUFF_REPO or its bundled demo; an installed app starts empty.
   */
  const startingProject = async (): Promise<ProjectEntry | undefined> => {
    const active = activeProject(await loadRegistry());
    if (active || packaged) return active;
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

  const configFile = findConfigFile([root, appDir, process.cwd()]);
  if (!configFile)
    throw new Error('No Puff configuration found (puff.config.yaml or ~/.puff/config.yaml)');
  userConfig = await loadConfig(configFile);
  db = await connect();
  try {
    const entry = await startingProject();
    current = entry ? await open(entry) : undefined;
  } catch (err) {
    await db.close().catch(() => {});
    throw err;
  }

  const need = (): OpenProject => {
    if (!current) throw new Error(NO_PROJECT);
    return current;
  };

  const refuseWhileRunning = (action: string) => {
    if (current?.controller.running)
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
    const next = await open(entry);
    await current?.chat.close();
    current = next;
    await setActiveProject(entry.slug);
    emit({ type: 'project', projectId: entry.slug });
  };

  const api: Omit<PuffApi, 'onEvent'> = {
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
        runBlocked: current.controller.runBlocked,
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
        linkDirs: info.linkDirs,
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
      if (current?.entry.slug === projectId && !current.controller.running) {
        current.entry = entry;
        current.config = applyProject(userConfig, await withDetectedSettings(entry));
        current.controller = await makeController(current.project, current.graph, current.config);
        await current.chat.close();
        current.chat = await makeChat(current.controller);
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
        const opened = next ? await open(next) : undefined;
        await current?.chat.close();
        current = opened;
        emit({ type: 'project', projectId: current?.entry.slug ?? '' });
      }
    },
    async pickDirectory() {
      return hooks.pickDirectory?.();
    },

    // ---- the open project ----------------------------------------------------------------------
    async indexProject() {
      const s = await need().controller.index();
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
      return need().controller.createTask({
        title: t.title ?? 'Untitled task',
        type: t.type,
        complexity: t.complexity,
        targets: t.targets,
        dependsOn: t.dependsOn,
        preferredAgent: t.preferredAgent,
        model: t.model,
      });
    },
    /** A goal becomes a planning task; when the team runs, the planner agent splits it into tasks. */
    async createGoal(_projectId, goal) {
      return [await need().controller.createGoal(goal)];
    },
    async getTask(taskId) {
      const p = need();
      const task = await getTask(p.graph, taskId);
      if (!task) throw new Error(`Unknown task ${taskId}`);
      return { task, sessions: await listSessions(p.graph, taskId) };
    },
    async retryTask(taskId) {
      return need().controller.retryTask(taskId);
    },
    async editTask(taskId, edit) {
      return need().controller.editTask(taskId, edit);
    },
    async removeTask(taskId) {
      await need().controller.removeTask(taskId);
    },
    async getTaskDiff(taskId) {
      return (await need().controller.diff(taskId)).diff;
    },
    async chatInfo() {
      if (!current)
        return {
          brain: 'Claude Code',
          ready: false,
          note: 'Add a project first.',
          autoApprove: false,
        };
      return current.chat.info();
    },
    async chatHistory() {
      return current ? current.chat.history : [];
    },
    async chatSend(text) {
      await need().chat.send(text);
    },
    async chatApprove(approvalId, approve) {
      await need().chat.approve(approvalId, approve);
    },
    async chatReset() {
      current?.chat.reset();
    },
    async chatSetAgent(agent) {
      const p = need();
      if (!['claude-code', 'codex', 'opencode'].includes(agent))
        throw new Error(`Ask Puff cannot talk to ${agent}.`);
      // remembered for next time, for every project
      process.env.PUFF_CHAT_AGENT = agent;
      await saveUserEnv('PUFF_CHAT_AGENT', agent);
      await p.chat.close();
      p.chat = await makeChat(p.controller);
      return p.chat.info();
    },

    // ---- taking control of a task -------------------------------------------------------------
    async stopTask(taskId) {
      return need().controller.stopTask(taskId);
    },
    async reassignTask(taskId, agent, model) {
      return need().controller.reassignTask(taskId, agent, model);
    },
    async markTaskDone(taskId, note) {
      return need().controller.markDone(taskId, note);
    },
    async addTaskNote(taskId, note) {
      return need().controller.addNote(taskId, note);
    },
    async pauseTeam() {
      return current?.controller.drain() ?? false;
    },
    async openTerminal({ taskId, cli, start }) {
      const p = need();
      const command = cli === 'shell' ? undefined : p.config.harnesses[cli]?.command;
      if (cli !== 'shell' && !command) throw new Error(`${cli} is not set up for this project.`);
      const over = await p.controller.takeOver(taskId);
      const id = terminals.open({
        taskId,
        cwd: over.cwd,
        cli,
        command,
        // one line: a program's first message is a command-line argument
        brief: start && cli !== 'shell' ? over.brief.replace(/\s*\n\s*/g, ' ') : undefined,
      });
      const task = await getTask(p.graph, taskId);
      return {
        id,
        taskId,
        cli,
        title: `${TERMINAL_LABEL[cli]} · ${task?.title ?? taskId}`,
        cwd: over.cwd,
        startedFrom: over.startedFrom,
        reused: over.reused,
        brief: over.brief,
      };
    },
    async terminalWrite(id, data) {
      terminals.write(id, data);
    },
    async terminalResize(id, cols, rows) {
      terminals.resize(id, cols, rows);
    },
    async terminalAttach(id) {
      return terminals.attach(id);
    },
    async closeTerminal(id) {
      terminals.close(id);
    },
    async openTaskFolder(taskId) {
      const folder = need().controller.manualFolder(taskId);
      if (!folder)
        throw new Error('You have not taken this task over, so it has no working folder.');
      await hooks.openPath?.(folder);
    },
    async landManualChanges(taskId) {
      const p = need();
      const result = await p.controller.landManual(taskId);
      if (result.status === 'done') {
        // The changes are in: the person's terminals are done with the folder, and Windows cannot delete a
        // folder a program is sitting in
        terminals.closeForTask(taskId);
        await p.controller.removeManualFolder(taskId);
      }
      return result;
    },
    async getContextPack(sessionId) {
      // A session that is just starting has no context yet: that is an answer, not an error
      return getContextPack(need().graph, sessionId);
    },
    async getWhy(taskId) {
      return getWhy(need().graph, taskId);
    },
    async getTraces(taskId) {
      return listTraces(need().graph, taskId);
    },
    async getMergePreview(taskId) {
      return getMergePreview(need().graph, taskId);
    },
    async getPlanPreview(taskId) {
      const p = need();
      return planPreviewFor(p.graph, {
        slug: p.project.slug,
        taskId,
        maxParallel: p.config.limits.maxParallel,
        graphOff: graphOff(p.config),
      });
    },
    async getMemoryFeed(_projectId, limit) {
      return current ? getMemoryFeed(current.graph, limit) : [];
    },
    async listMemory() {
      return current ? listMemory(current.graph) : [];
    },
    async listAgents() {
      return current ? agentProfiles(current.graph, current.config) : [];
    },
    async getTeamTimeline(_projectId, limit) {
      return current ? getTeamTimeline(current.graph, limit) : [];
    },

    /** Run the ready tasks. Returns at once; progress arrives as events, and a `run` event says how it ended. */
    async start() {
      await need().controller.start();
    },
    async stop() {
      await current?.controller.stop();
    },
  };
  return { api, harnesses: userConfig.harnesses };
}
