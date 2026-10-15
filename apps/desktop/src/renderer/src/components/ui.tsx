import type { ReactNode } from 'react';
import type { AgentName, TaskStatus } from '@puff/shared';
import { cn } from '@/lib/cn';
import { AGENT_META, STATUS_META } from '@/lib/theme';

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-xl border border-line bg-panel', className)}>{children}</div>;
}

export function AgentChip({ agent }: { agent?: AgentName }) {
  if (!agent) return <span className="text-xs text-muted">unassigned</span>;
  const meta = AGENT_META[agent];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium">
      <span className="size-2 rounded-full" style={{ background: meta.color }} />
      <span className={meta.text}>{meta.label}</span>
    </span>
  );
}

export function StatusPill({ status }: { status: TaskStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-panel-2 px-2 py-0.5 text-xs text-muted">
      <span className={cn('size-1.5 rounded-full', meta.dot)} />
      {meta.label}
    </span>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-xs font-semibold tracking-wider text-muted uppercase">{children}</h2>
      {right}
    </div>
  );
}
