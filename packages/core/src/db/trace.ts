// Graph traces: which queries a decision ran, how long they took and how many rows they returned. A
// decision (route a task, compile its context, check what it overlaps, mark memory stale, locate a
// failure) runs inside `traced()`; every `read`/`run` in it is collected without passing anything
// down. The result is stored as (:Trace)-[:FOR]->(:Task|:Session), so the app can show the actual
// Cypher behind each decision (Q19).
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Graph } from 'falkordb';
import type { GraphTrace, TraceKind, TraceStep } from '@puff/shared';
import { newId } from '../ids';

const collector = new AsyncLocalStorage<TraceStep[]>();

/** Called by `read` and `run` for every query. Does nothing outside `traced()`. */
export function noteQuery(
  cypher: string,
  params: Record<string, unknown>,
  ms: number,
  rows: number,
): void {
  const steps = collector.getStore();
  if (!steps) return;
  steps.push({
    cypher: cypher.replace(/\n\s+/g, '\n  ').trim(),
    params: Object.keys(params),
    ms: Math.round(ms * 100) / 100,
    rows,
  });
}

/** Run `fn`, collecting the queries it makes. Nested calls collect into their own list only. */
export async function traced<T>(fn: () => Promise<T>): Promise<{ value: T; steps: TraceStep[] }> {
  const steps: TraceStep[] = [];
  const value = await collector.run(steps, fn);
  return { value, steps };
}

/** Steps kept per trace, and characters kept per query, so a trace stays small. */
const MAX_STEPS = 16;
const MAX_CYPHER = 1500;
/** Traces kept per task or session for each kind (the scheduler checks again and again while a task waits). */
const KEEP_PER_KIND = 5;

export interface TraceOwner {
  taskId?: string;
  sessionId?: string;
}

/**
 * Store one decision's trace. Never throws: a trace is a record of what happened, and failing to
 * write it must not fail the decision itself. The query below is not traced (it uses graph.query).
 */
export async function saveTrace(
  graph: Graph,
  owner: TraceOwner,
  trace: { kind: TraceKind; reason: string; steps: TraceStep[]; graphOff?: boolean },
): Promise<void> {
  const ownerLabel = owner.sessionId ? 'Session' : owner.taskId ? 'Task' : undefined;
  if (!ownerLabel) return;
  const ownerId = owner.sessionId ?? owner.taskId!;
  const kept = trace.steps.slice(0, MAX_STEPS).map((s) => ({
    ...s,
    cypher: s.cypher.length > MAX_CYPHER ? `${s.cypher.slice(0, MAX_CYPHER - 1)}…` : s.cypher,
  }));
  const ms = Math.round(trace.steps.reduce((n, s) => n + s.ms, 0) * 100) / 100;
  const rows = trace.steps.reduce((n, s) => n + s.rows, 0);
  try {
    // The owner label comes from a closed set, never from input.
    await graph.query(
      `MATCH (o:${ownerLabel} {id: $owner})
       CREATE (t:Trace {id: $id, kind: $kind, reason: $reason, steps: $steps, queries: $queries,
                        ms: $ms, rows: $rows, graphOff: $graphOff, at: timestamp()})-[:FOR]->(o)
       WITH o
       MATCH (old:Trace {kind: $kind})-[:FOR]->(o)
       WITH old ORDER BY old.at DESC SKIP $keep
       DETACH DELETE old`,
      {
        params: {
          owner: ownerId,
          id: newId('Trace'),
          kind: trace.kind,
          reason: trace.reason,
          steps: JSON.stringify(kept),
          queries: trace.steps.length,
          ms,
          rows,
          graphOff: trace.graphOff ?? false,
          keep: KEEP_PER_KIND,
        } as never,
      },
    );
  } catch {
    // see above
  }
}

/** Run a decision and store its trace in one go. `reason` turns the decision's result into words. */
export async function tracedDecision<T>(
  graph: Graph,
  owner: TraceOwner,
  kind: TraceKind,
  fn: () => Promise<T>,
  reason: (value: T) => string,
  graphOff = false,
): Promise<T> {
  const { value, steps } = await traced(fn);
  await saveTrace(graph, owner, { kind, reason: reason(value), steps, graphOff });
  return value;
}

/** Q19: every trace for a task and the sessions that worked on it, newest first. */
export async function listTraces(graph: Graph, taskId: string): Promise<GraphTrace[]> {
  const res = await graph.roQuery<{
    id: string;
    kind: string;
    reason: string;
    steps: string;
    queries: number;
    ms: number;
    rows: number;
    graphOff: boolean;
    at: number;
    sessionId: string | null;
  }>(
    `MATCH (t:Trace)-[:FOR]->(:Task {id: $id})
     RETURN t.id AS id, t.kind AS kind, t.reason AS reason, t.steps AS steps, t.queries AS queries,
            t.ms AS ms, t.rows AS rows, coalesce(t.graphOff, false) AS graphOff, t.at AS at, null AS sessionId
     UNION
     MATCH (t:Trace)-[:FOR]->(se:Session)-[:WORKED_ON]->(:Task {id: $id})
     RETURN t.id AS id, t.kind AS kind, t.reason AS reason, t.steps AS steps, t.queries AS queries,
            t.ms AS ms, t.rows AS rows, coalesce(t.graphOff, false) AS graphOff, t.at AS at, se.id AS sessionId`,
    { params: { id: taskId } as never },
  );
  return (res.data ?? [])
    .map((r) => ({
      id: r.id,
      kind: r.kind as TraceKind,
      reason: r.reason,
      steps: JSON.parse(r.steps || '[]') as TraceStep[],
      queries: Number(r.queries),
      ms: Number(r.ms),
      rows: Number(r.rows),
      graphOff: Boolean(r.graphOff) || undefined,
      at: Number(r.at),
      sessionId: r.sessionId ?? undefined,
    }))
    .sort((a, b) => b.at - a.at);
}
