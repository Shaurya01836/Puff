import { FlaskConical, GitBranch, Hourglass } from 'lucide-react';
import type { Task, TaskStatus } from '@puff/shared';
import { AgentChip, StatusPill } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatTokens } from '@/lib/theme';

const COLUMNS: { title: string; statuses: TaskStatus[] }[] = [
  { title: 'Planned', statuses: ['planned', 'ready'] },
  { title: 'Running', statuses: ['running'] },
  { title: 'Verifying', statuses: ['verifying'] },
  { title: 'Failed / Retrying', statuses: ['failed', 'retrying', 'escalated'] },
  { title: 'Done', statuses: ['done'] },
];

export function Board({ tasks, onOpen }: { tasks: Task[]; onOpen: (taskId: string) => void }) {
  return (
    <div className="grid h-full min-w-[1000px] grid-cols-5 gap-3 p-4">
      {COLUMNS.map((col) => {
        const items = tasks
          .filter((t) => col.statuses.includes(t.status))
          .sort((a, b) => b.updatedAt - a.updatedAt);
        return (
          <section key={col.title} className="flex min-h-0 flex-col rounded-xl bg-panel/60">
            <header className="flex items-center justify-between px-3 py-3">
              <h3 className="text-sm font-semibold">{col.title}</h3>
              <span className="rounded-full bg-panel-2 px-2 text-xs text-muted">
                {items.length}
              </span>
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
              {items.map((t) => (
                <TaskCard key={t.id} task={t} onOpen={() => onOpen(t.id)} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function TaskCard({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const failing = task.testSummary && task.testSummary.passed < task.testSummary.total;
  return (
    <button
      onClick={onOpen}
      className="rounded-lg border border-line bg-panel p-3 text-left transition-colors hover:border-puff/60"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <AgentChip agent={task.assignedAgent} />
        <StatusPill status={task.status} />
      </div>
      <div className="text-sm leading-snug font-medium">{task.title}</div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
        <span>
          {task.type}
          {task.role ? ` · ${task.role}` : ''}
        </span>
        {task.worktree && (
          <span className="inline-flex items-center gap-1">
            <GitBranch className="size-3" />
            {task.id}
          </span>
        )}
        {task.testSummary && (
          <span className={cn('inline-flex items-center gap-1', failing ? 'text-fail' : 'text-ok')}>
            <FlaskConical className="size-3" />
            {task.testSummary.passed}/{task.testSummary.total}
          </span>
        )}
        {task.tokens && <span>{formatTokens(task.tokens.in + task.tokens.out)} tok</span>}
      </div>
      {task.blockedBy?.length ? (
        <div className="mt-2 inline-flex items-center gap-1 rounded-md bg-warn/10 px-2 py-1 text-[11px] text-warn">
          <Hourglass className="size-3" />
          waiting on {task.blockedBy.join(', ')} (code overlap)
        </div>
      ) : null}
    </button>
  );
}
