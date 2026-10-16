// Graph analytics on top of the project graph: where the code is load-bearing (PageRank over CALLS),
// and which past failures are worded like a new task (full-text search over Failure.message).
// Both use FalkorDB procedures, so the answer is computed where the data lives.
import type { Graph } from 'falkordb';
import { read, run } from '../db/client';
import { vectorSimilarFailures } from '../embed/lessons';

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
  /** Cosine similarity for a vector match; the full-text score otherwise */
  score: number;
  /** How it was found: the vector index (Q32) or full-text search (Q22) */
  via?: 'vector' | 'fulltext';
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
  // request words that every API task and test name shares
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'json',
  'test',
  'tests',
  'return',
  'returns',
  'expected',
  'error',
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
  // Q32 first: failures that mean the same, by the vector index, when the embedding model is on disk;
  // then full-text for the ones that share words but were not close enough in meaning
  const byMeaning = (await vectorSimilarFailures(graph, text, limit).catch(() => undefined)) ?? [];
  const byWords = await fullTextFailures(graph, text, limit);
  const seen = new Set(byMeaning.map((f) => f.id));
  return [...byMeaning, ...byWords.filter((f) => !seen.has(f.id))].slice(0, limit);
}

/** Q22: past failures that share meaningful words with `text` (full-text search over Failure.message) */
export async function fullTextFailures(
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
  return rows.map((r) => ({
    ...r,
    score: Number(r.score),
    stale: Boolean(r.stale),
    via: 'fulltext' as const,
  }));
}

export interface TaskRisk {
  symbol: string;
  name: string;
  /** 0 to 1: the share of this project's functions that score lower (0.95 = top 5%) */
  risk: number;
  pagerank: number;
  betweenness: number;
  openFailures: number;
}

/**
 * Q20: how load-bearing each function is. PageRank over CALLS (how much code depends on it, directly
 * or not) and betweenness (how many call paths run through it), each scaled to the project's highest,
 * plus a bump for failures nobody has fixed yet. Stored on the Symbol as a percentile, so the threshold
 * means the same thing in a small project and a large one. Run after every index.
 */
export async function computeRisk(graph: Graph): Promise<{ symbols: number }> {
  const pr = await read<{ id: string; score: number }>(
    graph,
    `CALL algo.pageRank('Symbol', 'CALLS') YIELD node, score
     WITH node, score WHERE coalesce(node.removed, false) = false
     RETURN node.id AS id, score`,
  );
  if (!pr.length) return { symbols: 0 };
  const bt = await read<{ id: string; score: number }>(
    graph,
    // FalkorDB samples start nodes at random unless told otherwise: a fixed seed and a sample as big as the
    // project (at most 2000) make the scores, and so risk and choke points, the same every time
    `CALL algo.betweenness({nodeLabels: ['Symbol'], relationshipTypes: ['CALLS'],
                            samplingSize: ${Math.max(1, Math.min(pr.length, 2000))}, samplingSeed: 7}) YIELD node, score
     WITH node, score WHERE coalesce(node.removed, false) = false
     RETURN node.id AS id, score`,
  );
  const open = await read<{ id: string; open: number }>(
    graph,
    `MATCH (f:Failure)-[:IN]->(s:Symbol) WHERE coalesce(f.stale, false) = false
     OPTIONAL MATCH (f)-[:FIXED_BY]->(sol:Solution)
     WITH s, f, count(sol) AS fixes WHERE fixes = 0
     RETURN s.id AS id, count(DISTINCT f) AS open`,
  );
  const btBy = new Map(bt.map((r) => [r.id, Number(r.score)]));
  const openBy = new Map(open.map((r) => [r.id, Number(r.open)]));
  const maxPr = Math.max(...pr.map((r) => Number(r.score)), 1e-9);
  const maxBt = Math.max(...bt.map((r) => Number(r.score)), 1e-9);
  const scored = pr.map((r) => {
    const pagerank = Number(r.score);
    const betweenness = btBy.get(r.id) ?? 0;
    const openFailures = openBy.get(r.id) ?? 0;
    const combined = pagerank / maxPr + betweenness / maxBt + Math.min(openFailures, 2) * 0.5;
    return { id: r.id, pagerank, betweenness, openFailures, combined };
  });
  const sorted = scored.map((s) => s.combined).sort((a, b) => a - b);
  const below = (c: number) => {
    // how many score strictly lower (binary search in the sorted list)
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]! < c) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const rows = scored.map((s) => ({
    id: s.id,
    pagerank: s.pagerank,
    betweenness: s.betweenness,
    openFailures: s.openFailures,
    risk: sorted.length > 1 ? below(s.combined) / (sorted.length - 1) : 0,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    await run(
      graph,
      `UNWIND $rows AS r
       MATCH (s:Symbol {id: r.id})
       SET s.pagerank = r.pagerank, s.betweenness = r.betweenness, s.openFailures = r.openFailures,
           s.risk = r.risk`,
      { rows: rows.slice(i, i + 500) },
    );
  }
  return { symbols: rows.length };
}

/** The riskiest function a task targets, when risk has been computed. */
export async function taskRisk(graph: Graph, taskId: string): Promise<TaskRisk | undefined> {
  const rows = await read<TaskRisk>(
    graph,
    `MATCH (:Task {id: $id})-[:TARGETS]->(s:Symbol) WHERE s.risk IS NOT NULL
     RETURN s.id AS symbol, s.name AS name, s.risk AS risk, s.pagerank AS pagerank,
            s.betweenness AS betweenness, coalesce(s.openFailures, 0) AS openFailures
     ORDER BY s.risk DESC LIMIT 1`,
    { id: taskId },
  );
  const r = rows[0];
  return r
    ? {
        symbol: r.symbol,
        name: r.name,
        risk: Number(r.risk),
        pagerank: Number(r.pagerank),
        betweenness: Number(r.betweenness),
        openFailures: Number(r.openFailures),
      }
    : undefined;
}
