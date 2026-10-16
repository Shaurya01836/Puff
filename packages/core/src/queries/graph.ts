// Export the project graph in the shape the UI draws (GraphData from @puff/shared).
import type { Graph } from 'falkordb';
import type { GraphData, GraphEdge, GraphNode } from '@puff/shared';
import { read } from '../db/client';

/** UI node ids: labels without an `id` property get a readable prefix so ids never collide. */
export function uiId(label: string, key: string): string {
  switch (label) {
    case 'Agent':
      return `agent:${key}`;
    case 'Capability':
      return `cap:${key}`;
    case 'Technology':
      return `tech:${key}`;
    default:
      return key;
  }
}

export function uiLabel(label: string, props: Record<string, unknown>): string {
  switch (label) {
    case 'File':
      return (
        String(props.path ?? '')
          .split('/')
          .pop() ?? ''
      );
    case 'Symbol':
      return String(props.name ?? props.id);
    case 'Task':
      return String(props.title ?? props.id);
    case 'Failure':
      return String(props.message ?? props.id);
    case 'Solution':
      return String(props.summary ?? props.id);
    case 'Decision':
    case 'Procedure':
      return String(props.text ?? props.id);
    case 'Session':
      return `${props.role ?? 'session'} · ${props.outcome ?? ''}`;
    case 'Handoff':
      return 'Handoff';
    default:
      return String(props.name ?? props.id ?? props.path ?? label);
  }
}

const HIDDEN_LABELS = ['Project', 'ContextPack'];
const HIDDEN_EDGES = ['HAS_FILE', 'HAS_TASK', 'RECEIVED', 'INCLUDED'];

/** Whole project graph minus bookkeeping nodes; removed code is left out. */
export async function exportGraph(graph: Graph): Promise<GraphData> {
  const nodeRows = await read<{ label: string; key: string; props: Record<string, unknown> }>(
    graph,
    `MATCH (n)
     WHERE NOT labels(n)[0] IN $hidden AND coalesce(n.removed, false) = false
     RETURN labels(n)[0] AS label, coalesce(n.id, n.path, n.name) AS key, properties(n) AS props`,
    { hidden: HIDDEN_LABELS },
  );
  const edgeRows = await read<{ al: string; ak: string; type: string; bl: string; bk: string }>(
    graph,
    `MATCH (a)-[r]->(b)
     WHERE NOT type(r) IN $hiddenEdges
       AND NOT labels(a)[0] IN $hidden AND NOT labels(b)[0] IN $hidden
       AND coalesce(a.removed, false) = false AND coalesce(b.removed, false) = false
     RETURN labels(a)[0] AS al, coalesce(a.id, a.path, a.name) AS ak, type(r) AS type,
            labels(b)[0] AS bl, coalesce(b.id, b.path, b.name) AS bk`,
    { hidden: HIDDEN_LABELS, hiddenEdges: HIDDEN_EDGES },
  );

  const nodes: GraphNode[] = nodeRows.map(({ label, key, props }) => {
    // a failure's vector (Q32) is 256 numbers nobody reads in the UI
    const { embedding: _vector, ...shown } = props;
    return { id: uiId(label, key), label: uiLabel(label, shown), kind: label, props: shown };
  });
  const edges: GraphEdge[] = edgeRows.map((e) => ({
    source: uiId(e.al, e.ak),
    target: uiId(e.bl, e.bk),
    type: e.type,
  }));
  return { nodes, edges };
}
