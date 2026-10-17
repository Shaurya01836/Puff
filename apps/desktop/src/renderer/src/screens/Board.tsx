import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import {
  Check,
  CheckCheck,
  Coins,
  Columns3,
  FlaskConical,
  GitBranch,
  Hand,
  Hourglass,
  LayoutList,
  Link2,
  LoaderCircle,
  Network,
  Pause,
  RotateCcw,
  Search,
  Square,
  StickyNote,
  Terminal,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { AgentName, Task, TaskStatus, TrailEntry } from '@puff/shared';
import type { SymbolOption } from '@/components/NewTaskDialog';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { AgentAvatar, AgentChip, StatusPill, WaitingChip } from '@/components/ui';
import { Menu } from '@/components/Menu';
import { cn } from '@/lib/cn';
import { TaskPanel } from '@/screens/TaskPanel';
import { AGENT_META, STATUS_META, TONE_COLOR, formatTokens } from '@/lib/theme';

/** Risk at or above this counts as load-bearing code (the default of graph.riskThreshold) */
const RISKY = 0.9;

const COLUMNS: { title: string; statuses: TaskStatus[]; tone: keyof typeof TONE_COLOR }[] = [
  { title: 'Planned', statuses: ['planned', 'ready'], tone: 'neutral' },
  { title: 'Running', statuses: ['running'], tone: 'info' },
  { title: 'Verifying', statuses: ['verifying'], tone: 'brand' },
  { title: 'Needs attention', statuses: ['failed', 'retrying', 'escalated'], tone: 'bad' },
  { title: 'Done', statuses: ['done'], tone: 'good' },
];

/** Something the person asks of a task from the board */
export type BoardAction =
  | { kind: 'stop' | 'retry' | 'done' | 'takeover'; id: string }
  | { kind: 'switch'; id: string; agent: AgentName };

const AGENTS: AgentName[] = ['claude-code', 'codex', 'opencode'];
const WORKING: TaskStatus[] = ['running', 'verifying'];

/** The current time, refreshed so "working for 4m" keeps counting */
function useNow(every = 15_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

function duration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Is this card the person's to work on (they took it over), and where does that stand? */
const takenOver = (t: Task) => Boolean(t.worktree?.endsWith('-manual'));

export function Board({
  tasks,
  selectedId,
  onSelect,
  terminalFor,
  symbols,
  onAction,
  onHint,
}: {
  tasks: Task[];
  /** The task shown next to the list */
  selectedId?: string;
  onSelect: (taskId: string | undefined) => void;
  /** A task whose panel should open on its terminal (Take over) */
  terminalFor?: string;
  symbols: SymbolOption[];
  onAction: (action: BoardAction) => void;
  /** Tell the person why a drop did nothing */
  onHint: (text: string) => void;
}) {
  const [viewMode, setViewMode] = useState<'list' | 'columns'>('list');
  const [query, setQuery] = useState('');
  const [agent, setAgent] = useState<AgentName | 'you' | 'all'>('all');
  const [hideDone, setHideDone] = useState(false);
  const [dropOn, setDropOn] = useState<string>();
  const now = useNow();

  // Taking a task over always shows its terminal, which lives in the list view
  useEffect(() => {
    if (terminalFor) setViewMode('list');
  }, [terminalFor]);

  const count = (statuses: TaskStatus[]) => tasks.filter((t) => statuses.includes(t.status)).length;
  const counts = [
    { label: 'running', n: count(['running', 'verifying']) },
    { label: 'queued', n: count(['planned', 'ready']) },
    {
      label: 'need attention',
      n: tasks.filter(
        (t) => ['failed', 'retrying', 'escalated'].includes(t.status) && !takenOver(t),
      ).length,
      bad: true,
    },
    {
      label: 'taken over by you',
      n: tasks.filter((t) => takenOver(t) && t.status !== 'done').length,
    },
    { label: 'done', n: count(['done']) },
  ];

  const shown = tasks.filter((t) => {
    if (hideDone && t.status === 'done') return false;
    if (query && !t.title.toLowerCase().includes(query.trim().toLowerCase())) return false;
    if (agent === 'you') return takenOver(t);
    if (agent !== 'all') {
      const involved = [t.assignedAgent, t.preferredAgent, ...(t.trail ?? []).map((e) => e.agent)];
      if (!involved.includes(agent)) return false;
    }
    return true;
  });
  // What needs the person first, then what is moving, then the rest; newest first inside each group
  const ordered = [...shown].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || b.updatedAt - a.updatedAt,
  );
  const selected = tasks.find((t) => t.id === selectedId) ?? ordered[0];

  /** Dropping a card on a column asks for what that column means (Puff moves the others itself). */
  const drop = (e: DragEvent, column: string) => {
    e.preventDefault();
    setDropOn(undefined);
    const id = e.dataTransfer.getData('text/plain');
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    if (column === 'Done') {
      if (task.status === 'done') return;
      onAction({ kind: 'done', id });
    } else if (column === 'Needs attention') {
      if (WORKING.includes(task.status)) onAction({ kind: 'stop', id });
      else onHint('Only a task that is running can be moved here, which stops it.');
    } else if (column === 'Planned') {
      if (task.status === 'failed') onAction({ kind: 'retry', id });
      else onHint('Only a failed task can be moved back to Planned, which retries it.');
    } else {
      onHint('Puff moves cards into Running and Verifying itself when you press Run team.');
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-abyss">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
          {counts.map((c) => (
            <span key={c.label}>
              <b
                className={cn(
                  'font-semibold tabular-nums',
                  c.bad && c.n > 0 ? 'text-rose-300' : 'text-slate-100',
                )}
              >
                {c.n}
              </b>{' '}
              {c.label}
            </span>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-7 items-center gap-1.5 rounded border border-line bg-surface px-2 focus-within:border-emerald-500/60">
            <Search className="size-3 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a task…"
              aria-label="Find a task"
              className="w-28 bg-transparent font-sans text-xs text-slate-200 transition-all outline-none placeholder:text-slate-500 focus:w-36"
            />
          </label>
          <select
            value={agent}
            onChange={(e) => setAgent(e.target.value as AgentName | 'you' | 'all')}
            aria-label="Show tasks worked on by"
            className="h-7 rounded border border-line bg-surface px-2 text-xs text-slate-300 outline-none"
          >
            <option value="all">Any agent</option>
            {AGENTS.map((a) => (
              <option key={a} value={a}>
                {AGENT_META[a].label}
              </option>
            ))}
            <option value="you">Taken over by you</option>
          </select>
          <button
            onClick={() => setHideDone((h) => !h)}
            aria-pressed={hideDone}
            className={cn(
              'h-7 rounded border px-2 text-xs transition-colors',
              hideDone
                ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                : 'border-line bg-surface text-slate-400 hover:text-white',
            )}
          >
            Hide done
          </button>
          <div className="flex items-center rounded border border-line bg-surface p-0.5">
            {(
              [
                ['list', LayoutList, 'List'],
                ['columns', Columns3, 'Board'],
              ] as const
            ).map(([mode, Icon, label]) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                aria-pressed={viewMode === mode}
                className={cn(
                  'inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs transition-colors',
                  viewMode === mode
                    ? 'bg-surface-3 font-medium text-white'
                    : 'text-slate-400 hover:text-white',
                )}
              >
                <Icon className="size-3" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {tasks.length === 0 ? (
        <div className="grid flex-1 place-items-center p-10 text-center">
          <div className="max-w-sm">
            <p className="font-display text-lg font-semibold text-white">No tasks yet</p>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              Give the team a goal in the box above and a planner splits it into tasks, or press{' '}
              <b className="font-medium text-slate-200">New task</b> to add one yourself.
            </p>
          </div>
        </div>
      ) : viewMode === 'list' ? (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(17rem,24rem)_1fr]">
          <ul className="min-h-0 overflow-y-auto border-r border-line" aria-label="Tasks">
            {ordered.map((t) => (
              <TaskRow
                key={t.id}
                task={t}
                now={now}
                selected={t.id === selected?.id}
                onSelect={() => onSelect(t.id)}
              />
            ))}
            {ordered.length === 0 && (
              <li className="py-12 text-center text-xs text-slate-500">No matching tasks</li>
            )}
          </ul>
          <div className="min-h-0 min-w-0">
            {selected ? (
              <ErrorBoundary resetKey={selected.id} label="This task's panel">
                <TaskPanel
                  key={selected.id}
                  taskId={selected.id}
                  symbols={symbols}
                  showTerminal={terminalFor === selected.id}
                  onRemoved={() => onSelect(undefined)}
                />
              </ErrorBoundary>
            ) : (
              <div className="grid h-full place-items-center text-sm text-slate-500">
                Pick a task to see what its agent is doing
              </div>
            )}
          </div>
        </div>
      ) : (
        /* Kanban Columns View */
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-x-auto p-4 md:grid-cols-5">
          {COLUMNS.map((col) => {
            const items = shown
              .filter((t) => col.statuses.includes(t.status))
              .sort((a, b) => b.updatedAt - a.updatedAt);
            const color = TONE_COLOR[col.tone];
            return (
              <section
                key={col.title}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDropOn(col.title);
                }}
                onDragLeave={() => setDropOn((d) => (d === col.title ? undefined : d))}
                onDrop={(e) => drop(e, col.title)}
                className={cn(
                  'flex min-h-0 flex-col rounded-xl border bg-surface transition-colors',
                  dropOn === col.title ? 'border-emerald-500/60 bg-emerald-500/5' : 'border-line',
                )}
              >
                <header className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
                  <span className="size-2 rounded-full" style={{ background: color }} />
                  <h3 className="text-xs font-semibold text-white">{col.title}</h3>
                  <span className="ml-auto rounded border border-line bg-surface-2 px-1.5 font-mono text-[10px] text-slate-400 tabular-nums">
                    {items.length}
                  </span>
                </header>
                <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-2.5">
                  {items.map((t) => (
                    <TaskCard
                      key={t.id}
                      task={t}
                      now={now}
                      onOpen={() => {
                        onSelect(t.id);
                        setViewMode('list');
                      }}
                      onAction={onAction}
                    />
                  ))}
                  {items.length === 0 && (
                    <div className="grid flex-1 place-items-center rounded-lg border border-dashed border-line py-8 text-xs text-slate-500">
                      Nothing here
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Where a status sorts in the list: what needs the person, then what is moving, then what waits, then done */
const ORDER: Record<TaskStatus, number> = {
  failed: 0,
  escalated: 0,
  retrying: 1,
  running: 2,
  verifying: 2,
  ready: 3,
  planned: 4,
  done: 5,
};

/**
 * The one line that says what the graph decided about this task: why it waits (when it does), why this agent
 * has it, or that its code is load-bearing. It comes from the task's own traces, never made up.
 */
function whyLine(task: Task): { text: string; tone: 'wait' | 'graph' | 'risk' } | undefined {
  if (task.blockedBy?.length && task.why?.schedule)
    return { text: task.why.schedule, tone: 'wait' };
  // Who took the task over after an agent could not finish it
  const [prev, last] = (task.trail ?? []).slice(-2);
  if (prev && last && last.agent !== prev.agent && last.agent !== 'you') {
    const name = (a: string) => AGENT_META[a as AgentName]?.label ?? a;
    return {
      text: `${name(last.agent)} took over from ${name(prev.agent)} (${OUTCOME[prev.outcome].word})`,
      tone: 'graph',
    };
  }
  if (task.why?.route) return { text: task.why.route, tone: 'graph' };
  if (task.risk !== undefined && task.risk >= RISKY)
    return {
      text: `load-bearing code: top ${Math.max(1, Math.round((1 - task.risk) * 100))}% by PageRank and betweenness`,
      tone: 'risk',
    };
  return undefined;
}

function WhyLine({ task, wrap }: { task: Task; wrap?: boolean }) {
  const why = whyLine(task);
  if (!why) return null;
  const Icon = why.tone === 'wait' ? Hourglass : Network;
  return (
    <p
      title={why.text + (task.why?.graphOff ? ' (graph off)' : '')}
      className={cn(
        'mt-1 flex items-start gap-1.5 text-[11px] leading-snug',
        why.tone === 'wait'
          ? 'text-amber-300/90'
          : why.tone === 'risk'
            ? 'text-rose-300/90'
            : 'text-memory',
      )}
    >
      <Icon className="mt-px size-3 shrink-0" />
      <span className={wrap ? 'line-clamp-3' : 'line-clamp-2'}>{why.text}</span>
    </p>
  );
}

/** A function id as people read it: `login()` in `src/auth/login.ts` */
const fnName = (id: string) => `${id.split('::')[1] ?? id}()`;

function TaskRow({
  task,
  now,
  selected,
  onSelect,
}: {
  task: Task;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const mine = takenOver(task);
  const who = mine ? undefined : (task.assignedAgent ?? task.preferredAgent);
  const working = WORKING.includes(task.status);
  const since = [...(task.trail ?? [])].reverse().find((e) => e.outcome === 'running')?.at;
  const ref = useRef<HTMLLIElement>(null);
  // A task opened from elsewhere (a board card, the chat, the timeline) scrolls into view
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  return (
    <li ref={ref}>
      <button
        onClick={onSelect}
        aria-current={selected}
        className={cn(
          'flex w-full items-start gap-3 border-b border-l-2 border-b-line px-4 py-3 text-left transition-colors',
          selected
            ? 'border-l-emerald-400 bg-surface-2'
            : 'border-l-transparent hover:bg-surface/60',
        )}
      >
        <span className="mt-0.5 shrink-0">
          {who ? (
            <AgentAvatar agent={who} size={22} />
          ) : (
            <span
              title={mine ? 'You took this over' : 'No agent yet'}
              className="grid size-[22px] place-items-center rounded-md border border-line bg-surface-3 text-slate-400"
            >
              {mine ? (
                <Hand className="size-3" />
              ) : (
                <span className="size-1.5 rounded-full bg-slate-500" />
              )}
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-start justify-between gap-2">
            <span className="line-clamp-2 text-sm leading-snug font-medium text-slate-100">
              {task.title}
            </span>
            <span className="shrink-0">
              <StatusPill status={task.status} byYou={takenOver(task)} />
            </span>
          </span>
          {task.targets.length > 0 && (
            <span className="mt-0.5 block truncate font-mono text-[11px] text-sky-400/80">
              {task.targets.slice(0, 2).map(fnName).join(', ')}
              {task.targets.length > 2 ? ` +${task.targets.length - 2}` : ''}
            </span>
          )}
          <WhyLine task={task} />
          {working && (since || task.stalledAt) && (
            <span
              className={cn(
                'mt-1 block text-[11px]',
                task.stalledAt ? 'text-amber-300' : 'text-slate-400',
              )}
            >
              {task.stalledAt
                ? `silent for ${duration(now - task.stalledAt)}: it may be stuck`
                : `working for ${duration(now - since!)}`}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

const OUTCOME: Record<
  TrailEntry['outcome'],
  { icon: typeof Check; color: string; word: string; spin?: boolean }
> = {
  success: { icon: Check, color: TONE_COLOR.good, word: 'finished' },
  failure: { icon: X, color: TONE_COLOR.bad, word: 'failed' },
  error: { icon: X, color: TONE_COLOR.warn, word: "couldn't run" },
  stalled: { icon: Pause, color: TONE_COLOR.warn, word: 'stalled' },
  stopped: { icon: Square, color: TONE_COLOR.neutral, word: 'stopped' },
  running: { icon: LoaderCircle, color: TONE_COLOR.info, word: 'working', spin: true },
};

/** Who has worked on the task, in order, and how each attempt ended: nothing disappears when the task moves on. */
function Trail({ trail }: { trail: TrailEntry[] }) {
  const hidden = Math.max(0, trail.length - 4);
  return (
    <ol className="flex flex-wrap items-center gap-1" aria-label="Attempts so far">
      {hidden > 0 && <li className="font-mono text-[10px] text-slate-500">+{hidden} earlier</li>}
      {trail.slice(-4).map((e, i) => {
        const o = OUTCOME[e.outcome];
        const Icon = o.icon;
        return (
          <li
            key={`${e.at}-${i}`}
            title={`${AGENT_META[e.agent].label} ${o.word}${e.detail ? `: ${e.detail}` : ''}`}
            className="inline-flex items-center gap-1 rounded border border-line bg-surface-3 py-0.5 pr-1.5 pl-0.5"
          >
            <AgentAvatar agent={e.agent} size={16} />
            <Icon
              className={cn('size-3', o.spin && 'animate-spin')}
              style={{ color: o.color }}
              aria-label={o.word}
            />
          </li>
        );
      })}
    </ol>
  );
}

function TaskCard({
  task,
  now,
  onOpen,
  onAction,
}: {
  task: Task;
  now: number;
  onOpen: () => void;
  onAction: (action: BoardAction) => void;
}) {
  const live = STATUS_META[task.status].live;
  const working = WORKING.includes(task.status);
  const tests = task.testSummary;
  const pass = tests ? tests.passed / Math.max(tests.total, 1) : 0;
  const agentColor = task.assignedAgent ? AGENT_META[task.assignedAgent].color : undefined;
  const since = [...(task.trail ?? [])].reverse().find((e) => e.outcome === 'running')?.at;
  const mine = takenOver(task);
  const act = (action: BoardAction) => onAction(action);

  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', task.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen())}
      style={live && agentColor ? ({ '--live-color': agentColor } as CSSProperties) : undefined}
      className={cn(
        'group cursor-pointer rounded-xl border border-line bg-surface-2 p-3 text-left transition-all outline-none',
        'hover:-translate-y-px hover:border-line-strong hover:bg-surface-3 hover:shadow-lg focus-visible:border-emerald-500/60',
        live && 'live-border',
        task.stalledAt && working && 'border-amber-500/50',
      )}
    >
      <div className="mb-2">
        <AgentChip
          agent={mine ? 'you' : (task.assignedAgent ?? task.preferredAgent)}
          sub={
            mine
              ? 'taken over'
              : task.assignedAgent
                ? task.role
                : task.preferredAgent
                  ? 'your choice'
                  : undefined
          }
        />
      </div>
      <div className="text-xs leading-snug font-medium text-slate-100">{task.title}</div>
      <WhyLine task={task} wrap />
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <StatusPill status={task.status} byYou={takenOver(task)} />
        {working && since && (
          <span className="font-mono text-[10px] text-slate-400">
            working for {duration(now - since)}
          </span>
        )}
        {task.stalledAt && working && (
          <span
            className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-amber-300"
            title="The agent has printed nothing for a while. It may be stuck: stop it or switch agent."
          >
            <TriangleAlert className="size-3" />
            stalled for {duration(now - task.stalledAt)}
          </span>
        )}
        {task.risk !== undefined && task.risk >= RISKY && (
          <span
            title="One of the functions this task changes is among the most depended-on in this code (PageRank and betweenness over the call graph). It goes to an agent that declares reasoning, with more room for what the team learned."
            className="inline-flex items-center gap-1 rounded bg-rose-500/12 px-1.5 py-0.5 font-mono text-[10px] font-medium text-rose-300"
          >
            <Network className="size-3" /> load-bearing · top{' '}
            {Math.max(1, Math.round((1 - task.risk) * 100))}%
          </span>
        )}
        {task.doneByHand && (
          <span className="inline-flex items-center gap-1 rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-slate-300">
            <CheckCheck className="size-3" /> done by you
          </span>
        )}
        {mine && task.status !== 'done' && (
          <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300">
            <Hand className="size-3" /> you are working on it
          </span>
        )}
        {task.note && (
          <span
            title={`Your note: ${task.note}`}
            className="inline-flex items-center gap-1 rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-slate-300"
          >
            <StickyNote className="size-3" /> note
          </span>
        )}
      </div>

      {task.trail && task.trail.length > 0 && (
        <div className="mt-2.5">
          <Trail trail={task.trail} />
        </div>
      )}

      {tests && (
        <div className="mt-3">
          <div className="flex items-center justify-between font-mono text-[10px]">
            <span className="inline-flex items-center gap-1 text-slate-400">
              <FlaskConical className="size-3" /> Tests
            </span>
            <span className={cn('tabular-nums', pass === 1 ? 'text-emerald-400' : 'text-rose-400')}>
              {tests.passed}/{tests.total}
            </span>
          </div>
          <div className="mt-1 flex h-1 gap-px overflow-hidden bg-surface-3">
            <div className="bg-emerald-400" style={{ width: `${pass * 100}%` }} />
            {pass < 1 && <div className="flex-1 bg-rose-500/70" />}
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-slate-400">
        <span className="border border-line bg-surface px-1.5 py-0.5 text-slate-300">
          {task.type}
        </span>
        {task.worktree && (
          <span className="inline-flex items-center gap-1">
            <GitBranch className="size-3" />
            {task.id}
          </span>
        )}
        {task.tokens && (
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Coins className="size-3" />
            {formatTokens(task.tokens.in + task.tokens.out)}
          </span>
        )}
        {task.dependsOn.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <Link2 className="size-3" />
            {task.dependsOn.length}
          </span>
        )}
      </div>

      {task.blockedBy && task.blockedBy.length > 0 && (
        <div className="mt-2.5">
          <WaitingChip on={task.blockedBy} />
        </div>
      )}

      {task.status !== 'done' && (
        <div
          className={cn(
            'mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-2.5 transition-opacity',
            task.stalledAt && working
              ? 'opacity-100'
              : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100',
          )}
          onClick={(e) => e.stopPropagation()}
        >
          {working && (
            <CardButton
              icon={Square}
              label="Stop"
              onClick={() => act({ kind: 'stop', id: task.id })}
            />
          )}
          {task.status === 'failed' && (
            <CardButton
              icon={RotateCcw}
              label="Retry"
              onClick={() => act({ kind: 'retry', id: task.id })}
            />
          )}
          <Menu
            compact
            label="Switch agent"
            title="Give this task to another agent"
            items={AGENTS.map((a) => ({
              label: AGENT_META[a].label,
              hint: a === (task.assignedAgent ?? task.preferredAgent) ? 'current' : undefined,
              onSelect: () => act({ kind: 'switch', id: task.id, agent: a }),
            }))}
          />
          <CardButton
            icon={Terminal}
            label="Take over"
            title="Stop the agent and open a real terminal in this task's folder"
            onClick={() => act({ kind: 'takeover', id: task.id })}
          />
          <CardButton
            icon={Check}
            label="Done"
            title="You did this yourself: mark it done"
            onClick={() => act({ kind: 'done', id: task.id })}
          />
        </div>
      )}
    </div>
  );
}

function CardButton({
  icon: Icon,
  label,
  title,
  onClick,
}: {
  icon: typeof Square;
  label: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded border border-line bg-surface px-2 py-1 font-mono text-[11px] text-slate-300 transition-colors hover:border-slate-600 hover:bg-surface-3 hover:text-white"
    >
      <Icon className="size-3" />
      {label}
    </button>
  );
}
