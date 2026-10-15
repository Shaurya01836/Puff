// In-memory PuffApi backed by fixtures. Used by the UI until the real backend lands,
// and by `npm run dev:web` so the renderer runs in a plain browser.
import type { PuffApi } from '../api';
import type {
  ChatMessage,
  MemoryEvent,
  ProjectSummary,
  PuffEvent,
  RepoInspection,
  SetupStatus,
  Task,
  TaskStatus,
} from '../types';
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
import { mockTeamTimeline } from './team';

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
  /** Start with the database "down", so the setup screen shows (until startDatabase is pressed) */
  databaseDown?: boolean;
}

const sampleSetup = (databaseOk: boolean): SetupStatus => ({
  databaseOk,
  databaseUrl: 'falkor://localhost:6379',
  databaseError: databaseOk
    ? undefined
    : 'Could not connect to FalkorDB at falkor://localhost:6379.',
  docker: 'ready',
  agents: [
    {
      id: 'claude-code',
      command: 'claude',
      installed: true,
      version: '2.1.0 (Claude Code)',
      installHint: '',
    },
    {
      id: 'codex',
      command: 'codex',
      installed: false,
      installHint: 'npm install -g @openai/codex, then run `codex` once to sign in',
    },
    { id: 'opencode', command: 'opencode', installed: true, version: '1.4.3', installHint: '' },
  ],
  homePath: '~/.puff',
});

export function createMockApi(opts: MockApiOptions = {}): PuffApi {
  const tickMs = opts.tickMs ?? 2500;
  let databaseUp = !opts.databaseDown;
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

  const projects: ProjectSummary[] = [
    {
      id: MOCK_PROJECT_ID,
      name: 'shop-api',
      repoPath: 'C:/work/shop-api',
      active: true,
      missing: false,
      addedAt: Date.now() - 864e5,
      files: 38,
      symbols: 78,
      tasks: 8,
      testCommand: 'npm test',
    },
    {
      id: 'billing_service',
      name: 'billing-service',
      repoPath: 'C:/work/billing-service',
      active: false,
      missing: false,
      addedAt: Date.now() - 36e5,
      files: 112,
      symbols: 340,
      tasks: 0,
    },
  ];

  const chat: ChatMessage[] = [];
  const say = (m: Omit<ChatMessage, 'id' | 'at'>) => {
    const message: ChatMessage = { id: `msg_${++seq}`, at: Date.now(), ...m };
    chat.push(message);
    emit({ type: 'chat', message: clone(message) });
  };

  /** Stand-in for looking at a folder: a few words in the path pick which situation to show. */
  const sampleInspection = (repoPath: string): RepoInspection => {
    const path = repoPath.replaceAll('\\', '/');
    const name = path.split('/').filter(Boolean).pop() ?? 'project';
    const python = /python|\.py/i.test(path);
    const noGit = /nogit/i.test(path);
    return {
      path,
      name,
      exists: true,
      isDirectory: true,
      git: {
        isRepo: !noGit,
        isRoot: !noGit,
        hasCommits: !noGit,
        dirty: /dirty/i.test(path),
        branch: noGit ? undefined : 'main',
      },
      testCommand: python ? undefined : 'npm test',
      packageManager: python ? undefined : 'npm',
      hasNodeModules: true,
      files: { supported: python ? 0 : 42, unsupported: python ? { py: 17 } : { py: 2 } },
      problems: python
        ? ['Puff reads TypeScript and JavaScript for now, and found only py files here.']
        : [],
      runBlockers: noGit
        ? [
            'Not a git repository. Agents work in git worktrees, so Puff can set one up (git init and a first commit) if you agree.',
          ]
        : [],
      warnings: [
        ...(python
          ? []
          : [
              'Puff reads TypeScript and JavaScript only. These files will not be in the code graph: 2 .py.',
            ]),
        ...(/dirty/i.test(path)
          ? [
              'There are uncommitted changes. Agents can run, but a finished task will not be merged until the main checkout is clean.',
            ]
          : []),
      ],
      canInitGit: noGit,
    };
  };

  return {
    async getBackendInfo() {
      return {
        mode: 'mock',
        projectId: projects.find((p) => p.active)?.id ?? MOCK_PROJECT_ID,
        projectName: projects.find((p) => p.active)?.name ?? 'shop-api',
        mockParts: ['everything'],
        needsSetup: databaseUp ? undefined : true,
      };
    },
    async getSetupStatus() {
      return sampleSetup(databaseUp);
    },
    async startDatabase() {
      await new Promise((r) => setTimeout(r, 1500));
      databaseUp = true;
      return sampleSetup(true);
    },
    async retrySetup() {
      return sampleSetup(databaseUp);
    },
    async listProjects() {
      return clone(projects);
    },
    async inspectProject(repoPath) {
      return sampleInspection(repoPath);
    },
    async addProject({ repoPath, name, testCommand }) {
      const info = sampleInspection(repoPath);
      if (info.problems.length) throw new Error(info.problems[0]);
      const project: ProjectSummary = {
        id: (name ?? info.name).toLowerCase().replace(/[^a-z0-9]+/g, '_'),
        name: name ?? info.name,
        repoPath: info.path,
        active: true,
        missing: false,
        testCommand,
        addedAt: Date.now(),
        files: info.files.supported,
        symbols: info.files.supported * 3,
        tasks: 0,
      };
      projects.forEach((p) => (p.active = false));
      projects.push(project);
      emit({ type: 'project', projectId: project.id });
      return clone(project);
    },
    async switchProject(projectId) {
      projects.forEach((p) => (p.active = p.id === projectId));
      emit({ type: 'project', projectId });
    },
    async updateProject(projectId, patch) {
      const p = projects.find((x) => x.id === projectId);
      if (!p) throw new Error(`Unknown project ${projectId}`);
      if (patch.name) p.name = patch.name;
      if (patch.testCommand !== undefined) p.testCommand = patch.testCommand ?? undefined;
      if (patch.linkDirs !== undefined) p.linkDirs = patch.linkDirs ?? undefined;
      return clone(p);
    },
    async removeProject(projectId) {
      const i = projects.findIndex((p) => p.id === projectId);
      if (i >= 0) projects.splice(i, 1);
      if (!projects.some((p) => p.active) && projects[0]) projects[0].active = true;
      emit({ type: 'project', projectId: projects.find((p) => p.active)?.id ?? '' });
    },
    async pickDirectory() {
      return 'C:/work/new-project';
    },
    // ---- chat: scripted, so the panel can be designed without an agent ---------------------------
    async chatInfo() {
      return { brain: 'Claude Code (sample)', ready: true, autoApprove: false };
    },
    async chatHistory() {
      return clone(chat);
    },
    async chatSend(text) {
      say({ role: 'user', text });
      if (text.trim().startsWith('/')) {
        say({
          role: 'system',
          ok: true,
          text: text.trim().startsWith('/help')
            ? 'Type a slash command, or just say what you want.\n/status   Tasks by state\n/run      Run the ready tasks (spends tokens)'
            : `(sample) ${text.trim()} done.`,
        });
        return;
      }
      await new Promise((r) => setTimeout(r, 700));
      say({ role: 'action', tool: 'create_goal', ok: true, text: `Added the goal: ${text}` });
      say({
        role: 'approval',
        text: 'Run the team now?',
        approval: {
          id: `apr_${++seq}`,
          summary: 'Run the ready tasks. This spends agent tokens.',
          state: 'pending',
        },
      });
      say({
        role: 'assistant',
        text: '(sample answer) I added that as a goal for the planner. Approve the run when you are ready.',
        tokens: { in: 1200, out: 90 },
      });
    },
    async chatApprove(approvalId, approve) {
      const m = chat.find((x) => x.approval?.id === approvalId);
      if (!m?.approval) throw new Error('That request is no longer waiting.');
      m.approval.state = approve ? 'approved' : 'declined';
      emit({ type: 'chat', message: clone(m) });
    },
    async chatReset() {
      chat.length = 0;
    },
    async retryTask(taskId) {
      const t = tasks.find((x) => x.id === taskId);
      if (!t) throw new Error(`Unknown task ${taskId}`);
      if (t.status !== 'failed') throw new Error('Only a failed task can be retried.');
      t.status = 'ready';
      t.updatedAt = Date.now();
      emit({ type: 'task:update', task: clone(t) });
      return clone(t);
    },
    async editTask(taskId, edit) {
      const t = tasks.find((x) => x.id === taskId);
      if (!t) throw new Error(`Unknown task ${taskId}`);
      if (!['planned', 'ready', 'failed'].includes(t.status))
        throw new Error('Only planned, ready or failed tasks can be edited.');
      if (edit.title) t.title = edit.title;
      if (edit.complexity) t.complexity = edit.complexity;
      if (edit.preferredAgent !== undefined) t.preferredAgent = edit.preferredAgent ?? undefined;
      if (edit.model !== undefined) t.model = edit.model ?? undefined;
      if (edit.targets) t.targets = edit.targets;
      t.updatedAt = Date.now();
      emit({ type: 'task:update', task: clone(t) });
      return clone(t);
    },
    async removeTask(taskId) {
      const i = tasks.findIndex((x) => x.id === taskId);
      if (i < 0) throw new Error(`Unknown task ${taskId}`);
      if (!['planned', 'ready'].includes(tasks[i]!.status))
        throw new Error('Only a task that has not run can be removed.');
      tasks.splice(i, 1);
      emit({ type: 'task:removed', taskId });
    },
    async getTaskDiff(taskId) {
      const t = tasks.find((x) => x.id === taskId);
      if (!t || ['planned', 'ready'].includes(t.status)) return undefined;
      return {
        source: t.status === 'done' ? 'merge' : 'attempt',
        ref: t.status === 'done' ? 'a1b2c3d4e5' : `puff/${taskId}-a1`,
        label: t.status === 'done' ? 'Merged into the main branch' : 'Attempt 1, not merged',
        files: ['src/auth/login.ts'],
        diff: [
          'diff --git a/src/auth/login.ts b/src/auth/login.ts',
          '--- a/src/auth/login.ts',
          '+++ b/src/auth/login.ts',
          '@@ -19,7 +19,7 @@ export function checkUser(email: string, password: string): UserRow {',
          '   const user = findUserByEmail(email);',
          '   if (!user || !verifyPassword(password, user.passwordHash)) {',
          "-    audit('login.failed', { email });",
          "+    audit('login.failed', { email, reason: user ? 'bad_password' : 'unknown_user' });",
          "     throw unauthorized('Invalid email or password');",
          '   }',
        ].join('\n'),
      };
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
    async getTeamTimeline(_projectId, limit = 60) {
      return clone(mockTeamTimeline.slice(0, limit));
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
