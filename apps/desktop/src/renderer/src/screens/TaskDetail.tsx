import { X } from 'lucide-react';
import type { ContextPack, SessionInfo, Task, WhyPath } from '@puff/shared';
import { AgentChip, SectionTitle, StatusPill } from '@/components/ui';
import { puff } from '@/lib/api';
import { useLoad } from '@/lib/hooks';
import { NODE_COLORS, formatTokens } from '@/lib/theme';

interface Detail {
  task: Task;
  sessions: SessionInfo[];
  pack?: ContextPack;
  why: WhyPath;
}

async function loadDetail(taskId: string): Promise<Detail> {
  const [{ task, sessions }, why] = await Promise.all([puff.getTask(taskId), puff.getWhy(taskId)]);
  const latest = sessions.at(-1);
  const pack = latest ? await puff.getContextPack(latest.id) : undefined;
  return { task, sessions, pack, why };
}

export function TaskDetail({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const detail = useLoad(() => loadDetail(taskId), [taskId]);

  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-black/40" onClick={onClose}>
      <aside
        className="flex h-full w-[560px] flex-col overflow-y-auto border-l border-line bg-panel p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <div className="font-mono text-[11px] text-muted">{taskId}</div>
            <h2 className="text-lg font-semibold">{detail?.task.title ?? '…'}</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-muted hover:bg-panel-2"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        {detail && (
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center gap-3">
              <StatusPill status={detail.task.status} />
              <AgentChip agent={detail.task.assignedAgent} />
              <span className="text-xs text-muted">
                {detail.task.type} · {detail.task.complexity}
              </span>
            </div>

            <section>
              <SectionTitle>Target code</SectionTitle>
              <ul className="flex flex-col gap-1 font-mono text-xs">
                {detail.task.targets.map((t) => (
                  <li key={t} className="rounded-md bg-panel-2 px-2 py-1">
                    {t}
                  </li>
                ))}
              </ul>
            </section>

            {detail.pack && (
              <section>
                <SectionTitle
                  right={
                    <span className="text-xs text-muted">~{detail.pack.tokenEstimate} tokens</span>
                  }
                >
                  Context received
                </SectionTitle>
                <ul className="flex flex-col gap-2">
                  {detail.pack.items.map((item) => (
                    <li key={item.id} className="rounded-lg border border-line p-2">
                      <div className="flex items-center gap-2 text-[11px] text-muted">
                        <span
                          className="size-2 rounded-full"
                          style={{ background: NODE_COLORS[item.kind] }}
                        />
                        {item.kind}
                        {item.stale && <span className="text-warn">· possibly outdated</span>}
                      </div>
                      <div className="text-sm">{item.text}</div>
                      <div className="mt-1 text-xs text-puff">why: {item.reason}</div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section>
              <SectionTitle>Why?</SectionTitle>
              <p className="mb-3 text-sm text-muted">{detail.why.summary}</p>
              <ul className="flex flex-col gap-1 font-mono text-xs">
                {detail.why.edges.map((e) => (
                  <li key={`${e.source}-${e.type}-${e.target}`}>
                    <span className="text-text">{e.source}</span>
                    <span className="text-puff"> -[{e.type}]→ </span>
                    <span className="text-text">{e.target}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <SectionTitle>Sessions</SectionTitle>
              {detail.sessions.length === 0 && (
                <p className="text-sm text-muted">No sessions yet.</p>
              )}
              <ul className="flex flex-col gap-2">
                {detail.sessions.map((s) => (
                  <li key={s.id} className="rounded-lg border border-line p-3 text-sm">
                    <div className="flex items-center justify-between">
                      <AgentChip agent={s.agent} />
                      <span className="text-xs text-muted">
                        {s.outcome}
                        {s.tokensIn !== undefined &&
                          ` · ${formatTokens((s.tokensIn ?? 0) + (s.tokensOut ?? 0))} tok`}
                      </span>
                    </div>
                    {s.output && <p className="mt-2 text-muted">{s.output}</p>}
                    {s.changedFiles.length > 0 && (
                      <div className="mt-2 font-mono text-[11px] text-muted">
                        {s.changedFiles.join('  ')}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}
