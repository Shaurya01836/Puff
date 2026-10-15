import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { GraphData, GraphNode } from '@puff/shared';
import { Panel, SectionTitle } from '@/components/ui';
import { useMemoryFeed } from '@/lib/hooks';
import { NODE_COLORS, timeAgo } from '@/lib/theme';

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

export function MemoryGraph({ projectId, graph }: { projectId: string; graph?: GraphData }) {
  const [ref, size] = useSize<HTMLDivElement>();
  const [selected, setSelected] = useState<GraphNode>();
  const feed = useMemoryFeed(projectId, 30);

  // force-graph mutates link objects, so hand it copies.
  const data = useMemo(
    () => ({
      nodes: (graph?.nodes ?? []).map((n) => ({ ...n })),
      links: (graph?.edges ?? []).map((e) => ({ ...e })),
    }),
    [graph],
  );
  const kinds = useMemo(() => [...new Set(data.nodes.map((n) => n.kind))], [data]);

  return (
    <div className="grid h-full grid-cols-[1fr_320px] gap-4 p-4">
      <Panel className="relative min-h-0 overflow-hidden">
        <div ref={ref} className="absolute inset-0">
          {size.width > 0 && (
            <ForceGraph2D
              width={size.width}
              height={size.height}
              graphData={data}
              backgroundColor="#161226"
              nodeId="id"
              nodeLabel={(n) => `${n.kind}: ${n.label}`}
              nodeColor={(n) => NODE_COLORS[n.kind] ?? '#9a92bf'}
              nodeVal={(n) => (n.kind === 'File' ? 3 : n.kind === 'Failure' ? 4 : 2)}
              linkColor={() => 'rgba(154,146,191,0.25)'}
              linkDirectionalArrowLength={3}
              linkDirectionalArrowRelPos={1}
              onNodeClick={(n) => setSelected(n as GraphNode)}
              cooldownTicks={120}
            />
          )}
        </div>
        <div className="pointer-events-none absolute top-3 left-3 flex flex-wrap gap-2">
          {kinds.map((k) => (
            <span
              key={k}
              className="inline-flex items-center gap-1.5 rounded-full bg-bg/80 px-2 py-0.5 text-[11px] text-muted"
            >
              <span className="size-2 rounded-full" style={{ background: NODE_COLORS[k] }} />
              {k}
            </span>
          ))}
        </div>
        {selected && (
          <div className="absolute right-3 bottom-3 w-72 rounded-lg border border-line bg-bg/95 p-3 text-sm">
            <div className="text-[11px] text-muted uppercase">{selected.kind}</div>
            <div className="font-medium">{selected.label}</div>
            <div className="mt-1 font-mono text-[11px] break-all text-muted">{selected.id}</div>
          </div>
        )}
      </Panel>

      <Panel className="flex min-h-0 flex-col p-4">
        <SectionTitle>Memory feed</SectionTitle>
        <ol className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
          {feed.map((e) => (
            <li key={e.id} className="border-l-2 border-line pl-3">
              <div className="text-[11px] text-muted">
                {e.type.replaceAll('_', ' ')} · {timeAgo(e.at)}
              </div>
              <div className="text-sm">{e.text}</div>
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}
