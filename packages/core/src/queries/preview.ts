// Previews on a copy of the graph (P18). FalkorDB's GRAPH.COPY makes a full copy of the project graph
// in milliseconds; Puff changes the copy, compares it with the real one, and throws the copy away.
//
//   Merge preview (Q25)  index a task's branch into a copy: which functions and calls it adds, removes
//                        or changes, which lessons it would make outdated, and which load-bearing
//                        functions gain new callers. Stored on the task before the merge happens.
//   Plan preview (Q26)   put a goal's tasks on a copy and run the scheduler dry: which start together,
//                        which wait, for what, and why. Nothing real is claimed or run.
import type { Graph } from 'falkordb';
import type { MergePreview, PlanPreview, PlanWave, Task } from '@puff/shared';
import { openSibling, read, run } from '../db/client';
import { graphName, newId } from '../ids';
import { indexRepo } from '../indexer/index';
import { listTasks, updateTask } from '../memory/tasks';
import { overlappingTasks } from '../orchestrator/schedule';

/** Copies are named after the project graph, so they are easy to recognise and to clean up. */
export const PREVIEW_MARK = '__preview_';
export const previewName = (slug: string, purpose: string) =>
  `${graphName(slug)}${PREVIEW_MARK}${purpose}_${Date.now().toString(36)}`;
export const isPreviewGraph = (name: string) => name.includes(PREVIEW_MARK);

/** Copy the project graph, use the copy, always delete it. */
export async function withGraphCopy<T>(
  graph: Graph,
  name: string,
  fn: (copy: Graph) => Promise<T>,
): Promise<T> {
  await graph.copy(name);
  const copy = openSibling(graph, name);
  try {
    return await fn(copy);
  } finally {
    await copy.delete().catch(() => {});
  }
}

type SymbolRow = { id: string; hash: string | null };
type MemoryRow = { id: string; kind: string; text: string };

const symbols = (g: Graph) =>
  read<SymbolRow>(
    g,
    `MATCH (s:Symbol) WHERE coalesce(s.removed, false) = false
     RETURN s.id AS id, s.bodyHash AS hash`,
  );
const calls = (g: Graph) =>
  read<{ edge: string }>(
    g,
    `MATCH (a:Symbol)-[:CALLS]->(b:Symbol)
     WHERE coalesce(a.removed, false) = false AND coalesce(b.removed, false) = false
     RETURN a.id + ' -> ' + b.id AS edge`,
  );
const stale = (g: Graph) =>
  read<MemoryRow>(
    g,
    `MATCH (m) WHERE labels(m)[0] IN ['Failure', 'Decision'] AND coalesce(m.stale, false) = true
     RETURN m.id AS id, labels(m)[0] AS kind, coalesce(m.message, m.text) AS text`,
  );

const name = (id: string) => `${id.split('::')[1] ?? id}()`;

/**
 * Q25: what merging `branchPath` (a task's worktree) would change in the graph. The real graph is not
 * touched: the branch is indexed into a copy, and the two are compared.
 */
export async function previewMerge(
  graph: Graph,
  opts: { slug: string; taskId: string; branchPath: string; riskThreshold?: number },
): Promise<MergePreview> {
  const started = performance.now();
  const threshold = opts.riskThreshold ?? 0.9;
  const [before, beforeCalls, beforeStale, risky] = await Promise.all([
    symbols(graph),
    calls(graph),
    stale(graph),
    read<{ id: string; risk: number }>(
      graph,
      `MATCH (s:Symbol) WHERE s.risk >= $t RETURN s.id AS id, s.risk AS risk`,
      { t: threshold },
    ),
  ]);
  const after = await withGraphCopy(graph, previewName(opts.slug, 'merge'), async (copy) => {
    // the real indexer, on the copy: it also marks memory about changed functions stale there
    await indexRepo(copy, { slug: opts.slug, repoPath: opts.branchPath }, { graphOff: false });
    const [s, c, m] = await Promise.all([symbols(copy), calls(copy), stale(copy)]);
    return { symbols: s, calls: c, stale: m };
  });

  const was = new Map(before.map((s) => [s.id, s.hash]));
  const now = new Map(after.symbols.map((s) => [s.id, s.hash]));
  const symbolsAdded = [...now.keys()].filter((id) => !was.has(id)).sort();
  const symbolsRemoved = [...was.keys()].filter((id) => !now.has(id)).sort();
  const symbolsChanged = [...now.keys()]
    .filter((id) => was.has(id) && was.get(id) && now.get(id) && was.get(id) !== now.get(id))
    .sort();
  const callsWas = new Set(beforeCalls.map((c) => c.edge));
  const callsNow = new Set(after.calls.map((c) => c.edge));
  const split = (edge: string) => {
    const [from, to] = edge.split(' -> ');
    return { from: from!, to: to! };
  };
  const callsAdded = [...callsNow]
    .filter((e) => !callsWas.has(e))
    .sort()
    .map(split);
  const callsRemoved = [...callsWas]
    .filter((e) => !callsNow.has(e))
    .sort()
    .map(split);
  const staleWas = new Set(beforeStale.map((m) => m.id));
  const wouldGoStale = after.stale.filter((m) => !staleWas.has(m.id));
  const riskOf = new Map(risky.map((r) => [r.id, Number(r.risk)]));
  const newCallersOfRisky = callsAdded
    .filter((c) => riskOf.has(c.to))
    .map((c) => ({ ...c, risk: riskOf.get(c.to)! }));

  const parts = [
    symbolsAdded.length && `${symbolsAdded.length} function(s) added`,
    symbolsChanged.length && `${symbolsChanged.length} changed`,
    symbolsRemoved.length && `${symbolsRemoved.length} removed`,
    (callsAdded.length || callsRemoved.length) &&
      `${callsAdded.length} call(s) added, ${callsRemoved.length} removed`,
    wouldGoStale.length && `${wouldGoStale.length} lesson(s) would become possibly outdated`,
    newCallersOfRisky.length &&
      `new callers of load-bearing ${[...new Set(newCallersOfRisky.map((c) => name(c.to)))].join(', ')}`,
  ].filter(Boolean);
  return {
    taskId: opts.taskId,
    at: Date.now(),
    ms: Math.round(performance.now() - started),
    symbolsAdded,
    symbolsRemoved,
    symbolsChanged,
    callsAdded,
    callsRemoved,
    wouldGoStale,
    newCallersOfRisky,
    summary: parts.length ? parts.join('; ') : 'No change to the code graph',
  };
}

/** Keep the newest preview of each kind on the task. */
export async function saveMergePreview(graph: Graph, preview: MergePreview): Promise<void> {
  await run(
    graph,
    `MATCH (t:Task {id: $task})
     OPTIONAL MATCH (t)-[:PREVIEWED]->(old:MergePreview)
     DETACH DELETE old`,
    { task: preview.taskId },
  );
  await run(
    graph,
    `MATCH (t:Task {id: $task})
     CREATE (t)-[:PREVIEWED]->(:MergePreview {id: $id, at: $at, summary: $summary, data: $data})`,
    {
      task: preview.taskId,
      id: newId('Preview'),
      at: preview.at,
      summary: preview.summary,
      data: JSON.stringify(preview),
    },
  );
}

export async function getMergePreview(
  graph: Graph,
  taskId: string,
): Promise<MergePreview | undefined> {
  const rows = await read<{ data: string }>(
    graph,
    `MATCH (:Task {id: $id})-[:PREVIEWED]->(p:MergePreview) RETURN p.data AS data ORDER BY p.at DESC LIMIT 1`,
    { id: taskId },
  );
  return rows[0] ? (JSON.parse(rows[0].data) as MergePreview) : undefined;
}

/**
 * Q26: how these tasks would run, without running them. On a copy of the graph, tasks are started in
 * waves the way the scheduler does: a task starts when what it depends on is done and no running task
 * overlaps it (Q8), at most `maxParallel` at a time. Agent slots are not simulated.
 */
export async function previewPlan(
  graph: Graph,
  opts: { slug: string; taskIds?: string[]; maxParallel: number; graphOff?: boolean },
): Promise<PlanPreview> {
  const started = performance.now();
  return withGraphCopy(graph, previewName(opts.slug, 'plan'), async (copy) => {
    const all = await listTasks(copy);
    const wanted = new Set(
      opts.taskIds?.length
        ? opts.taskIds
        : all.filter((t) => t.status === 'planned' || t.status === 'ready').map((t) => t.id),
    );
    // Only the plan's tasks matter here: anything else in flight in the copy is left as it is.
    const titles = new Map(all.map((t) => [t.id, t.title]));
    const done = new Set(all.filter((t) => t.status === 'done').map((t) => t.id));
    let left = all.filter((t) => wanted.has(t.id));
    const waves: PlanWave[] = [];
    let guard = 0;
    while (left.length && guard++ < 50) {
      const wave: PlanWave = { start: [], waits: [] };
      const ready = left
        .filter((t) => t.dependsOn.every((d) => done.has(d) || !wanted.has(d)))
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const t of left.filter((x) => !ready.includes(x))) {
        const on = t.dependsOn.filter((d) => wanted.has(d) && !done.has(d));
        wave.waits.push({
          task: t.id,
          for: on,
          reason: `depends on ${on.map((d) => `"${titles.get(d) ?? d}"`).join(', ')}`,
        });
      }
      for (const t of ready) {
        if (wave.start.length >= opts.maxParallel) {
          wave.waits.push({ task: t.id, for: [], reason: `at most ${opts.maxParallel} at a time` });
          continue;
        }
        // tasks started in this wave are "running" in the copy, so the overlap check sees them
        const blockers = await overlappingTasks(copy, t as Task, { graphOff: opts.graphOff });
        if (blockers.length) {
          wave.waits.push({
            task: t.id,
            for: blockers,
            reason: `${opts.graphOff ? 'same file as' : 'touches the same code as'} ${blockers
              .map((b) => `"${titles.get(b) ?? b}"`)
              .join(', ')}`,
          });
          continue;
        }
        await updateTask(copy, t.id, { status: 'running' });
        wave.start.push(t.id);
      }
      if (!wave.start.length) {
        // nothing can start: a dependency outside the plan, or a cycle
        waves.push(wave);
        break;
      }
      waves.push(wave);
      for (const id of wave.start) {
        await updateTask(copy, id, { status: 'done' });
        done.add(id);
      }
      left = left.filter((t) => !wave.start.includes(t.id));
    }
    const lanes = await planLanes(
      copy,
      all.filter((t) => wanted.has(t.id)),
      opts.graphOff,
    );
    return {
      at: Date.now(),
      ms: Math.round(performance.now() - started),
      tasks: [...wanted],
      titles: Object.fromEntries([...wanted].map((id) => [id, titles.get(id) ?? id])),
      waves,
      stuck: left.map((t) => t.id),
      lanes,
    };
  });
}

/**
 * Q30: the plan's independent lanes, on the copy. Two tasks are tied when they would collide (a shared
 * function or one call apart, the Q8 rule, whatever their status), when one depends on the other, or when
 * either changes code without naming it. The ties are written as CONFLICTS edges (on the copy only), and
 * weakly connected components (`algo.WCC`) over tasks and those edges are the lanes: a lane runs its
 * tasks one after another, and different lanes never touch each other's code, so the number of lanes is
 * how many agents the plan can keep busy without collisions.
 */
export async function planLanes(
  copy: Graph,
  tasks: Task[],
  graphOff = false,
): Promise<{ tasks: string[]; ties: string[] }[]> {
  const ids = tasks.map((t) => t.id);
  if (ids.length === 0) return [];
  const pairs: { a: string; b: string; why: string }[] = [];
  const writes = (t: Task) => t.type === 'implement' || t.type === 'chore';
  if (graphOff) {
    const file = (s: string) => s.split('::')[0];
    for (const a of tasks)
      for (const b of tasks)
        if (a.id < b.id && a.targets.some((x) => b.targets.some((y) => file(x) === file(y))))
          pairs.push({ a: a.id, b: b.id, why: 'same file' });
  } else {
    const rows = await read<{ a: string; b: string; s: string; n: string }>(
      copy,
      `MATCH (a:Task)-[:TARGETS]->(s:Symbol)-[:CALLS*0..1]-(n:Symbol)<-[:TARGETS]-(b:Task)
       WHERE a.id IN $ids AND b.id IN $ids AND a.id < b.id
       RETURN DISTINCT a.id AS a, b.id AS b, s.name AS s, n.name AS n`,
      { ids },
    );
    for (const r of rows)
      pairs.push({ a: r.a, b: r.b, why: r.s === r.n ? `${r.s}()` : `${r.s}() and ${r.n}()` });
  }
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const t of tasks) {
    for (const d of t.dependsOn) if (byId.has(d)) pairs.push({ a: t.id, b: d, why: 'depends on' });
    // a writer that names no code could touch anything another writer touches
    if (writes(t) && t.type === 'implement' && t.targets.length === 0)
      for (const o of tasks)
        if (o.id !== t.id && writes(o)) pairs.push({ a: t.id, b: o.id, why: 'names no code' });
  }
  await run(
    copy,
    `UNWIND $pairs AS p
     MATCH (a:Task {id: p.a}), (b:Task {id: p.b})
     MERGE (a)-[:CONFLICTS]->(b)`,
    { pairs },
  );
  const rows = await read<{ id: string; lane: number }>(
    copy,
    `CALL algo.WCC({nodeLabels: ['Task'], relationshipTypes: ['CONFLICTS']})
     YIELD node, componentId
     WITH node, componentId WHERE node.id IN $ids
     RETURN node.id AS id, componentId AS lane`,
    { ids },
  );
  const lanes = new Map<number, string[]>();
  for (const r of rows) lanes.set(Number(r.lane), [...(lanes.get(Number(r.lane)) ?? []), r.id]);
  const order = new Map(tasks.map((t, i) => [t.id, i]));
  return [...lanes.values()]
    .map((members) => {
      const inLane = new Set(members);
      const ties = [
        ...new Set(pairs.filter((p) => inLane.has(p.a) && inLane.has(p.b)).map((p) => p.why)),
      ];
      return { tasks: members.sort((x, y) => order.get(x)! - order.get(y)!), ties };
    })
    .sort(
      (x, y) =>
        y.tasks.length - x.tasks.length || order.get(x.tasks[0]!)! - order.get(y.tasks[0]!)!,
    );
}

/** Delete preview copies a crash left behind. */
export async function cleanPreviewGraphs(
  list: () => Promise<string[]>,
  drop: (name: string) => Promise<unknown>,
  slug: string,
): Promise<number> {
  const mine = (await list()).filter((g) => g.startsWith(`${graphName(slug)}${PREVIEW_MARK}`));
  for (const g of mine) await drop(g).catch(() => {});
  return mine.length;
}

/** The plan preview for a plan task: its tasks that have not finished yet, dry-run on a copy. */
export async function planPreviewFor(
  graph: Graph,
  opts: { slug: string; taskId: string; maxParallel: number; graphOff?: boolean },
): Promise<PlanPreview | undefined> {
  const children = await read<{ id: string }>(
    graph,
    `MATCH (:Task {id: $id})<-[:WORKED_ON]-(:Session)-[:SPAWNED]->(t:Task)
     WHERE t.status <> 'done'
     RETURN DISTINCT t.id AS id`,
    { id: opts.taskId },
  );
  if (!children.length) return undefined;
  return previewPlan(graph, { ...opts, taskIds: children.map((c) => c.id) });
}
