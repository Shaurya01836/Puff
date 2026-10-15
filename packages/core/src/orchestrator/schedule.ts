// What may run at the same time. The graph answers it: two tasks conflict when they target the
// same function, or functions that call each other, because an edit to one can break the other.
import type { Graph } from 'falkordb';
import type { Task } from '@puff/shared';
import { read } from '../db/client';
import { listTasks } from '../memory/tasks';

/** Statuses of a task that has an agent working on it, or is about to again. */
export const IN_FLIGHT = ['running', 'verifying', 'retrying', 'escalated'] as const;

const WRITES = new Set<Task['type']>(['implement', 'chore']);

/**
 * Q8: in-flight tasks that overlap this one. Overlap means a shared target, or targets one CALLS hop
 * apart. A task that writes code but names no targets has an unknown footprint, so it conflicts with
 * every other writer. Read-only tasks (plans, reviews) never conflict.
 */
export async function overlappingTasks(graph: Graph, task: Task): Promise<string[]> {
  if (!WRITES.has(task.type)) return [];
  const all = await listTasks(graph);
  const inFlight = all.filter(
    (t) =>
      t.id !== task.id && (IN_FLIGHT as readonly string[]).includes(t.status) && WRITES.has(t.type),
  );
  if (inFlight.length === 0) return [];

  const blockers = new Set<string>();
  if (task.targets.length > 0) {
    const rows = await read<{ id: string }>(
      graph,
      `MATCH (:Task {id: $id})-[:TARGETS]->(s:Symbol)
       MATCH (s)-[:CALLS*0..1]-(near:Symbol)<-[:TARGETS]-(other:Task)
       WHERE other.id <> $id AND other.status IN $statuses
       RETURN DISTINCT other.id AS id`,
      { id: task.id, statuses: [...IN_FLIGHT] },
    );
    for (const r of rows) blockers.add(r.id);
  }
  for (const other of inFlight) {
    if (task.targets.length === 0 || other.targets.length === 0) blockers.add(other.id);
  }
  // only count tasks that really are in flight and write code
  return [...blockers].filter((id) => inFlight.some((t) => t.id === id)).sort();
}

/**
 * How many runs each agent may have at once (its configured `instances`). Extra runs wait their turn
 * in order, so a slow agent never gets more work than it was given slots for.
 */
export class SlotPool {
  private readonly used = new Map<string, number>();
  private readonly waiting = new Map<string, { go: () => void; cancel: () => void }[]>();

  constructor(private readonly limits: Record<string, number>) {}

  inUse(agent: string): number {
    return this.used.get(agent) ?? 0;
  }

  /** Resolves with a release function once a slot is free. Rejects if `signal` aborts while waiting. */
  acquire(agent: string, signal?: AbortSignal): Promise<() => void> {
    const limit = this.limits[agent] ?? 1;
    const take = () => {
      this.used.set(agent, this.inUse(agent) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.used.set(agent, this.inUse(agent) - 1);
        this.waiting.get(agent)?.shift()?.go();
      };
    };
    if (signal?.aborted) return Promise.reject(new Error('aborted'));
    if (this.inUse(agent) < limit) return Promise.resolve(take());

    return new Promise((resolve, reject) => {
      const queue = this.waiting.get(agent) ?? [];
      this.waiting.set(agent, queue);
      const entry = {
        go: () => {
          signal?.removeEventListener('abort', entry.cancel);
          resolve(take());
        },
        cancel: () => {
          const i = queue.indexOf(entry);
          if (i >= 0) queue.splice(i, 1);
          reject(new Error('aborted'));
        },
      };
      queue.push(entry);
      signal?.addEventListener('abort', entry.cancel, { once: true });
    });
  }
}
