import { useState, type ComponentType } from 'react';
import { Bot, Columns3, Database, Network, RefreshCw } from 'lucide-react';
import type { AgentProfile, BackendInfo } from '@puff/shared';
import { cn } from '@/lib/cn';
import { AGENT_META } from '@/lib/theme';
import { Mascot, MASCOT_LINES, type MascotState } from './Mascot';
import { AgentAvatar } from './ui';

export type Screen = 'graph' | 'board' | 'agents';

const NAV: {
  id: Screen;
  label: string;
  hint: string;
  icon: ComponentType<{ className?: string }>;
}[] = [
  { id: 'graph', label: 'Memory graph', hint: 'Code + what the team learned', icon: Network },
  { id: 'board', label: 'Board', hint: 'Tasks across agents', icon: Columns3 },
  { id: 'agents', label: 'Agents', hint: 'Pool, routing, savings', icon: Bot },
];

export function Sidebar({
  screen,
  onScreen,
  mascot,
  agents,
  info,
  onReindex,
  counts,
}: {
  screen: Screen;
  onScreen: (s: Screen) => void;
  mascot: MascotState;
  agents?: AgentProfile[];
  info?: BackendInfo;
  onReindex: () => Promise<string>;
  counts: Partial<Record<Screen, number>>;
}) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-surface/70">
      <div className="flex items-center gap-2.5 px-5 pt-5 pb-4">
        <Mascot state={mascot} size={38} />
        <div>
          <div className="font-display text-xl leading-none font-bold tracking-tight">
            <span className="text-gradient">Puff</span>
          </div>
          <div className="mt-1 text-[11px] text-ink-3">One brain. Many agents.</div>
        </div>
      </div>

      <ProjectCard info={info} onReindex={onReindex} />

      <nav className="flex flex-col gap-0.5 px-3">
        {NAV.map(({ id, label, hint, icon: Icon }) => {
          const active = screen === id;
          return (
            <button
              key={id}
              onClick={() => onScreen(id)}
              className={cn(
                'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors',
                active ? 'bg-surface-3 text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
              )}
            >
              {active && (
                <span className="absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-brand shadow-[0_0_10px_var(--color-brand)]" />
              )}
              <Icon className={cn('size-4', active ? 'text-brand-soft' : 'text-ink-3')} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm">{label}</span>
                <span className="block truncate text-[11px] text-ink-3">{hint}</span>
              </span>
              {counts[id] !== undefined && (
                <span className="rounded-md bg-surface-2 px-1.5 text-[11px] text-ink-3 tabular-nums">
                  {counts[id]}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="mt-6 px-5">
        <div className="mb-2 text-[11px] font-semibold tracking-[0.12em] text-ink-3 uppercase">
          Agent pool
        </div>
        <ul className="flex flex-col gap-2.5">
          {agents?.map((a) => (
            <li key={a.name} className="flex items-center gap-2.5">
              <AgentAvatar agent={a.name} size={26} />
              <span className="flex-1 text-sm text-ink-2">{AGENT_META[a.name].label}</span>
              <span className="flex gap-1" title={`${a.busy} of ${a.instances} busy`}>
                {Array.from({ length: a.instances }, (_, i) => (
                  <span
                    key={i}
                    className={cn('size-2 rounded-sm', i < a.busy ? '' : 'bg-surface-3')}
                    style={i < a.busy ? { background: AGENT_META[a.name].color } : undefined}
                  />
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-auto p-3">
        <div className="flex items-start gap-2.5 rounded-xl border border-line bg-surface-2/60 p-3">
          <Mascot state={mascot} size={30} />
          <p className="text-[12px] leading-snug text-ink-2">{MASCOT_LINES[mascot]}</p>
        </div>
      </div>
    </aside>
  );
}

function ProjectCard({
  info,
  onReindex,
}: {
  info?: BackendInfo;
  onReindex: () => Promise<string>;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>();
  const live = info?.mode === 'live';

  const reindex = async () => {
    setBusy(true);
    try {
      setResult(await onReindex());
    } catch (err) {
      setResult(`Index failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-3 mb-4 rounded-xl border border-line bg-surface-2/70 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{info?.projectName ?? '…'}</span>
        {live ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-good">
            <span className="size-1.5 animate-breathe rounded-full bg-good" />
            live graph
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1.5 text-[11px] text-warn"
            title={info?.error ?? 'Running on mock data'}
          >
            <span className="size-1.5 rounded-full bg-warn" />
            mock
          </span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-ink-3">
        <Database className="size-3 shrink-0" />
        <span className="truncate">{info?.graphName ?? `puff_${info?.projectId ?? ''}`}</span>
        {live && (
          <button
            onClick={reindex}
            disabled={busy}
            className="ml-auto rounded p-0.5 text-ink-3 hover:bg-surface-3 hover:text-ink disabled:opacity-60"
            title="Re-index the repository"
          >
            <RefreshCw className={cn('size-3', busy && 'animate-spin')} />
          </button>
        )}
      </div>
      {result && <div className="mt-1.5 text-[11px] text-ink-2">{result}</div>}
      {!live && info?.error && (
        <div className="mt-1.5 line-clamp-3 text-[11px] text-warn/80">{info.error}</div>
      )}
    </div>
  );
}
