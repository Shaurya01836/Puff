import { useEffect, useState } from 'react';
import { ArrowRight, FileCode2, Sparkles, X } from 'lucide-react';
import type { AgentName, ContextPack, SessionInfo, Task, WhyPath } from '@puff/shared';
import { AgentChip, SectionTitle, StatusPill } from '@/components/ui';
import { puff } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useLoad } from '@/lib/hooks';
import { AGENT_META, NODE_COLORS, formatTokens } from '@/lib/theme';

interface Detail {
  task: Task;
  sessions: SessionInfo[];
  pack?: ContextPack;
  why: WhyPath;
}

async function loadDetail(taskId: string): Promise<Detail> {
  const [{ task, sessions }, why] = await Promise.all([puff.getTask(taskId), puff.getWhy(taskId)]);
  const latest = sessions.at(-1);
  // A session that has not been given context yet has no pack; that is fine, not an error.
  const pack = latest ? await puff.getContextPack(latest.id).catch(() => undefined) : undefined;
  return { task, sessions, pack, why };
}

type Tab = 'context' | 'why' | 'sessions';

export function TaskDetail({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const detail = useLoad(() => loadDetail(taskId), [taskId]);
  const [tab, setTab] = useState<Tab>('context');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-20 flex justify-end bg-abyss/60 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <aside
        className="flex h-full w-[620px] animate-slide-in flex-col border-l border-line-strong bg-surface shadow-[-30px_0_60px_-20px_rgb(0_0_0/0.7)]"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Task detail"
      >
        <header className="border-b border-line p-6 pb-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="font-mono text-[11px] text-ink-3">{taskId}</span>
                {detail && <StatusPill status={detail.task.status} />}
              </div>
              <h2 className="font-display text-xl leading-snug font-semibold">
                {detail?.task.title ?? 'Loading…'}
              </h2>
            </div>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink"
              aria-label="Close"
            >
              <X className="size-4" />
            </button>
          </div>

          {detail && (
            <div className="mt-4 flex flex-wrap items-center gap-4">
              <AgentChip agent={detail.task.assignedAgent} sub={detail.task.role} />
              <Meta label="Type" value={detail.task.type} />
              <Meta label="Complexity" value={detail.task.complexity} />
              {detail.task.tokens && (
                <Meta
                  label="Tokens"
                  value={formatTokens(detail.task.tokens.in + detail.task.tokens.out)}
                />
              )}
            </div>
          )}

          <div className="mt-5 flex gap-1">
            {(
              [
                ['context', 'Context received'],
                ['why', 'Why?'],
                ['sessions', `Sessions${detail ? ` · ${detail.sessions.length}` : ''}`],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={cn(
                  '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
                  tab === id
                    ? 'border-brand text-ink'
                    : 'border-transparent text-ink-3 hover:text-ink-2',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {detail && tab === 'context' && <ContextTab task={detail.task} pack={detail.pack} />}
          {detail && tab === 'why' && <WhyTab why={detail.why} />}
          {detail && tab === 'sessions' && <SessionsTab sessions={detail.sessions} />}
        </div>
      </aside>
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-xs">
      <span className="text-ink-3">{label} </span>
      <span className="font-medium text-ink-2">{value}</span>
    </span>
  );
}

function ContextTab({ task, pack }: { task: Task; pack?: ContextPack }) {
  return (
    <div className="flex flex-col gap-6">
      <section>
        <SectionTitle>Target code</SectionTitle>
        <ul className="flex flex-col gap-1.5">
          {task.targets.map((t) => {
            const [file, name] = t.split('::');
            return (
              <li
                key={t}
                className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs"
              >
                <FileCode2 className="size-3.5 text-brand-soft" />
                <span className="text-ink-3">{file}</span>
                <span className="text-ink-3">::</span>
                <span className="text-ink">{name}</span>
              </li>
            );
          })}
        </ul>
      </section>

      {pack ? (
        <section>
          <SectionTitle
            right={
              <span className="text-xs text-ink-3">
                ~{pack.tokenEstimate.toLocaleString()} tokens
              </span>
            }
          >
            What Puff gave the agent
          </SectionTitle>
          <ul className="flex flex-col gap-2">
            {pack.items.map((item) => {
              const color = NODE_COLORS[item.kind] ?? '#6b7894';
              return (
                <li
                  key={item.id}
                  className={cn(
                    'relative overflow-hidden rounded-xl border border-line bg-surface-2 py-3 pr-3 pl-4',
                    item.stale && 'opacity-60',
                  )}
                >
                  <span
                    className="absolute inset-y-0 left-0 w-[3px]"
                    style={{ background: color }}
                  />
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="font-semibold" style={{ color }}>
                      {item.kind}
                    </span>
                    {item.stale && (
                      <span className="rounded bg-warn/10 px-1.5 text-warn">possibly outdated</span>
                    )}
                  </div>
                  <div className="mt-0.5 text-sm text-ink">{item.text}</div>
                  <div className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-memory">
                    <Sparkles className="size-3" />
                    {item.reason}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : (
        <p className="text-sm text-ink-3">
          No context compiled yet. It is built when an agent picks this task up.
        </p>
      )}

      {pack && (
        <section>
          <SectionTitle>Prompt sent</SectionTitle>
          <pre className="overflow-x-auto rounded-xl border border-line bg-abyss p-4 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-ink-2">
            {pack.prompt}
          </pre>
        </section>
      )}
    </div>
  );
}

function WhyTab({ why }: { why: WhyPath }) {
  const byId = new Map(why.nodes.map((n) => [n.id, n]));
  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border border-brand/25 bg-brand/8 p-4 text-sm leading-relaxed text-ink-2">
        {why.summary}
      </div>
      <section>
        <SectionTitle>Graph path</SectionTitle>
        <ol className="flex flex-col gap-2">
          {why.edges.map((e) => {
            const from = byId.get(e.source);
            const to = byId.get(e.target);
            if (!from || !to) return null;
            return (
              <li
                key={`${e.source}-${e.type}-${e.target}`}
                className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-2/60 p-2"
              >
                <PathNode kind={from.kind} label={from.label} />
                <span className="inline-flex items-center gap-1 font-mono text-[11px] text-memory">
                  {e.type}
                  <ArrowRight className="size-3" />
                </span>
                <PathNode kind={to.kind} label={to.label} />
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

function PathNode({ kind, label }: { kind: string; label: string }) {
  const agent = kind === 'Agent' ? (label as AgentName) : undefined;
  const color =
    agent && AGENT_META[agent] ? AGENT_META[agent].color : (NODE_COLORS[kind] ?? '#6b7894');
  return (
    <span className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface px-2.5 py-1 text-sm">
      <span
        className="size-2.5 rounded-full"
        style={{ background: color, boxShadow: `0 0 8px ${color}` }}
      />
      <span className="text-[11px] text-ink-3">{kind}</span>
      <span className="text-ink">{label}</span>
    </span>
  );
}

function SessionsTab({ sessions }: { sessions: SessionInfo[] }) {
  if (sessions.length === 0) return <p className="text-sm text-ink-3">No sessions yet.</p>;
  return (
    <ol className="relative ml-3 border-l border-line">
      {sessions.map((s) => {
        const color =
          s.outcome === 'success'
            ? 'var(--color-good)'
            : s.outcome === 'running'
              ? 'var(--color-info)'
              : 'var(--color-bad)';
        return (
          <li key={s.id} className="relative mb-4 pl-6">
            <span
              className="absolute top-3 -left-[5px] size-2.5 rounded-full ring-4 ring-surface"
              style={{ background: color }}
            />
            <div className="rounded-xl border border-line bg-surface-2 p-3.5">
              <div className="flex items-center justify-between gap-3">
                <AgentChip agent={s.agent} sub={`${s.role} · ${s.id}`} />
                <span className="text-xs font-medium capitalize" style={{ color }}>
                  {s.outcome}
                </span>
              </div>
              {s.output && <p className="mt-2.5 text-sm text-ink-2">{s.output}</p>}
              <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-3">
                {s.tokensIn !== undefined && (
                  <span>{formatTokens(s.tokensIn + (s.tokensOut ?? 0))} tokens</span>
                )}
                {s.durationMs !== undefined && <span>{Math.round(s.durationMs / 60000)} min</span>}
                {s.changedFiles.map((f) => (
                  <span key={f} className="font-mono">
                    {f}
                  </span>
                ))}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
