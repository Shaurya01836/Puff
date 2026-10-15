// Everything a person (or an agent acting for them) can do to the open project: look at tasks, create
// and change them, run the team, stop it. The desktop app, the slash commands, the chat's tools and the
// CLI all go through this one class, so they cannot disagree about what an action means.
import type { Graph } from 'falkordb';
import type { PuffEvent, SessionInfo, Task, TaskStatus } from '@puff/shared';
import type { PuffConfig } from '../config';
import type { ProjectInfo } from '../db/init';
import type { TaskDiff } from '../git/repo';
import { indexRepo, type IndexStats } from '../indexer/index';
import {
  createTask,
  editTask,
  getTask,
  listTasks,
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
import { getWhy } from '../queries/explain';
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

export class ProjectController {
  private orchestrator?: Orchestrator;

  private constructor(
    readonly deps: ControllerDeps,
    private runDeps: OrchestratorDeps | undefined,
    private blocked: string | undefined,
  ) {}

  /** Agents can only run when the project is its own git repository; if not, say why instead of failing later. */
  static async create(deps: ControllerDeps): Promise<ProjectController> {
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
      (results) => this.emit({ type: 'run', running: false, ...summarizeRun(results) }),
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
