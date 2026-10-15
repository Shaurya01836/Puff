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

/**
 * Turn user-facing references into symbol ids: a full id (`src/auth/login.ts::login`) or a unique name (`login`).
 * Throws with a helpful message when a name is unknown or ambiguous.
 */
export async function resolveSymbols(graph: Graph, refs: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const ref of refs) {
    if (ref.includes('::')) {
      const rows = await read<{ id: string }>(
        graph,
        `MATCH (s:Symbol {id: $id}) WHERE coalesce(s.removed, false) = false RETURN s.id AS id`,
        { id: ref },
      );
      if (!rows.length) throw new Error(`Unknown symbol "${ref}"`);
      ids.push(ref);
      continue;
    }
    const rows = await read<{ id: string }>(
      graph,
      `MATCH (s:Symbol) WHERE s.name = $name AND coalesce(s.removed, false) = false
       RETURN s.id AS id ORDER BY id`,
      { name: ref },
    );
    if (rows.length === 0) throw new Error(`No symbol named "${ref}"`);
    if (rows.length > 1) {
      throw new Error(`"${ref}" is ambiguous: ${rows.map((r) => r.id).join(', ')}`);
    }
    ids.push(rows[0]!.id);
  }
  return [...new Set(ids)];
}

/** Which of these symbol ids currently exist in the graph (and are not removed). */
export async function existingSymbols(graph: Graph, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await read<{ id: string }>(
    graph,
    `MATCH (s:Symbol) WHERE s.id IN $ids AND coalesce(s.removed, false) = false RETURN s.id AS id`,
    { ids },
  );
  return new Set(rows.map((r) => r.id));
}

export async function symbolInfos(graph: Graph, ids: string[]): Promise<SymbolRow[]> {
  if (ids.length === 0) return [];
  return read<SymbolRow>(
    graph,
    `MATCH (s:Symbol) WHERE s.id IN $ids
     RETURN s.id AS id, s.name AS name, s.kind AS kind, s.file AS file,
            s.startLine AS startLine, s.endLine AS endLine, coalesce(s.signature, '') AS signature
     ORDER BY s.id`,
    { ids },
  );
}
