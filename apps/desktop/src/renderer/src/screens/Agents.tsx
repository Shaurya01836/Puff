import { ArrowDown, ArrowUp } from 'lucide-react';
import type { AgentProfile, Savings } from '@puff/shared';
import { AgentAvatar, Panel, SectionTitle } from '@/components/ui';
import { cn } from '@/lib/cn';
import { AGENT_META, formatTokens } from '@/lib/theme';

export function Agents({
  agents,
  savings,
  mock,
}: {
  agents?: AgentProfile[];
  savings?: Savings;
  mock: boolean;
}) {
  return (
    <div className="flex flex-col gap-8 overflow-y-auto p-6">
      <section>
        <SectionTitle>Agent pool · routed by strength and past results</SectionTitle>
        <div className="grid grid-cols-3 gap-4">
          {agents?.map((a) => (
            <AgentCard key={a.name} agent={a} />
          ))}
        </div>
      </section>

      {savings && (
        <section>
          <SectionTitle
            right={
              mock && (
                <span className="rounded-full border border-warn/25 bg-warn/10 px-2.5 py-1 text-[11px] font-medium text-warn">
                  Mock numbers, not benchmark results
                </span>
              )
            }
          >
            With Puff vs without · same {savings.tasks} tasks, same models
          </SectionTitle>
          <div className="grid grid-cols-3 gap-4">
            <Meter
              label="Tokens spent"
              withPuff={savings.withPuff.tokens}
              baseline={savings.baseline.tokens}
              format={formatTokens}
              lowerIsBetter
            />
            <Meter
              label="Files read"
              withPuff={savings.withPuff.filesRead}
              baseline={savings.baseline.filesRead}
              lowerIsBetter
            />
            <Meter
              label="First-try pass rate"
              withPuff={savings.withPuff.firstTryPassRate}
              baseline={savings.baseline.firstTryPassRate}
              format={(v) => `${Math.round(v * 100)}%`}
            />
          </div>
        </section>
      )}
    </div>
  );
}

function AgentCard({ agent: a }: { agent: AgentProfile }) {
  const meta = AGENT_META[a.name];
  return (
    <Panel className="relative overflow-hidden p-5">
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-28"
        style={{
          background: `radial-gradient(120% 100% at 0% 0%, ${meta.color}26, transparent 70%)`,
        }}
      />
      <div className="relative flex items-start gap-3">
        <AgentAvatar agent={a.name} size={44} />
        <div className="min-w-0 flex-1">
          <div className="font-display text-lg leading-tight font-semibold">{meta.label}</div>
          <div className="text-xs text-ink-3">{meta.tagline}</div>
        </div>
        <div className="text-right">
          <div className="flex justify-end gap-1">
            {Array.from({ length: a.instances }, (_, i) => (
              <span
                key={i}
                className={cn('h-4 w-2 rounded-sm', i >= a.busy && 'bg-surface-3')}
                style={i < a.busy ? { background: meta.color } : undefined}
              />
            ))}
          </div>
          <div className="mt-1 text-[11px] text-ink-3">
            {a.busy}/{a.instances} busy
          </div>
        </div>
      </div>

      <div className="relative mt-4 flex flex-wrap gap-1.5">
        {a.strengths.map((s) => (
          <span
            key={s}
            className="rounded-md border border-line bg-surface-2 px-2 py-0.5 text-[11px] text-ink-2"
          >
            {s}
          </span>
        ))}
      </div>

      <div className="relative mt-5 grid grid-cols-2 gap-4">
        <div>
          <div className="text-[11px] tracking-wider text-ink-3 uppercase">Success rate</div>
          <div className="mt-1 font-display text-2xl font-semibold tabular-nums">
            {Math.round(a.stats.successRate * 100)}%
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div
              className="h-full rounded-full"
              style={{ width: `${a.stats.successRate * 100}%`, background: meta.color }}
            />
          </div>
          <div className="mt-1 text-[11px] text-ink-3">
            {a.stats.wins} of {a.stats.runs} runs
          </div>
        </div>
        <div>
          <div className="text-[11px] tracking-wider text-ink-3 uppercase">Avg tokens / run</div>
          <div className="mt-1 font-display text-2xl font-semibold tabular-nums">
            {a.stats.avgTokens !== undefined ? formatTokens(a.stats.avgTokens) : '—'}
          </div>
        </div>
      </div>
    </Panel>
  );
}

/** Hero delta + two direct-labelled bars. Text stays in ink colours; the bars carry identity. */
function Meter({
  label,
  withPuff,
  baseline,
  format = String,
  lowerIsBetter = false,
}: {
  label: string;
  withPuff: number;
  baseline: number;
  format?: (v: number) => string;
  lowerIsBetter?: boolean;
}) {
  const max = Math.max(withPuff, baseline) || 1;
  const delta = baseline ? (withPuff - baseline) / baseline : 0;
  const better = lowerIsBetter ? delta < 0 : delta > 0;
  const Arrow = delta < 0 ? ArrowDown : ArrowUp;
  return (
    <Panel className="p-5">
      <div className="text-sm text-ink-2">{label}</div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="font-display text-4xl font-semibold tracking-tight tabular-nums">
          {format(withPuff)}
        </span>
        <span
          className={cn(
            'inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-semibold',
            better ? 'bg-good/12 text-good' : 'bg-bad/12 text-bad',
          )}
        >
          <Arrow className="size-3" />
          {Math.abs(Math.round(delta * 100))}%
        </span>
      </div>
      <div className="mt-4 flex flex-col gap-2.5">
        {(
          [
            ['With Puff', withPuff, 'var(--color-brand)'],
            ['Without Puff', baseline, 'var(--color-ink-3)'],
          ] as const
        ).map(([name, value, color]) => (
          <div key={name}>
            <div className="mb-1 flex justify-between text-[11px]">
              <span className="text-ink-2">{name}</span>
              <span className="text-ink-2 tabular-nums">{format(value)}</span>
            </div>
            <div className="h-2 rounded-full bg-surface-3">
              <div
                className="h-full rounded-full"
                style={{ width: `${(value / max) * 100}%`, background: color }}
              />
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
