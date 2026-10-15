// The team loop: keep picking the next ready task and running it. For now one task at a time (P4
// adds overlap checks so independent tasks can run in parallel).
import type { AgentName } from '@puff/shared';
import { createAdapters } from '../agents/adapters';
import { GitRepo } from '../git/repo';
import { listTasks, promoteReady, recoverInterrupted } from '../memory/tasks';
import { flushMemoryEvents, runTask, type RunDeps, type TaskRunResult } from './run';

export type OrchestratorDeps = Omit<RunDeps, 'signal' | 'unavailable'>;

/** Open the project's git repository and build the adapters from config. */
export async function createRunDeps(
  base: Pick<RunDeps, 'graph' | 'project' | 'config' | 'emit' | 'log'>,
): Promise<OrchestratorDeps> {
  const repo = await GitRepo.open(base.project.repoPath, base.config.worktrees.linkDirs);
  return { ...base, repo, adapters: createAdapters(base.config) };
}

export class Orchestrator {
  private controller?: AbortController;
  private loop?: Promise<TaskRunResult[]>;
  private readonly unavailable = new Map<AgentName, string>();

  constructor(private readonly deps: OrchestratorDeps) {}

  get running(): boolean {
    return this.loop !== undefined;
  }

  /** Start working through ready tasks. Resolves with every task result once the queue is empty or stopped. */
  start(): Promise<TaskRunResult[]> {
    if (this.loop) return this.loop;
    this.controller = new AbortController();
    const { signal } = this.controller;
    this.loop = this.work(signal).finally(() => {
      this.loop = undefined;
      this.controller = undefined;
    });
    return this.loop;
  }

  /** Stop after killing the agent that is running right now; its task goes back to the queue. */
  async stop(): Promise<void> {
    this.controller?.abort();
    await this.loop?.catch(() => {});
  }

  /** Agents found unusable during this run, with the reason. */
  get blocked(): ReadonlyMap<AgentName, string> {
    return this.unavailable;
  }

  private async work(signal: AbortSignal): Promise<TaskRunResult[]> {
    const { graph, log } = this.deps;
    const results: TaskRunResult[] = [];
    await flushMemoryEvents(this.deps, true);
    const reset = await recoverInterrupted(graph);
    if (reset) log?.(`reset ${reset} interrupted task(s) back to the queue`);

    while (!signal.aborted) {
      for (const t of await promoteReady(graph)) this.deps.emit?.({ type: 'task:update', task: t });
      const next = (await listTasks(graph))
        .filter((t) => t.status === 'ready')
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!next) break;
      const result = await runTask(
        { ...this.deps, signal, unavailable: this.unavailable },
        next.id,
      );
      results.push(result);
      if (result.status === 'aborted') break;
    }
    const waiting = (await listTasks(graph)).filter((t) => t.status === 'planned');
    if (waiting.length && !signal.aborted) {
      log?.(`${waiting.length} task(s) are waiting on tasks that did not finish`);
    }
    return results;
  }
}
