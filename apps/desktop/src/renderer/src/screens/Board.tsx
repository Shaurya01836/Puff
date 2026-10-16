import { useEffect, useState, type CSSProperties, type DragEvent } from 'react';
import {
  Check,
  CheckCheck,
  Coins,
  FlaskConical,
  GitBranch,
  Hand,
  Link2,
  LoaderCircle,
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
import { AgentAvatar, AgentChip, StatusPill, WaitingChip } from '@/components/ui';
import { Menu } from '@/components/Menu';
import { cn } from '@/lib/cn';
import { AGENT_META, STATUS_META, TONE_COLOR, formatTokens } from '@/lib/theme';

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
  const [query, setQuery] = useState('');
  const [agent, setAgent] = useState<AgentName | 'you' | 'all'>('all');
  const [hideDone, setHideDone] = useState(false);
  const [dropOn, setDropOn] = useState<string>();
  const now = useNow();

  const waiting = tasks.filter((t) => t.blockedBy?.length).length;
  const live = tasks.filter((t) => STATUS_META[t.status].live).length;
  const stalled = tasks.filter((t) => t.stalledAt && WORKING.includes(t.status)).length;
  const tokens = tasks.reduce((sum, t) => sum + (t.tokens ? t.tokens.in + t.tokens.out : 0), 0);

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
    <div className="flex h-full min-w-[1080px] flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
        <Summary label="tasks" value={tasks.length} />
        <Summary label="agents working" value={live} color={TONE_COLOR.info} />
        {stalled > 0 && <Summary label="stalled" value={stalled} color={TONE_COLOR.warn} />}
        <Summary label="waiting on overlap" value={waiting} color={TONE_COLOR.warn} />
        <Summary label="tokens spent" value={formatTokens(tokens)} />

        <div className="ml-auto flex items-center gap-2">
          <label className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 focus-within:border-brand/60">
            <Search className="size-3.5 text-ink-3" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a task"
              aria-label="Find a task"
              className="w-36 bg-transparent text-xs text-ink outline-none placeholder:text-ink-3"
            />
          </label>
          <select
            value={agent}
            onChange={(e) => setAgent(e.target.value as AgentName | 'you' | 'all')}
            aria-label="Show tasks worked on by"
            className="h-8 rounded-lg border border-line bg-surface px-2 text-xs text-ink-2 outline-none"
          >
            <option value="all">Any agent</option>
            {AGENTS.map((a) => (
              <option key={a} value={a}>
                {AGENT_META[a].label}
              </option>
            ))}
            <option value="you">You</option>
          </select>
          <button
            onClick={() => setHideDone((h) => !h)}
            aria-pressed={hideDone}
            className={cn(
              'h-8 rounded-lg border px-2.5 text-xs transition-colors',
              hideDone
                ? 'border-brand/50 bg-brand/15 text-ink'
                : 'border-line bg-surface text-ink-2 hover:bg-surface-3',
            )}
          >
            Hide done
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-5 gap-3">
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
                'flex min-h-0 flex-col rounded-2xl border bg-surface/50 transition-colors',
                dropOn === col.title ? 'border-brand/60 bg-brand/5' : 'border-line',
              )}
            >
              <header className="flex items-center gap-2 px-3.5 pt-3.5 pb-3">
                <span className="size-2 rounded-full" style={{ background: color }} />
                <h3 className="text-sm font-semibold">{col.title}</h3>
                <span className="ml-auto rounded-md bg-surface-3 px-1.5 text-[11px] text-ink-3 tabular-nums">
                  {items.length}
                </span>
              </header>
              <div
                className="mx-3.5 mb-2 h-px"
                style={{ background: `linear-gradient(90deg, ${color}66, transparent)` }}
              />
              <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-2.5 pb-2.5">
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
                  <div className="grid flex-1 place-items-center rounded-xl border border-dashed border-line py-8 text-xs text-ink-3">
                    Nothing here
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Summary({
  label,
  value,
  color,
}: {
  label: string;
  value: number | string;
  color?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5">
      {color && <span className="size-1.5 rounded-full" style={{ background: color }} />}
      <b className="font-semibold text-ink tabular-nums">{value}</b>
      {label}
    </span>
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
      {hidden > 0 && <li className="text-[10px] text-ink-3">+{hidden} earlier</li>}
      {trail.slice(-4).map((e, i) => {
        const o = OUTCOME[e.outcome];
        const Icon = o.icon;
        return (
          <li
            key={`${e.at}-${i}`}
            title={`${AGENT_META[e.agent].label} ${o.word}${e.detail ? `: ${e.detail}` : ''}`}
            className="inline-flex items-center gap-1 rounded-md bg-surface-3 py-0.5 pr-1.5 pl-0.5"
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
        'group animate-fade-in cursor-pointer rounded-xl border border-line bg-surface-2/80 p-3 text-left transition-all outline-none',
        'hover:-translate-y-px hover:border-line-strong hover:bg-surface-2 hover:shadow-[0_10px_30px_-12px_rgb(0_0_0/0.8)] focus-visible:border-brand/60',
        live && 'live-border',
        task.stalledAt && working && 'border-warn/50',
      )}
    >
      <div className="mb-2.5">
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
      <div className="text-[13px] leading-snug font-medium text-ink">{task.title}</div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <StatusPill status={task.status} />
        {working && since && (
          <span className="text-[11px] text-ink-3">working for {duration(now - since)}</span>
        )}
        {task.stalledAt && working && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn"
            title="The agent has printed nothing for a while. It may be stuck: stop it or switch agent."
          >
            <TriangleAlert className="size-3" />
            stalled for {duration(now - task.stalledAt)}
          </span>
        )}
        {task.doneByHand && (
          <span className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-ink-2">
            <CheckCheck className="size-3" /> done by you
          </span>
        )}
        {mine && task.status !== 'done' && (
          <span className="inline-flex items-center gap-1 rounded-full bg-brand/15 px-2 py-0.5 text-[11px] text-brand-soft">
            <Hand className="size-3" /> you are working on it
          </span>
        )}
        {task.note && (
          <span
            title={`Your note: ${task.note}`}
            className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-2 py-0.5 text-[11px] text-ink-2"
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
          <div className="flex items-center justify-between text-[11px]">
            <span className="inline-flex items-center gap-1 text-ink-3">
              <FlaskConical className="size-3" /> Tests
            </span>
            <span className={cn('tabular-nums', pass === 1 ? 'text-good' : 'text-bad')}>
              {tests.passed}/{tests.total}
            </span>
          </div>
          <div className="mt-1 flex h-1 gap-px overflow-hidden rounded-full bg-surface-3">
            <div className="rounded-full bg-good" style={{ width: `${pass * 100}%` }} />
            {pass < 1 && <div className="flex-1 rounded-full bg-bad/70" />}
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-3">
        <span className="rounded bg-surface-3 px-1.5 py-0.5 font-medium text-ink-2">
          {task.type}
        </span>
        {task.worktree && (
          <span className="inline-flex items-center gap-1 font-mono">
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

      {task.blockedBy?.length ? (
        <div className="mt-2.5">
          <WaitingChip on={task.blockedBy} />
        </div>
      ) : null}

      {task.status !== 'done' && (
        <div
          className={cn(
            'mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-2.5 transition-opacity',
            // always there for a stalled agent; otherwise shown when the card is pointed at
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
      className="inline-flex items-center gap-1 rounded-lg border border-line-strong bg-surface-2 px-2 py-1 text-[11px] font-medium text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
    >
      <Icon className="size-3" />
      {label}
    </button>
  );
}
