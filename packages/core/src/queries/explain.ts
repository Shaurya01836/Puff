// Read models for the UI: why an agent got its task and context (Q5), the live memory feed, and
// per-agent results. All derived from the graph, so there is no second copy to keep in sync.
import type { Graph } from 'falkordb';
import type {
  AgentName,
  AgentProfile,
  GraphEdge,
  GraphNode,
  MemoryEvent,
  MemoryEventType,
  Role,
  SessionOutcome,
  TeamEvent,
  WhyPath,
} from '@puff/shared';
import type { PuffConfig } from '../config';
import { getContextPack } from '../context/compiler';
import { read } from '../db/client';
import { uiId, uiLabel } from './graph';

/** Q5 plus the routing path: why this agent, and why each item of context. */
export async function getWhy(graph: Graph, taskId: string): Promise<WhyPath> {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const addNode = (label: string, props: Record<string, unknown>, highlight = false): string => {
    const key = String(props.id ?? props.path ?? props.name);
    const id = uiId(label, key);
    if (!nodes.has(id))
      nodes.set(id, { id, label: uiLabel(label, props), kind: label, props, highlight });
    return id;
  };

  const task = await read<{ p: Record<string, unknown> }>(
    graph,
    `MATCH (t:Task {id: $id}) RETURN properties(t) AS p`,
    { id: taskId },
  );
  if (!task[0]) throw new Error(`Unknown task ${taskId}`);
  const taskNode = addNode('Task', task[0].p, true);

  const required = await read<{ cap: string }>(
    graph,
    `MATCH (:Task {id: $id})-[:REQUIRES]->(c:Capability) RETURN c.name AS cap ORDER BY cap`,
    { id: taskId },
  );
  for (const { cap } of required) {
    edges.push({
      source: taskNode,
      target: addNode('Capability', { name: cap }),
      type: 'REQUIRES',
    });
  }

  const latest = await read<{ session: Record<string, unknown>; agent: string }>(
    graph,
    `MATCH (a:Agent)-[:RAN]->(se:Session)-[:WORKED_ON]->(:Task {id: $id})
     RETURN properties(se) AS session, a.name AS agent ORDER BY se.startedAt DESC LIMIT 1`,
    { id: taskId },
  );
  const run = latest[0];
  let summary = `${taskId} has not been picked up yet.`;

  if (run) {
    const agentNode = addNode('Agent', { name: run.agent }, true);
    const sessionNode = addNode('Session', run.session);
    edges.push({ source: agentNode, target: sessionNode, type: 'RAN' });
    edges.push({ source: sessionNode, target: taskNode, type: 'WORKED_ON' });

    // Which declared strength matched, and how this agent has done on that capability before.
    const strengths = await read<{ cap: string; runs: number; wins: number }>(
      graph,
      `MATCH (:Task {id: $id})-[:REQUIRES]->(c:Capability)<-[:HAS_STRENGTH]-(a:Agent {name: $agent})
       OPTIONAL MATCH (a)-[:RAN]->(s:Session)-[:WORKED_ON]->(:Task)-[:REQUIRES]->(c)
       WHERE s.outcome IN ['success', 'failure', 'error'] AND s.id <> $sid
       WITH c, collect(DISTINCT s) AS ss
       RETURN c.name AS cap, size(ss) AS runs, size([x IN ss WHERE x.outcome = 'success']) AS wins`,
      { id: taskId, agent: run.agent, sid: String(run.session.id) },
    );
    for (const s of strengths) {
      edges.push({ source: agentNode, target: uiId('Capability', s.cap), type: 'HAS_STRENGTH' });
    }
    const why = strengths.length
      ? strengths
          .map((s) =>
            s.runs
              ? `${s.cap} (${s.wins}/${s.runs} earlier runs succeeded)`
              : `${s.cap} (no earlier runs)`,
          )
          .join(', ')
      : 'no declared match (assigned manually)';
    summary = `${taskId} went to ${run.agent}: ${why}.`;
    // The routing decision as it was made (Q19), when it was recorded
    const route = await read<{ reason: string }>(
      graph,
      `MATCH (t:Trace {kind: 'route'})-[:FOR]->(:Task {id: $id})
       RETURN t.reason AS reason ORDER BY t.at DESC LIMIT 1`,
      { id: taskId },
    );
    if (route[0]) summary += ` Routing: ${route[0].reason}.`;

    const pack = await getContextPack(graph, String(run.session.id));
    if (pack) {
      const packNode = addNode('ContextPack', {
        id: pack.id,
        name: `context · ~${pack.tokenEstimate} tokens`,
      });
      edges.push({ source: sessionNode, target: packNode, type: 'RECEIVED' });
      for (const item of pack.items) {
        const itemNode = addNode(item.kind, { id: item.id, ...itemProps(item.kind, item.text) });
        edges.push({
          source: packNode,
          target: itemNode,
          type: 'INCLUDED',
          props: { reason: item.reason },
        });
      }
      // Show where each memory is anchored, so the path from a lesson back to the code is visible.
      const memoryIds = pack.items
        .filter((i) => i.kind === 'Failure' || i.kind === 'Decision')
        .map((i) => i.id);
      if (memoryIds.length) {
        const anchors = await read<{
          id: string;
          kind: string;
          symbol: string;
          name: string;
          rel: string;
        }>(
          graph,
          `MATCH (m)-[r:IN|ABOUT]->(s:Symbol) WHERE m.id IN $ids
           RETURN m.id AS id, labels(m)[0] AS kind, s.id AS symbol, s.name AS name, type(r) AS rel`,
          { ids: memoryIds },
        );
        for (const a of anchors) {
          const symbolNode = addNode('Symbol', { id: a.symbol, name: a.name });
          edges.push({ source: uiId(a.kind, a.id), target: symbolNode, type: a.rel });
        }
      }
      const fixes = pack.items.filter((i) => i.kind === 'Solution');
      if (fixes.length) {
        const links = await read<{ f: string; s: string }>(
          graph,
          `MATCH (f:Failure)-[:FIXED_BY]->(s:Solution) WHERE s.id IN $ids RETURN f.id AS f, s.id AS s`,
          { ids: fixes.map((x) => x.id) },
        );
        for (const l of links)
          if (nodes.has(l.f)) edges.push({ source: l.f, target: l.s, type: 'FIXED_BY' });
      }
      const kinds = pack.items.filter((i) => i.kind !== 'Symbol');
      summary += pack.graphOff
        ? ` Graph off: the context was the task and its target files only, ~${pack.tokenEstimate} tokens.`
        : ` Context: ${pack.items.length} items (${kinds.length} from memory), ~${pack.tokenEstimate} tokens.`;
    }
  }
  return { nodes: [...nodes.values()], edges, summary };
}

function itemProps(kind: string, text: string): Record<string, unknown> {
  switch (kind) {
    case 'Failure':
      return { message: text };
    case 'Solution':
      return { summary: text };
    case 'Decision':
    case 'Procedure':
      return { text };
    default:
      return { name: text };
  }
}

type FeedRow = { id: string; at: number; text: string; refs: string[] };

/** The memory feed, newest first, derived from timestamps on the memory nodes themselves. */
export async function getMemoryFeed(graph: Graph, limit = 50): Promise<MemoryEvent[]> {
  const events: MemoryEvent[] = [];
  const add = (type: MemoryEventType, rows: FeedRow[], text: (r: FeedRow) => string) => {
    for (const r of rows) {
      events.push({
        id: `${type}:${r.id}`,
        at: Number(r.at),
        type,
        text: text(r),
        refs: r.refs.filter(Boolean),
      });
    }
  };

  add(
    'failure_recorded',
    await read<FeedRow>(
      graph,
      `MATCH (f:Failure)-[:IN]->(s:Symbol)
       RETURN f.id AS id, f.createdAt AS at, f.message AS text, [f.id] + collect(s.id) AS refs`,
    ),
    (r) => r.text,
  );
  add(
    'solution_recorded',
    await read<FeedRow>(
      graph,
      `MATCH (f:Failure)-[:FIXED_BY]->(s:Solution)
       RETURN s.id AS id, s.createdAt AS at, s.summary AS text, [s.id, f.id] AS refs`,
    ),
    (r) => r.text,
  );
  add(
    'decision_recorded',
    await read<FeedRow>(
      graph,
      `MATCH (d:Decision)-[:ABOUT]->(s:Symbol)
       RETURN d.id AS id, d.createdAt AS at, d.text AS text, [d.id] + collect(s.id) AS refs`,
    ),
    (r) => r.text,
  );
  add(
    'decision_superseded',
    await read<FeedRow>(
      graph,
      `MATCH (n:Decision)-[:SUPERSEDES]->(o:Decision)
       RETURN o.id AS id, n.createdAt AS at, o.text + '  →  ' + n.text AS text, [n.id, o.id] AS refs`,
    ),
    (r) => r.text,
  );
  add(
    'handoff',
    await read<FeedRow>(
      graph,
      `MATCH (a:Agent)-[:RAN]->(se:Session)-[:HANDED_OFF]->(h:Handoff)
       RETURN h.id AS id, h.createdAt AS at, a.name + ' handed off' + coalesce(' to ' + h.toRole, '') AS text, [h.id, se.id] AS refs`,
    ),
    (r) => r.text,
  );
  // The text is built here: FalkorDB returns null for a string concatenation that contains an aggregate.
  type PackRow = FeedRow & { agent: string; title: string; items: number; tokens: number };
  add(
    'context_compiled',
    await read<PackRow>(
      graph,
      `MATCH (a:Agent)-[:RAN]->(se:Session)-[:RECEIVED]->(p:ContextPack)
       MATCH (se)-[:WORKED_ON]->(t:Task)
       OPTIONAL MATCH (p)-[r:INCLUDED]->()
       RETURN p.id AS id, p.createdAt AS at, a.name AS agent, t.title AS title,
              count(r) AS items, p.tokenEstimate AS tokens, [se.id, t.id] AS refs`,
    ),
    (r) => {
      const p = r as PackRow;
      return `Context for “${p.title}” (${p.agent}): ${p.items} items, ~${p.tokens} tokens`;
    },
  );
  // Q23: one event per reverted merge, counting what it downgraded (text built here, see above)
  type RevertRow = FeedRow & { sha: string; n: number };
  add(
    'memory_downgraded',
    await read<RevertRow>(
      graph,
      `MATCH (x:Commit)-[r:REVERTED_BY]->(:Commit)
       OPTIONAL MATCH (m) WHERE m.revertedIn = x.sha OR m.downgradedBy = x.sha
       RETURN x.sha AS id, x.sha AS sha, r.at AS at, count(m) AS n, collect(m.id) AS refs`,
    ),
    (r) => {
      const v = r as RevertRow;
      const n = Number(v.n);
      return n
        ? `${n} lesson${n === 1 ? '' : 's'} downgraded because ${v.sha.slice(0, 7)} was reverted`
        : `${v.sha.slice(0, 7)} was reverted (nothing had been learned from it)`;
    },
  );
  add(
    'memory_stale',
    await read<FeedRow>(
      graph,
      `MATCH (m) WHERE labels(m)[0] IN ['Failure', 'Decision'] AND m.staleAt IS NOT NULL
       RETURN m.id AS id, m.staleAt AS at,
              'Possibly outdated: ' + coalesce(m.message, m.text) + ' (' + coalesce(m.staleBecause, 'code') + ' changed)' AS text,
              [m.id] AS refs`,
    ),
    (r) => r.text,
  );

  return events.sort((a, b) => b.at - a.at).slice(0, limit);
}

/** Per-agent pool status and results, from sessions in the graph. */
export async function agentProfiles(graph: Graph, config: PuffConfig): Promise<AgentProfile[]> {
  const stats = await read<{ name: string; runs: number; wins: number; tokens: number | null }>(
    graph,
    `MATCH (a:Agent)
     OPTIONAL MATCH (a)-[:RAN]->(s:Session) WHERE s.outcome IN ['success', 'failure', 'error']
     RETURN a.name AS name, count(s) AS runs,
            sum(CASE WHEN s.outcome = 'success' THEN 1 ELSE 0 END) AS wins,
            avg(coalesce(s.tokensIn, 0) + coalesce(s.tokensOut, 0)) AS tokens`,
  );
  const busy = await read<{ name: string; busy: number }>(
    graph,
    `MATCH (a:Agent)-[:RAN]->(s:Session {outcome: 'running'}) RETURN a.name AS name, count(s) AS busy`,
  );
  return Object.entries(config.harnesses).map(([name, h]) => {
    const s = stats.find((x) => x.name === name);
    const runs = Number(s?.runs ?? 0);
    const wins = Number(s?.wins ?? 0);
    return {
      name: name as AgentName,
      instances: h.instances,
      busy: Number(busy.find((b) => b.name === name)?.busy ?? 0),
      strengths: h.strengths,
      stats: {
        runs,
        wins,
        successRate: runs ? wins / runs : 0,
        avgTokens: s?.tokens ? Math.round(Number(s.tokens)) : undefined,
      },
    };
  });
}

/**
 * The team's story, newest first: which agent worked on what, which notes were handed to whom,
 * which agent asked for which follow-up task, and when a task moved to another agent or got a
 * second try. Everything is derived from sessions, handoffs and spawn edges already in the graph.
 */
export async function getTeamTimeline(graph: Graph, limit = 60): Promise<TeamEvent[]> {
  const events: TeamEvent[] = [];
  const num = (v: unknown) => Number(v ?? 0);

  type SessionRow = {
    id: string;
    agent: AgentName;
    role: Role;
    outcome: SessionOutcome;
    at: number;
    summary: string | null;
    taskId: string;
    title: string;
  };
  const sessions = await read<SessionRow>(
    graph,
    `MATCH (a:Agent)-[:RAN]->(se:Session)-[:WORKED_ON]->(t:Task)
     RETURN se.id AS id, a.name AS agent, se.role AS role, se.outcome AS outcome,
            se.startedAt AS at, se.summary AS summary, t.id AS taskId, t.title AS title
     ORDER BY at`,
  );
  const byTask = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    byTask.set(s.taskId, [...(byTask.get(s.taskId) ?? []), s]);
    events.push({
      id: `session:${s.id}`,
      at: num(s.at),
      kind: 'session',
      agent: s.agent,
      role: s.role,
      taskId: s.taskId,
      taskTitle: s.title,
      outcome: s.outcome,
      text: s.summary ?? (s.outcome === 'running' ? 'Working on it…' : ''),
    });
  }
  // A later session on the same task is a retry (same agent) or an escalation (a different one).
  for (const list of byTask.values()) {
    list.forEach((s, i) => {
      const prev = list[i - 1];
      if (!prev || prev.outcome === 'running') return;
      const escalated = prev.agent !== s.agent;
      events.push({
        id: `${escalated ? 'escalated' : 'retried'}:${s.id}`,
        // just before the new session, so it reads in order
        at: num(s.at) - 1,
        kind: escalated ? 'escalated' : 'retried',
        agent: prev.agent,
        toAgent: s.agent,
        role: s.role,
        taskId: s.taskId,
        taskTitle: s.title,
        text: escalated
          ? `${prev.agent} could not finish it (${prev.outcome}), so it moved to ${s.agent}`
          : `${s.agent} tries again, this time knowing what the last attempt taught`,
      });
    });
  }

  type HandoffRow = {
    id: string;
    at: number;
    payload: string;
    toRole: string | null;
    agent: AgentName;
    role: Role;
    taskId: string;
    title: string;
    toAgent: AgentName | null;
  };
  const handoffs = await read<HandoffRow>(
    graph,
    `MATCH (a:Agent)-[:RAN]->(se:Session)-[:HANDED_OFF]->(h:Handoff)
     MATCH (se)-[:WORKED_ON]->(t:Task)
     OPTIONAL MATCH (h)-[:TO]->(:Session)<-[:RAN]-(a2:Agent)
     RETURN h.id AS id, h.createdAt AS at, h.payload AS payload, h.toRole AS toRole,
            a.name AS agent, se.role AS role, t.id AS taskId, t.title AS title, a2.name AS toAgent`,
  );
  for (const h of handoffs) {
    let text = '';
    try {
      text = String((JSON.parse(h.payload) as { summary?: unknown }).summary ?? h.payload);
    } catch {
      text = h.payload;
    }
    events.push({
      id: `handoff:${h.id}`,
      at: num(h.at),
      kind: 'handoff',
      agent: h.agent,
      role: h.role,
      taskId: h.taskId,
      taskTitle: h.title,
      toAgent: h.toAgent ?? undefined,
      toRole: h.toRole ?? undefined,
      text,
    });
  }

  type SpawnRow = {
    at: number;
    agent: AgentName;
    role: Role;
    taskId: string;
    title: string;
    newId: string;
    newTitle: string;
  };
  const spawns = await read<SpawnRow>(
    graph,
    `MATCH (a:Agent)-[:RAN]->(se:Session)-[:SPAWNED]->(n:Task)
     MATCH (se)-[:WORKED_ON]->(t:Task)
     RETURN n.createdAt AS at, a.name AS agent, se.role AS role, t.id AS taskId, t.title AS title,
            n.id AS newId, n.title AS newTitle`,
  );
  for (const s of spawns) {
    events.push({
      id: `spawned:${s.newId}`,
      at: num(s.at),
      kind: 'spawned',
      agent: s.agent,
      role: s.role,
      taskId: s.taskId,
      taskTitle: s.title,
      toTaskId: s.newId,
      toTaskTitle: s.newTitle,
      text: s.newTitle,
    });
  }

  return events.sort((a, b) => b.at - a.at).slice(0, limit);
}
