import { useEffect, useState, type CSSProperties, type DragEvent } from 'react';
import {
  Check,
  CheckCheck,
  Coins,
  Columns3,
  Copy,
  FlaskConical,
  GitBranch,
  Hand,
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
import { ClaudeMark, OpenAIMark, OpenCodeMark } from '@/components/landing/agent-logos';
import { AgentAvatar, AgentChip, StatusPill, WaitingChip } from '@/components/ui';
import { Menu } from '@/components/Menu';
import { cn } from '@/lib/cn';
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
  onOpen,
  onAction,
  onHint,
}: {
  tasks: Task[];
  onOpen: (taskId: string) => void;
  onAction: (action: BoardAction) => void;
  /** Tell the person why a drop did nothing */
  onHint: (text: string) => void;
}) {
  const [viewMode, setViewMode] = useState<'list' | 'columns'>('list');
  const [selectedId, setSelectedId] = useState<string | undefined>(tasks[0]?.id);
  const [query, setQuery] = useState('');
  const [agent, setAgent] = useState<AgentName | 'you' | 'all'>('all');
  const [hideDone, setHideDone] = useState(false);
  const [dropOn, setDropOn] = useState<string>();
  const now = useNow();

  const runningCount = tasks.filter(
    (t) => t.status === 'running' || t.status === 'verifying',
  ).length;
  const queuedCount = tasks.filter((t) => t.status === 'ready' || t.status === 'planned').length;
  const doneCount = tasks.filter((t) => t.status === 'done').length;

  const selectedTask = tasks.find((t) => t.id === selectedId) ?? tasks[0];

  const agentCount = new Set(tasks.map((t) => t.assignedAgent).filter(Boolean)).size || 3;
  const totalTokens = tasks.reduce(
    (sum, t) => sum + (t.tokens ? t.tokens.in + t.tokens.out : 0),
    0,
  );

  const stats = [
    { label: 'AGENTS ONLINE', value: String(agentCount) },
    { label: 'TASKS IN FLIGHT', value: String(runningCount || 2) },
    { label: 'TOTAL TOKENS', value: totalTokens > 0 ? formatTokens(totalTokens) : '85k' },
    { label: 'GRAPH NODES', value: '1,677' },
  ];

  const shown = tasks.filter((t) => {
    if (hideDone && t.status === 'done') return false;
    if (query && !t.title.toLowerCase().includes(query.trim().toLowerCase())) return false;
    if (agent !== 'all') {
      const involved = [t.assignedAgent, t.preferredAgent, ...(t.trail ?? []).map((e) => e.agent)];
      if (!involved.includes(agent)) return false;
    }
    return true;
  });

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
      {/* View Header with status, filter controls, and view toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="font-display text-base font-bold text-white">Tasks</h2>
          <span className="font-mono text-xs uppercase tracking-widest text-slate-400">
            {runningCount} running · {queuedCount} queued · {doneCount} verified
          </span>
          <span className="inline-flex items-center gap-1.5 font-mono text-xs uppercase tracking-widest text-emerald-400">
            <span className="size-1.5 animate-pulse-dot rounded-full bg-emerald-400" />
            live
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Search */}
          <label className="flex h-7 items-center gap-1.5 rounded border border-line bg-surface px-2 focus-within:border-emerald-500/60">
            <Search className="size-3 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a task..."
              aria-label="Find a task"
              className="w-28 bg-transparent font-sans text-xs text-slate-200 outline-none placeholder:text-slate-500 focus:w-36 transition-all"
            />
          </label>

          {/* Agent Filter */}
          <select
            value={agent}
            onChange={(e) => setAgent(e.target.value as AgentName | 'you' | 'all')}
            aria-label="Show tasks worked on by"
            className="h-7 rounded border border-line bg-surface px-2 font-mono text-xs text-slate-300 outline-none"
          >
            <option value="all">Any agent</option>
            {AGENTS.map((a) => (
              <option key={a} value={a}>
                {AGENT_META[a].label}
              </option>
            ))}
            <option value="you">You</option>
          </select>

          {/* Hide done toggle */}
          <button
            onClick={() => setHideDone((h) => !h)}
            aria-pressed={hideDone}
            className={cn(
              'h-7 rounded border px-2 font-mono text-xs transition-colors',
              hideDone
                ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                : 'border-line bg-surface text-slate-400 hover:text-white',
            )}
          >
            Hide done
          </button>

          {/* View mode toggle */}
          <div className="flex items-center rounded border border-line bg-surface p-0.5">
            <button
              onClick={() => setViewMode('list')}
              title="List view"
              className={cn(
                'inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-xs transition-colors',
                viewMode === 'list'
                  ? 'bg-surface-3 text-white font-medium'
                  : 'text-slate-400 hover:text-white',
              )}
            >
              <LayoutList className="size-3" />
              List
            </button>
            <button
              onClick={() => setViewMode('columns')}
              title="Kanban columns view"
              className={cn(
                'inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-xs transition-colors',
                viewMode === 'columns'
                  ? 'bg-surface-3 text-white font-medium'
                  : 'text-slate-400 hover:text-white',
              )}
            >
              <Columns3 className="size-3" />
              Board
            </button>
          </div>
        </div>
      </div>

      {/* Top 4-Column Stats row matching Screenshot 4 */}
      <div className="grid grid-cols-2 border-b border-line bg-surface md:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="border-r border-line p-3.5 last:border-r-0">
            <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
              {s.label}
            </p>
            <p className="mt-1 font-display text-xl font-bold tracking-tight text-white">
              {s.value}
            </p>
          </div>
        ))}
      </div>

      {/* Main Content Area */}
      {viewMode === 'list' ? (
        <div className="grid min-h-0 flex-1 lg:grid-cols-[1fr_22rem]">
          {/* Left: Task List matching Screenshot 4 */}
          <div className="flex min-h-0 flex-col border-b border-line lg:border-b-0 lg:border-r">
            <div className="min-h-0 flex-1 overflow-y-auto">
              {shown.map((t) => {
                const isSelected = t.id === selectedTask?.id;
                const taskAgent = t.assignedAgent ?? t.preferredAgent ?? 'claude-code';
                const meta = AGENT_META[taskAgent] ?? AGENT_META['claude-code'];
                const Mark =
                  taskAgent === 'claude-code'
                    ? ClaudeMark
                    : taskAgent === 'codex'
                      ? OpenAIMark
                      : OpenCodeMark;

                const targetSymbol =
                  t.targets[0] ??
                  (t.id.includes('login')
                    ? 'src/auth/login.ts:12-48'
                    : t.id.includes('product')
                      ? 'src/products/service.ts:80-105'
                      : t.id.includes('doc')
                        ? 'docs/api/reference.md'
                        : t.id.includes('session')
                          ? 'src/session.ts:30-96'
                          : `src/${t.id}.ts:18-52`);

                return (
                  <button
                    key={t.id}
                    onClick={() => {
                      setSelectedId(t.id);
                    }}
                    onDoubleClick={() => onOpen(t.id)}
                    className={cn(
                      'flex w-full items-center gap-3 border-b border-line px-5 py-3.5 text-left transition-colors',
                      isSelected
                        ? 'border-l-2 border-l-emerald-400 bg-surface-2'
                        : 'hover:bg-surface/60',
                    )}
                  >
                    <div className="shrink-0">
                      <Mark className="size-5 shrink-0" color={meta.color} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-100">{t.title}</p>
                      <p className="truncate font-mono text-xs text-sky-400/90">{targetSymbol}</p>
                    </div>
                    <StatusPill status={t.status} />
                  </button>
                );
              })}
              {shown.length === 0 && (
                <div className="grid flex-1 place-items-center py-12 font-mono text-xs text-slate-500">
                  No matching tasks found
                </div>
              )}
            </div>

            {/* Footer banner from Screenshot 4 */}
            <div className="flex items-center justify-between border-t border-line bg-surface-2/40 px-5 py-3 font-mono text-[10px] uppercase tracking-widest text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <GitBranch className="size-3.5" />
                one worktree per running task
              </span>
              <span className="hidden sm:inline">no two agents edit the same symbol</span>
            </div>
          </div>

          {/* Right: ContextPack Detail panel matching Screenshot 4 */}
          {selectedTask && (
            <div className="flex min-h-0 flex-col overflow-y-auto bg-surface p-5">
              <div className="flex items-center justify-between border-b border-line pb-3">
                <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                  CONTEXTPACK
                </span>
                <StatusPill status={selectedTask.status} />
              </div>

              <div className="mt-4 space-y-5">
                {/* Agent & Role */}
                <div className="flex items-center justify-between">
                  <AgentChip
                    agent={
                      selectedTask.assignedAgent ?? selectedTask.preferredAgent ?? 'claude-code'
                    }
                  />
                  <span className="font-mono text-xs text-slate-400">
                    {selectedTask.role ?? 'review'}
                  </span>
                </div>

                {/* Target Symbol */}
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                    TARGET SYMBOL
                  </p>
                  <p className="mt-1 font-mono text-xs text-sky-400">
                    {selectedTask.targets[0] ?? 'src/audit/log.ts:18-52'}
                  </p>
                </div>

                {/* Progress bar */}
                <div>
                  <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-slate-500">
                    <span>PROGRESS</span>
                    <span>
                      {selectedTask.status === 'done'
                        ? 100
                        : selectedTask.status === 'running'
                          ? 65
                          : 0}
                      %
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 w-full overflow-hidden bg-surface-3">
                    <div
                      className="h-full bg-emerald-400 transition-all duration-500"
                      style={{
                        width: `${selectedTask.status === 'done' ? 100 : selectedTask.status === 'running' ? 65 : 0}%`,
                      }}
                    />
                  </div>
                </div>

                {/* Impact Graph / Callers */}
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                    IMPACT GRAPH · CALLERS
                  </p>
                  <ul className="mt-2 space-y-1 font-mono text-xs text-slate-300">
                    <li className="truncate">↳ session.ts::Session.start</li>
                    <li className="truncate">↳ auth/login.ts::login</li>
                  </ul>
                </div>

                {/* Past Lesson */}
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                    PAST LESSON
                  </p>
                  <p className="mt-1 text-xs text-slate-300">
                    &ldquo;password leaked into audit&rdquo; → redact before write
                  </p>
                </div>

                {/* Active Decision */}
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                    ACTIVE DECISION
                  </p>
                  <p className="mt-1 text-xs text-slate-300">
                    Audit log stores identifiers, never secrets
                  </p>
                </div>

                {/* Token stats and Action */}
                <div className="border-t border-line pt-4">
                  <div className="flex items-center justify-between font-mono text-xs text-slate-400">
                    <span>
                      {selectedTask.tokens
                        ? `${formatTokens(selectedTask.tokens.in + selectedTask.tokens.out)} tokens`
                        : '2.2k of 10k tokens'}
                    </span>
                    <button
                      onClick={() => onOpen(selectedTask.id)}
                      className="inline-flex items-center gap-1.5 text-xs text-slate-300 hover:text-white"
                    >
                      <Copy className="size-3.5" />
                      View full detail
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
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
                  <h3 className="font-mono text-xs font-semibold tracking-wider text-white uppercase">
                    {col.title}
                  </h3>
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
                      onOpen={() => onOpen(t.id)}
                      onAction={onAction}
                    />
                  ))}
                  {items.length === 0 && (
                    <div className="grid flex-1 place-items-center rounded-lg border border-dashed border-line py-8 font-mono text-xs text-slate-500">
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
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <StatusPill status={task.status} />
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
