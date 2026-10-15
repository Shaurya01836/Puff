import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods, type NodeObject } from 'react-force-graph-2d';
import { Crosshair, Maximize2, X } from 'lucide-react';
import type { AgentName, GraphData, GraphEdge, GraphNode } from '@puff/shared';
import { EventIcon, Panel, SectionTitle } from '@/components/ui';
import { puff } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useMemoryFeed } from '@/lib/hooks';
import { AGENT_META, MEMORY_EVENT_META, NODE_COLORS, NODE_GROUPS, timeAgo } from '@/lib/theme';

type Group = 'code' | 'work' | 'memory';
type GNode = NodeObject<GraphNode>;

const GROUPS: { id: Group; label: string; color: string }[] = [
  { id: 'code', label: 'Code', color: '#8b7cf6' },
  { id: 'work', label: 'Work', color: '#e7ecf6' },
  { id: 'memory', label: 'Memory', color: '#2dd4e0' },
];

const MEMORY_LINKS = new Set([
  'IN',
  'FIXED_BY',
  'ABOUT',
  'HIT',
  'SUPERSEDES',
  'APPLIES_TO',
  'INCLUDED',
]);
const RADIUS: Record<string, number> = {
  File: 5,
  Symbol: 3.6,
  Technology: 4,
  Task: 4.6,
  Session: 3,
  Agent: 6.5,
  Capability: 3,
  Failure: 5.5,
  Solution: 4.2,
  Decision: 4.2,
  Procedure: 3.8,
};

/** force-graph renders tooltips as HTML; labels can come from real repos, so escape them. */
const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const idOf = (v: unknown): string =>
  typeof v === 'object' && v !== null ? String((v as { id: string }).id) : String(v);

/** Failures and decisions can go out of date (their code changed) or be replaced (decisions). */
function memoryStateOf(n: GraphNode): 'outdated' | 'superseded' | undefined {
  if (n.props?.status === 'superseded') return 'superseded';
  if (n.props?.stale === true) return 'outdated';
  return undefined;
}

function nodeColor(n: GraphNode): string {
  if (n.kind === 'Agent') {
    const agent = n.id.replace('agent:', '') as AgentName;
    return AGENT_META[agent]?.color ?? NODE_COLORS.Agent!;
  }
  return NODE_COLORS[n.kind] ?? '#6b7894';
}

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

export function MemoryGraph({
  projectId,
  graph,
  feedIsSample,
}: {
  projectId: string;
  graph?: GraphData;
  /** Feed still comes from mocks (memory goes live in P2) */
  feedIsSample: boolean;
}) {
  const [ref, size] = useSize<HTMLDivElement>();
  const fg = useRef<ForceGraphMethods<GNode, GraphEdge> | undefined>(undefined);
  const fitted = useRef(false);
  const [groups, setGroups] = useState<Record<Group, boolean>>({
    code: true,
    work: true,
    memory: true,
  });
  const [hover, setHover] = useState<string>();
  const [selected, setSelected] = useState<GraphNode>();
  const [focus, setFocus] = useState<{ id: string; label: string; data: GraphData }>();
  const feed = useMemoryFeed(projectId, 40);

  const source = focus?.data ?? graph;

  // force-graph mutates nodes/links (adds x/y, swaps ids for objects), so hand it copies.
  const data = useMemo(() => {
    const nodes = (source?.nodes ?? [])
      .filter((n) => groups[NODE_GROUPS[n.kind] ?? 'code'])
      .map((n) => ({ ...n }));
    const keep = new Set(nodes.map((n) => n.id));
    const links = (source?.edges ?? [])
      .filter((e) => keep.has(e.source) && keep.has(e.target))
      .map((e) => ({ ...e }));
    return { nodes, links };
  }, [source, groups]);

  const neighbours = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of source?.edges ?? []) {
      if (!map.has(e.source)) map.set(e.source, new Set());
      if (!map.has(e.target)) map.set(e.target, new Set());
      map.get(e.source)!.add(e.target);
      map.get(e.target)!.add(e.source);
    }
    return map;
  }, [source]);

  const stats = useMemo(() => {
    const count = (kinds: string[]) =>
      graph?.nodes.filter((n) => kinds.includes(n.kind)).length ?? 0;
    return [
      { label: 'Files', value: count(['File']) },
      { label: 'Symbols', value: count(['Symbol']) },
      { label: 'Memories', value: count(['Failure', 'Solution', 'Decision', 'Procedure']) },
      { label: 'Tasks', value: count(['Task']) },
    ];
  }, [graph]);

  const groupCounts = useMemo(() => {
    const c: Record<Group, number> = { code: 0, work: 0, memory: 0 };
    for (const n of source?.nodes ?? []) c[NODE_GROUPS[n.kind] ?? 'code']++;
    return c;
  }, [source]);

  // Agents and capabilities float apart until sessions link them to code, so fit the view to
  // code and memory whenever there is any, and to everything otherwise.
  const fit = useCallback(
    (ms: number) => {
      const anchored = data.nodes.some((n) => NODE_GROUPS[n.kind] !== 'work' || n.kind === 'Task');
      fg.current?.zoomToFit(ms, 70, (n) =>
        anchored ? n.kind !== 'Agent' && n.kind !== 'Capability' : true,
      );
    },
    [data],
  );

  // Fit once the layout settles; the timer covers remounts where the engine stops early.
  useEffect(() => {
    fitted.current = false;
    const t = setTimeout(() => {
      fit(500);
      fitted.current = true;
    }, 1600);
    return () => clearTimeout(t);
  }, [source, groups, size.width, size.height]);

  const active = hover ?? selected?.id;
  const isLit = useCallback(
    (id: string) => !active || id === active || neighbours.get(active)?.has(id) === true,
    [active, neighbours],
  );

  const drawNode = useCallback(
    (node: GNode, ctx: CanvasRenderingContext2D, scale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const r = RADIUS[node.kind] ?? 3.5;
      const color = nodeColor(node);
      const lit = isLit(node.id);
      const group = NODE_GROUPS[node.kind];

      const memoryState = memoryStateOf(node);
      ctx.save();
      ctx.globalAlpha = lit ? (memoryState === 'superseded' ? 0.45 : 1) : 0.12;
      if (group === 'memory' || node.kind === 'Agent') {
        ctx.shadowColor = color;
        ctx.shadowBlur = node.kind === 'Failure' ? 18 : 10;
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      if (node.kind === 'File') {
        ctx.roundRect(x - r, y - r, r * 2, r * 2, 2);
      } else {
        ctx.arc(x, y, r, 0, 2 * Math.PI);
      }
      ctx.fill();
      ctx.shadowBlur = 0;

      if (memoryState === 'outdated') {
        // dashed amber ring: the code this memory is about has changed since
        ctx.strokeStyle = '#f5b83d';
        ctx.lineWidth = 1.2 / scale;
        ctx.setLineDash([2 / scale, 2 / scale]);
        ctx.beginPath();
        ctx.arc(x, y, r + 2.5, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      if (node.id === selected?.id || node.highlight) {
        ctx.strokeStyle = '#e7ecf6';
        ctx.lineWidth = 1.5 / scale;
        ctx.beginPath();
        ctx.arc(x, y, r + 3, 0, 2 * Math.PI);
        ctx.stroke();
      }

      const showLabel =
        scale > 2.4 ||
        (lit && active !== undefined) ||
        (group === 'memory' && scale > 1.6) ||
        node.kind === 'Failure' ||
        node.kind === 'Agent';
      if (showLabel) {
        const size = Math.max(10 / scale, 1.6);
        ctx.font = `500 ${size}px 'Inter Variable', sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = group === 'memory' ? color : '#a9b4cc';
        const label = node.label.length > 28 ? `${node.label.slice(0, 27)}…` : node.label;
        ctx.fillText(label, x, y + r + 2);
      }
      ctx.restore();
    },
    [isLit, selected, active],
  );

  const focusOn = async (node: GraphNode) => {
    const data = await puff.getGraph(projectId, node.id, 2);
    setFocus({ id: node.id, label: node.label, data });
    setSelected(node);
  };

  return (
    <div className="grid h-full grid-cols-[minmax(0,1fr)_340px] gap-4 p-4">
      <div className="sea relative min-h-0 overflow-hidden rounded-[14px] border border-line">
        <div ref={ref} className="absolute inset-0">
          {size.width > 0 && (
            <ForceGraph2D<GraphNode, GraphEdge>
              ref={fg}
              width={size.width}
              height={size.height}
              graphData={data}
              backgroundColor="rgba(0,0,0,0)"
              nodeId="id"
              nodeLabel={(n) => `<b>${n.kind}</b> · ${escapeHtml(n.label)}`}
              nodeCanvasObject={drawNode}
              nodePointerAreaPaint={(n, color, ctx) => {
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(n.x ?? 0, n.y ?? 0, (RADIUS[n.kind] ?? 3.5) + 3, 0, 2 * Math.PI);
                ctx.fill();
              }}
              linkColor={(l) => {
                const lit = !active || idOf(l.source) === active || idOf(l.target) === active;
                if (!lit) return 'rgba(107,120,148,0.05)';
                if (MEMORY_LINKS.has(l.type)) return 'rgba(45,212,224,0.5)';
                if (l.type === 'CALLS') return 'rgba(139,124,246,0.4)';
                return 'rgba(107,120,148,0.22)';
              }}
              linkWidth={(l) => (MEMORY_LINKS.has(l.type) ? 1.4 : 0.8)}
              linkDirectionalArrowLength={(l) => (l.type === 'CALLS' ? 3 : 0)}
              linkDirectionalArrowRelPos={1}
              linkDirectionalParticles={(l) => (MEMORY_LINKS.has(l.type) ? 2 : 0)}
              linkDirectionalParticleWidth={2}
              linkDirectionalParticleSpeed={0.005}
              linkDirectionalParticleColor={() => '#2dd4e0'}
              onNodeHover={(n) => setHover(n ? n.id : undefined)}
              onNodeClick={(n) => setSelected(n)}
              onBackgroundClick={() => setSelected(undefined)}
              cooldownTicks={140}
              d3VelocityDecay={0.3}
              onEngineStop={() => {
                if (!fitted.current) {
                  fit(500);
                  fitted.current = true;
                }
              }}
            />
          )}
        </div>

        {/* top-left: hero numbers */}
        <div className="pointer-events-none absolute top-4 left-4 flex gap-2">
          {stats.map((s) => (
            <div
              key={s.label}
              className="rounded-xl border border-line bg-abyss/70 px-3 py-2 backdrop-blur"
            >
              <div className="font-display text-lg leading-none font-semibold tabular-nums">
                {s.value}
              </div>
              <div className="mt-1 text-[10px] tracking-wider text-ink-3 uppercase">{s.label}</div>
            </div>
          ))}
        </div>

        {/* top-right: layer toggles */}
        <div className="absolute top-4 right-4 flex items-center gap-1.5 rounded-xl border border-line bg-abyss/70 p-1 backdrop-blur">
          {GROUPS.map((g) => (
            <button
              key={g.id}
              onClick={() => setGroups((s) => ({ ...s, [g.id]: !s[g.id] }))}
              aria-pressed={groups[g.id]}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs transition-colors',
                groups[g.id] ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:text-ink-2',
              )}
            >
              <span
                className="size-2 rounded-full"
                style={{
                  background: groups[g.id] ? g.color : 'transparent',
                  boxShadow: `inset 0 0 0 1px ${g.color}`,
                }}
              />
              {g.label}
              <span className="text-ink-3 tabular-nums">{groupCounts[g.id]}</span>
            </button>
          ))}
          <button
            onClick={() => fit(400)}
            className="ml-1 rounded-lg p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink"
            title="Fit to view"
          >
            <Maximize2 className="size-3.5" />
          </button>
        </div>

        {focus && (
          <div className="absolute top-20 left-4 inline-flex items-center gap-2 rounded-lg border border-brand/30 bg-brand/10 px-3 py-1.5 text-xs text-brand-soft backdrop-blur">
            <Crosshair className="size-3.5" />
            Neighbourhood of <b className="font-medium text-ink">{focus.label}</b>
            <button
              onClick={() => setFocus(undefined)}
              className="ml-1 text-ink-3 hover:text-ink"
              title="Show all"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}

        {/* bottom-left: legend */}
        <div className="pointer-events-none absolute bottom-4 left-4 flex max-w-[60%] flex-wrap gap-x-3 gap-y-1.5 rounded-xl border border-line bg-abyss/70 px-3 py-2 backdrop-blur">
          {[
            'Symbol',
            'File',
            'Task',
            'Session',
            'Failure',
            'Solution',
            'Decision',
            'Procedure',
          ].map((k) => (
            <span key={k} className="inline-flex items-center gap-1.5 text-[11px] text-ink-2">
              <span
                className={cn('size-2', k === 'File' ? 'rounded-[2px]' : 'rounded-full')}
                style={{ background: NODE_COLORS[k] }}
              />
              {k}
            </span>
          ))}
        </div>

        {/* bottom-right: inspector */}
        {selected && (
          <div className="absolute right-4 bottom-4 w-80 animate-fade-in rounded-xl border border-line-strong bg-abyss/90 p-4 backdrop-blur">
            <div className="flex items-center justify-between">
              <span
                className="rounded-md px-2 py-0.5 text-[11px] font-medium"
                style={{
                  color: nodeColor(selected),
                  background: `color-mix(in oklab, ${nodeColor(selected)} 14%, transparent)`,
                }}
              >
                {selected.kind}
              </span>
              <button onClick={() => setSelected(undefined)} className="text-ink-3 hover:text-ink">
                <X className="size-4" />
              </button>
            </div>
            <div className="mt-2 text-sm font-medium">{selected.label}</div>
            {memoryStateOf(selected) && (
              <div
                className="mt-1.5 inline-block rounded bg-warn/10 px-1.5 py-0.5 text-[11px] text-warn"
                title={
                  memoryStateOf(selected) === 'outdated'
                    ? 'The code this is about changed after it was recorded. It is shown to agents labelled "possibly outdated".'
                    : 'Replaced by a newer decision. Kept for history, not given to agents.'
                }
              >
                {memoryStateOf(selected) === 'outdated' ? 'possibly outdated' : 'superseded'}
              </div>
            )}
            <div className="mt-1 font-mono text-[11px] break-all text-ink-3">{selected.id}</div>
            <div className="mt-3 flex items-center justify-between text-xs text-ink-3">
              <span>{neighbours.get(selected.id)?.size ?? 0} connections</span>
              <button
                onClick={() => void focusOn(selected)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-surface-3 px-2.5 py-1 text-ink hover:bg-line-strong"
              >
                <Crosshair className="size-3.5" />
                Focus 2 hops
              </button>
            </div>
          </div>
        )}
      </div>

      <Panel className="flex min-h-0 flex-col p-4">
        <SectionTitle
          right={
            feedIsSample ? (
              <span className="rounded-full bg-warn/10 px-2 py-0.5 text-[11px] text-warn">
                sample
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-memory">
                <span className="size-1.5 animate-breathe rounded-full bg-memory" />
                live
              </span>
            )
          }
        >
          Memory feed
        </SectionTitle>
        <ol className="-mr-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-2">
          {feed.map((e) => (
            <li
              key={e.id}
              className="flex animate-fade-in gap-3 rounded-lg p-2 transition-colors hover:bg-surface-2"
            >
              <EventIcon type={e.type} />
              <div className="min-w-0">
                <div className="flex items-baseline gap-2 text-[11px]">
                  <span className="font-medium" style={{ color: MEMORY_EVENT_META[e.type].color }}>
                    {MEMORY_EVENT_META[e.type].label}
                  </span>
                  <span className="text-ink-3">{timeAgo(e.at)}</span>
                </div>
                <div className="text-[13px] leading-snug text-ink-2">{e.text}</div>
              </div>
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}
