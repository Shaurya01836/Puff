import type { AgentProfile, Savings } from '@puff/shared';
import { Panel, SectionTitle } from '@/components/ui';
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
    <div className="flex flex-col gap-6 overflow-y-auto p-4">
      <section>
        <SectionTitle>Agent pool</SectionTitle>
        <div className="grid grid-cols-3 gap-4">
          {agents?.map((a) => {
            const meta = AGENT_META[a.name];
            return (
              <Panel key={a.name} className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="size-3 rounded-full" style={{ background: meta.color }} />
                    <span className="font-semibold">{meta.label}</span>
                  </div>
                  <span className="text-xs text-muted">
                    {a.busy}/{a.instances} busy
                  </span>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {a.strengths.map((s) => (
                    <span
                      key={s}
                      className="rounded-md bg-panel-2 px-2 py-0.5 text-[11px] text-muted"
                    >
                      {s}
                    </span>
                  ))}
                </div>
                <div className="mt-4 text-xs text-muted">
                  Success rate · {a.stats.wins}/{a.stats.runs} runs
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-panel-2">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${a.stats.successRate * 100}%`, background: meta.color }}
                  />
                </div>
                {a.stats.avgTokens !== undefined && (
                  <div className="mt-3 text-xs text-muted">
                    avg {formatTokens(a.stats.avgTokens)} tokens / run
                  </div>
                )}
              </Panel>
            );
          })}
        </div>
      </section>

      {savings && (
        <section>
          <SectionTitle
            right={
              mock && (
                <span className="rounded-md bg-warn/10 px-2 py-0.5 text-[11px] text-warn">
                  mock numbers, not benchmark results
                </span>
              )
            }
          >
            With vs without Puff · {savings.tasks} tasks
          </SectionTitle>
          <div className="grid grid-cols-3 gap-4">
            <Meter
              label="Tokens"
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
  return (
    <Panel className="p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium">{label}</span>
        <span className={better ? 'text-sm text-ok' : 'text-sm text-fail'}>
          {delta > 0 ? '+' : ''}
          {Math.round(delta * 100)}%
        </span>
      </div>
      {[
        ['With Puff', withPuff, 'bg-puff'],
        ['Baseline', baseline, 'bg-muted/50'],
      ].map(([name, value, color]) => (
        <div key={name as string} className="mt-3">
          <div className="flex justify-between text-xs text-muted">
            <span>{name}</span>
            <span>{format(value as number)}</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-panel-2">
            <div
              className={`h-full rounded-full ${color as string}`}
              style={{ width: `${((value as number) / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </Panel>
  );
}
