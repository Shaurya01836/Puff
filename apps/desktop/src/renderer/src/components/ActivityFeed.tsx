import { useEffect, useRef, useState } from 'react';
import {
  Flag,
  FileText,
  LoaderCircle,
  MessageSquare,
  Pencil,
  Search,
  Terminal,
  Wrench,
} from 'lucide-react';
import type { ActivityKind, ActivityStep } from '@puff/shared';
import { AgentChip } from '@/components/ui';
import type { ActivityGroup } from '@/lib/hooks';
import { cn } from '@/lib/cn';

const ICONS: Record<ActivityKind, typeof FileText> = {
  read: FileText,
  edit: Pencil,
  command: Terminal,
  search: Search,
  message: MessageSquare,
  tool: Wrench,
  phase: Flag,
};

/** Time since the first step of the session: 0:07, 1:32 */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function Step({ step, start }: { step: ActivityStep; start: number }) {
  const Icon = ICONS[step.kind];
  const failed = step.ok === false;
  return (
    <li
      className={cn(
        'flex items-start gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] leading-snug',
        step.kind === 'phase' && 'bg-brand/8',
        failed && 'bg-bad/8',
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 size-3.5 shrink-0',
          failed
            ? 'text-bad'
            : step.ok === true
              ? 'text-good'
              : step.kind === 'phase'
                ? 'text-brand-soft'
                : step.kind === 'edit'
                  ? 'text-warn'
                  : 'text-ink-3',
        )}
      />
      <span
        className={cn(
          'min-w-0 flex-1 break-words',
          step.kind === 'message' ? 'text-ink-2 italic' : 'text-ink',
          step.kind === 'command' && 'font-mono text-xs',
          failed && 'text-bad',
        )}
      >
        {step.text}
      </span>
      <span className="shrink-0 pt-0.5 font-mono text-[10px] text-ink-3 tabular-nums">
        {elapsed(step.at - start)}
      </span>
    </li>
  );
}

/**
 * What the agent did, step by step, one block per attempt. While an attempt is running the newest step
 * appears as it happens and the view follows it; afterwards the same steps stay as the record.
 */
export function ActivityFeed({ groups, active }: { groups: ActivityGroup[]; active: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  const total = groups.reduce((n, g) => n + g.steps.length, 0);
  useEffect(() => {
    if (active) end.current?.scrollIntoView({ block: 'nearest' });
  }, [total, active]);

  const [view, setView] = useState<'feed' | 'console'>('feed');

  if (groups.length === 0) {
    return (
      <p className="text-sm text-ink-3">
        {active
          ? 'Waiting for the agent’s first step…'
          : 'No steps were recorded. They are kept for runs made from this version of Puff on.'}
      </p>
    );
  }

  const toggle = (
    <div
      role="group"
      aria-label="How to show the steps"
      className="flex self-end rounded-lg border border-line bg-surface-2 p-0.5 text-[11px]"
    >
      {(
        [
          ['feed', 'Feed'],
          ['console', 'Console'],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          onClick={() => setView(id)}
          aria-pressed={view === id}
          className={cn(
            'rounded-md px-2.5 py-1 transition-colors',
            view === id ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:text-ink-2',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );

  if (view === 'console') {
    return (
      <div className="flex flex-col gap-3">
        {toggle}
        <ConsoleView groups={groups} />
        <div ref={end} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {toggle}
      {groups.map((g, i) => {
        const running = g.session?.outcome === 'running' || (!g.session && active);
        const start = g.steps[0]?.at ?? 0;
        return (
          <section key={g.id}>
            <div className="mb-2 flex items-center justify-between gap-3">
              {g.session ? (
                <AgentChip agent={g.session.agent} sub={`Attempt ${i + 1} · ${g.session.role}`} />
              ) : (
                <span className="text-xs text-ink-3">Attempt {i + 1}</span>
              )}
              {running ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-info">
                  <LoaderCircle className="size-3.5 animate-spin" />
                  Working
                </span>
              ) : g.session ? (
                <span
                  className={cn(
                    'text-xs font-medium capitalize',
                    g.session.outcome === 'success' ? 'text-good' : 'text-bad',
                  )}
                >
                  {g.session.outcome}
                </span>
              ) : null}
            </div>
            {g.steps.length === 0 ? (
              <p className="px-2.5 text-[12px] text-ink-3">
                No steps were recorded for this attempt.
              </p>
            ) : (
              <ol className="flex flex-col gap-0.5">
                {g.steps.map((s) => (
                  <Step key={s.id} step={s} start={start} />
                ))}
              </ol>
            )}
          </section>
        );
      })}
      <div ref={end} />
    </div>
  );
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });

/**
 * The same steps as a terminal log: one line each, in order, monospace, the way a CLI prints them.
 * (A task's agent runs without its own screen so Puff can read it; to see the agent's real screen, take the
 * task over from the Terminal tab.)
 */
function ConsoleView({ groups }: { groups: ActivityGroup[] }) {
  return (
    <pre
      aria-label="Console"
      className="max-h-[62vh] overflow-auto rounded-xl border border-line bg-[#0a0a0a] p-3.5 font-mono text-[12px] leading-relaxed text-[#d4d4d4]"
    >
      {groups.map((g, i) => (
        <div key={g.id} className="mb-3 last:mb-0">
          <div className="text-ink-3">
            {'── '}
            {g.session ? `${g.session.agent} · ${g.session.role}` : 'attempt'} · attempt {i + 1}
            {g.session && g.session.outcome !== 'running' ? ` · ${g.session.outcome}` : ''}
            {' ──'}
          </div>
          {g.steps.map((s) => (
            <div key={s.id} className="flex gap-2.5 whitespace-pre-wrap">
              <span className="shrink-0 text-ink-3">{clock(s.at)}</span>
              <span
                className={cn(
                  s.ok === false
                    ? 'text-[#f45d6d]'
                    : s.ok === true
                      ? 'text-[#4ade80]'
                      : s.kind === 'phase'
                        ? 'text-[#a99bff]'
                        : s.kind === 'edit'
                          ? 'text-[#f5b83d]'
                          : s.kind === 'message'
                            ? 'text-[#9ca3af] italic'
                            : '',
                )}
              >
                {s.kind === 'command'
                  ? '$ '
                  : s.kind === 'phase'
                    ? '▶ '
                    : s.ok === false
                      ? '✖ '
                      : '· '}
                {s.text}
              </span>
            </div>
          ))}
        </div>
      ))}
    </pre>
  );
}
