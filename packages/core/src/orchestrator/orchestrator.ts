// The team loop. It keeps up to `limits.maxParallel` tasks running at once:
//   - a ready task is only started if its code does not overlap a task already in flight (Q8);
//     otherwise it waits, and the board says what it is waiting on (`blockedBy`)
//   - starting a task claims it atomically (Q9), so two loops can never start the same task
//   - each agent gets at most its configured number of simultaneous runs
// Merges happen one at a time (see GitRepo.serial), whatever runs in parallel.
import type { AgentName } from '@puff/shared';
import { ROLE_FOR_TYPE, createAdapters } from '../agents/adapters';
import { WRITES_FILES } from '../agents/types';
import { graphOff } from '../config';
import { saveTrace, traced } from '../db/trace';
import { GitRepo } from '../git/repo';
import {
  claimTask,
  listTasks,
  promoteReady,
  recoverInterrupted,
  updateTask,
} from '../memory/tasks';
import { flushMemoryEvents, runTask, type RunDeps, type TaskRunResult } from './run';
import { SlotPool, nearbyWork, overlapDetails, pathText } from './schedule';
import { failureLines, runVerification } from './verify';

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
  private checked = false;
  /** The failures the project's check had before any agent touched it */
  private baseline?: Set<string>;
  /** One abort switch per task in flight, so a single task can be stopped without stopping the team */
  private readonly taskAborts = new Map<string, AbortController>();
  /** Finish what is running, start nothing new */
  private draining = false;
  /** Set when the run stopped before starting agents because the project cannot be checked */
  problem?: string;

  constructor(private readonly deps: OrchestratorDeps) {}

  get running(): boolean {
    return this.loop !== undefined;
  }

  /** Start working through ready tasks. Resolves with every task result once the queue is empty or stopped. */
  start(opts: StartOptions = {}): Promise<TaskRunResult[]> {
    if (this.loop) return this.loop;
    this.draining = false;
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

  /**
   * Run the project's check once on the untouched code, before any agent that writes code is started.
   * If the command cannot run at all (no package.json where it runs, a missing tool), every attempt would
   * fail only after the agent had spent its tokens, so say so now. Failing tests are allowed through: the
   * task may be exactly the fix. Returns a message when the run must not start.
   */
  private async preflight(signal: AbortSignal): Promise<string | undefined> {
    const { repo, config, log } = this.deps;
    const verdict = await repo
      .withCleanCheckout('preflight', config.worktrees.linkDirs, (dir) =>
        runVerification(dir, config.verify.testCommand, config.limits.timeoutMs, signal),
      )
      .catch((err: Error) => ({ kind: 'error' as const, message: err.message }));
    if (verdict.kind === 'error')
      return `No agent was started, and nothing was spent: the project's check cannot run. ${verdict.message ?? ''} The command is "${config.verify.testCommand}". Change it in the project's settings.`.replace(
        /\s+/g,
        ' ',
      );
    if (verdict.kind === 'tests-failed') {
      this.baseline = failureLines(verdict.output);
      log?.(
        this.baseline.size
          ? `the project already fails its check (${this.baseline.size} failure(s)) before any agent touches it; a task passes if it adds no new failure`
          : 'the project already fails its check before any agent touches it, in a format Puff cannot compare, so tasks must make it pass',
      );
    }
    return undefined;
  }

  /** Stop one task: its agent is killed and the task is marked failed ("Stopped by you"). False if it is not running here. */
  stopTask(taskId: string): boolean {
    const own = this.taskAborts.get(taskId);
    if (!own) return false;
    own.abort();
    return true;
  }

  /** Ids of the tasks this run is working on right now */
  get activeTaskIds(): string[] {
    return [...this.taskAborts.keys()];
  }

  /** Finish the tasks that are running, then stop: nothing new is started. Gentler than stop(). */
  drain(): void {
    if (!this.loop) return;
    this.draining = true;
    this.deps.log?.('pausing: finishing the running tasks, starting nothing new');
  }

  get isDraining(): boolean {
    return this.draining;
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
      const own = new AbortController();
      this.taskAborts.set(taskId, own);
      const run = runTask(
        {
          ...this.deps,
          signal: AbortSignal.any([signal, own.signal]),
          userStopped: () => own.signal.aborted && !signal.aborted,
          unavailable: this.unavailable,
          baseline: this.baseline,
          slots,
        },
        taskId,
        { agent: opts.agent },
      )
        .then((r) => void results.push(r))
        .catch((err: Error) => {
          log?.(`✖ ${taskId} crashed: ${err.message}`);
          results.push({ taskId, status: 'failed', attempts: [], reason: err.message });
        })
        .finally(() => {
          running.delete(taskId);
          this.taskAborts.delete(taskId);
        });
      running.set(taskId, run);
    };

    while (!signal.aborted && !this.problem) {
      for (const t of await promoteReady(graph)) emit?.({ type: 'task:update', task: t });

      const ready = (await listTasks(graph))
        .filter((t) => t.status === 'ready' && !t.archived)
        .sort((a, b) => a.createdAt - b.createdAt);

      for (const task of ready) {
        if (running.size >= maxParallel || this.draining) break;
        if (!this.checked && WRITES_FILES[ROLE_FOR_TYPE[task.type]]) {
          this.problem = await this.preflight(signal);
          this.checked = true;
          if (this.problem) {
            log?.(`✖ ${this.problem}`);
            break;
          }
        }
        // Tasks claimed a moment ago are already 'running' in the graph, so they count as in flight.
        const off = graphOff(config);
        const check = await traced(async () => {
          const found = await overlapDetails(graph, task, { graphOff: off });
          // Q31: free to start, but how close is the nearest running work? (the call path, for the trace)
          const near = found.length || off ? [] : await nearbyWork(graph, task);
          return { details: found, near };
        });
        const { details, near } = check.value;
        const blockers = details.map((d) => d.id);
        const nearest = near[0];
        const was = (task.blockedBy ?? []).join();
        // One trace per change of answer (and one when it is free to start), not one per loop
        if (blockers.join() !== was || blockers.length === 0) {
          await saveTrace(
            graph,
            { taskId: task.id },
            {
              kind: 'schedule',
              reason: blockers.length
                ? `waits for ${blockers.join(', ')}: ${[...new Set(details.map((d) => d.why))].join('; ')}${off ? ' (graph off)' : ''}`
                : `free to start: no running task touches ${off ? 'the same file (graph off)' : 'the same functions or their direct callers and callees'}${nearest ? `; nearest running work: ${nearest.id}, ${nearest.hops} calls away (${pathText(nearest.path)})` : ''}`,
              steps: check.steps,
              graphOff: off,
            },
          );
        }
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

    const waiting = (await listTasks(graph)).filter((t) => t.status === 'planned' && !t.archived);
    if (waiting.length && !signal.aborted) {
      log?.(`${waiting.length} task(s) are waiting on tasks that did not finish`);
    }
    return results;
  }
}
