// Modules and what each agent knows about them (P17).
//
//   (Symbol)-[:IN_MODULE]->(Module {id, name, size})        recomputed after every index
//   (Module)-[:DEPENDS_ON {calls}]->(Module)                 how many CALLS cross from one module to another
//   (Agent)-[:KNOWS {runs, wins, lastAt}]->(Module)          what each agent has done in a module
//
// A module is a folder: the first directory below the source root (`auth` for `src/auth/login.ts`), or
// `core/orchestrator`-style for a monorepo package. Folders are what people mean by a module. Label
// propagation over CALLS was tried first and clusters around shared utilities instead (users, products
// and middleware code land together), so CALLS is used for what it is good at: how modules depend on
// each other (Q27).
import type { Graph } from 'falkordb';
import { read, run } from '../db/client';

/** Folders whose children are separate packages in a monorepo */
const PACKAGE_ROOTS = new Set(['packages', 'apps', 'services', 'libs']);
const SOURCE_DIRS = new Set(['src', 'source']);

const dirOf = (path: string) => path.split('/').slice(0, -1);

/** The directory every file shares (`my-app` when the whole project lives in one folder), if any. */
export function commonDirPrefix(paths: string[]): string[] {
  if (!paths.length) return [];
  let prefix = dirOf(paths[0]!);
  for (const p of paths.slice(1)) {
    const d = dirOf(p);
    let i = 0;
    while (i < prefix.length && i < d.length && prefix[i] === d[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix.length) break;
  }
  return prefix;
}

/** The module a file belongs to, given the directory all files share. */
export function moduleOf(path: string, prefix: string[] = []): string {
  let dirs = dirOf(path);
  // drop the shared prefix, then the source root
  if (prefix.length && prefix.every((s, i) => dirs[i] === s)) dirs = dirs.slice(prefix.length);
  if (dirs[0] && SOURCE_DIRS.has(dirs[0])) dirs = dirs.slice(1);
  if (dirs[0] && PACKAGE_ROOTS.has(dirs[0]) && dirs.length > 1) {
    const pkg = dirs[1]!;
    let rest = dirs.slice(2);
    if (rest[0] && SOURCE_DIRS.has(rest[0])) rest = rest.slice(1);
    return rest[0] ? `${pkg}/${rest[0]}` : pkg;
  }
  return dirs[0] ?? '(root)';
}

export interface ModuleInfo {
  id: string;
  name: string;
  size: number;
  /** Modules it calls into, and how many calls */
  dependsOn: { module: string; calls: number }[];
}

const SEP = '\u0001';

/**
 * Q27: put every function in a module, and count the calls between modules. Recomputed after every
 * index (a function may have moved, been added or removed); safe to run again.
 */
export async function computeModules(graph: Graph): Promise<ModuleInfo[]> {
  const syms = await read<{ id: string; file: string }>(
    graph,
    `MATCH (s:Symbol) WHERE coalesce(s.removed, false) = false RETURN s.id AS id, s.file AS file`,
  );
  if (!syms.length) return [];
  const prefix = commonDirPrefix([...new Set(syms.map((s) => s.file))]);
  const modOf = new Map(syms.map((s) => [s.id, moduleOf(s.file, prefix)]));
  const size = new Map<string, number>();
  for (const m of modOf.values()) size.set(m, (size.get(m) ?? 0) + 1);

  // symbols: replace their module edge, then drop modules nothing is in any more
  await run(graph, `MATCH (:Symbol)-[r:IN_MODULE]->(:Module) DELETE r`);
  const rows = syms.map((s) => ({ id: s.id, module: modOf.get(s.id)! }));
  for (let i = 0; i < rows.length; i += 500) {
    await run(
      graph,
      `UNWIND $rows AS r
       MATCH (s:Symbol {id: r.id})
       MERGE (m:Module {id: r.module}) SET m.name = r.module
       MERGE (s)-[:IN_MODULE]->(m)`,
      { rows: rows.slice(i, i + 500) },
    );
  }
  await run(graph, `UNWIND $sizes AS x MATCH (m:Module {id: x.id}) SET m.size = x.size`, {
    sizes: [...size].map(([id, n]) => ({ id, size: n })),
  });
  await run(graph, `MATCH (m:Module) WHERE NOT (:Symbol)-[:IN_MODULE]->(m) DETACH DELETE m`);

  // module to module: CALLS that cross a module boundary, counted
  const edges = await read<{ a: string; b: string }>(
    graph,
    `MATCH (a:Symbol)-[:CALLS]->(b:Symbol)
     WHERE coalesce(a.removed, false) = false AND coalesce(b.removed, false) = false
     RETURN a.id AS a, b.id AS b`,
  );
  const deps = new Map<string, number>();
  for (const e of edges) {
    const from = modOf.get(e.a);
    const to = modOf.get(e.b);
    if (from && to && from !== to)
      deps.set(`${from}${SEP}${to}`, (deps.get(`${from}${SEP}${to}`) ?? 0) + 1);
  }
  await run(graph, `MATCH (:Module)-[r:DEPENDS_ON]->(:Module) DELETE r`);
  const depRows = [...deps].map(([k, calls]) => {
    const [from, to] = k.split(SEP);
    return { from: from!, to: to!, calls };
  });
  if (depRows.length)
    await run(
      graph,
      `UNWIND $rows AS r
       MATCH (a:Module {id: r.from}), (b:Module {id: r.to})
       MERGE (a)-[d:DEPENDS_ON]->(b) SET d.calls = r.calls`,
      { rows: depRows },
    );

  return [...size]
    .map(([id, n]) => ({
      id,
      name: id,
      size: n,
      dependsOn: depRows
        .filter((d) => d.from === id)
        .map((d) => ({ module: d.to, calls: d.calls }))
        .sort((a, b) => b.calls - a.calls),
    }))
    .sort((a, b) => b.size - a.size || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------------------------
// Expertise
// ---------------------------------------------------------------------------------------------

/**
 * Q28: what each agent has done in each module, from the sessions that worked on tasks targeting code
 * in it (only runs that ended as a success or a failure count: an agent that could not start has shown
 * nothing about the code). Stored as (Agent)-[:KNOWS]->(Module) so the graph and the app can show it.
 * Computed from history every time, so it is also right for sessions recorded before modules existed.
 */
export async function refreshExpertise(graph: Graph): Promise<void> {
  const rows = await read<{
    agent: string;
    module: string;
    runs: number;
    wins: number;
    last: number;
  }>(
    graph,
    `MATCH (a:Agent)-[:RAN]->(s:Session)-[:WORKED_ON]->(:Task)-[:TARGETS]->(:Symbol)-[:IN_MODULE]->(m:Module)
     WHERE s.outcome IN ['success', 'failure']
     WITH a, m, collect(DISTINCT s) AS ss
     RETURN a.name AS agent, m.id AS module, size(ss) AS runs,
            size([x IN ss WHERE x.outcome = 'success']) AS wins,
            reduce(l = 0, x IN ss | CASE WHEN coalesce(x.endedAt, 0) > l THEN x.endedAt ELSE l END) AS last`,
  );
  if (!rows.length) return;
  await run(
    graph,
    `UNWIND $rows AS r
     MATCH (a:Agent {name: r.agent}), (m:Module {id: r.module})
     MERGE (a)-[k:KNOWS]->(m)
     SET k.runs = r.runs, k.wins = r.wins, k.lastAt = r.last`,
    {
      rows: rows.map((r) => ({
        ...r,
        runs: Number(r.runs),
        wins: Number(r.wins),
        last: Number(r.last),
      })),
    },
  );
}

export interface Expertise {
  module: string;
  runs: number;
  wins: number;
}

/** Each agent's record in the given modules (all of them when none are given). */
export async function agentExpertise(
  graph: Graph,
  modules?: string[],
): Promise<Map<string, Expertise[]>> {
  const rows = await read<{ agent: string; module: string; runs: number; wins: number }>(
    graph,
    `MATCH (a:Agent)-[k:KNOWS]->(m:Module) WHERE $all OR m.id IN $modules
     RETURN a.name AS agent, m.id AS module, k.runs AS runs, k.wins AS wins ORDER BY runs DESC`,
    { all: !modules, modules: modules ?? [] },
  );
  const out = new Map<string, Expertise[]>();
  for (const r of rows) {
    const list = out.get(r.agent) ?? [];
    list.push({ module: r.module, runs: Number(r.runs), wins: Number(r.wins) });
    out.set(r.agent, list);
  }
  return out;
}

/** The modules a task's targets are in. */
export async function taskModules(graph: Graph, taskId: string): Promise<string[]> {
  return (
    await read<{ m: string }>(
      graph,
      `MATCH (:Task {id: $id})-[:TARGETS]->(:Symbol)-[:IN_MODULE]->(m:Module) RETURN DISTINCT m.id AS m ORDER BY m`,
      { id: taskId },
    )
  ).map((r) => r.m);
}

/** Runs needed in a module before an agent's record there can outweigh its declared strengths. */
export const EXPERTISE_MIN_RUNS = 3;
/** How much better (smoothed win rate) an agent must be in the module than the declared best to take the lead. */
export const EXPERTISE_MARGIN = 0.25;
/** Smoothing toward 0.5: this many imaginary runs at 50% are added to every record. */
const PRIOR_RUNS = 2;

/** A win rate pulled toward the neutral 0.5 when there are few runs behind it. */
export const smoothedRate = (wins: number, runs: number): number =>
  (wins + 0.5 * PRIOR_RUNS) / (runs + PRIOR_RUNS);
