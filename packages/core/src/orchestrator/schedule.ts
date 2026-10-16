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
 * A task that names no targets has an unknown footprint. If it is a `chore` (docs, formatting) it is
 * taken to touch files outside the code graph, so it only waits for another untargeted chore. If it
 * is an `implement` task, it could touch anything, so it waits for every other writer (and every
 * writer waits for it).
 */
function unknownFootprint(a: Task, b: Task): boolean {
  const aOpen = a.targets.length === 0;
  const bOpen = b.targets.length === 0;
  if (!aOpen && !bOpen) return false;
  const wideOpen = (t: Task, open: boolean) => open && t.type === 'implement';
  if (wideOpen(a, aOpen) || wideOpen(b, bOpen)) return true;
  return aOpen && bOpen; // two untargeted chores
}

/** How many of the most load-bearing functions (by betweenness) count as choke points */
export const CHOKE_POINTS = 3;

/** The file part of a symbol id (`src/a.ts::f` → `src/a.ts`) */
const fileOf = (symbolId: string) => symbolId.split('::')[0]!;

/**
 * Q8: in-flight tasks that overlap this one, and why. Overlap means a shared target, or targets one
 * CALLS hop apart, or (Q29) any code in the same module as a choke point. See `unknownFootprint` for tasks that name no targets. Read-only tasks (plans, reviews)
 * never conflict. With the graph off (the ablation) overlap is only "targets in the same file".
 */
export async function overlapDetails(
  graph: Graph,
  task: Task,
  opts: { graphOff?: boolean } = {},
): Promise<{ id: string; why: string }[]> {
  if (!WRITES.has(task.type)) return [];
  const all = await listTasks(graph);
  const inFlight = all.filter(
    (t) =>
      t.id !== task.id && (IN_FLIGHT as readonly string[]).includes(t.status) && WRITES.has(t.type),
  );
  if (inFlight.length === 0) return [];

  const blockers = new Set<string>();
  const why = new Map<string, string>();
  const block = (id: string, reason: string) => {
    blockers.add(id);
    if (!why.has(id)) why.set(id, reason);
  };
  if (opts.graphOff) {
    const mine = new Set(task.targets.map(fileOf));
    for (const other of inFlight)
      if (other.targets.some((t) => mine.has(fileOf(t)))) block(other.id, 'same file');
  } else if (task.targets.length > 0) {
    // Which of my functions meets which of theirs, and how: the same function, or one call apart
    const rows = await read<{ id: string; mine: string; theirs: string; how: string }>(
      graph,
      `MATCH (:Task {id: $id})-[:TARGETS]->(s:Symbol)
       MATCH (s)-[:CALLS*0..1]-(near:Symbol)<-[:TARGETS]-(other:Task)
       WHERE other.id <> $id AND other.status IN $statuses
       // exists((s)-[:CALLS]->(near)) ignores the direction when both ends are bound; a match does not
       OPTIONAL MATCH (s)-[c:CALLS]->(near)
       RETURN DISTINCT other.id AS id, s.id AS mine, near.id AS theirs,
              CASE WHEN s = near THEN 'same' WHEN c IS NOT NULL THEN 'calls' ELSE 'called' END AS how
       ORDER BY id, how DESC, mine, theirs`,
      { id: task.id, statuses: [...IN_FLIGHT] },
    );
    for (const r of rows) block(r.id, edgeReason(r.id, r.mine, r.theirs, r.how));
    // Q29: a choke point (the code most paths run through) does not share its module with anyone else
    const choke = await read<{ other: string; symbol: string; module: string }>(
      graph,
      `MATCH (s:Symbol) WHERE s.betweenness > 0 AND coalesce(s.removed, false) = false
       WITH s ORDER BY s.betweenness DESC, s.id LIMIT $k
       WITH collect(s.id) AS choke
       MATCH (:Task {id: $id})-[:TARGETS]->(mine:Symbol)-[:IN_MODULE]->(m:Module)
       MATCH (other:Task)-[:TARGETS]->(theirs:Symbol)-[:IN_MODULE]->(m)
       WHERE other.id <> $id AND other.status IN $statuses AND (mine.id IN choke OR theirs.id IN choke)
       RETURN DISTINCT other.id AS other,
              CASE WHEN mine.id IN choke THEN mine.name ELSE theirs.name END AS symbol, m.name AS module`,
      { id: task.id, statuses: [...IN_FLIGHT], k: CHOKE_POINTS },
    );
    for (const r of choke)
      block(r.other, `${r.symbol}() is a choke point in the ${r.module} module`);
  }
  for (const other of inFlight) {
    if (unknownFootprint(task, other)) block(other.id, 'a task with no named targets');
  }
  // only count tasks that really are in flight and write code
  const ids = [...blockers].filter((id) => inFlight.some((t) => t.id === id)).sort();
  return ids.map((id) => ({ id, why: why.get(id) ?? 'overlapping code' }));
}

const fn = (symbolId: string) => `${symbolId.split('::')[1] ?? symbolId}()`;

/** The overlap in words, naming both functions and which way the call goes */
function edgeReason(other: string, mine: string, theirs: string, how: string): string {
  if (how === 'same') return `both change ${fn(mine)}`;
  if (how === 'calls') return `${fn(mine)} calls ${fn(theirs)}, which ${other} changes`;
  return `${other} changes ${fn(theirs)}, which calls ${fn(mine)}`;
}

/** How far apart (in calls) Q31 still reports running work as nearby */
export const NEARBY_HOPS = 3;

/**
 * Q31: running work that is near this task in the call graph but not near enough to wait for: the shortest
 * call path, in either direction (`algo.SPpaths`), from one of its functions to one of theirs, 2 to
 * NEARBY_HOPS calls long. Such tasks run side by side; the schedule trace says how close they are.
 */
export async function nearbyWork(
  graph: Graph,
  task: Task,
): Promise<{ id: string; hops: number; path: string[] }[]> {
  if (task.targets.length === 0 || !WRITES.has(task.type)) return [];
  const rows = await read<{ id: string; hops: number; path: string[] }>(
    graph,
    `MATCH (:Task {id: $id})-[:TARGETS]->(s:Symbol), (other:Task)-[:TARGETS]->(t:Symbol)
     WHERE other.id <> $id AND other.status IN $statuses AND other.type IN $writes AND s <> t
     CALL algo.SPpaths({sourceNode: s, targetNode: t, relTypes: ['CALLS'], relDirection: 'both',
                        maxLen: $max, pathCount: 1})
     YIELD path, pathWeight
     RETURN other.id AS id, pathWeight AS hops, [n IN nodes(path) | n.id] AS path
     ORDER BY hops, id`,
    { id: task.id, statuses: [...IN_FLIGHT], writes: [...WRITES], max: NEARBY_HOPS },
  );
  const best = new Map<string, { id: string; hops: number; path: string[] }>();
  for (const r of rows) {
    const hops = Number(r.hops);
    if (hops >= 2 && !best.has(r.id)) best.set(r.id, { id: r.id, hops, path: r.path });
  }
  return [...best.values()];
}

/** A call path as people read it: `postLogin() → login() → audit()` */
export const pathText = (path: string[]): string => path.map(fn).join(' → ');

/** In-flight tasks that overlap this one (ids only). */
export async function overlappingTasks(
  graph: Graph,
  task: Task,
  opts: { graphOff?: boolean } = {},
): Promise<string[]> {
  return (await overlapDetails(graph, task, opts)).map((d) => d.id);
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
