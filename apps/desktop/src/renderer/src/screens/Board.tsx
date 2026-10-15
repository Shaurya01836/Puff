import type { CSSProperties } from 'react';
import { Coins, FlaskConical, GitBranch, Link2 } from 'lucide-react';
import type { Task, TaskStatus } from '@puff/shared';
import { AgentChip, StatusPill, WaitingChip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { AGENT_META, STATUS_META, TONE_COLOR, formatTokens } from '@/lib/theme';

const COLUMNS: { title: string; statuses: TaskStatus[]; tone: keyof typeof TONE_COLOR }[] = [
  { title: 'Planned', statuses: ['planned', 'ready'], tone: 'neutral' },
  { title: 'Running', statuses: ['running'], tone: 'info' },
  { title: 'Verifying', statuses: ['verifying'], tone: 'brand' },
  { title: 'Needs attention', statuses: ['failed', 'retrying', 'escalated'], tone: 'bad' },
  { title: 'Done', statuses: ['done'], tone: 'good' },
];

export function Board({ tasks, onOpen }: { tasks: Task[]; onOpen: (taskId: string) => void }) {
  const waiting = tasks.filter((t) => t.blockedBy?.length).length;
  const live = tasks.filter((t) => STATUS_META[t.status].live).length;
  const tokens = tasks.reduce((sum, t) => sum + (t.tokens ? t.tokens.in + t.tokens.out : 0), 0);

  return (
    <div className="flex h-full min-w-[1080px] flex-col gap-4 p-4">
      <div className="flex items-center gap-2 text-xs text-ink-2">
        <Summary label="tasks" value={tasks.length} />
        <Summary label="agents working" value={live} color={TONE_COLOR.info} />
        <Summary label="waiting on overlap" value={waiting} color={TONE_COLOR.warn} />
        <Summary label="tokens spent" value={formatTokens(tokens)} />
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-5 gap-3">
        {COLUMNS.map((col) => {
          const items = tasks
            .filter((t) => col.statuses.includes(t.status))
            .sort((a, b) => b.updatedAt - a.updatedAt);
          const color = TONE_COLOR[col.tone];
          return (
            <section
              key={col.title}
              className="flex min-h-0 flex-col rounded-2xl border border-line bg-surface/50"
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
                  <TaskCard key={t.id} task={t} onOpen={() => onOpen(t.id)} />
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

function TaskCard({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const live = STATUS_META[task.status].live;
  const tests = task.testSummary;
  const pass = tests ? tests.passed / Math.max(tests.total, 1) : 0;
  const agentColor = task.assignedAgent ? AGENT_META[task.assignedAgent].color : undefined;

  return (
    <button
      onClick={onOpen}
      style={live && agentColor ? ({ '--live-color': agentColor } as CSSProperties) : undefined}
      className={cn(
        'group animate-fade-in rounded-xl border border-line bg-surface-2/80 p-3 text-left transition-all',
        'hover:-translate-y-px hover:border-line-strong hover:bg-surface-2 hover:shadow-[0_10px_30px_-12px_rgb(0_0_0/0.8)]',
        live && 'live-border',
      )}
    >
      <div className="mb-2.5">
        <AgentChip
          agent={task.assignedAgent ?? task.preferredAgent}
          sub={task.assignedAgent ? task.role : task.preferredAgent ? 'your choice' : undefined}
        />
      </div>
      <div className="text-[13px] leading-snug font-medium text-ink">{task.title}</div>
      <div className="mt-2">
        <StatusPill status={task.status} />
      </div>

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
    </button>
  );
}
