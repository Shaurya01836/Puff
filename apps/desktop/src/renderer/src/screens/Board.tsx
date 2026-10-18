import { useEffect, useRef, useState, type DragEvent } from 'react';
import {
  Archive,
  ArchiveRestore,
  Check,
  Columns3,
  LayoutList,
  LoaderCircle,
  Pause,
  RotateCcw,
  Search,
  Square,
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

const COLUMNS: { title: string; statuses: TaskStatus[] }[] = [
  { title: 'Planned', statuses: ['planned', 'ready'] },
  { title: 'Running', statuses: ['running'] },
  { title: 'Verifying', statuses: ['verifying'] },
  { title: 'Needs attention', statuses: ['failed', 'retrying', 'escalated'] },
  { title: 'Done', statuses: ['done'] },
];

/** Something the person asks of a task from the board */
export type BoardAction =
  | { kind: 'stop' | 'retry' | 'done' | 'takeover' | 'archive' | 'restore'; id: string }
  | { kind: 'clearFinished' }
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
  const [showArchived, setShowArchived] = useState(false);
  const [dropOn, setDropOn] = useState<string>();
  const now = useNow();

  // Taking a task over always shows its terminal, which lives in the list view
  useEffect(() => {
    if (terminalFor) setViewMode('list');
  }, [terminalFor]);

  const activeTasks = tasks.filter((t) => !t.archived);
  const archivedTasks = tasks.filter((t) => t.archived);
  const archivedCount = archivedTasks.length;

  const count = (statuses: TaskStatus[]) =>
    activeTasks.filter((t) => statuses.includes(t.status)).length;
  const counts = [
    { label: 'running', n: count(['running', 'verifying']) },
    { label: 'queued', n: count(['planned', 'ready']) },
    {
      label: 'need attention',
      n: activeTasks.filter(
        (t) => ['failed', 'retrying', 'escalated'].includes(t.status) && !takenOver(t),
      ).length,
      bad: true,
    },
    {
      label: 'taken over by you',
      n: activeTasks.filter((t) => takenOver(t) && t.status !== 'done').length,
    },
    { label: 'done', n: count(['done']) },
  ];

  const clearable = activeTasks.filter(
    (t) =>
      !WORKING.includes(t.status) &&
      (t.status === 'done' ||
        t.status === 'failed' ||
        t.status === 'escalated' ||
        (t.trail ?? []).some((e) => e.outcome === 'stopped')),
  );
  const clearableCount = clearable.length;

  const handleClearFinished = () => {
    if (clearableCount === 0) return;
    const confirmed = window.confirm(
      `Archive ${clearableCount} finished, failed, or stopped task${clearableCount === 1 ? '' : 's'}? They will be hidden from the active board, and their sessions and lessons stay in graph memory.`,
    );
    if (!confirmed) return;
    onAction({ kind: 'clearFinished' });
  };

  const pool = showArchived ? archivedTasks : activeTasks;
  const shown = pool.filter((t) => {
    if (!showArchived && hideDone && t.status === 'done') return false;
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
  const selected = ordered.find((t) => t.id === selectedId) ?? ordered[0];

  /** Dropping a card on a column asks for what that column means (Puff moves the others itself). */
  const drop = (e: DragEvent, column: string) => {
    e.preventDefault();
    setDropOn(undefined);
    const id = e.dataTransfer.getData('text/plain');
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    if (task.archived) {
      onHint('This task is archived. Restore it first before moving it on the board.');
      return;
    }
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
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
          {counts.map((c) => (
            <span key={c.label}>
              <b
                className={cn(
                  'font-semibold tabular-nums',
                  c.bad && c.n > 0 ? 'text-bad' : 'text-ink',
                )}
              >
                {c.n}
              </b>{' '}
              {c.label}
            </span>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-7 items-center gap-1.5 rounded border border-line bg-surface px-2 focus-within:border-brand/50">
            <Search className="size-3 text-ink-2" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a task…"
              aria-label="Find a task"
              className="w-28 bg-transparent font-sans text-xs text-ink transition-all outline-none placeholder:text-ink-3 focus:w-36"
            />
          </label>
          <select
            value={agent}
            onChange={(e) => setAgent(e.target.value as AgentName | 'you' | 'all')}
            aria-label="Show tasks worked on by"
            className="h-7 rounded border border-line bg-surface px-2 text-xs text-ink outline-none"
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
                ? 'border-brand/40 bg-brand/10 text-brand'
                : 'border-line bg-surface text-ink-2 hover:text-ink',
            )}
          >
            Hide done
          </button>
          {!showArchived && (
            <button
              onClick={handleClearFinished}
              disabled={clearableCount === 0}
              title={
                clearableCount > 0
                  ? 'Archive every done, failed or stopped task. Kept in graph memory.'
                  : 'No finished, failed, or stopped tasks to clear'
              }
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded border px-2 text-xs transition-colors',
                clearableCount > 0
                  ? 'border-line bg-surface text-ink hover:border-line-strong hover:bg-surface-2'
                  : 'cursor-not-allowed border-line/40 bg-surface/30 text-ink-3',
              )}
            >
              <Archive className="size-3 text-ink-2" />
              <span>Clear finished</span>
              {clearableCount > 0 && (
                <span className="rounded bg-surface-3 px-1 py-0.2 font-mono text-[0.625rem] text-ink-2 tabular-nums">
                  {clearableCount}
                </span>
              )}
            </button>
          )}
          <button
            onClick={() => setShowArchived((s) => !s)}
            aria-pressed={showArchived}
            title={
              showArchived
                ? 'Return to the active board'
                : 'View archived tasks and restore them to the board'
            }
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded border px-2 text-xs transition-colors',
              showArchived
                ? 'border-brand/40 bg-brand/10 font-medium text-brand'
                : 'border-line bg-surface text-ink-2 hover:bg-surface-2 hover:text-ink',
            )}
          >
            <ArchiveRestore className="size-3" />
            <span>Archived ({archivedCount})</span>
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
                    ? 'bg-surface-3 font-medium text-ink'
                    : 'text-ink-2 hover:text-ink',
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
            <p className="font-display text-lg font-semibold text-ink">No tasks yet</p>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">
              Give the team a goal in the box above and a planner splits it into tasks, or press{' '}
              <b className="font-medium text-ink">New task</b> to add one yourself.
            </p>
          </div>
        </div>
      ) : viewMode === 'list' ? (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(17rem,24rem)_1fr]">
          <div className="flex min-h-0 flex-col border-r border-line">
            <div className="flex h-9 shrink-0 items-center justify-between border-b border-line bg-surface/30 px-3.5 py-1 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="font-medium text-ink">
                  {showArchived ? 'Archived tasks' : 'Tasks'}
                </span>
                <span className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[0.625rem] text-ink-2 tabular-nums">
                  {ordered.length}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                {!showArchived && clearableCount > 0 && (
                  <button
                    type="button"
                    onClick={handleClearFinished}
                    title="Archive all done, failed, and stopped tasks"
                    className="inline-flex items-center gap-1 rounded border border-line bg-surface px-2 py-0.5 font-mono text-[0.6875rem] text-ink transition-colors hover:border-line-strong hover:bg-surface-2"
                  >
                    <Archive className="size-3 text-ink-2" />
                    Clear finished
                  </button>
                )}
                {showArchived && (
                  <button
                    type="button"
                    onClick={() => setShowArchived(false)}
                    className="inline-flex items-center gap-1 rounded border border-line bg-surface px-2 py-0.5 font-mono text-[0.6875rem] text-ink transition-colors hover:border-line-strong hover:bg-surface-2"
                  >
                    Exit archive
                  </button>
                )}
              </div>
            </div>
            <ul
              className="min-h-0 flex-1 overflow-y-auto"
              aria-label={showArchived ? 'Archived tasks' : 'Tasks'}
            >
              {ordered.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  now={now}
                  selected={t.id === selected?.id}
                  onSelect={() => onSelect(t.id)}
                  onAction={onAction}
                />
              ))}
              {ordered.length === 0 && (
                <li className="py-12 text-center text-xs text-ink-3">
                  {showArchived ? (
                    <div className="px-4">
                      <p className="font-medium text-ink-2">No archived tasks</p>
                      <p className="mt-1 text-ink-3">
                        Finished, failed, or stopped tasks that you archive or clear will appear here.
                      </p>
                      <button
                        type="button"
                        onClick={() => setShowArchived(false)}
                        className="mt-3 inline-flex items-center gap-1 rounded border border-line bg-surface px-2.5 py-1 text-xs text-ink hover:bg-surface-2"
                      >
                        Return to active tasks
                      </button>
                    </div>
                  ) : archivedCount > 0 ? (
                    <div className="px-4">
                      <p className="font-medium text-ink-2">All tasks are archived</p>
                      <p className="mt-1 text-ink-3">
                        You cleared or archived all tasks.
                      </p>
                      <button
                        type="button"
                        onClick={() => setShowArchived(true)}
                        className="mt-3 inline-flex items-center gap-1.5 rounded border border-brand/40 bg-brand/10 px-2.5 py-1 text-xs text-brand hover:bg-brand/20"
                      >
                        <ArchiveRestore className="size-3" />
                        View archived ({archivedCount})
                      </button>
                    </div>
                  ) : (
                    'No matching tasks'
                  )}
                </li>
              )}
            </ul>
          </div>
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
              <div className="grid h-full place-items-center text-sm text-ink-3">
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
                  'flex min-h-0 flex-col rounded-md border bg-surface transition-colors',
                  dropOn === col.title ? 'border-brand/50 bg-brand/5' : 'border-line',
                )}
              >
                <header className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
                  <h3 className="text-xs font-semibold text-ink">{col.title}</h3>
                  <span className="ml-auto rounded border border-line bg-surface-2 px-1.5 font-mono text-[0.625rem] text-ink-2 tabular-nums">
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
                    <div className="grid flex-1 place-items-center rounded-sm border border-dashed border-line py-8 text-xs text-ink-3">
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
  return (
    <p
      title={why.text + (task.why?.graphOff ? ' (graph off)' : '')}
      className={cn(
        'mt-1 text-[0.6875rem] leading-snug',
        why.tone === 'wait' ? 'text-warn' : why.tone === 'risk' ? 'text-bad' : 'text-memory',
      )}
    >
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
  onAction,
}: {
  task: Task;
  now: number;
  selected: boolean;
  onSelect: () => void;
  onAction?: (action: BoardAction) => void;
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
          selected ? 'border-l-brand bg-surface-2' : 'border-l-transparent hover:bg-surface/60',
        )}
      >
        <span className="mt-0.5 shrink-0">
          {who ? (
            <AgentAvatar agent={mine ? 'you' : who} size={22} />
          ) : (
            <span
              title="No agent yet"
              className="grid size-[22px] place-items-center rounded-sm border border-line bg-surface-3 font-mono text-[0.6875rem] text-ink-3"
            >
              —
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-start justify-between gap-2">
            <span className="line-clamp-2 text-sm leading-snug font-medium text-ink">
              {task.title}
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              <StatusPill status={task.status} byYou={takenOver(task)} />
              {task.archived && (
                <span className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[0.625rem] text-ink-3">
                  archived
                </span>
              )}
              {task.archived && onAction && (
                <span
                  role="button"
                  tabIndex={0}
                  title="Restore this task to the active board"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAction({ kind: 'restore', id: task.id });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.stopPropagation();
                      e.preventDefault();
                      onAction({ kind: 'restore', id: task.id });
                    }
                  }}
                  className="inline-flex items-center gap-1 rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[0.625rem] text-ink transition-colors hover:border-brand/50 hover:bg-surface-3 hover:text-brand"
                >
                  <ArchiveRestore className="size-3" />
                  Restore
                </span>
              )}
            </span>
          </span>
          {task.targets.length > 0 && (
            <span className="mt-0.5 block truncate font-mono text-[0.6875rem] text-ink-3">
              {task.targets.slice(0, 2).map(fnName).join(', ')}
              {task.targets.length > 2 ? ` +${task.targets.length - 2}` : ''}
            </span>
          )}
          <WhyLine task={task} />
          {working && (since || task.stalledAt) && (
            <span
              className={cn('mt-1 block text-[0.6875rem]', task.stalledAt ? 'text-warn' : 'text-ink-2')}
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

const OUTCOME: Record<TrailEntry['outcome'], { color: string; word: string }> = {
  success: { color: TONE_COLOR.good, word: 'finished' },
  failure: { color: TONE_COLOR.bad, word: 'failed' },
  error: { color: TONE_COLOR.warn, word: "couldn't run" },
  stalled: { color: TONE_COLOR.warn, word: 'stalled' },
  stopped: { color: TONE_COLOR.neutral, word: 'stopped' },
  running: { color: TONE_COLOR.brand, word: 'working' },
};

/** Who has worked on the task, in order, and how each attempt ended: nothing disappears when the task moves on. */
function Trail({ trail }: { trail: TrailEntry[] }) {
  const hidden = Math.max(0, trail.length - 4);
  return (
    <ol className="flex flex-wrap items-center gap-1" aria-label="Attempts so far">
      {hidden > 0 && <li className="font-mono text-[0.625rem] text-ink-3">+{hidden} earlier</li>}
      {trail.slice(-4).map((e, i) => {
        const o = OUTCOME[e.outcome];
        return (
          <li
            key={`${e.at}-${i}`}
            title={`${AGENT_META[e.agent].label} ${o.word}${e.detail ? `: ${e.detail}` : ''}`}
            className="inline-flex items-center gap-1.5 rounded border border-line bg-surface-3 py-0.5 pr-2 pl-1"
          >
            <AgentAvatar agent={e.agent} size={16} />
            <span className="font-mono text-[0.625rem]" style={{ color: o.color }}>
              {o.word}
            </span>
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
      className={cn(
        'group cursor-pointer rounded-md border border-line bg-surface-2 p-3 text-left transition-colors outline-none',
        'hover:border-line-strong hover:bg-surface-3 focus-visible:border-brand/50',
        live && 'border-brand/40',
        task.stalledAt && working && 'border-warn/40',
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
      <div className="text-xs leading-snug font-medium text-ink">{task.title}</div>
      <WhyLine task={task} wrap />
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <StatusPill status={task.status} byYou={takenOver(task)} />
        {working && since && (
          <span className="font-mono text-[0.625rem] text-ink-2">
            working for {duration(now - since)}
          </span>
        )}
        {task.stalledAt && working && (
          <span
            className="rounded bg-warn/10 px-1.5 py-0.5 font-mono text-[0.625rem] font-medium text-warn"
            title="The agent has printed nothing for a while. It may be stuck: stop it or switch agent."
          >
            stalled for {duration(now - task.stalledAt)}
          </span>
        )}
        {task.risk !== undefined && task.risk >= RISKY && (
          <span
            title="One of the functions this task changes is among the most depended-on in this code (PageRank and betweenness over the call graph). It goes to an agent that declares reasoning, with more room for what the team learned."
            className="rounded bg-bad/10 px-1.5 py-0.5 font-mono text-[0.625rem] font-medium text-bad"
          >
            load-bearing · top {Math.max(1, Math.round((1 - task.risk) * 100))}%
          </span>
        )}
        {task.doneByHand && (
          <span className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[0.625rem] text-ink">
            done by you
          </span>
        )}
        {task.archived && (
          <span className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[0.625rem] text-ink-3">
            archived
          </span>
        )}
        {mine && task.status !== 'done' && (
          <span className="rounded bg-brand/10 px-1.5 py-0.5 font-mono text-[0.625rem] text-brand">
            you are working on it
          </span>
        )}
        {task.note && (
          <span
            title={`Your note: ${task.note}`}
            className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[0.625rem] text-ink"
          >
            note
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
          <div className="flex items-center justify-between font-mono text-[0.625rem]">
            <span className="text-ink-2">Tests</span>
            <span className={cn('tabular-nums', pass === 1 ? 'text-brand' : 'text-bad')}>
              {tests.passed}/{tests.total}
            </span>
          </div>
          <div className="mt-1 flex h-1 gap-px overflow-hidden bg-surface-3">
            <div className="bg-brand" style={{ width: `${pass * 100}%` }} />
            {pass < 1 && <div className="flex-1 bg-bad/70" />}
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[0.625rem] text-ink-2">
        <span className="border border-line bg-surface px-1.5 py-0.5 text-ink">{task.type}</span>
        {task.worktree && <span>{task.id}</span>}
        {task.tokens && (
          <span className="tabular-nums">
            {formatTokens(task.tokens.in + task.tokens.out)} tokens
          </span>
        )}
        {task.dependsOn.length > 0 && (
          <span>
            {task.dependsOn.length} {task.dependsOn.length === 1 ? 'dependency' : 'dependencies'}
          </span>
        )}
      </div>

      {task.blockedBy && task.blockedBy.length > 0 && (
        <div className="mt-2.5">
          <WaitingChip on={task.blockedBy} />
        </div>
      )}

      {(task.status !== 'done' || !working) && (
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
          {task.status !== 'done' && (
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
          )}
          {task.status !== 'done' && (
            <CardButton
              icon={Terminal}
              label="Take over"
              title="Stop the agent and open a real terminal in this task's folder"
              onClick={() => act({ kind: 'takeover', id: task.id })}
            />
          )}
          {task.status !== 'done' && (
            <CardButton
              icon={Check}
              label="Done"
              title="You did this yourself: mark it done"
              onClick={() => act({ kind: 'done', id: task.id })}
            />
          )}
          {!working && (
            <CardButton
              icon={task.archived ? ArchiveRestore : Archive}
              label={task.archived ? 'Restore' : 'Archive'}
              title={
                task.archived
                  ? 'Restore this task to the active board'
                  : 'Archive this task. Its sessions and lessons stay in graph memory.'
              }
              onClick={() => act({ kind: task.archived ? 'restore' : 'archive', id: task.id })}
            />
          )}
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
      className="inline-flex items-center gap-1 rounded border border-line bg-surface px-2 py-1 font-mono text-[0.6875rem] text-ink transition-colors hover:border-line-strong hover:bg-surface-3 hover:text-ink"
    >
      <Icon className="size-3" />
      {label}
    </button>
  );
}
