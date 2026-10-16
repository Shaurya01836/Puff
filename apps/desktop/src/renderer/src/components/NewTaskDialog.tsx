import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Cpu, X } from 'lucide-react';
import type { AgentName, Complexity, Task, TaskEditInput, TaskType } from '@puff/shared';
import { cn } from '@/lib/cn';
import { AGENT_META } from '@/lib/theme';
import { AgentAvatar } from './ui';

export interface SymbolOption {
  id: string;
  name: string;
  file: string;
}

const TYPES: { id: TaskType; label: string; hint: string }[] = [
  { id: 'implement', label: 'Implement', hint: 'change code and its tests' },
  { id: 'chore', label: 'Chore', hint: 'docs, formatting' },
  { id: 'plan', label: 'Plan', hint: 'split a goal into tasks' },
  { id: 'verify', label: 'Review', hint: 'read-only check' },
];
const LEVELS: Complexity[] = ['low', 'medium', 'high'];
const AGENTS: AgentName[] = ['claude-code', 'codex', 'opencode'];

/**
 * Delegate a task: what, where in the code, and who does it (Auto lets Puff route it). With `edit`
 * the same form changes an existing task instead (its type stays as it was).
 */
export function NewTaskDialog({
  symbols,
  onClose,
  onCreate,
  edit,
}: {
  symbols: SymbolOption[];
  onClose: () => void;
  onCreate: (task: Partial<Task>, run: boolean) => Promise<void>;
  edit?: { task: Task; onSave: (changes: TaskEditInput) => Promise<void> };
}) {
  const initial = edit?.task;
  const [title, setTitle] = useState(initial?.title ?? '');
  const [type, setType] = useState<TaskType>(initial?.type ?? 'implement');
  const [complexity, setComplexity] = useState<Complexity>(initial?.complexity ?? 'medium');
  const [targets, setTargets] = useState<SymbolOption[]>(() =>
    (initial?.targets ?? []).map(
      (id) =>
        symbols.find((s) => s.id === id) ?? {
          id,
          name: id.split('::').pop() ?? id,
          file: id.split('::')[0] ?? '',
        },
    ),
  );
  const [query, setQuery] = useState('');
  const [agent, setAgent] = useState<AgentName | 'auto'>(initial?.preferredAgent ?? 'auto');
  const [model, setModel] = useState(initial?.model ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const titleRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => titleRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return symbols
      .filter(
        (s) =>
          !targets.some((t) => t.id === s.id) &&
          (s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)),
      )
      .slice(0, 6);
  }, [query, symbols, targets]);

  const submit = async (run: boolean) => {
    if (!title.trim()) return setError('Say what needs doing.');
    setBusy(true);
    setError(undefined);
    try {
      if (edit) {
        await edit.onSave({
          title: title.trim(),
          complexity,
          preferredAgent: agent === 'auto' ? null : agent,
          model: model.trim() || null,
          targets: targets.map((t) => t.id),
        });
        onClose();
        return;
      }
      await onCreate(
        {
          title: title.trim(),
          type,
          complexity,
          targets: targets.map((t) => t.id),
          preferredAgent: agent === 'auto' ? undefined : agent,
          model: model.trim() || undefined,
        },
        run,
      );
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-30 grid place-items-center bg-abyss/70 p-6 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="New task"
        className="w-full max-w-lg animate-fade-in rounded-2xl border border-line-strong bg-surface shadow-[0_30px_80px_-20px_rgb(0_0_0/0.9)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between border-b border-line px-6 py-4">
          <div>
            <h2 className="font-display text-lg font-semibold">
              {edit ? 'Edit task' : 'New task'}
            </h2>
            <p className="text-xs text-ink-3">
              {edit
                ? 'Change what this task asks for before it runs.'
                : 'Delegate a task to an agent in this project.'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex flex-col gap-5 px-6 py-5">
          <Field label="What needs doing?">
            <textarea
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              rows={3}
              placeholder="Add edge-case coverage for the login lockout and make sure the tests pass"
              className="w-full resize-none rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm outline-none placeholder:text-ink-3 focus:border-brand/60"
            />
          </Field>

          <div className="grid grid-cols-2 gap-5">
            <Field label="Type">
              {edit ? (
                <div className="rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2 capitalize">
                  {type}
                </div>
              ) : (
                <Segmented
                  value={type}
                  onChange={setType}
                  options={TYPES.map((t) => ({ id: t.id, label: t.label, title: t.hint }))}
                />
              )}
            </Field>
            <Field label="Complexity">
              <Segmented
                value={complexity}
                onChange={setComplexity}
                options={LEVELS.map((l) => ({ id: l, label: l }))}
              />
            </Field>
          </div>

          <Field
            label="Code it touches"
            hint="Tasks that touch the same functions never run at the same time."
          >
            <div className="rounded-xl border border-line bg-surface-2 p-2">
              <div className="flex flex-wrap gap-1.5">
                {targets.map((t) => (
                  <span
                    key={t.id}
                    className="inline-flex items-center gap-1 rounded-md bg-brand/15 px-2 py-0.5 font-mono text-[11px] text-brand-soft"
                    title={t.id}
                  >
                    {t.name}
                    <button
                      onClick={() => setTargets((x) => x.filter((y) => y.id !== t.id))}
                      aria-label={`Remove ${t.name}`}
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && matches[0]) {
                      e.preventDefault();
                      setTargets((x) => [...x, matches[0]!]);
                      setQuery('');
                    }
                  }}
                  placeholder={targets.length ? '' : 'Search functions, e.g. login'}
                  className="min-w-32 flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-ink-3"
                />
              </div>
              {matches.length > 0 && (
                <ul className="mt-2 border-t border-line pt-1">
                  {matches.map((s) => (
                    <li key={s.id}>
                      <button
                        onClick={() => {
                          setTargets((x) => [...x, s]);
                          setQuery('');
                        }}
                        className="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-surface-3"
                      >
                        <span className="font-mono text-xs">{s.name}</span>
                        <span className="truncate font-mono text-[11px] text-ink-3">{s.file}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Field>

          <div className="grid grid-cols-[1fr_180px] gap-5">
            <Field label="Agent">
              <div className="flex gap-1.5">
                <AgentButton
                  active={agent === 'auto'}
                  onClick={() => setAgent('auto')}
                  label="Auto"
                  title="Puff picks from declared strengths and past results"
                >
                  <span className="grid size-6 place-items-center rounded-md bg-surface-3 text-ink-2">
                    <Cpu className="size-3.5" />
                  </span>
                </AgentButton>
                {AGENTS.map((a) => (
                  <AgentButton
                    key={a}
                    active={agent === a}
                    onClick={() => setAgent(a)}
                    label={AGENT_META[a].label}
                  >
                    <AgentAvatar agent={a} size={24} />
                  </AgentButton>
                ))}
              </div>
            </Field>
            <Field label="Model">
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="CLI default"
                className="w-full rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm outline-none placeholder:text-ink-3 focus:border-brand/60"
              />
            </Field>
          </div>

          {error && <p className="text-sm text-bad">{error}</p>}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-line px-6 py-4">
          <button
            onClick={onClose}
            className="rounded px-4 py-2 text-sm text-slate-400 hover:text-white"
          >
            Cancel
          </button>
          {edit ? (
            <button
              disabled={busy}
              onClick={() => void submit(false)}
              className="rounded bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
            >
              Save changes
            </button>
          ) : (
            <>
              <button
                disabled={busy}
                onClick={() => void submit(false)}
                className="rounded border border-line bg-surface-2 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-surface-3 hover:text-white disabled:opacity-50"
              >
                Add to board
              </button>
              <button
                disabled={busy}
                onClick={() => void submit(true)}
                className="rounded bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
              >
                Add and run
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold tracking-[0.12em] text-ink-3 uppercase">
        {label}
      </div>
      {children}
      {hint && <p className="mt-1.5 text-[11px] text-ink-3">{hint}</p>}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string; title?: string }[];
}) {
  return (
    <div className="flex rounded-xl border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          title={o.title}
          onClick={() => onChange(o.id)}
          className={cn(
            'flex-1 rounded-[10px] px-2 py-1.5 text-xs capitalize transition-colors',
            value === o.id ? 'bg-surface-3 text-ink' : 'text-ink-3 hover:text-ink-2',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function AgentButton({
  active,
  onClick,
  label,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title ?? label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        'relative grid size-11 place-items-center rounded-xl border transition-colors',
        active ? 'border-brand bg-brand/10' : 'border-line bg-surface-2 hover:border-line-strong',
      )}
    >
      {children}
      {active && (
        <span className="absolute -top-1 -right-1 grid size-4 place-items-center rounded-full bg-brand text-white">
          <Check className="size-2.5" />
        </span>
      )}
    </button>
  );
}
