// The team loop. It keeps up to `limits.maxParallel` tasks running at once:
//   - a ready task is only started if its code does not overlap a task already in flight (Q8);
//     otherwise it waits, and the board says what it is waiting on (`blockedBy`)
//   - starting a task claims it atomically (Q9), so two loops can never start the same task
//   - each agent gets at most its configured number of simultaneous runs
// Merges happen one at a time (see GitRepo.serial), whatever runs in parallel.
import type { AgentName } from '@puff/shared';
import { createAdapters } from '../agents/adapters';
import { GitRepo } from '../git/repo';
import {
  claimTask,
  listTasks,
  promoteReady,
  recoverInterrupted,
  updateTask,
} from '../memory/tasks';
import { flushMemoryEvents, runTask, type RunDeps, type TaskRunResult } from './run';
import { SlotPool, overlappingTasks } from './schedule';

export type OrchestratorDeps = Omit<RunDeps, 'signal' | 'unavailable' | 'slots'>;

/** Open the project's git repository and build the adapters from config. */
export async function createRunDeps(
  base: Pick<RunDeps, 'graph' | 'project' | 'config' | 'emit' | 'log'>,
): Promise<OrchestratorDeps> {
  const repo = await GitRepo.open(base.project.repoPath, base.config.worktrees.linkDirs);
  return { ...base, repo, adapters: createAdapters(base.config) };
}

export interface StartOptions {
  /** Start every task with this agent instead of routing (escalation still applies) */
  agent?: AgentName;
}

export class Orchestrator {
  private controller?: AbortController;
  private loop?: Promise<TaskRunResult[]>;
  private readonly unavailable = new Map<AgentName, string>();
  private readonly owner = `puff-${process.pid}-${Date.now().toString(36)}`;

  constructor(private readonly deps: OrchestratorDeps) {}

  get running(): boolean {
    return this.loop !== undefined;
  }

  /** Start working through ready tasks. Resolves with every task result once the queue is empty or stopped. */
  start(opts: StartOptions = {}): Promise<TaskRunResult[]> {
    if (this.loop) return this.loop;
    this.controller = new AbortController();
    const { signal } = this.controller;
    this.loop = this.work(signal, opts).finally(() => {
      this.loop = undefined;
      this.controller = undefined;
    });
    return this.loop;
  }

  /** Stop after killing the agents that are running; their tasks go back to the queue. */
  async stop(): Promise<void> {
    this.controller?.abort();
    await this.loop?.catch(() => {});
  }

  /** Agents found unusable during this run, with the reason. */
  get blocked(): ReadonlyMap<AgentName, string> {
    return this.unavailable;
  }

  private async work(signal: AbortSignal, opts: StartOptions): Promise<TaskRunResult[]> {
    const { graph, config, log, emit } = this.deps;
    const results: TaskRunResult[] = [];
    const running = new Map<string, Promise<void>>();
    const slots = new SlotPool(
      Object.fromEntries(Object.entries(config.harnesses).map(([name, h]) => [name, h.instances])),
    );
    const maxParallel = Math.max(1, config.limits.maxParallel);

    await flushMemoryEvents(this.deps, true);
    const reset = await recoverInterrupted(graph);
    if (reset) log?.(`reset ${reset} interrupted task(s) back to the queue`);

    const launch = (taskId: string) => {
      const run = runTask({ ...this.deps, signal, unavailable: this.unavailable, slots }, taskId, {
        agent: opts.agent,
      })
        .then((r) => void results.push(r))
        .catch((err: Error) => {
          log?.(`✖ ${taskId} crashed: ${err.message}`);
          results.push({ taskId, status: 'failed', attempts: [], reason: err.message });
        })
        .finally(() => void running.delete(taskId));
      running.set(taskId, run);
    };

    while (!signal.aborted) {
      for (const t of await promoteReady(graph)) emit?.({ type: 'task:update', task: t });

      const ready = (await listTasks(graph))
        .filter((t) => t.status === 'ready')
        .sort((a, b) => a.createdAt - b.createdAt);

      for (const task of ready) {
        if (running.size >= maxParallel) break;
        // Tasks claimed a moment ago are already 'running' in the graph, so they count as in flight.
        const blockers = await overlappingTasks(graph, task);
        const was = (task.blockedBy ?? []).join();
        if (blockers.join() !== was) {
          const updated = await updateTask(graph, task.id, {
            blockedBy: blockers.length ? blockers : null,
          });
          emit?.({ type: 'task:update', task: updated });
          if (blockers.length)
            log?.(`${task.id} waits for ${blockers.join(', ')} (overlapping code)`);
        }
        if (blockers.length) continue;
        if (!(await claimTask(graph, task.id, this.owner))) continue;
        log?.(`start ${task.id}: ${task.title}`);
        launch(task.id);
      }

      if (running.size === 0) break; // nothing running and nothing startable: the queue is done
      // Wake when any task finishes (new tasks may have been spawned or unblocked) or on abort.
      await Promise.race([
        ...running.values(),
        new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        ),
      ]);
    }
    await Promise.all(running.values());

    const waiting = (await listTasks(graph)).filter((t) => t.status === 'planned');
    if (waiting.length && !signal.aborted) {
      log?.(`${waiting.length} task(s) are waiting on tasks that did not finish`);
    }
    return results;
  }
}
