import type { ComponentType } from 'react';
import { ArrowRightLeft, ListPlus, RefreshCw, TrendingUp } from 'lucide-react';
import type { TeamEvent, TeamEventKind } from '@puff/shared';
import { AgentAvatar, Panel } from '@/components/ui';
import { cn } from '@/lib/cn';
import { AGENT_META, timeAgo } from '@/lib/theme';

const OUTCOME: Record<string, { label: string; color: string }> = {
  success: { label: 'passed', color: 'var(--color-good)' },
  failure: { label: 'failed', color: 'var(--color-bad)' },
  error: { label: "couldn't run", color: 'var(--color-warn)' },
  running: { label: 'working', color: 'var(--color-info)' },
};

const KIND_ICON: Record<
  Exclude<TeamEventKind, 'session'>,
  ComponentType<{ className?: string }>
> = {
  handoff: ArrowRightLeft,
  spawned: ListPlus,
  escalated: TrendingUp,
  retried: RefreshCw,
};

const name = (a?: string) =>
  a && a in AGENT_META ? AGENT_META[a as keyof typeof AGENT_META].label : a;

/** The story of the team: who worked on what, who handed what to whom, who asked for which task. */
export function Team({
  events,
  onOpenTask,
}: {
  events?: TeamEvent[];
  onOpenTask: (taskId: string) => void;
}) {
  if (!events) return null;
  if (events.length === 0) {
    return (
      <div className="grid h-full place-items-center p-10 text-center text-sm text-ink-3">
        <div>
          <div className="font-display text-lg text-ink-2">Nothing has happened yet</div>
          <p className="mt-2 max-w-sm">
            Add a goal or a task and press Run team. Every agent run, handoff, follow-up task and
            escalation shows up here, in order.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl p-6">
      <ol className="relative">
        <span className="absolute top-2 bottom-2 left-[19px] w-px bg-line" aria-hidden />
        {events.map((e) => (
          <li key={e.id} className="relative mb-3 flex animate-fade-in gap-4">
            <Marker event={e} />
            <Panel className="min-w-0 flex-1 p-4">
              <Body event={e} onOpenTask={onOpenTask} />
            </Panel>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Marker({ event: e }: { event: TeamEvent }) {
  if (e.kind === 'session' && e.agent) {
    return (
      <span className="z-10 grid size-10 shrink-0 place-items-center rounded-full bg-abyss">
        <AgentAvatar agent={e.agent} size={34} />
      </span>
    );
  }
  const Icon = KIND_ICON[e.kind as keyof typeof KIND_ICON] ?? ArrowRightLeft;
  const color =
    e.kind === 'escalated'
      ? 'var(--color-warn)'
      : e.kind === 'retried'
        ? 'var(--color-info)'
        : 'var(--color-memory)';
  return (
    <span
      className="z-10 grid size-10 shrink-0 place-items-center rounded-full border border-line bg-abyss"
      style={{ color }}
    >
      <Icon className="size-4" />
    </span>
  );
}

function TaskLink({
  id,
  title,
  onOpen,
}: {
  id: string;
  title: string;
  onOpen: (id: string) => void;
}) {
  return (
    <button
      onClick={() => onOpen(id)}
      className="max-w-full truncate rounded-md bg-surface-3 px-2 py-0.5 text-left text-xs text-ink-2 hover:text-ink"
      title={title}
    >
      {title}
    </button>
  );
}

function Body({ event: e, onOpenTask }: { event: TeamEvent; onOpenTask: (id: string) => void }) {
  const when = <span className="shrink-0 text-[11px] text-ink-3">{timeAgo(e.at)}</span>;

  if (e.kind === 'session') {
    const outcome = e.outcome ? OUTCOME[e.outcome] : undefined;
    return (
      <>
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{name(e.agent)}</span>
          <span className="text-ink-3">as {e.role}</span>
          {outcome && (
            <span
              className="rounded-full px-2 py-0.5 text-[11px] font-medium"
              style={{
                color: outcome.color,
                background: `color-mix(in oklab, ${outcome.color} 14%, transparent)`,
              }}
            >
              {outcome.label}
            </span>
          )}
          <span className="ml-auto">{when}</span>
        </div>
        <div className="mt-2">
          <TaskLink id={e.taskId} title={e.taskTitle} onOpen={onOpenTask} />
        </div>
        {e.text && <p className="mt-2 text-sm leading-snug text-ink-2">{e.text}</p>}
      </>
    );
  }

  if (e.kind === 'handoff') {
    return (
      <>
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{name(e.agent)}</span>
          <span className="text-ink-3">handed off to</span>
          <span className="font-medium">
            {e.toAgent ? name(e.toAgent) : (e.toRole ?? 'whoever is next')}
          </span>
          <span className="ml-auto">{when}</span>
        </div>
        <blockquote className="mt-2 border-l-2 border-memory/50 pl-3 text-sm leading-snug text-ink-2">
          {e.text}
        </blockquote>
        <div className="mt-2">
          <TaskLink id={e.taskId} title={e.taskTitle} onOpen={onOpenTask} />
        </div>
      </>
    );
  }

  if (e.kind === 'spawned') {
    return (
      <>
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{name(e.agent)}</span>
          <span className="text-ink-3">
            {e.role === 'planner' ? 'planned a task' : 'asked for follow-up work'}
          </span>
          <span className="ml-auto">{when}</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-3">
          {e.toTaskId && (
            <TaskLink id={e.toTaskId} title={e.toTaskTitle ?? e.text} onOpen={onOpenTask} />
          )}
          <span>while working on</span>
          <TaskLink id={e.taskId} title={e.taskTitle} onOpen={onOpenTask} />
        </div>
      </>
    );
  }

  // escalated / retried
  return (
    <>
      <div className="flex items-center gap-2 text-sm">
        <span className={cn('font-medium', e.kind === 'escalated' ? 'text-warn' : 'text-info')}>
          {e.kind === 'escalated'
            ? `Escalated from ${name(e.agent)} to ${name(e.toAgent)}`
            : `${name(e.toAgent)} tries again`}
        </span>
        <span className="ml-auto">{when}</span>
      </div>
      <p className="mt-1.5 text-sm text-ink-2">{e.text}</p>
      <div className="mt-2">
        <TaskLink id={e.taskId} title={e.taskTitle} onOpen={onOpenTask} />
      </div>
    </>
  );
}
