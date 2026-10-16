// Everything a person (or an agent acting for them) can do to the open project: look at tasks, create
// and change them, run the team, stop it. The desktop app, the slash commands, the chat's tools and the
// CLI all go through this one class, so they cannot disagree about what an action means.
import type { Graph } from 'falkordb';
import type { AgentName, PuffEvent, SessionInfo, Task, TaskStatus } from '@puff/shared';
import type { PuffConfig } from '../config';
import type { ProjectInfo } from '../db/init';
import type { TaskDiff } from '../git/repo';
import { indexRepo, type IndexStats } from '../indexer/index';
import {
  createTask,
  editTask,
  getTask,
  listTasks,
  promoteReady,
  recoverInterrupted,
  removeTask,
  updateTask,
  type NewTask,
  type TaskEdit,
} from '../memory/tasks';
import { listSessions } from '../memory/sessions';
import {
  Orchestrator,
  createRunDeps,
  type OrchestratorDeps,
  type StartOptions,
} from '../orchestrator/orchestrator';
import { landManualWork } from '../orchestrator/run';
import { getWhy } from '../queries/explain';
import { buildHandoffBrief } from './handoff';
import { resolveTask, shortId } from './resolve';
import { summarizeRun } from './summary';

export interface ControllerDeps {
  graph: Graph;
  project: ProjectInfo;
  config: PuffConfig;
  emit?: (e: PuffEvent) => void;
  log?: (line: string) => void;
  /** Tests pass run dependencies with fake agents; otherwise they are built from the repository. */
  runDeps?: OrchestratorDeps;
}

export interface ProjectStatus {
  project: string;
  total: number;
  counts: Record<TaskStatus, number>;
  running: boolean;
  /** Why agents cannot run for this project, when they cannot */
  runBlocked?: string;
  /** Tasks held back because their code overlaps a running task */
  waiting: { id: string; title: string; on: string[] }[];
}

export interface TaskReport {
  task: Task;
  /** Newest first */
  sessions: SessionInfo[];
}

const ALL_STATUSES: TaskStatus[] = [
  'planned',
  'ready',
  'running',
  'verifying',
  'failed',
  'retrying',
  'escalated',
  'done',
];

/** What the person needs to work on a task themselves */
export interface TakeOver {
  taskId: string;
  /** The working folder (a git worktree of the project) */
  cwd: string;
  /** Where it started: the agent's last attempt, or the current code */
  startedFrom: string;
  /** The folder was already there from an earlier take-over and holds the person's work */
  reused: boolean;
  /** A short message for the CLI they open there, saying what the task is and what was tried */
  brief: string;
}

export class ProjectController {
  private orchestrator?: Orchestrator;

  private constructor(
    readonly deps: ControllerDeps,
    private runDeps: OrchestratorDeps | undefined,
    private blocked: string | undefined,
  ) {}

  /** Agents can only run when the project is its own git repository; if not, say why instead of failing later. */
  static async create(deps: ControllerDeps): Promise<ProjectController> {
    // A task left "running" by an app that was closed (or crashed) mid-run would show as running forever.
    // Anything silent for longer than two agent timeouts cannot still be running, so it goes back to the queue.
    const reset = await recoverInterrupted(deps.graph, {
      olderThanMs: deps.config.limits.timeoutMs * 2,
    }).catch(() => 0);
    if (reset)
      deps.log?.(
        `${reset} task(s) were left running by an earlier session and are back in the queue`,
      );
    if (deps.runDeps) return new ProjectController(deps, deps.runDeps, undefined);
    try {
      const runDeps = await createRunDeps({
        graph: deps.graph,
        project: deps.project,
        config: deps.config,
        emit: deps.emit,
        log: deps.log,
      });
      return new ProjectController(deps, runDeps, undefined);
    } catch (err) {
      return new ProjectController(deps, undefined, (err as Error).message);
    }
  }

  get graph(): Graph {
    return this.deps.graph;
  }
  get project(): ProjectInfo {
    return this.deps.project;
  }
  get config(): PuffConfig {
    return this.deps.config;
  }
  get running(): boolean {
    return this.orchestrator?.running === true;
  }
  /** Why agents cannot run, or undefined when they can */
  get runBlocked(): string | undefined {
    return this.blocked;
  }

  private emit(e: PuffEvent): void {
    this.deps.emit?.(e);
  }

  // ---- looking ------------------------------------------------------------------------------
  tasks(): Promise<Task[]> {
    return listTasks(this.graph);
  }

  /** The task a person means by `ref` (an id, the end of one, or a word from the title). */
  async find(ref: string): Promise<Task> {
    return resolveTask(await this.tasks(), ref);
  }

  async taskReport(ref: string): Promise<TaskReport> {
    const task = await this.find(ref);
    const sessions = (await listSessions(this.graph, task.id)).sort(
      (a, b) => b.startedAt - a.startedAt,
    );
    return { task, sessions };
  }

  async status(): Promise<ProjectStatus> {
    const tasks = await this.tasks();
    const counts = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<
      TaskStatus,
      number
    >;
    for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1;
    return {
      project: this.project.name,
      total: tasks.length,
      counts,
      running: this.running,
      runBlocked: this.runBlocked,
      waiting: tasks
        .filter((t) => t.blockedBy?.length)
        .map((t) => ({ id: t.id, title: t.title, on: t.blockedBy! })),
    };
  }

  async why(ref: string): Promise<{ task: Task; summary: string }> {
    const task = await this.find(ref);
    return { task, summary: (await getWhy(this.graph, task.id)).summary };
  }

  /** What a task changed: the commit that merged it, or its newest attempt that was kept. */
  async diff(ref: string): Promise<{ task: Task; diff?: TaskDiff }> {
    const task = await this.find(ref);
    return { task, diff: await this.runDeps?.repo.taskDiff(task.id) };
  }

  // ---- changing -----------------------------------------------------------------------------
  async createTask(input: NewTask): Promise<Task> {
    const task = await createTask(this.graph, this.project.slug, this.config, input);
    this.emit({ type: 'task:update', task });
    return task;
  }

  /** A goal becomes a planning task; when the team runs, the planner agent splits it into tasks. */
  async createGoal(goal: string): Promise<Task> {
    const text = goal.trim();
    if (!text) throw new Error('A goal needs some words.');
    return this.createTask({ title: `Plan: ${text}`, type: 'plan', complexity: 'high' });
  }

  /** Put a failed task back in the queue. Its earlier attempts stay in its history. */
  async retryTask(ref: string): Promise<Task> {
    const task = await this.find(ref);
    if (task.status !== 'failed')
      throw new Error(
        `Task ${shortId(task.id)} is ${task.status}; only a failed task can be retried.`,
      );
    const all = await this.tasks();
    const waiting = task.dependsOn.some((d) => all.find((t) => t.id === d)?.status !== 'done');
    const updated = await updateTask(this.graph, task.id, {
      status: waiting ? 'planned' : 'ready',
      blockedBy: null,
    });
    this.emit({ type: 'task:update', task: updated });
    return updated;
  }

  // ---- taking control -----------------------------------------------------------------------
  /** Wait until a task is no longer being worked on (its agent has been stopped), up to `ms`. */
  private async settled(taskId: string, ms = 20_000): Promise<Task> {
    const until = Date.now() + ms;
    for (;;) {
      const t = (await getTask(this.graph, taskId))!;
      if (!['running', 'verifying'].includes(t.status) || Date.now() > until) return t;
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  /**
   * Stop one task: its agent is killed and the task shows as failed ("Stopped by you"), ready to Retry,
   * switch agent or take over. The rest of the team keeps working.
   */
  async stopTask(ref: string): Promise<Task> {
    const task = await this.find(ref);
    if (!['running', 'verifying', 'retrying', 'escalated'].includes(task.status))
      throw new Error(
        `Task ${shortId(task.id)} is ${task.status}; only a task being worked on can be stopped.`,
      );
    if (this.orchestrator?.stopTask(task.id)) return this.settled(task.id);
    // Nothing in this app is working on it (an earlier session left it behind)
    const updated = await updateTask(this.graph, task.id, { status: 'failed', stalledAt: null });
    await recoverInterrupted(this.graph, { olderThanMs: 0 }).catch(() => 0);
    this.emit({ type: 'task:update', task: updated });
    return updated;
  }

  /**
   * Give a task to another agent (and model): stop it if it is running, change who it is for, and put it
   * back in the queue. Press Run team to start it.
   */
  async reassignTask(ref: string, agent: AgentName, model?: string): Promise<Task> {
    let task = await this.find(ref);
    if (['running', 'verifying'].includes(task.status)) task = await this.stopTask(task.id);
    if (task.status === 'done') throw new Error('This task is already done.');
    if (!this.config.harnesses[agent]) throw new Error(`${agent} is not set up for this project.`);
    await editTask(this.graph, task.id, { preferredAgent: agent, model: model?.trim() || null });
    this.emit({ type: 'task:update', task: (await getTask(this.graph, task.id))! });
    return task.status === 'failed'
      ? this.retryTask(task.id)
      : (await getTask(this.graph, task.id))!;
  }

  /** The person did this task themselves: mark it done, so what waits for it can go on. */
  async markDone(ref: string, note?: string): Promise<Task> {
    let task = await this.find(ref);
    if (['running', 'verifying'].includes(task.status)) task = await this.stopTask(task.id);
    const updated = await updateTask(this.graph, task.id, {
      status: 'done',
      doneByHand: true,
      stalledAt: null,
      ...(note?.trim() ? { note } : {}),
    });
    this.emit({ type: 'task:update', task: updated });
    for (const t of await promoteReady(this.graph)) this.emit({ type: 'task:update', task: t });
    return updated;
  }

  /** A note the next attempt on this task is told to follow. An empty note removes it. */
  async addNote(ref: string, note: string): Promise<Task> {
    const task = await this.find(ref);
    const updated = await updateTask(this.graph, task.id, { note: note.trim() || null });
    this.emit({ type: 'task:update', task: updated });
    return updated;
  }

  /** Finish what is running, start nothing new. */
  drain(): boolean {
    if (!this.orchestrator?.running) return false;
    this.orchestrator.drain();
    return true;
  }

  get draining(): boolean {
    return this.orchestrator?.isDraining === true;
  }

  /**
   * Take a task over: stop its agent, and give the person a working folder (starting from the agent's last
   * attempt) to continue in, with a short brief for the CLI they open there. Nothing runs by itself after this.
   */
  async takeOver(ref: string): Promise<TakeOver> {
    if (!this.runDeps) throw new Error(this.blocked ?? 'Agents cannot run for this project');
    let task = await this.find(ref);
    if (['running', 'verifying'].includes(task.status)) task = await this.stopTask(task.id);
    if (task.status === 'done') throw new Error('This task is already done.');
    const { wt, startedFrom, reused } = await this.runDeps.repo.openManualWorktree(
      task.id,
      this.config.worktrees.linkDirs,
    );
    // The task is the person's now: failed means the queue leaves it alone
    task = await updateTask(this.graph, task.id, {
      status: 'failed',
      worktree: `.puff/worktrees/${wt.name}`,
      stalledAt: null,
    });
    this.emit({ type: 'task:update', task });
    const sessions = await listSessions(this.graph, task.id);
    return {
      taskId: task.id,
      cwd: wt.path,
      startedFrom,
      reused,
      brief: buildHandoffBrief(task, sessions, this.config.verify.testCommand),
    };
  }

  /** The person's working folder for a task, if they have taken it over. */
  manualFolder(taskId: string): string | undefined {
    return this.runDeps?.repo.manualWorktree(taskId, this.config.worktrees.linkDirs)?.path;
  }

  /**
   * Remove the person's working folder once their changes have landed. It may take a moment to let go: a
   * program that was running in it has to finish closing first.
   */
  async removeManualFolder(taskId: string): Promise<void> {
    const repo = this.runDeps?.repo;
    for (let attempt = 0; attempt < 8 && repo; attempt++) {
      const wt = repo.manualWorktree(taskId, this.config.worktrees.linkDirs);
      if (!wt) return;
      await repo.remove(wt, { deleteBranch: true }).catch(() => {});
      if (!repo.manualWorktree(taskId, this.config.worktrees.linkDirs)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Check the person's own changes, merge them, re-test the combined result (like an agent's work). */
  async landManual(ref: string): Promise<{ status: 'done' | 'failed'; message: string }> {
    if (!this.runDeps) throw new Error(this.blocked ?? 'Agents cannot run for this project');
    const task = await this.find(ref);
    const wt = this.runDeps.repo.manualWorktree(task.id, this.config.worktrees.linkDirs);
    if (!wt)
      throw new Error(
        'You have not taken this task over, so there are no changes of yours to land.',
      );
    return landManualWork(this.runDeps, task.id, wt);
  }

  async editTask(ref: string, edit: TaskEdit): Promise<Task> {
    const task = await this.find(ref);
    const updated = await editTask(this.graph, task.id, edit);
    this.emit({ type: 'task:update', task: updated });
    return updated;
  }

  /** Delete a task that never ran. Never used by the chat agent: deleting stays a person's decision. */
  async removeTask(ref: string): Promise<Task> {
    const task = await this.find(ref);
    await removeTask(this.graph, task.id);
    this.emit({ type: 'task:removed', taskId: task.id });
    return task;
  }

  async index(): Promise<IndexStats> {
    return indexRepo(this.graph, this.project);
  }

  // ---- running ------------------------------------------------------------------------------
  /**
   * Run the ready tasks. Returns at once; progress arrives as events, and a `run` event says how it
   * ended. Returns false when a run was already going.
   */
  async start(opts: StartOptions = {}): Promise<boolean> {
    if (!this.runDeps) throw new Error(this.blocked ?? 'Agents cannot run for this project');
    if (this.orchestrator?.running) return false;
    const orchestrator = (this.orchestrator = new Orchestrator(this.runDeps));
    this.emit({ type: 'run', running: true });
    orchestrator.start(opts).then(
      (results) =>
        this.emit({
          type: 'run',
          running: false,
          // A run that could not start says why, instead of the usual "0 tasks done"
          ...(orchestrator.problem
            ? { message: orchestrator.problem, tone: 'bad' as const }
            : summarizeRun(results)),
        }),
      (err: Error) => this.emit({ type: 'run', running: false, message: err.message, tone: 'bad' }),
    );
    return true;
  }

  async stop(): Promise<void> {
    await this.orchestrator?.stop();
  }

  /** Find a task by id without fuzzy matching (internal callers that already hold an id). */
  getTask(id: string): Promise<Task | undefined> {
    return getTask(this.graph, id);
  }
}
