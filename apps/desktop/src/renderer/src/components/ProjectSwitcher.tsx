import { useEffect, useRef, useState } from 'react';
import { Check, ChevronsUpDown, Database, Plus, RefreshCw, Settings2 } from 'lucide-react';
import type { BackendInfo, ProjectSummary } from '@puff/shared';
import { cn } from '@/lib/cn';

/** The project card at the top of the sidebar: what is open, a way to switch, and a way to add one. */
export function ProjectSwitcher({
  info,
  projects,
  onReindex,
  onSwitch,
  onAdd,
  onSettings,
}: {
  info?: BackendInfo;
  projects?: ProjectSummary[];
  onReindex: () => Promise<string>;
  onSwitch: (id: string) => void;
  onAdd: () => void;
  onSettings: (project: ProjectSummary) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string>();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const live = info?.mode === 'live';
  const noProject = info?.noProject === true;

  // Close the list when the person clicks anywhere else or presses Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

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
    <div ref={box} className="relative mx-3 mb-4">
      <div className="rounded-xl border border-line bg-surface-2/70 px-3 py-2.5">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          title="Switch or add a project"
          className="flex w-full items-center justify-between gap-2 text-left"
        >
          <span className="truncate text-sm font-medium">
            {noProject ? 'No project yet' : (info?.projectName ?? '…')}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {!live ? (
              <span
                className="inline-flex items-center gap-1.5 text-[11px] text-warn"
                title={info?.error ?? 'Running on mock data'}
              >
                <span className="size-1.5 rounded-full bg-warn" />
                mock
              </span>
            ) : !noProject ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-good">
                <span className="size-1.5 animate-breathe rounded-full bg-good" />
                live graph
              </span>
            ) : null}
            <ChevronsUpDown className="size-3.5 text-ink-3" />
          </span>
        </button>
        {!noProject && (
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
        )}
        {result && <div className="mt-1.5 text-[11px] text-ink-2">{result}</div>}
        {!live && info?.error && (
          <div className="mt-1.5 line-clamp-3 text-[11px] text-warn/80">{info.error}</div>
        )}
      </div>

      {open && (
        <div
          role="listbox"
          className="absolute top-full right-0 left-0 z-20 mt-1.5 animate-fade-in overflow-hidden rounded-xl border border-line-strong bg-surface shadow-[0_20px_50px_-15px_rgb(0_0_0/0.9)]"
        >
          <ul className="max-h-64 overflow-y-auto p-1.5">
            {projects?.map((p) => (
              <li key={p.id} className="group flex items-center gap-1">
                <button
                  role="option"
                  aria-selected={p.active}
                  onClick={() => {
                    setOpen(false);
                    if (!p.active) onSwitch(p.id);
                  }}
                  className="flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface-2"
                >
                  <Check
                    className={cn(
                      'mt-0.5 size-3.5 shrink-0',
                      p.active ? 'text-brand-soft' : 'opacity-0',
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{p.name}</span>
                    <span
                      className={cn(
                        'block truncate font-mono text-[10px]',
                        p.missing ? 'text-bad' : 'text-ink-3',
                      )}
                      title={p.repoPath}
                    >
                      {p.missing ? 'folder is missing' : p.repoPath}
                    </span>
                  </span>
                </button>
                <button
                  onClick={() => {
                    setOpen(false);
                    onSettings(p);
                  }}
                  aria-label={`Settings for ${p.name}`}
                  title="Settings"
                  className="rounded-md p-1.5 text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-surface-3 hover:text-ink focus:opacity-100"
                >
                  <Settings2 className="size-3.5" />
                </button>
              </li>
            ))}
            {projects?.length === 0 && (
              <li className="px-2 py-2 text-[12px] text-ink-3">No projects yet.</li>
            )}
          </ul>
          <button
            onClick={() => {
              setOpen(false);
              onAdd();
            }}
            className="flex w-full items-center gap-2 border-t border-line px-3.5 py-2.5 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            <Plus className="size-4" />
            Add a project…
          </button>
        </div>
      )}
    </div>
  );
}
