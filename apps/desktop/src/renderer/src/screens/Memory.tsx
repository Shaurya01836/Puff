import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods, type NodeObject } from 'react-force-graph-2d';
import { Bot, Braces, Crosshair, Search, Send, type LucideIcon } from 'lucide-react';
import type {
  AgentName,
  GraphData,
  GraphEdge,
  GraphNode,
  LessonKind,
  MemoryItem,
  MemoryState,
} from '@puff/shared';
import { AgentChip, SectionTitle } from '@/components/ui';
import { puff } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useLoad } from '@/lib/hooks';
import { AGENT_META, NODE_COLORS, timeAgo } from '@/lib/theme';
import { MemoryGraph } from '@/screens/MemoryGraph';

const KINDS: { id: LessonKind | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'Failure', label: 'Failures' },
  { id: 'Solution', label: 'Fixes' },
  { id: 'Decision', label: 'Decisions' },
  { id: 'Procedure', label: 'Procedures' },
];

const KIND_WORD: Record<LessonKind, string> = {
  Failure: 'Failure',
  Solution: 'Fix',
  Decision: 'Decision',
  Procedure: 'Procedure',
};

/** The order lessons are grouped in, and the heading each group gets. */
const LESSON_KINDS: LessonKind[] = ['Failure', 'Solution', 'Decision', 'Procedure'];
const KIND_PLURAL: Record<LessonKind, string> = {
  Failure: 'Failures',
  Solution: 'Fixes',
  Decision: 'Decisions',
  Procedure: 'Procedures',
};

const STATE_META: Record<MemoryState, { label: string; tone: string; why: string }> = {
  current: {
    label: 'current',
    tone: 'text-brand bg-brand/10',
    why: 'Agents are given it.',
  },
  outdated: {
    label: 'possibly outdated',
    tone: 'text-warn bg-warn/10',
    why: 'The code it is about changed after it was learned. Agents still see it, marked as possibly outdated.',
  },
  superseded: {
    label: 'replaced',
    tone: 'text-ink bg-surface-3',
    why: 'A newer decision replaced it. It is kept for history and not given to agents.',
  },
  reverted: {
    label: 'reverted',
    tone: 'text-bad bg-bad/10',
    why: 'The merge it was learned in was undone. It is never offered to an agent.',
  },
  downgraded: {
    label: 'builds on a revert',
    tone: 'text-orange-300 bg-orange-500/10',
    why: 'It was learned from something that was later reverted, so it is trusted less.',
  },
};

/** Which lessons to show: everything, what agents get now, or what needs a person's look */
type Show = 'all' | 'current' | 'look';
/** Below this trust a lesson is worth a person's look (TRUST_LOW in core) */
const LOW_TRUST = 0.5;

const fnName = (id: string) => `${id.split('::')[1] ?? id}()`;

/**
 * What the team learned, one lesson at a time: the list says what each one is about and whether it still holds;
 * the selected one shows its trust, what moved it, and where it sits in the graph.
 */
export function Memory({
  projectId,
  graph,
  feedIsSample,
}: {
  projectId: string;
  /** The whole graph, for the overview */
  graph?: GraphData;
  feedIsSample: boolean;
}) {
  const [view, setView] = useState<'lessons' | 'graph'>('lessons');
  const [tick, setTick] = useState(0);
  const items = useLoad(() => puff.listMemory(projectId), [projectId, tick]);
  const [kind, setKind] = useState<LessonKind | 'all'>('all');
  const [show, setShow] = useState<Show>('all');
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>();

  // New memory arrives while agents work
  useEffect(() => puff.onEvent((e) => e.type === 'memory' && setTick((t) => t + 1)), []);

  const needsLook = (i: MemoryItem) =>
    i.state === 'outdated' ||
    i.state === 'downgraded' ||
    (i.trust !== undefined && i.trust < LOW_TRUST && i.state !== 'superseded');
  const matches = (i: MemoryItem) => {
    if (show === 'current' && i.state !== 'current') return false;
    if (show === 'look' && !needsLook(i)) return false;
    const q = query.trim().toLowerCase();
    if (q && !`${i.text} ${i.about.join(' ')}`.toLowerCase().includes(q)) return false;
    return true;
  };
  // What survives the state and search filters; the kind filter is applied on top of this.
  const matching = (items ?? []).filter(matches);
  const shown = matching.filter((i) => kind === 'all' || i.kind === kind);
  // Group the lessons by what they are, with anything worth a look first inside each group, so the
  // list reads as labelled sections rather than one long mixed stream.
  const grouped = LESSON_KINDS.map((k) => ({
    kind: k,
    items: shown
      .filter((i) => i.kind === k)
      .sort((a, b) => Number(needsLook(b)) - Number(needsLook(a)) || b.at - a.at),
  })).filter((g) => g.items.length > 0);
  const selected = (items ?? []).find((i) => i.id === selectedId) ?? grouped[0]?.items[0];
  const lookCount = (items ?? []).filter(needsLook).length;

  const toggle = (
    <div className="flex items-center rounded border border-line bg-surface p-0.5">
      {(
        [
          ['lessons', 'Lessons'],
          ['graph', 'Whole graph'],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          onClick={() => setView(id)}
          aria-pressed={view === id}
          className={cn(
            'rounded px-2.5 py-0.5 text-xs transition-colors',
            view === id ? 'bg-surface-3 font-medium text-ink' : 'text-ink-2 hover:text-ink',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (view === 'graph') {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-end border-b border-line px-5 py-2.5">
          {toggle}
        </div>
        <div className="min-h-0 flex-1">
          <MemoryGraph projectId={projectId} graph={graph} feedIsSample={feedIsSample} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-abyss">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-2.5">
        <div className="flex flex-wrap items-center gap-1">
          {KINDS.map((k) => {
            const n =
              k.id === 'all'
                ? matching.length
                : matching.filter((i) => i.kind === k.id).length;
            return (
              <button
                key={k.id}
                onClick={() => setKind(k.id)}
                aria-pressed={kind === k.id}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors',
                  kind === k.id ? 'bg-surface-3 font-medium text-ink' : 'text-ink-2 hover:text-ink',
                )}
              >
                {k.label}
                <span className="tabular-nums text-ink-3">{n}</span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-7 items-center gap-1.5 rounded border border-line bg-surface px-2 focus-within:border-brand/50">
            <Search className="size-3 text-ink-2" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a lesson or function…"
              aria-label="Find a lesson"
              className="w-44 bg-transparent text-xs text-ink outline-none placeholder:text-ink-3"
            />
          </label>
          <select
            value={show}
            onChange={(e) => setShow(e.target.value as Show)}
            aria-label="Which lessons"
            className="h-7 rounded border border-line bg-surface px-2 text-xs text-ink outline-none"
          >
            <option value="all">Every state</option>
            <option value="current">Only what agents get as is</option>
            <option value="look">Worth a look ({lookCount})</option>
          </select>
          {toggle}
        </div>
      </div>

      {items && items.length === 0 ? (
        <div className="grid flex-1 place-items-center p-10 text-center">
          <div className="max-w-sm">
            <p className="font-display text-lg font-semibold text-ink">Nothing learned yet</p>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">
              When an agent's tests fail, Puff records the failure on the function it happened in,
              and the fix that made them pass. Decisions and procedures agents write show up here
              too.
            </p>
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(17rem,26rem)_1fr]">
          <ul className="min-h-0 overflow-y-auto border-r border-line" aria-label="Lessons">
            {grouped.map((group) => {
              const color = NODE_COLORS[group.kind] ?? '#77777f';
              return (
                <li key={group.kind}>
                  <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-surface-2/95 px-4 py-1.5 backdrop-blur">
                    <span
                      className="size-1.5 rounded-full"
                      style={{ background: color }}
                      aria-hidden
                    />
                    <span
                      className="text-[0.6875rem] font-semibold tracking-wide uppercase"
                      style={{ color }}
                    >
                      {KIND_PLURAL[group.kind]}
                    </span>
                    <span className="ml-auto font-mono text-[0.625rem] tabular-nums text-ink-3">
                      {group.items.length}
                    </span>
                  </div>
                  <ul>
                    {group.items.map((i) => (
                      <LessonRow
                        key={i.id}
                        item={i}
                        selected={i.id === selected?.id}
                        onSelect={() => setSelectedId(i.id)}
                      />
                    ))}
                  </ul>
                </li>
              );
            })}
            {items && shown.length === 0 && (
              <li className="py-12 text-center text-xs text-ink-3">No lessons match</li>
            )}
          </ul>
          <div className="min-h-0 min-w-0 overflow-y-auto">
            {selected ? (
              <LessonDetail
                key={selected.id}
                projectId={projectId}
                item={selected}
                onOpen={(id) => {
                  setKind('all');
                  setShow('all');
                  setQuery('');
                  setSelectedId(id);
                }}
              />
            ) : (
              <div className="grid h-full place-items-center text-sm text-ink-3">
                {items ? 'Pick a lesson' : 'Loading…'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StateBadge({ state }: { state: MemoryState }) {
  const m = STATE_META[state];
  return (
    <span title={m.why} className={cn('rounded px-1.5 py-0.5 text-[0.625rem] font-medium', m.tone)}>
      {m.label}
    </span>
  );
}

/**
 * Trust reads in the accent, never in amber: solid for strong trust, the lighter tone for the middle
 * band, and red below the line where a lesson is held back from agents.
 */
function trustTone(trust: number): string {
  if (trust >= 0.7) return 'var(--color-brand)';
  if (trust >= LOW_TRUST) return 'var(--color-brand-soft)';
  return 'var(--color-bad)';
}

/** The trust value, what it means, and the two lines where a lesson stops being trusted. */
function TrustMeter({ trust }: { trust: number }) {
  const tone = trustTone(trust);
  const pct = Math.round(trust * 100);
  const status =
    trust < 0.35
      ? 'left out of agent prompts'
      : trust < LOW_TRUST
        ? 'given to agents as low confidence'
        : 'given to agents';
  return (
    <div className="max-w-md">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className="font-mono text-lg leading-none font-semibold tabular-nums"
          style={{ color: tone }}
        >
          {trust.toFixed(2)}
        </span>
        <span className="text-xs text-ink-3">{status}</span>
      </div>
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={trust}
        aria-label="Trust"
        className="relative mt-2 h-2.5 rounded-full bg-surface-3 ring-1 ring-line ring-inset"
      >
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out"
          style={{
            width: `${Math.max(pct, 3)}%`,
            background: `linear-gradient(90deg, color-mix(in oklab, ${tone} 35%, transparent), ${tone})`,
            boxShadow: `0 0 5px -3px color-mix(in oklab, ${tone} 55%, transparent)`,
          }}
        />
        <span
          className="pointer-events-none absolute inset-y-0 w-px bg-abyss/70"
          style={{ left: '35%' }}
        />
        <span
          className="pointer-events-none absolute inset-y-0 w-px bg-abyss/70"
          style={{ left: '50%' }}
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.625rem] text-ink-3">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-px bg-ink-3" />
          left out below 0.35
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-px bg-ink-3" />
          low confidence below 0.50
        </span>
      </div>
    </div>
  );
}

function LessonRow({
  item: i,
  selected,
  onSelect,
}: {
  item: MemoryItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const color = NODE_COLORS[i.kind] ?? '#77777f';
  return (
    <li ref={ref}>
      <button
        onClick={onSelect}
        aria-current={selected}
        className={cn(
          'flex w-full flex-col gap-1 border-b border-l-2 border-b-line px-4 py-3 text-left transition-colors',
          selected ? 'border-l-brand bg-surface-2' : 'border-l-transparent hover:bg-surface/60',
          i.state === 'superseded' && !selected && 'opacity-60',
        )}
      >
        <span className="flex items-center gap-2 text-[0.6875rem]">
          <span className="font-semibold" style={{ color }}>
            {KIND_WORD[i.kind]}
          </span>
          {i.state !== 'current' && <StateBadge state={i.state} />}
          <span className="ml-auto text-ink-3">{timeAgo(i.at)}</span>
        </span>
        <span
          className={cn(
            'line-clamp-2 text-sm leading-snug text-ink',
            (i.state === 'reverted' || i.state === 'superseded') && 'line-through decoration-ink-3',
          )}
        >
          {i.text}
        </span>
        <span className="flex items-center gap-2 text-[0.6875rem] text-ink-2">
          <span className="min-w-0 truncate font-mono text-ink-3">
            {i.about.length ? i.about.slice(0, 2).map(fnName).join(', ') : (i.appliesTo ?? '')}
            {i.about.length > 2 ? ` +${i.about.length - 2}` : ''}
          </span>
          {i.trust !== undefined && (
            <span className="ml-auto inline-flex shrink-0 items-center gap-1" title="Trust">
              <span className="h-1 w-10 overflow-hidden rounded-full bg-surface-3">
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${Math.round(i.trust * 100)}%`, background: trustTone(i.trust) }}
                />
              </span>
              <span className="tabular-nums" style={{ color: trustTone(i.trust) }}>
                {i.trust.toFixed(2)}
              </span>
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

function LessonDetail({
  projectId,
  item: i,
  onOpen,
}: {
  projectId: string;
  item: MemoryItem;
  onOpen: (id: string) => void;
}) {
  const color = NODE_COLORS[i.kind] ?? '#77777f';
  const related =
    i.kind === 'Failure'
      ? 'Fixed by'
      : i.kind === 'Solution'
        ? 'Fixes'
        : i.kind === 'Decision'
          ? 'Replaces'
          : '';
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 border-b border-line bg-abyss/95 px-6 py-4 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span
            className="rounded px-1.5 py-0.5 text-[0.625rem] font-semibold"
            style={{ color, background: `color-mix(in oklab, ${color} 16%, transparent)` }}
          >
            {KIND_WORD[i.kind]}
          </span>
          <StateBadge state={i.state} />
          {i.seeded && (
            <span className="rounded bg-warn/10 px-1.5 py-0.5 text-[0.625rem] text-warn">
              sample
            </span>
          )}
          <span className="ml-auto font-mono text-[0.625rem] text-ink-3">{i.id}</span>
        </div>
        <h2 className="mt-3 font-display text-lg leading-snug font-semibold text-ink">{i.text}</h2>
      </header>

      <div className="flex flex-col gap-6 px-6 py-5">
        <section>
          <SectionTitle>What this means</SectionTitle>
          <p className="text-[0.8125rem] leading-relaxed text-ink-2">{STATE_META[i.state].why}</p>
        </section>

        <section>
          <SectionTitle>Details</SectionTitle>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Fact icon={Braces} label={i.kind === 'Procedure' ? 'Applies to' : 'About'}>
              {i.about.length ? (
                <span className="flex flex-wrap gap-1">
                  {i.about.map((a) => (
                    <span
                      key={a}
                      title={a}
                      className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[0.6875rem] text-ink-2"
                    >
                      {fnName(a)}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="text-sm text-ink-2">{i.appliesTo ?? 'nothing recorded'}</span>
              )}
            </Fact>
            <Fact icon={Bot} label="Learned">
              <span className="flex flex-col gap-1.5">
                {i.agent ? (
                  <AgentChip agent={i.agent as AgentName} />
                ) : (
                  <span className="text-sm text-ink-2">by a person or seed</span>
                )}
                <span className="text-xs text-ink-3">{timeAgo(i.at)}</span>
              </span>
            </Fact>
            <Fact icon={Send} label="Given to agents">
              <Count n={i.usedIn} unit={i.usedIn === 1 ? 'time' : 'times'} />
            </Fact>
            {i.hits !== undefined && (
              <Fact icon={Crosshair} label="Hit">
                <Count n={i.hits} unit={i.hits === 1 ? 'time' : 'times'} />
              </Fact>
            )}
          </dl>
        </section>

        {i.trust !== undefined && (
          <section>
            <SectionTitle>How far it is trusted</SectionTitle>
            <TrustMeter trust={i.trust} />
            <ul className="mt-3 flex flex-col gap-0.5 text-[0.8125rem] text-ink-2">
              <li>Starts at 0.60.</li>
              {(i.trustWhy ?? []).map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </section>
        )}

        {i.related && related && (
          <section>
            <SectionTitle>{related}</SectionTitle>
            <button
              onClick={() => onOpen(i.related!.id)}
              className="w-full rounded-md border border-line bg-surface-2 px-3 py-2.5 text-left text-sm text-ink hover:border-line-strong hover:bg-surface-3"
            >
              {i.related.text}
            </button>
          </section>
        )}

        <section>
          <SectionTitle>Where it sits in the graph</SectionTitle>
          <FocusGraph projectId={projectId} focusId={i.id} />
        </section>
      </div>
    </div>
  );
}

function Fact({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-2/50 p-3.5">
      <dt className="flex items-center gap-1.5 text-[0.6875rem] font-medium tracking-wide text-ink-3 uppercase">
        <Icon className="size-3" />
        {label}
      </dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  );
}

/** A count with its unit, the number given the weight */
function Count({ n, unit }: { n: number; unit: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-lg leading-none font-semibold tabular-nums">{n}</span>
      <span className="text-xs text-ink-3">{unit}</span>
    </span>
  );
}

type GNode = NodeObject<GraphNode>;

/** Readable names for the edges a person sees around one lesson */
const EDGE_WORD: Record<string, string> = {
  IN: 'in',
  ABOUT: 'about',
  FIXED_BY: 'fixed by',
  HIT: 'hit',
  CALLS: 'calls',
  DEFINES: 'defines',
  SUPERSEDES: 'replaces',
  LEARNED_IN: 'learned in',
  DERIVED_FROM: 'built on',
  TARGETS: 'targets',
  RAN: 'ran',
  WORKED_ON: 'worked on',
  APPLIES_TO: 'applies to',
};

/** At most this many nodes on the outer ring; the rest are counted, not drawn */
const MAX_OUTER = 14;
/** Which kinds come first around a ring: code, then memory, then work */
const KIND_ORDER = [
  'Symbol',
  'File',
  'Failure',
  'Solution',
  'Decision',
  'Procedure',
  'Session',
  'Task',
  'Agent',
];

/** The lesson and what is two steps from it, every node labelled: small enough to read, unlike the whole graph */
function FocusGraph({ projectId, focusId }: { projectId: string; focusId: string }) {
  const data = useLoad(() => puff.getGraph(projectId, focusId, 2), [projectId, focusId]);
  const wrap = useRef<HTMLDivElement>(null);
  const fg = useRef<ForceGraphMethods<GNode, GraphEdge> | undefined>(undefined);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(e.contentRect.width));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);

  // Rings, not a free layout: the lesson in the middle, what it touches directly on the first ring, the next
  // step on the outer ring next to what leads to it. Every label then has room. Bookkeeping nodes are left out.
  const { graph, hidden } = useMemo(() => {
    const all = (data?.nodes ?? []).filter(
      (n) => n.kind !== 'Capability' && n.kind !== 'Technology',
    );
    const ids = new Set(all.map((n) => n.id));
    const edges = (data?.edges ?? []).filter((e) => ids.has(e.source) && ids.has(e.target));
    const near = new Map<string, string[]>();
    for (const e of edges) {
      near.set(e.source, [...(near.get(e.source) ?? []), e.target]);
      near.set(e.target, [...(near.get(e.target) ?? []), e.source]);
    }
    const byId = new Map(all.map((n) => [n.id, n]));
    const ring1 = [...new Set(near.get(focusId) ?? [])].sort(byKind);
    const parentOf = new Map<string, string>();
    for (const p of ring1)
      for (const n of near.get(p) ?? [])
        if (n !== focusId && !ring1.includes(n) && !parentOf.has(n)) parentOf.set(n, p);
    const outer = [...parentOf.keys()].sort(
      (a, b) => ring1.indexOf(parentOf.get(a)!) - ring1.indexOf(parentOf.get(b)!) || byKind(a, b),
    );
    const ring2 = outer.slice(0, MAX_OUTER);
    const place = (list: string[], r: number, offset = 0) =>
      list.map((id, i) => {
        const a = offset + (2 * Math.PI * i) / Math.max(list.length, 1) - Math.PI / 2;
        return { ...byId.get(id)!, fx: Math.cos(a) * r, fy: Math.sin(a) * r };
      });
    const r1 = Math.max(90, ring1.length * 22);
    const nodes: GNode[] = [
      { ...byId.get(focusId)!, fx: 0, fy: 0 },
      ...place(ring1, r1),
      ...place(ring2, r1 + Math.max(110, ring2.length * 9), Math.PI / Math.max(ring2.length, 1)),
    ].filter((n) => n.id);
    const keep = new Set(nodes.map((n) => n.id));
    const links = edges
      .filter((e) => keep.has(e.source) && keep.has(e.target))
      .map((e) => ({ ...e }));
    function byKind(a: string, b: string) {
      return (
        KIND_ORDER.indexOf(byId.get(a)?.kind ?? '') - KIND_ORDER.indexOf(byId.get(b)?.kind ?? '') ||
        a.localeCompare(b)
      );
    }
    return { graph: { nodes, links }, hidden: outer.length - ring2.length };
  }, [data, focusId]);

  // Positions are fixed, so fit as soon as the canvas has them
  useEffect(() => {
    const t = setTimeout(() => fg.current?.zoomToFit(300, 36), 250);
    return () => clearTimeout(t);
  }, [graph, width]);

  const draw = useCallback(
    (node: GNode, ctx: CanvasRenderingContext2D, scale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const focus = node.id === focusId;
      const r = focus ? 7 : 4.5;
      const color =
        node.kind === 'Agent'
          ? (AGENT_META[node.label as AgentName]?.color ?? NODE_COLORS.Agent!)
          : (NODE_COLORS[node.kind] ?? '#77777f');
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fill();
      if (focus) {
        ctx.strokeStyle = '#a4a4ad';
        ctx.lineWidth = 1.5 / scale;
        ctx.beginPath();
        ctx.arc(x, y, r + 3, 0, 2 * Math.PI);
        ctx.stroke();
      }
      const size = Math.max(11 / scale, 2);
      ctx.font = `${focus ? 600 : 500} ${size}px 'Inter Variable', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = focus ? '#f2f2f4' : '#a4a4ad';
      const name = node.kind === 'Symbol' ? `${node.label}()` : node.label;
      ctx.fillText(name.length > 26 ? `${name.slice(0, 25)}…` : name, x, y + r + 2);
    },
    [focusId],
  );

  if (data && graph.nodes.length <= 1)
    return <p className="text-sm text-ink-3">Nothing is connected to it yet.</p>;

  return (
    <div
      ref={wrap}
      className="canvas relative h-[420px] overflow-hidden rounded-md border border-line"
    >
      {width > 0 && data && (
        <ForceGraph2D<GraphNode, GraphEdge>
          ref={fg}
          width={width}
          height={420}
          graphData={graph}
          backgroundColor="rgba(0,0,0,0)"
          nodeId="id"
          nodeLabel={(n) =>
            `${n.kind}: ${n.label}`.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
          }
          nodeCanvasObject={draw}
          linkColor={() => 'rgba(140,155,190,0.35)'}
          linkDirectionalArrowLength={3}
          linkDirectionalArrowRelPos={1}
          linkCanvasObjectMode={() => 'after'}
          linkCanvasObject={(l, ctx, scale) => {
            const a = l.source as GNode;
            const b = l.target as GNode;
            if (scale < 1.2 || a.x === undefined || b.x === undefined) return;
            const word = EDGE_WORD[l.type] ?? l.type.toLowerCase();
            ctx.font = `${Math.max(9 / scale, 1.6)}px 'Inter Variable', sans-serif`;
            ctx.fillStyle = 'rgba(160,172,200,0.7)';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(word, (a.x + (b.x ?? 0)) / 2, ((a.y ?? 0) + (b.y ?? 0)) / 2);
          }}
          cooldownTicks={20}
          onEngineStop={() => fg.current?.zoomToFit(400, 40)}
        />
      )}
      <div className="pointer-events-none absolute bottom-2 left-3 text-[0.625rem] text-ink-3">
        two steps around this lesson{hidden > 0 ? ` · ${hidden} more not drawn` : ''} · scroll to
        zoom
      </div>
    </div>
  );
}
