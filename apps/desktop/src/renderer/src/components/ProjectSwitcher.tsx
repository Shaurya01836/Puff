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
  onConfigureDatabase,
}: {
  info?: BackendInfo;
  projects?: ProjectSummary[];
  onReindex: () => Promise<string>;
  onSwitch: (id: string) => void;
  onAdd: () => void;
  onSettings: (project: ProjectSummary) => void;
  onConfigureDatabase?: () => void;
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
    <div ref={box} className="relative">
      <div className="border border-line bg-surface p-3 transition-colors hover:border-line-strong">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          title="Switch or add a project"
          className="flex w-full items-start justify-between text-left"
        >
          <div className="min-w-0 flex-1">
            <span className="block font-mono text-[10px] uppercase tracking-wide text-ink-3">
              WORKSPACE
            </span>
            <span className="mt-0.5 block truncate text-sm font-semibold text-ink">
              {noProject ? 'No project yet' : (info?.projectName ?? 'puff_demo')}
            </span>
            <span className="mt-1 block font-mono text-[10px] text-ink-2">
              {live ? 'falkordb · connected' : 'mock data · connected'}
            </span>
          </div>
          <ChevronsUpDown className="mt-1 size-3.5 shrink-0 text-ink-3" />
        </button>

        {!noProject && live && (
          <div className="mt-2 flex items-center justify-between border-t border-line/60 pt-1.5 font-mono text-[10px] text-ink-3">
            <span className="truncate">{info?.graphName ?? 'graph: connected'}</span>
            <button
              onClick={reindex}
              disabled={busy}
              className="rounded p-0.5 text-ink-2 hover:text-ink disabled:opacity-50"
              title="Re-index the repository"
            >
              <RefreshCw className={cn('size-3', busy && 'animate-spin')} />
            </button>
          </div>
        )}

        {result && <div className="mt-1.5 font-mono text-[10px] text-brand">{result}</div>}
        {!live && info?.error && (
          <div className="mt-1.5 line-clamp-2 font-mono text-[10px] text-warn">{info.error}</div>
        )}
      </div>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 bottom-full left-0 z-30 mb-1.5 animate-fade-in overflow-hidden border border-line-strong bg-surface shadow-[0_16px_40px_-16px_rgb(0_0_0/0.8)]"
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
                  className="flex min-w-0 flex-1 items-start gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-surface-2"
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
                  className="rounded-sm p-1.5 text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-surface-3 hover:text-ink focus:opacity-100"
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
              onConfigureDatabase?.();
            }}
            className="flex w-full items-center gap-2 border-t border-line px-3.5 py-2.5 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink cursor-pointer"
          >
            <Database className="size-4 text-brand" />
            Configure FalkorDB…
          </button>
          <button
            onClick={() => {
              setOpen(false);
              onAdd();
            }}
            className="flex w-full items-center gap-2 border-t border-line px-3.5 py-2.5 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink cursor-pointer"
          >
            <Plus className="size-4" />
            Add a project…
          </button>
        </div>
      )}
    </div>
  );
}
