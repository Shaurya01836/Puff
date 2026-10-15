import type { ReactNode } from 'react';
import {
  ArrowRightLeft,
  CircleCheck,
  CircleDot,
  History,
  Hourglass,
  Loader,
  Package,
  RefreshCw,
  Scale,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import type { AgentName, MemoryEventType, TaskStatus } from '@puff/shared';
import { cn } from '@/lib/cn';
import { AGENT_META, MEMORY_EVENT_META, STATUS_META, TONE_COLOR } from '@/lib/theme';

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('panel', className)}>{children}</div>;
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-[11px] font-semibold tracking-[0.12em] text-ink-3 uppercase">
        {children}
      </h2>
      {right}
    </div>
  );
}

/** Rounded-square avatar in the agent's colour; the initials keep identity readable without colour. */
export function AgentAvatar({ agent, size = 28 }: { agent: AgentName; size?: number }) {
  const meta = AGENT_META[agent];
  return (
    <span
      className="inline-grid shrink-0 place-items-center rounded-lg font-display font-bold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        color: meta.color,
        background: `color-mix(in oklab, ${meta.color} 16%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${meta.color} 35%, transparent)`,
      }}
      aria-hidden
    >
      {meta.short}
    </span>
  );
}

export function AgentChip({ agent, sub }: { agent?: AgentName; sub?: string }) {
  if (!agent)
    return (
      <span className="inline-flex items-center gap-2 text-xs text-ink-3">
        <span className="inline-grid size-7 place-items-center rounded-lg border border-dashed border-line-strong">
          ?
        </span>
        Auto-routing
      </span>
    );
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <AgentAvatar agent={agent} />
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-xs font-medium text-ink">
          {AGENT_META[agent].label}
        </span>
        {sub && <span className="block truncate text-[11px] text-ink-3">{sub}</span>}
      </span>
    </span>
  );
}

const STATUS_ICON: Record<TaskStatus, typeof CircleDot> = {
  planned: CircleDot,
  ready: Zap,
  running: Loader,
  verifying: Loader,
  failed: TriangleAlert,
  retrying: RefreshCw,
  escalated: TriangleAlert,
  done: CircleCheck,
};

/** Status always shows icon + label, never colour alone. */
export function StatusPill({ status }: { status: TaskStatus }) {
  const meta = STATUS_META[status];
  const color = TONE_COLOR[meta.tone];
  const Icon = STATUS_ICON[status];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ color, background: `color-mix(in oklab, ${color} 13%, transparent)` }}
    >
      <Icon className={cn('size-3', meta.live && 'animate-spin-slow')} />
      {meta.label}
    </span>
  );
}

const EVENT_ICON: Record<MemoryEventType, typeof CircleDot> = {
  failure_recorded: TriangleAlert,
  solution_recorded: CircleCheck,
  decision_recorded: Scale,
  decision_superseded: RefreshCw,
  memory_stale: History,
  handoff: ArrowRightLeft,
  context_compiled: Package,
};

export function EventIcon({ type }: { type: MemoryEventType }) {
  const { color } = MEMORY_EVENT_META[type];
  const Icon = EVENT_ICON[type];
  return (
    <span
      className="grid size-7 shrink-0 place-items-center rounded-lg"
      style={{ color, background: `color-mix(in oklab, ${color} 13%, transparent)` }}
    >
      <Icon className="size-3.5" />
    </span>
  );
}

export function WaitingChip({ on }: { on: string[] }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-warn/10 px-2 py-1 text-[11px] text-warn">
      <Hourglass className="size-3" />
      Waiting on {on.join(', ')} · overlapping code
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-line-strong bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-ink-3">
      {children}
    </kbd>
  );
}

export function MockBadge() {
  return (
    <span
      className="rounded-full border border-warn/25 bg-warn/10 px-2.5 py-1 text-[11px] font-medium text-warn"
      title="Data comes from packages/shared/src/mocks until the backend lands"
    >
      Mock data
    </span>
  );
}
