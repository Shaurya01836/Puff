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
  Undo2,
  Zap,
} from 'lucide-react';
import type { Actor, MemoryEventType, TaskStatus } from '@puff/shared';
import { ClaudeMark, OpenAIMark, OpenCodeMark } from '@/components/landing/agent-logos';
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

/** Avatar using official direct agent SVG mark, no background box, crisp and normal. */
export function AgentAvatar({ agent, size = 22, className }: { agent: Actor; size?: number; className?: string }) {
  const meta = AGENT_META[agent];
  if (agent === 'you') {
    return (
      <span
        className={cn('inline-flex shrink-0 items-center justify-center font-mono font-bold text-slate-300', className)}
        style={{ width: size, height: size, fontSize: size * 0.45 }}
        aria-hidden
      >
        ME
      </span>
    );
  }
  const Mark =
    agent === 'claude-code'
      ? ClaudeMark
      : agent === 'codex'
        ? OpenAIMark
        : OpenCodeMark;

  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center', className)}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <Mark className="shrink-0" color={meta.color} style={{ width: size, height: size }} />
    </span>
  );
}

export function AgentChip({ agent, sub }: { agent?: Actor; sub?: string }) {
  if (!agent)
    return (
      <span className="inline-flex items-center gap-2 text-xs text-ink-3">
        <span className="font-mono text-xs text-slate-500">?</span>
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
        {sub && <span className="block truncate font-mono text-[10px] text-ink-3">{sub}</span>}
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

/** Status always shows icon + label, styled in landing page monospace badge style. */
export function StatusPill({ status }: { status: TaskStatus }) {
  const meta = STATUS_META[status];
  const color = TONE_COLOR[meta.tone];
  const Icon = STATUS_ICON[status];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 border border-line-strong bg-surface-2/60 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest"
      style={{ color }}
    >
      <span
        className={cn('size-1.5 rounded-full', meta.live && 'animate-live-ring')}
        style={{ background: color }}
      />
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
  memory_downgraded: Undo2,
  handoff: ArrowRightLeft,
  context_compiled: Package,
};

export function EventIcon({ type }: { type: MemoryEventType }) {
  const { color } = MEMORY_EVENT_META[type];
  const Icon = EVENT_ICON[type];
  return (
    <span
      className="flex size-5 shrink-0 items-center justify-center pt-0.5"
      style={{ color, filter: `drop-shadow(0 0 6px ${color}80)` }}
    >
      <Icon className="size-4" />
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

export function MockBadge({ label = 'Mock data' }: { label?: string }) {
  return (
    <span
      className="rounded-full border border-warn/25 bg-warn/10 px-2.5 py-1 text-[11px] font-medium text-warn"
      title="Data comes from packages/shared/src/mocks until the backend lands"
    >
      {label}
    </span>
  );
}

const NOTICE_TONE = {
  good: { color: 'var(--color-good)', Icon: CircleCheck },
  warn: { color: 'var(--color-warn)', Icon: TriangleAlert },
  bad: { color: 'var(--color-bad)', Icon: TriangleAlert },
} as const;

/** A short message about what just happened (a run finished, Run team could not start). */
export function Notice({
  tone,
  children,
  onClose,
}: {
  tone: keyof typeof NOTICE_TONE;
  children: ReactNode;
  onClose: () => void;
}) {
  const { color, Icon } = NOTICE_TONE[tone];
  return (
    <div
      role="status"
      className="fixed right-6 bottom-6 z-30 flex max-w-md animate-fade-in items-start gap-3 rounded-xl border border-line-strong bg-surface-2 px-4 py-3 text-sm shadow-[0_20px_40px_-12px_rgb(0_0_0/0.8)]"
    >
      <Icon className="mt-0.5 size-4 shrink-0" style={{ color }} />
      <div className="text-ink-2">{children}</div>
      <button onClick={onClose} className="ml-2 text-ink-3 hover:text-ink" aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
