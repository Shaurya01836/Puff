// Everything the team learned, for the Memory screen: each failure, fix, decision and procedure with the code
// it is about, who learned it, how often agents were given it, whether it still holds, and how far it is trusted.
import type { Graph } from 'falkordb';
import type { AgentName, MemoryItem, LessonKind, MemoryState } from '@puff/shared';
import { read } from '../db/client';
import { memoryTrust } from '../memory/provenance';

interface Row {
  id: string;
  text: string | null;
  about: string[];
  appliesTo?: string | null;
  at: number | null;
  agent: string | null;
  hits?: number | null;
  usedIn: number;
  relatedId: string | null;
  relatedText: string | null;
  stale: boolean | null;
  status: string | null;
  revertedIn: string | null;
  downgradedBy: string | null;
  seeded: boolean | null;
}

// Shared tail of every query: who learned it, and how many agent prompts it went into
const LEARNED = `
  OPTIONAL MATCH (m)-[:LEARNED_IN]->(:Session)<-[:RAN]-(a:Agent)
  WITH m, about, related, head(collect(a.name)) AS agent
  OPTIONAL MATCH (m)<-[:INCLUDED]-(cp:ContextPack)
  WITH m, about, related, agent, count(DISTINCT cp) AS usedIn`;

const COLUMNS = `m.id AS id, about, agent, usedIn, related[0] AS relatedId, related[1] AS relatedText,
  coalesce(m.stale, false) AS stale, m.status AS status, m.revertedIn AS revertedIn,
  m.downgradedBy AS downgradedBy, coalesce(m.seeded, false) AS seeded`;

const QUERIES: Record<LessonKind, string> = {
  // A failure: the functions it happened in, and its newest fix
  Failure: `
    MATCH (m:Failure)
    OPTIONAL MATCH (m)-[:IN]->(s:Symbol)
    WITH m, collect(DISTINCT s.id) AS about
    OPTIONAL MATCH (m)-[:FIXED_BY]->(fix:Solution)
    WITH m, about, fix ORDER BY fix.createdAt DESC
    WITH m, about, head(collect([fix.id, fix.summary])) AS related
    ${LEARNED}
    RETURN ${COLUMNS}, m.message AS text, coalesce(m.lastSeenAt, m.createdAt) AS at, m.count AS hits`,
  // A fix: the failure it fixed, and that failure's functions
  Solution: `
    MATCH (m:Solution)
    OPTIONAL MATCH (f:Failure)-[:FIXED_BY]->(m)
    OPTIONAL MATCH (f)-[:IN]->(s:Symbol)
    WITH m, f, collect(DISTINCT s.id) AS about
    WITH m, about, [f.id, f.message] AS related
    ${LEARNED}
    RETURN ${COLUMNS}, m.summary AS text, m.createdAt AS at`,
  Decision: `
    MATCH (m:Decision)
    OPTIONAL MATCH (m)-[:ABOUT]->(s:Symbol)
    WITH m, collect(DISTINCT s.id) AS about
    OPTIONAL MATCH (m)-[:SUPERSEDES]->(old:Decision)
    WITH m, about, head(collect([old.id, old.text])) AS related
    ${LEARNED}
    RETURN ${COLUMNS}, m.text AS text, m.createdAt AS at`,
  // A procedure applies to a technology, or to the whole project
  Procedure: `
    MATCH (m:Procedure)
    OPTIONAL MATCH (m)-[:APPLIES_TO]->(t:Technology)
    WITH m, [] AS about, [null, null] AS related, head(collect(t.name)) AS tech
    ${LEARNED.replace(/related, /g, 'related, tech, ')}
    RETURN ${COLUMNS}, m.text AS text, m.createdAt AS at, coalesce(tech, 'the whole project') AS appliesTo`,
};

/** A lesson's state, worst first: a reverted fix or decision, one built on it, replaced, then out of date */
export function memoryState(
  r: Pick<Row, 'stale' | 'status' | 'revertedIn' | 'downgradedBy'>,
): MemoryState {
  if (r.revertedIn || r.status === 'reverted') return 'reverted';
  if (r.downgradedBy) return 'downgraded';
  if (r.status === 'superseded') return 'superseded';
  if (r.stale) return 'outdated';
  return 'current';
}

/** Everything the team learned, newest first, with its trust (failures and decisions, Q24). */
export async function listMemory(graph: Graph): Promise<MemoryItem[]> {
  const items: MemoryItem[] = [];
  for (const kind of Object.keys(QUERIES) as LessonKind[]) {
    for (const r of await read<Row>(graph, QUERIES[kind])) {
      items.push({
        id: r.id,
        kind,
        text: r.text ?? '',
        about: [...(r.about ?? [])].sort(),
        appliesTo: r.appliesTo ?? undefined,
        at: Number(r.at ?? 0),
        agent: (r.agent as AgentName | null) ?? undefined,
        hits: r.hits === undefined || r.hits === null ? undefined : Number(r.hits),
        usedIn: Number(r.usedIn ?? 0),
        related: r.relatedId ? { id: r.relatedId, text: r.relatedText ?? '' } : undefined,
        state: memoryState(r),
        seeded: r.seeded ? true : undefined,
      });
    }
  }
  const trust = await memoryTrust(graph, {
    Failure: items.filter((i) => i.kind === 'Failure').map((i) => i.id),
    Decision: items.filter((i) => i.kind === 'Decision').map((i) => i.id),
  });
  for (const i of items) {
    const t = trust.get(i.id);
    if (t) {
      i.trust = t.trust;
      i.trustWhy = t.why;
    }
  }
  return items.sort((a, b) => b.at - a.at);
}
