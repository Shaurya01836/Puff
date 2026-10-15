// Graph analytics on top of the project graph: where the code is load-bearing (PageRank over CALLS),
// and which past failures are worded like a new task (full-text search over Failure.message).
// Both use FalkorDB procedures, so the answer is computed where the data lives.
import type { Graph } from 'falkordb';
import { read } from '../db/client';

export interface HotspotRow {
  id: string;
  name: string;
  file: string;
  /** PageRank over the CALLS graph: higher means more code depends on it, directly or indirectly */
  score: number;
  failures: number;
  staleFailures: number;
  decisions: number;
}

/** The symbols other code depends on most, with the memory anchored to each one. */
export async function hotspots(graph: Graph, limit = 10): Promise<HotspotRow[]> {
  const ranked = await read<{ id: string; score: number }>(
    graph,
    `CALL algo.pageRank('Symbol', 'CALLS') YIELD node, score
     WITH node, score WHERE coalesce(node.removed, false) = false
     RETURN node.id AS id, score ORDER BY score DESC LIMIT $limit`,
    { limit },
  );
  if (!ranked.length) return [];

  const memory = await read<{
    id: string;
    name: string;
    file: string;
    failures: number;
    staleFailures: number;
    decisions: number;
  }>(
    graph,
    `MATCH (s:Symbol) WHERE s.id IN $ids
     OPTIONAL MATCH (f:Failure)-[:IN]->(s)
     OPTIONAL MATCH (d:Decision {status: 'active'})-[:ABOUT]->(s)
     RETURN s.id AS id, s.name AS name, s.file AS file,
            count(DISTINCT f) AS failures,
            count(DISTINCT CASE WHEN coalesce(f.stale, false) THEN f END) AS staleFailures,
            count(DISTINCT d) AS decisions`,
    { ids: ranked.map((r) => r.id) },
  );
  const byId = new Map(memory.map((m) => [m.id, m]));

  return ranked.map((r) => {
    const m = byId.get(r.id);
    return {
      id: r.id,
      name: m?.name ?? r.id,
      file: m?.file ?? '',
      score: Number(r.score),
      failures: Number(m?.failures ?? 0),
      staleFailures: Number(m?.staleFailures ?? 0),
      decisions: Number(m?.decisions ?? 0),
    };
  });
}

export interface SimilarFailure {
  id: string;
  message: string;
  symbol: string;
  stale: boolean;
  score: number;
}

/** Words too common to tell two failures apart. */
const STOP = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'when',
  'what',
  'not',
  'are',
  'was',
  'but',
  'has',
  'have',
  'into',
  'its',
  'can',
  'use',
  'add',
  'new',
  'all',
  'any',
  'out',
]);

/**
 * Past failures worded like `text`, wherever they happened: full-text search over Failure.message,
 * matching any of the meaningful words. Each hit says which symbol it is anchored to.
 */
export async function similarFailures(
  graph: Graph,
  text: string,
  limit = 5,
): Promise<SimilarFailure[]> {
  // Only plain words reach the full-text query: punctuation is query syntax there and breaks it.
  const words = [
    ...new Set((text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []).filter((w) => !STOP.has(w))),
  ].slice(0, 12);
  if (!words.length) return [];

  const rows = await read<{
    id: string;
    message: string;
    symbol: string;
    stale: boolean;
    score: number;
  }>(
    graph,
    `CALL db.idx.fulltext.queryNodes('Failure', $query) YIELD node, score
     MATCH (node)-[:IN]->(s:Symbol)
     RETURN node.id AS id, node.message AS message, s.id AS symbol,
            coalesce(node.stale, false) AS stale, score
     ORDER BY score DESC LIMIT $limit`,
    { query: words.join(' | '), limit },
  );
  return rows.map((r) => ({ ...r, score: Number(r.score), stale: Boolean(r.stale) }));
}
