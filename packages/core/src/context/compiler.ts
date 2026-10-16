// Context compiler: given a task and a role, ask the graph what this agent needs to know, rank it,
// fit it into a token budget, and record exactly what was sent and why (the ContextPack).
// Everything the agent receives carries a reason, stored on the INCLUDED edge (design rule 6).
import type { Graph } from 'falkordb';
import type { ContextItem, ContextPack, MemoryKind, Role } from '@puff/shared';
import { graphOff as graphIsOff } from '../config';
import { read, run } from '../db/client';
import { saveTrace, traced } from '../db/trace';
import { newId } from '../ids';
import { getTask, listTasks } from '../memory/tasks';
import { pendingHandoffs } from '../memory/memory';
import { symbolInfos, type SymbolRow } from '../queries/code';
import { similarFailures, taskRisk, type TaskRisk } from '../queries/insights';
import { estimateTokens, renderPrompt, type PromptInput } from './prompt';

export const DEFAULT_BUDGET_TOKENS = 2000;

export interface CompileOptions {
  role: Role;
  /** Session the pack is delivered to. Required unless `preview` is set. */
  sessionId?: string;
  budgetTokens?: number;
  /** Build the context without writing a ContextPack or marking handoffs delivered */
  preview?: boolean;
  /** Planner only: how many tasks a plan may contain */
  maxTasks?: number;
  /** Verifier only: the diff under review and the command that runs the tests */
  diff?: string;
  testCommand?: string;
  at?: number;
  /** The ablation: the task and its target files only, nothing chosen by the graph. Default: PUFF_GRAPH */
  graphOff?: boolean;
  /** Risk (0 to 1) at or above which the task gets a 1.5× budget; default 0.9 (config graph.riskThreshold) */
  riskThreshold?: number;
}

export type CompiledContext = ContextPack & {
  /** Memory items left out to stay inside the budget */
  dropped: number;
  /** The budget actually used (bigger for risky code) */
  budgetTokens: number;
  /** The riskiest function the task targets, when risk is known */
  risk?: TaskRisk;
};

/** Load-bearing code gets this much more room for what the team learned about it. */
export const RISK_BUDGET_FACTOR = 1.5;

interface Policy {
  failures: boolean;
  decisions: boolean;
  procedures: boolean;
  handoffs: boolean;
  callers: boolean;
  /** No targets to anchor on: use recent project-wide failures and decisions instead */
  projectWide: boolean;
}

const POLICY: Record<Role, Policy> = {
  planner: {
    failures: true,
    decisions: true,
    procedures: true,
    handoffs: true,
    callers: false,
    projectWide: true,
  },
  coder: {
    failures: true,
    decisions: true,
    procedures: true,
    handoffs: true,
    callers: true,
    projectWide: false,
  },
  verifier: {
    failures: true,
    decisions: true,
    procedures: true,
    handoffs: true,
    callers: false,
    projectWide: false,
  },
  chore: {
    failures: false,
    decisions: true,
    procedures: true,
    handoffs: true,
    callers: false,
    projectWide: false,
  },
};

/** Lower rank = more important = kept first when the budget is tight. */
const RANK = {
  unresolvedFailure: 10,
  fixedFailure: 20,
  handoff: 30,
  targetDecision: 40,
  nearUnresolvedFailure: 50,
  nearFixedFailure: 55,
  nearDecision: 60,
  /** Two calls away from a target (the target calls something that calls it) */
  farFailure: 62,
  farDecision: 64,
  /** Not near the task in the code, but worded like it (full-text search over failures) */
  similarFailure: 66,
  procedure: 70,
};

interface Bundle {
  rank: number;
  at: number;
  stale: boolean;
  /** Failures and decisions can go stale; procedures and handoffs cannot */
  memory: boolean;
  items: ContextItem[];
  apply: (into: PromptInput) => void;
}

type Rel = 'self' | 'caller' | 'callee' | 'callee2';
interface Near {
  target: string;
  near: string;
  rel: Rel;
  /** For a callee two hops away: the function in between */
  via: string | null;
}
/** Closest first, so a symbol that is both a callee and a callee's callee counts as the callee */
const REL_ORDER: Record<Rel, number> = { self: 0, caller: 1, callee: 1, callee2: 2 };

const short = (s: string, n = 70): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const symbolText = (s: SymbolRow): string => `${s.file}:${s.startLine}-${s.endLine}  ${s.name}`;

function handoffText(payload: Record<string, unknown>): string {
  const text = payload.summary ?? payload.notes ?? payload.note ?? JSON.stringify(payload);
  return short(String(text), 300);
}

/**
 * Build what an agent is told for this task. Unless it is a preview, the pack is stored (Q4) together
 * with the trace of every query that chose it (Q19).
 */
export async function compileContext(
  graph: Graph,
  taskId: string,
  opts: CompileOptions,
): Promise<CompiledContext> {
  const off = opts.graphOff ?? graphIsOff();
  const { value: pack, steps } = await traced(() =>
    buildContext(graph, taskId, { ...opts, graphOff: off }),
  );
  if (!opts.preview && opts.sessionId) {
    const memory = pack.items.filter((i) => i.kind !== 'Symbol').length;
    const risky = pack.risk && pack.budgetTokens > (opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS);
    await saveTrace(
      graph,
      { sessionId: opts.sessionId },
      {
        kind: 'context',
        reason: off
          ? `graph off: the task and its target files only, ~${pack.tokenEstimate} tokens`
          : `${pack.items.length} items (${memory} from memory), ~${pack.tokenEstimate} of ${pack.budgetTokens} tokens` +
            (pack.dropped ? `, ${pack.dropped} left out to fit` : '') +
            (risky
              ? `; budget ×${RISK_BUDGET_FACTOR} because ${pack.risk!.name}() is in the top ${Math.max(1, Math.round((1 - pack.risk!.risk) * 100))}% by risk`
              : ''),
        steps,
        graphOff: off,
      },
    );
  }
  return pack;
}

async function buildContext(
  graph: Graph,
  taskId: string,
  opts: CompileOptions & { graphOff: boolean },
): Promise<CompiledContext> {
  if (!opts.preview && !opts.sessionId)
    throw new Error('compileContext needs a sessionId (or preview: true)');
  const task = await getTask(graph, taskId);
  if (!task) throw new Error(`Unknown task ${taskId}`);
  if (opts.sessionId && !opts.preview) {
    const ok = await read<{ id: string }>(
      graph,
      `MATCH (se:Session {id: $sid})-[:WORKED_ON]->(:Task {id: $tid}) RETURN se.id AS id`,
      { sid: opts.sessionId, tid: taskId },
    );
    if (!ok.length) throw new Error(`Session ${opts.sessionId} did not work on task ${taskId}`);
  }

  const off = opts.graphOff;
  // With the graph off nothing below is chosen by the graph: no callers, no memory, no procedures.
  const policy: Policy = off
    ? {
        failures: false,
        decisions: false,
        procedures: false,
        handoffs: false,
        callers: false,
        projectWide: false,
      }
    : POLICY[opts.role];
  const risk = off ? undefined : await taskRisk(graph, taskId);
  const risky = risk !== undefined && risk.risk >= (opts.riskThreshold ?? 0.9);
  const budget = Math.round(
    (opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS) * (risky ? RISK_BUDGET_FACTOR : 1),
  );
  const targetIds = task.targets;

  // --- Where this task sits in the call graph ---------------------------------------------------
  // Q21: lessons travel along the call graph, two calls down: a mistake made in audit() matters to a
  // task on login() when login() calls checkUser() and checkUser() calls audit().
  const near = (
    targetIds.length && !off
      ? await read<Near>(
          graph,
          `MATCH (:Task {id: $id})-[:TARGETS]->(s:Symbol)
         RETURN s.id AS target, s.id AS near, 'self' AS rel, null AS via
         UNION
         MATCH (:Task {id: $id})-[:TARGETS]->(s:Symbol)<-[:CALLS]-(n:Symbol)
         WHERE coalesce(n.removed, false) = false
         RETURN s.id AS target, n.id AS near, 'caller' AS rel, null AS via
         UNION
         MATCH (:Task {id: $id})-[:TARGETS]->(s:Symbol)-[:CALLS]->(n:Symbol)
         WHERE coalesce(n.removed, false) = false
         RETURN s.id AS target, n.id AS near, 'callee' AS rel, null AS via
         UNION
         MATCH (:Task {id: $id})-[:TARGETS]->(s:Symbol)-[:CALLS]->(m:Symbol)-[:CALLS]->(n:Symbol)
         WHERE n <> s AND coalesce(m.removed, false) = false AND coalesce(n.removed, false) = false
         RETURN s.id AS target, n.id AS near, 'callee2' AS rel, m.id AS via`,
          { id: taskId },
        )
      : []
  ).sort((a, b) => REL_ORDER[a.rel] - REL_ORDER[b.rel] || a.near.localeCompare(b.near));
  const callerRows =
    policy.callers && targetIds.length
      ? await read<{ id: string; of: string }>(
          graph,
          `MATCH (:Task {id: $id})-[:TARGETS]->(s:Symbol)<-[:CALLS*1..2]-(c:Symbol)
         WHERE coalesce(c.removed, false) = false
         RETURN DISTINCT c.id AS id, s.id AS of ORDER BY id LIMIT 12`,
          { id: taskId },
        )
      : [];
  const nearIds = [...new Set(near.map((n) => n.near))];

  // --- Memory around those symbols --------------------------------------------------------------
  type FailureRow = {
    id: string;
    message: string;
    stale: boolean;
    count: number;
    at: number;
    symbol: string;
    solId: string | null;
    fix: string | null;
    solAt: number | null;
  };
  const failureCols = `f.id AS id, f.message AS message, coalesce(f.stale, false) AS stale,
         coalesce(f.count, 1) AS count, f.createdAt AS at, s.id AS symbol,
         sol.id AS solId, sol.summary AS fix, sol.createdAt AS solAt`;
  const failureRows: FailureRow[] = !policy.failures
    ? []
    : policy.projectWide
      ? await read<FailureRow>(
          graph,
          `MATCH (f:Failure)-[:IN]->(s:Symbol)
           OPTIONAL MATCH (f)-[:FIXED_BY]->(sol:Solution)
           RETURN ${failureCols} ORDER BY f.createdAt DESC LIMIT 25`,
        )
      : nearIds.length
        ? await read<FailureRow>(
            graph,
            `MATCH (f:Failure)-[:IN]->(s:Symbol) WHERE s.id IN $ids
             OPTIONAL MATCH (f)-[:FIXED_BY]->(sol:Solution)
             RETURN ${failureCols} ORDER BY f.createdAt DESC`,
            { ids: nearIds },
          )
        : [];

  // Q22: failures worded like this task (full-text), wherever they are anchored, up to two that the
  // call graph did not already bring in. They rank below everything near the code.
  const similarIds = new Set<string>();
  if (policy.failures && !policy.projectWide) {
    const have = new Set(failureRows.map((f) => f.id));
    const hits = (
      await similarFailures(graph, [task.title, task.note ?? ''].join(' '), 8).catch(() => [])
    )
      .filter((h) => !h.stale && !have.has(h.id))
      .slice(0, 2);
    if (hits.length) {
      const rows = await read<FailureRow>(
        graph,
        `MATCH (f:Failure)-[:IN]->(s:Symbol) WHERE f.id IN $ids
         OPTIONAL MATCH (f)-[:FIXED_BY]->(sol:Solution)
         RETURN ${failureCols}`,
        { ids: hits.map((h) => h.id) },
      );
      for (const r of rows) {
        failureRows.push(r);
        similarIds.add(r.id);
      }
    }
  }

  type DecisionRow = { id: string; text: string; stale: boolean; at: number; symbols: string[] };
  const decisionCols = `d.id AS id, d.text AS text, coalesce(d.stale, false) AS stale, d.createdAt AS at, collect(s.id) AS symbols`;
  const decisionRows: DecisionRow[] = !policy.decisions
    ? []
    : policy.projectWide
      ? await read<DecisionRow>(
          graph,
          `MATCH (d:Decision {status: 'active'})-[:ABOUT]->(s:Symbol)
           RETURN ${decisionCols} ORDER BY at DESC LIMIT 5`,
        )
      : nearIds.length
        ? await read<DecisionRow>(
            graph,
            `MATCH (d:Decision {status: 'active'})-[:ABOUT]->(s:Symbol) WHERE s.id IN $ids
             RETURN ${decisionCols} ORDER BY at DESC`,
            { ids: nearIds },
          )
        : [];

  const techRows = off
    ? []
    : await read<{ name: string }>(
        graph,
        targetIds.length && !policy.projectWide
          ? `MATCH (s:Symbol)<-[:DEFINES]-(:File)-[:USES]->(t:Technology) WHERE s.id IN $ids RETURN DISTINCT t.name AS name ORDER BY name`
          : `MATCH (:File)-[:USES]->(t:Technology) RETURN DISTINCT t.name AS name ORDER BY name`,
        targetIds.length && !policy.projectWide ? { ids: targetIds } : {},
      );
  const technologies = techRows.map((t) => t.name);

  type ProcRow = { id: string; text: string; tech: string | null };
  const procedureRows: ProcRow[] = policy.procedures
    ? [
        ...(await read<ProcRow>(
          graph,
          `MATCH (p:Procedure)-[:APPLIES_TO]->(:Project) RETURN p.id AS id, p.text AS text, null AS tech ORDER BY p.createdAt`,
        )),
        ...(technologies.length
          ? await read<ProcRow>(
              graph,
              `MATCH (p:Procedure)-[:APPLIES_TO]->(t:Technology) WHERE t.name IN $techs
               RETURN p.id AS id, p.text AS text, t.name AS tech ORDER BY p.createdAt`,
              { techs: technologies },
            )
          : []),
      ]
    : [];
  const handoffs = policy.handoffs ? await pendingHandoffs(graph, taskId) : [];

  // --- Names for everything we mention ----------------------------------------------------------
  const wanted = new Set<string>([
    ...targetIds,
    ...callerRows.map((c) => c.id),
    ...failureRows.map((f) => f.symbol),
    ...decisionRows.flatMap((d) => d.symbols),
    ...near.flatMap((n) => (n.via ? [n.via] : [])),
  ]);
  const infos = new Map((await symbolInfos(graph, [...wanted])).map((s) => [s.id, s]));
  const nameOf = (id: string) => infos.get(id)?.name ?? id.split('::')[1] ?? id;

  // --- Base: the task, its targets and its callers (always included) -----------------------------
  const targets = targetIds.flatMap((id) => (infos.has(id) ? [infos.get(id)!] : []));
  const callerIds = [...new Set(callerRows.map((c) => c.id))].filter(
    (id) => !targetIds.includes(id),
  );
  const baseItems: ContextItem[] = [
    ...targets.map((s) => ({
      kind: 'Symbol' as MemoryKind,
      id: s.id,
      text: symbolText(s),
      reason: 'target of this task',
    })),
    ...callerRows
      .filter((c) => callerIds.includes(c.id))
      .filter((c, i, all) => all.findIndex((x) => x.id === c.id) === i)
      .flatMap((c) =>
        infos.has(c.id)
          ? [
              {
                kind: 'Symbol' as MemoryKind,
                id: c.id,
                text: symbolText(infos.get(c.id)!),
                reason: `calls ${nameOf(c.of)}(): may break if it changes`,
              },
            ]
          : [],
      ),
  ];
  // The planner cannot target what it cannot see: show it the files and the functions in them.
  const codeMap =
    opts.role === 'planner' && !off
      ? (
          await read<{ file: string; symbols: string[] }>(
            graph,
            `MATCH (f:File)-[:DEFINES]->(s:Symbol)
             WHERE coalesce(f.removed, false) = false AND coalesce(s.removed, false) = false
               AND coalesce(f.isTest, false) = false
               AND NOT s.name ENDS WITH '.constructor'
             RETURN f.path AS file, collect(s.name) AS symbols ORDER BY file LIMIT 60`,
          )
        ).map((f) => ({ file: f.file, symbols: f.symbols.slice(0, 12) }))
      : undefined;
  const boardTitles =
    opts.role === 'planner'
      ? (await listTasks(graph))
          .filter((t) => t.id !== taskId && t.status !== 'failed')
          .slice(-15)
          .map((t) => t.title)
      : undefined;

  const base: PromptInput = {
    role: opts.role,
    title: task.title,
    targets: targets.map((s) => ({
      id: s.id,
      name: s.name,
      file: s.file,
      startLine: s.startLine,
      endLine: s.endLine,
    })),
    callers: callerIds,
    failures: [],
    decisions: [],
    procedures: [],
    handoffs: [],
    technologies: opts.role === 'planner' ? technologies : [],
    codeMap,
    boardTitles,
    maxTasks: opts.maxTasks,
    hints: task.hints,
    note: task.note,
    diff: opts.diff,
    testCommand: opts.testCommand,
  };

  // --- Memory bundles, each with its reason -----------------------------------------------------
  const targetSet = new Set(targetIds);
  /** How a symbol relates to the task: a target itself, or a caller/callee of one. */
  const relation = (
    symbol: string,
  ): { rel: Rel; target: string; via: string | null } | undefined => {
    if (targetSet.has(symbol)) return { rel: 'self', target: symbol, via: null };
    const hit = near.find((n) => n.near === symbol);
    return hit ? { rel: hit.rel, target: hit.target, via: hit.via } : undefined;
  };
  const where = (symbol: string, kind: string): string => {
    const r = relation(symbol);
    const name = `${nameOf(symbol)}()`;
    if (!r) return `${kind} in ${name}, one of the most recent in this project`;
    if (r.rel === 'self') return `${kind} in ${name}, which this task targets`;
    const t = `${nameOf(r.target)}()`;
    if (r.rel === 'callee2')
      return `${kind} in ${name}, which the target ${t} reaches through ${nameOf(r.via ?? '')}()`;
    return r.rel === 'caller'
      ? `${kind} in ${name}, which calls the target ${t}`
      : `${kind} in ${name}, which the target ${t} calls`;
  };
  const closeness = (symbol: string) =>
    REL_ORDER[relation(symbol)?.rel ?? 'callee2'] + (relation(symbol) ? 0 : 1);

  const bundles: Bundle[] = [];

  const failures = new Map<string, FailureRow[]>();
  for (const row of failureRows) failures.set(row.id, [...(failures.get(row.id) ?? []), row]);
  for (const rows of failures.values()) {
    const f = rows[0]!;
    const solution = rows.filter((r) => r.solId).sort((a, b) => (b.solAt ?? 0) - (a.solAt ?? 0))[0];
    // Prefer the symbol that is closest to the task for the explanation.
    const symbol = rows.map((r) => r.symbol).sort((a, b) => closeness(a) - closeness(b))[0]!;
    const onTarget = relation(symbol)?.rel === 'self';
    const far = relation(symbol)?.rel === 'callee2';
    const similar = similarIds.has(f.id);
    const again = f.count > 1 ? ` (seen ${f.count} times)` : '';
    const items: ContextItem[] = [
      {
        kind: 'Failure',
        id: f.id,
        text: f.message,
        reason: similar
          ? `failed in ${nameOf(symbol)}(), worded like this task (full-text search)${again}`
          : `${where(symbol, 'failed')}${again}`,
        stale: f.stale || undefined,
      },
    ];
    if (solution?.solId) {
      items.push({
        kind: 'Solution',
        id: solution.solId,
        text: solution.fix ?? '',
        reason: `fix for: ${short(f.message, 60)}`,
        stale: f.stale || undefined,
      });
    }
    bundles.push({
      rank: similar
        ? RANK.similarFailure
        : far
          ? RANK.farFailure
          : solution
            ? onTarget
              ? RANK.fixedFailure
              : RANK.nearFixedFailure
            : onTarget
              ? RANK.unresolvedFailure
              : RANK.nearUnresolvedFailure,
      at: f.at,
      stale: f.stale,
      memory: true,
      items,
      apply: (into) =>
        into.failures.push({ message: f.message, fix: solution?.fix ?? undefined, stale: f.stale }),
    });
  }

  for (const d of decisionRows) {
    const symbol = [...d.symbols].sort((a, b) => closeness(a) - closeness(b))[0]!;
    const onTarget = relation(symbol)?.rel === 'self';
    bundles.push({
      rank:
        onTarget || policy.projectWide
          ? RANK.targetDecision
          : relation(symbol)?.rel === 'callee2'
            ? RANK.farDecision
            : RANK.nearDecision,
      at: d.at,
      stale: d.stale,
      memory: true,
      items: [
        {
          kind: 'Decision',
          id: d.id,
          text: d.text,
          reason: where(symbol, 'active decision').replace(
            'active decision in',
            'active decision about',
          ),
          stale: d.stale || undefined,
        },
      ],
      apply: (into) => into.decisions.push({ text: d.text, stale: d.stale }),
    });
  }

  const seenProc = new Set<string>();
  for (const p of procedureRows) {
    if (seenProc.has(p.id)) continue;
    seenProc.add(p.id);
    bundles.push({
      rank: RANK.procedure,
      at: 0,
      stale: false,
      memory: false,
      items: [
        {
          kind: 'Procedure',
          id: p.id,
          text: p.text,
          reason: p.tech ? `procedure for ${p.tech}, used by this code` : 'project-wide procedure',
        },
      ],
      apply: (into) => into.procedures.push(p.text),
    });
  }

  for (const h of handoffs) {
    const text = handoffText(h.payload);
    bundles.push({
      rank: RANK.handoff,
      at: 0,
      stale: false,
      memory: false,
      items: [
        {
          kind: 'Handoff',
          id: h.id,
          text,
          reason: `handoff from ${h.fromAgent} (${h.fromRole}) waiting for this task`,
        },
      ],
      apply: (into) => into.handoffs.push(text),
    });
  }

  // Stale memory is dropped unless nothing fresh is left, in which case it is kept and labelled.
  const hasFresh = bundles.some((b) => b.memory && !b.stale);
  const usable = bundles.filter((b) => !(b.memory && b.stale && hasFresh));

  // --- Fit into the budget, most important first -------------------------------------------------
  usable.sort((a, b) => a.rank - b.rank || b.at - a.at);
  let input = base;
  const accepted: Bundle[] = [];
  let dropped = bundles.length - usable.length;
  for (const bundle of usable) {
    const next = structuredClone(input);
    bundle.apply(next);
    if (estimateTokens(renderPrompt(next)) <= budget) {
      input = next;
      accepted.push(bundle);
    } else {
      dropped++;
    }
  }

  const prompt = renderPrompt(input);
  const seen = new Set<string>();
  const items = [...baseItems, ...accepted.flatMap((b) => b.items)].filter(
    (i) => !seen.has(i.id) && seen.add(i.id),
  );
  const pack: CompiledContext = {
    id: opts.preview ? '' : newId('ContextPack'),
    sessionId: opts.sessionId ?? '',
    tokenEstimate: estimateTokens(prompt),
    items,
    prompt,
    dropped,
    budgetTokens: budget,
    ...(risk ? { risk } : {}),
    ...(off ? { graphOff: true } : {}),
  };
  if (!opts.preview)
    await persistPack(
      graph,
      pack,
      opts.role,
      handoffs.map((h) => h.id),
      opts.at,
    );
  return pack;
}

const KIND_LABEL: Record<MemoryKind, string> = {
  Failure: 'Failure',
  Solution: 'Solution',
  Decision: 'Decision',
  Procedure: 'Procedure',
  Symbol: 'Symbol',
  Handoff: 'Handoff',
};

/** Q4: record the pack and an INCLUDED edge, with its reason, for every item. */
async function persistPack(
  graph: Graph,
  pack: ContextPack,
  role: Role,
  deliveredHandoffs: string[],
  at?: number,
): Promise<void> {
  await run(
    graph,
    `MATCH (se:Session {id: $sid})
     CREATE (se)-[:RECEIVED]->(:ContextPack {id: $id, role: $role, tokenEstimate: $tokens, prompt: $prompt,
                                             graphOff: $graphOff, createdAt: coalesce($at, timestamp())})`,
    {
      sid: pack.sessionId,
      id: pack.id,
      role,
      tokens: pack.tokenEstimate,
      prompt: pack.prompt,
      graphOff: pack.graphOff ?? false,
      at: at ?? null,
    },
  );
  const byKind = new Map<
    MemoryKind,
    { id: string; reason: string; stale: boolean; ord: number }[]
  >();
  pack.items.forEach((item, ord) => {
    const list = byKind.get(item.kind) ?? [];
    list.push({ id: item.id, reason: item.reason, stale: item.stale ?? false, ord });
    byKind.set(item.kind, list);
  });
  for (const [kind, items] of byKind) {
    // The label comes from a closed set, never from input.
    await run(
      graph,
      `MATCH (cp:ContextPack {id: $id})
       UNWIND $items AS item
       MATCH (m:${KIND_LABEL[kind]} {id: item.id})
       CREATE (cp)-[:INCLUDED {reason: item.reason, stale: item.stale, ord: item.ord}]->(m)`,
      { id: pack.id, items },
    );
  }
  const delivered = deliveredHandoffs.filter((id) => pack.items.some((i) => i.id === id));
  if (delivered.length) {
    await run(
      graph,
      `MATCH (se:Session {id: $sid}) UNWIND $ids AS hid MATCH (h:Handoff {id: hid}) MERGE (h)-[:TO]->(se)`,
      { sid: pack.sessionId, ids: delivered },
    );
  }
}

/** What an item says, derived from the node it points at. */
export function memoryText(kind: string, p: Record<string, unknown>): string {
  switch (kind) {
    case 'Failure':
      return String(p.message ?? '');
    case 'Solution':
      return String(p.summary ?? '');
    case 'Decision':
    case 'Procedure':
      return String(p.text ?? '');
    case 'Symbol':
      return `${p.file}:${p.startLine}-${p.endLine}  ${p.name}`;
    case 'Handoff':
      return handoffText(JSON.parse(String(p.payload ?? '{}')) as Record<string, unknown>);
    default:
      return String(p.id ?? '');
  }
}

/** Q5, first half: exactly what a session was given, in the order it was ranked. */
export async function getContextPack(
  graph: Graph,
  sessionId: string,
): Promise<ContextPack | undefined> {
  const packs = await read<{ id: string; tokens: number; prompt: string; graphOff: boolean }>(
    graph,
    `MATCH (:Session {id: $sid})-[:RECEIVED]->(p:ContextPack)
     RETURN p.id AS id, p.tokenEstimate AS tokens, p.prompt AS prompt,
            coalesce(p.graphOff, false) AS graphOff ORDER BY p.createdAt DESC LIMIT 1`,
    { sid: sessionId },
  );
  const pack = packs[0];
  if (!pack) return undefined;
  const rows = await read<{
    kind: string;
    props: Record<string, unknown>;
    reason: string;
    stale: boolean;
    ord: number;
  }>(
    graph,
    `MATCH (:ContextPack {id: $id})-[r:INCLUDED]->(m)
     RETURN labels(m)[0] AS kind, properties(m) AS props, coalesce(r.reason, '') AS reason,
            coalesce(r.stale, false) AS stale, coalesce(r.ord, 0) AS ord
     ORDER BY ord`,
    { id: pack.id },
  );
  return {
    id: pack.id,
    sessionId,
    tokenEstimate: Number(pack.tokens),
    prompt: pack.prompt,
    ...(pack.graphOff ? { graphOff: true } : {}),
    items: rows.map((r) => ({
      kind: r.kind as MemoryKind,
      id: String(r.props.id),
      text: memoryText(r.kind, r.props),
      reason: r.reason,
      stale: r.stale || undefined,
    })),
  };
}
