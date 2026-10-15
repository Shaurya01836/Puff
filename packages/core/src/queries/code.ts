import type { Graph } from 'falkordb';
import { read } from '../db/client';

export interface ImpactRow {
  file: string;
  callers: string[];
}

/** Q6: files whose code calls this symbol, up to 3 hops away (what may break if it changes). */
export async function impactOf(graph: Graph, symbolId: string): Promise<ImpactRow[]> {
  return read<ImpactRow>(
    graph,
    `MATCH (s:Symbol {id: $id})<-[:CALLS*1..3]-(c:Symbol)<-[:DEFINES]-(f:File)
     WHERE coalesce(c.removed, false) = false
     RETURN f.path AS file, collect(DISTINCT c.id) AS callers
     ORDER BY file`,
    { id: symbolId },
  );
}

export interface SymbolRow {
  id: string;
  name: string;
  kind: string;
  file: string;
  startLine: number;
  endLine: number;
  signature: string;
}

/** Find symbols by (partial) name or id, for the CLI and agents. */
export async function findSymbols(graph: Graph, term: string, limit = 20): Promise<SymbolRow[]> {
  return read<SymbolRow>(
    graph,
    `MATCH (s:Symbol)
     WHERE coalesce(s.removed, false) = false AND (s.name CONTAINS $term OR s.id CONTAINS $term)
     RETURN s.id AS id, s.name AS name, s.kind AS kind, s.file AS file,
            s.startLine AS startLine, s.endLine AS endLine, s.signature AS signature
     ORDER BY size(s.id)
     LIMIT $limit`,
    { term, limit },
  );
}
