// Q32: a vector index on failures. Each failure's message is embedded with a small static model
// (embed/static.ts) and stored on the node as `embedding`; FalkorDB's vector index (cosine) then finds the
// failures that mean the same as a new task, even when no word is shared ("credentials are written to the
// logs" finds "password appears in audit log"). Without the model on disk, callers fall back to full-text.
import type { Graph } from 'falkordb';
import { read, run } from '../db/client';
import type { SimilarFailure } from '../queries/insights';
import { DEFAULT_EMBED_MODEL, loadEmbedder, type Embedder } from './static';

/** Cosine similarity below which a failure is not "like" the task */
export const SIMILAR_MIN = 0.35;

let loaded: Embedder | undefined;

/** The embedder, once its model is on disk. PUFF_EMBED=off turns vectors off; PUFF_EMBED_MODEL picks the model. */
export function getEmbedder(): Embedder | undefined {
  if (process.env.PUFF_EMBED === 'off') return undefined;
  const model = process.env.PUFF_EMBED_MODEL || DEFAULT_EMBED_MODEL;
  if (loaded?.model === model) return loaded;
  try {
    // only a model that loaded is kept, so one downloaded later is picked up on the next call
    loaded = loadEmbedder(model);
  } catch {
    loaded = undefined;
  }
  return loaded;
}

const indexed = new WeakSet<Graph>();

/** The vector index on Failure.embedding (idempotent) */
export async function ensureVectorIndex(graph: Graph, dimension: number): Promise<void> {
  if (indexed.has(graph)) return;
  try {
    // DDL takes no parameters; the dimension is a number from the model file, never input
    await graph.query(
      `CREATE VECTOR INDEX FOR (f:Failure) ON (f.embedding)
       OPTIONS {dimension: ${Math.trunc(dimension)}, similarityFunction: 'cosine'}`,
    );
  } catch (err) {
    if (!/already indexed|already exists/i.test((err as Error).message)) throw err;
  }
  indexed.add(graph);
}

/** Embed failures that have no vector yet (or one from another model). Returns how many were embedded. */
export async function embedFailures(graph: Graph, embedder: Embedder): Promise<number> {
  const rows = await read<{ id: string; message: string | null }>(
    graph,
    `MATCH (f:Failure) WHERE f.embedding IS NULL OR coalesce(f.embedModel, '') <> $model
     RETURN f.id AS id, f.message AS message LIMIT 500`,
    { model: embedder.model },
  );
  if (!rows.length) return 0;
  await run(
    graph,
    `UNWIND $rows AS r
     MATCH (f:Failure {id: r.id})
     SET f.embedding = vecf32(r.vec), f.embedModel = $model`,
    {
      rows: rows.map((r) => ({ id: r.id, vec: Array.from(embedder.embed(r.message ?? '')) })),
      model: embedder.model,
    },
  );
  return rows.length;
}

/**
 * Failures that mean the same as `text`, by cosine similarity on the vector index. Undefined when no
 * embedding model is available (the caller then uses full-text search).
 */
export async function vectorSimilarFailures(
  graph: Graph,
  text: string,
  limit = 5,
): Promise<SimilarFailure[] | undefined> {
  const embedder = getEmbedder();
  if (!embedder || !text.trim()) return undefined;
  await ensureVectorIndex(graph, embedder.dimension);
  await embedFailures(graph, embedder);
  const rows = await read<{
    id: string;
    message: string;
    symbol: string;
    stale: boolean;
    score: number;
  }>(
    graph,
    `CALL db.idx.vector.queryNodes('Failure', 'embedding', $k, vecf32($q)) YIELD node, score
     WITH node, 1 - score AS similarity WHERE similarity >= $min
     MATCH (node)-[:IN]->(s:Symbol)
     RETURN node.id AS id, node.message AS message, s.id AS symbol,
            coalesce(node.stale, false) AS stale, similarity AS score
     ORDER BY score DESC LIMIT $limit`,
    { k: limit * 3, q: Array.from(embedder.embed(text)), min: SIMILAR_MIN, limit },
  );
  return rows.map((r) => ({
    ...r,
    score: Math.round(Number(r.score) * 100) / 100,
    stale: Boolean(r.stale),
    via: 'vector' as const,
  }));
}
