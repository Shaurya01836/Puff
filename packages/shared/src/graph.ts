import type { GraphData } from './types';

/** Nodes within `depth` hops of `focusId` (undirected), for the focused graph view. */
export function neighbourhood(graph: GraphData, focusId: string, depth = 2): GraphData {
  const keep = new Set([focusId]);
  let frontier = [focusId];
  for (let i = 0; i < depth; i++) {
    const next: string[] = [];
    for (const e of graph.edges) {
      for (const [a, b] of [
        [e.source, e.target],
        [e.target, e.source],
      ] as const) {
        if (frontier.includes(a) && !keep.has(b)) {
          keep.add(b);
          next.push(b);
        }
      }
    }
    frontier = next;
  }
  return {
    nodes: graph.nodes
      .filter((n) => keep.has(n.id))
      .map((n) => (n.id === focusId ? { ...n, highlight: true } : n)),
    edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
  };
}
