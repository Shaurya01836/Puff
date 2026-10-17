import { ArrowDown, ArrowUp } from 'lucide-react';
import type { AgentProfile, Savings, TeamEvent } from '@puff/shared';
import { ClaudeMark, OpenAIMark, OpenCodeMark } from '@/components/landing/agent-logos';
import { Panel, SectionTitle } from '@/components/ui';
import { Team } from '@/screens/Team';
import { cn } from '@/lib/cn';
import { AGENT_META, formatTokens } from '@/lib/theme';

export function Agents({
  agents,
  savings,
  mock,
  timeline,
  onOpenTask,
}: {
  agents?: AgentProfile[];
  savings?: Savings;
  mock: boolean;
  /** Who worked on what, handed what to whom and escalated what: the team's history */
  timeline?: TeamEvent[];
  onOpenTask: (taskId: string) => void;
}) {
  const busy = agents?.reduce((n, a) => n + a.busy, 0) ?? 0;

  return (
    <div className="flex flex-col gap-6 overflow-y-auto p-6">
      {/* View Title matching Screenshot 3 */}
      <div className="flex items-center gap-3 border-b border-line pb-4">
        <h2 className="font-display text-xl font-bold tracking-tight text-ink">Agents</h2>
        <span className="text-xs text-ink-2">
          {agents?.length ?? 0} in the pool · {busy} working now
        </span>
      </div>

      <section>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {agents?.map((a) => (
            <AgentCard key={a.name} agent={a} />
          ))}
        </div>
      </section>

      <section>
        <SectionTitle>Who did what</SectionTitle>
        <Team compact events={timeline} onOpenTask={onOpenTask} />
      </section>

      {savings && <SavingsSection savings={savings} mock={mock} />}
    </div>
  );
}

function AgentCard({ agent: a }: { agent: AgentProfile }) {
  const meta = AGENT_META[a.name];
  const Mark =
    a.name === 'claude-code' ? ClaudeMark : a.name === 'codex' ? OpenAIMark : OpenCodeMark;

  const runs = a.stats.runs;
  const successRate = runs ? `${Math.round(a.stats.successRate * 100)}%` : 'no runs yet';

  return (
    <div className="relative overflow-hidden border border-line bg-surface p-5 transition-colors hover:border-line-strong">
      {/* Top row with agent brand mark and title */}
      <div className="relative z-10 flex items-center gap-3.5">
        <div className="shrink-0">
          <Mark className="size-8 shrink-0" color={meta.color} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-base font-semibold leading-tight text-ink">
            {meta.label}
          </h3>
          <p className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-wide text-ink-2">
            {meta.roles}
          </p>
        </div>
      </div>

      {/* Metrics list matching Screenshot 3 */}
      <dl className="mt-5 space-y-2.5 font-mono text-xs">
        <div className="flex items-center justify-between border-b border-line/60 pb-2">
          <dt className="text-ink-3">status</dt>
          <dd
            className={cn(
              'inline-flex items-center gap-1.5 font-medium',
              a.busy > 0 ? 'text-brand' : 'text-ink-2',
            )}
          >
            {a.busy > 0 ? `${a.busy} running` : 'idle'}
          </dd>
        </div>
        <div className="flex items-center justify-between border-b border-line/60 pb-2">
          <dt className="text-ink-3">success rate</dt>
          <dd className="font-semibold tabular-nums text-ink">{successRate}</dd>
        </div>
        <div className="flex items-center justify-between border-b border-line/60 pb-2">
          <dt className="text-ink-3">runs finished</dt>
          <dd className="font-semibold tabular-nums text-ink">{runs}</dd>
        </div>
        <div className="flex items-center justify-between pt-0.5">
          <dt className="text-ink-3">instances</dt>
          <dd
            className={cn('text-[11px] tabular-nums', a.busy > 0 ? 'text-brand' : 'text-ink-2')}
            title={`${a.busy} of ${a.instances} busy`}
          >
            {a.busy}/{a.instances}
          </dd>
        </div>
      </dl>

      {/* What this agent has done in each module (Q28): the record that can outrank a declared strength */}
      {a.modules && a.modules.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 font-mono text-[10px] tracking-wider text-ink-3 uppercase">
            Knows
          </div>
          <ul className="flex flex-col gap-1">
            {a.modules.slice(0, 4).map((m) => (
              <li
                key={m.module}
                className="flex items-center gap-2 font-mono text-[11px]"
                title={`${m.wins} of ${m.runs} runs in the ${m.module} module succeeded`}
              >
                <span className="w-24 truncate text-ink">{m.module}</span>
                <span className="h-1 flex-1 overflow-hidden bg-surface-3">
                  <span
                    className="block h-full bg-brand"
                    style={{ width: `${Math.round((m.wins / Math.max(m.runs, 1)) * 100)}%` }}
                  />
                </span>
                <span className="tabular-nums text-ink-2">
                  {m.wins}/{m.runs}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Strengths tags */}
      {a.strengths && a.strengths.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5 pt-1">
          {a.strengths.map((s) => (
            <span
              key={s}
              className="border border-line bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-ink-2"
            >
              {s}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function SavingsSection({ savings, mock }: { savings: Savings; mock: boolean }) {
  const m = savings.measured;
  return (
    <section className="mt-4 border-t border-line pt-6">
      <SectionTitle
        right={
          mock ? (
            <span className="border border-warn/30 bg-warn/10 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-warn">
              Mock numbers, not benchmark results
            </span>
          ) : (
            <span className="border border-brand/25 bg-brand/10 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-brand">
              Measured
            </span>
          )
        }
      >
        With Puff vs without · same {savings.tasks} tasks, same model
      </SectionTitle>
      {m && (
        <p className="-mt-1 mb-3 font-mono text-xs text-ink-3">
          {AGENT_META[m.agent as keyof typeof AGENT_META]?.label ?? m.agent} ({m.model}) ·{' '}
          {m.runsPerArm} run{m.runsPerArm === 1 ? '' : 's'} per task and arm · one attempt each ·{' '}
          {new Date(m.generatedAt).toLocaleDateString()}
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Meter
          label="Tokens spent per run"
          withPuff={savings.withPuff.tokens}
          baseline={savings.baseline.tokens}
          format={formatTokens}
          lowerIsBetter
        />
        {m && !m.filesReadReported ? (
          <div className="border border-line bg-surface p-5">
            <div className="font-mono text-xs uppercase tracking-wider text-ink-2">Files read</div>
            <p className="mt-3 text-xs leading-relaxed text-ink-3">
              Not reported by this agent. Only OpenCode prints its tool calls, so Puff does not
              guess.
            </p>
          </div>
        ) : (
          <Meter
            label="Files read per run"
            withPuff={savings.withPuff.filesRead}
            baseline={savings.baseline.filesRead}
            format={(v) => v.toFixed(1)}
            lowerIsBetter
          />
        )}
        <Meter
          label="First-try pass rate"
          withPuff={savings.withPuff.firstTryPassRate}
          baseline={savings.baseline.firstTryPassRate}
          format={(v) => `${Math.round(v * 100)}%`}
        />
      </div>

      {m && (
        <>
          <div className="mt-4 overflow-hidden border border-line bg-surface">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line font-mono text-[10px] uppercase tracking-wide text-ink-3">
                <tr>
                  <th className="px-4 py-2.5 font-normal">Task</th>
                  <th className="px-4 py-2.5 font-normal">Without Puff</th>
                  <th className="px-4 py-2.5 font-normal">With Puff</th>
                </tr>
              </thead>
              <tbody>
                {m.perTask.map((t) => (
                  <tr key={t.id} className="border-b border-line/60 last:border-0">
                    <td className="px-4 py-2.5 font-mono text-xs text-ink">{t.id}</td>
                    <td className="px-4 py-2.5 tabular-nums">
                      <Result arm={t.plain} />
                    </td>
                    <td className="px-4 py-2.5 tabular-nums">
                      <Result arm={t.puff} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="mt-3 flex list-disc flex-col gap-1 pl-5 font-mono text-[11px] text-ink-3">
            {m.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Result({ arm }: { arm: { passed: number; runs: number; tokens: number } }) {
  return (
    <span className="font-mono text-xs">
      <span className={arm.passed === arm.runs ? 'text-brand' : 'text-bad'}>
        {arm.passed}/{arm.runs} passed
      </span>
      <span className="text-ink-3"> · {formatTokens(arm.tokens)} tokens</span>
    </span>
  );
}

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
    <div className="border border-line bg-surface p-5">
      <div className="font-mono text-xs uppercase tracking-wider text-ink-2">{label}</div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="font-display text-3xl font-bold tracking-tight tabular-nums text-ink">
          {format(withPuff)}
        </span>
        <span
          className={cn(
            'inline-flex items-center gap-0.5 border px-1.5 py-0.5 font-mono text-xs font-semibold',
            better ? 'border-brand/25 bg-brand/10 text-brand' : 'border-bad/25 bg-bad/10 text-bad',
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
            ['Without Puff', baseline, 'var(--color-line-strong)'],
          ] as const
        ).map(([name, value, color]) => (
          <div key={name}>
            <div className="mb-1 flex justify-between font-mono text-[11px]">
              <span className="text-ink-2">{name}</span>
              <span className="text-ink tabular-nums">{format(value)}</span>
            </div>
            <div className="h-1.5 bg-surface-3">
              <div
                className="h-full"
                style={{ width: `${(value / max) * 100}%`, background: color }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
