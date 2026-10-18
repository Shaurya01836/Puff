import { useEffect, useState, type ReactNode } from 'react';
import {
  Check,
  CircleX,
  FolderOpen,
  GitBranch,
  LoaderCircle,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { ProjectSummary, RepoInspection } from '@puff/shared';
import { cn } from '@/lib/cn';

/** The frame every project dialog shares: dimmed backdrop, Escape to close, a header and a footer. */
function Dialog({
  title,
  subtitle,
  onClose,
  footer,
  children,
}: {
  title: string;
  subtitle: string;
  onClose: () => void;
  footer: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-30 grid place-items-center bg-abyss/70 p-6 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={title}
        className="flex max-h-full w-full max-w-lg animate-fade-in flex-col rounded-lg border border-line-strong bg-surface shadow-[0_20px_50px_-24px_rgb(0_0_0/0.85)]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-start justify-between border-b border-line px-6 py-4">
          <div>
            <h2 className="font-display text-lg font-semibold">{title}</h2>
            <p className="text-xs text-ink-3">{subtitle}</p>
          </div>
          <button
            onClick={onClose}
            className="rounded-sm p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </header>
        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto px-6 py-5">{children}</div>
        <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-6 py-4">
          {footer}
        </footer>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[0.6875rem] font-semibold tracking-wide text-ink-3 uppercase">
        {label}
      </div>
      {children}
      {hint && <p className="mt-1.5 text-[0.6875rem] text-ink-3">{hint}</p>}
    </div>
  );
}

const INPUT =
  'w-full rounded-md border border-line bg-surface-2 px-3 py-2 text-sm outline-none placeholder:text-ink-3 focus:border-brand/60';

const GHOST = 'rounded-md px-4 py-2 text-sm text-ink-2 hover:text-ink';
const PRIMARY =
  'rounded-md bg-brand px-4 py-2 text-sm font-semibold text-abyss hover:bg-brand-soft disabled:opacity-50';

type Tone = 'good' | 'warn' | 'bad';

/** One line of the inspection: an icon that says how it went, a label, and the detail. */
function Row({ tone, label, children }: { tone: Tone; label: string; children: ReactNode }) {
  const Icon = tone === 'good' ? Check : tone === 'warn' ? TriangleAlert : CircleX;
  return (
    <li className="flex items-start gap-3">
      <Icon
        className={cn(
          'mt-0.5 size-4 shrink-0',
          tone === 'good' ? 'text-good' : tone === 'warn' ? 'text-warn' : 'text-bad',
        )}
      />
      <div className="min-w-0 text-sm">
        <div className="font-medium">{label}</div>
        <div className="text-[0.8125rem] leading-snug text-ink-2">{children}</div>
      </div>
    </li>
  );
}

function gitSummary(g: RepoInspection['git']): { tone: Tone; text: string } {
  if (!g.isRepo) return { tone: 'warn', text: 'Not a git repository yet.' };
  if (!g.isRoot) return { tone: 'warn', text: `Inside the repository at ${g.root}.` };
  if (!g.hasCommits) return { tone: 'warn', text: 'A repository with no commits yet.' };
  return {
    tone: g.dirty ? 'warn' : 'good',
    text: `Branch ${g.branch ?? '(detached)'}${g.dirty ? ', with uncommitted changes' : ', clean'}.`,
  };
}

/** Add a folder as a project: look at it first, say what will and will not work, then add it. */
export function ImportProjectDialog({
  onClose,
  onPick,
  onInspect,
  onAdd,
}: {
  onClose: () => void;
  onPick: () => Promise<string | undefined>;
  onInspect: (path: string) => Promise<RepoInspection>;
  onAdd: (input: {
    repoPath: string;
    name?: string;
    testCommand?: string;
    initGit?: boolean;
  }) => Promise<void>;
}) {
  const [path, setPath] = useState('');
  const [info, setInfo] = useState<RepoInspection>();
  const [checking, setChecking] = useState(false);
  const [name, setName] = useState('');
  const [testCommand, setTestCommand] = useState('');
  const [initGit, setInitGit] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();

  const check = async (target: string) => {
    if (!target.trim()) return;
    setChecking(true);
    setError(undefined);
    try {
      const found = await onInspect(target.trim());
      setInfo(found);
      setName(found.name);
      setTestCommand(found.testCommand ?? '');
      setInitGit(false);
    } catch (err) {
      setInfo(undefined);
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const browse = async () => {
    const picked = await onPick();
    if (!picked) return;
    setPath(picked);
    await check(picked);
  };

  const add = async () => {
    if (!info) return;
    setAdding(true);
    setError(undefined);
    try {
      await onAdd({
        repoPath: info.path,
        name: name.trim() || undefined,
        testCommand: testCommand.trim() || undefined,
        initGit: initGit && info.canInitGit,
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setAdding(false);
    }
  };

  const blocked = !info || info.problems.length > 0;
  const git = info ? gitSummary(info.git) : undefined;
  const other = info
    ? Object.entries(info.files.unsupported)
        .map(([ext, n]) => `${n} .${ext}`)
        .join(', ')
    : '';

  return (
    <Dialog
      title="Add a project"
      subtitle="Choose a folder. Puff looks at it first and tells you what will work."
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className={GHOST}>
            Cancel
          </button>
          <button disabled={blocked || adding} onClick={() => void add()} className={PRIMARY}>
            {adding ? 'Adding and indexing…' : 'Add project'}
          </button>
        </>
      }
    >
      <Field label="Folder">
        <div className="flex gap-2">
          <input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void check(path)}
            onBlur={() => path.trim() && path.trim() !== info?.path && void check(path)}
            placeholder="C:\work\my-app"
            aria-label="Project folder"
            className={cn(INPUT, 'font-mono text-xs')}
            autoFocus
          />
          <button
            onClick={() => void browse()}
            className="inline-flex shrink-0 items-center gap-2 rounded-md border border-line-strong bg-surface-2 px-3 text-sm font-medium hover:bg-surface-3"
          >
            <FolderOpen className="size-4" />
            Browse
          </button>
        </div>
      </Field>

      {checking && (
        <div className="flex items-center gap-2 text-sm text-ink-3">
          <LoaderCircle className="size-4 animate-spin" />
          Looking at the folder…
        </div>
      )}

      {info && !checking && (
        <>
          <ul className="flex flex-col gap-3 rounded-md border border-line bg-surface-2/60 p-4">
            {info.problems.map((p) => (
              <Row key={p} tone="bad" label="Can't add this folder">
                {p}
              </Row>
            ))}
            {info.exists && info.isDirectory && git && (
              <Row tone={git.tone} label="Git">
                {git.text}
              </Row>
            )}
            {info.exists && info.isDirectory && (
              <Row tone={info.files.supported > 0 ? 'good' : 'bad'} label="Code">
                {info.files.supported} TypeScript and JavaScript files
                {other ? `. Not read (other languages): ${other}` : ''}.
              </Row>
            )}
            {info.exists && info.isDirectory && (
              <Row tone={info.testCommand ? 'good' : 'warn'} label="Tests">
                {info.testCommand
                  ? `${info.testCommand}, from package.json.`
                  : 'No test command found. Set one below so agents can be verified.'}
              </Row>
            )}
          </ul>

          {info.problems.length === 0 && info.runBlockers.length > 0 && (
            <div className="rounded-md border border-warn/25 bg-warn/10 p-4 text-[0.8125rem] leading-snug text-ink-2">
              <div className="mb-1 font-medium text-warn">
                You can add it and explore it, but agents can't run yet
              </div>
              <ul className="list-disc pl-4">
                {info.runBlockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
              {info.canInitGit && (
                <label className="mt-3 flex cursor-pointer items-start gap-2.5">
                  <input
                    type="checkbox"
                    checked={initGit}
                    onChange={(e) => setInitGit(e.target.checked)}
                    className="mt-0.5 accent-[var(--color-brand)]"
                  />
                  <span>
                    <span className="flex items-center gap-1.5 font-medium text-ink">
                      <GitBranch className="size-3.5" />
                      Set up git for me
                    </span>
                    <span className="text-ink-3">
                      Runs <code>git init</code> if needed, creates a <code>.gitignore</code> for{' '}
                      <code>node_modules</code> if there is none, and commits all files as "Initial
                      commit". Nothing is changed unless you tick this.
                    </span>
                  </span>
                </label>
              )}
            </div>
          )}

          {info.warnings.length > 0 && info.problems.length === 0 && (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-[0.8125rem] leading-snug text-ink-3">
              {info.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}

          {info.problems.length === 0 && (
            <div className="grid grid-cols-2 gap-4">
              <Field label="Name">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  aria-label="Project name"
                  className={INPUT}
                />
              </Field>
              <Field label="Test command">
                <input
                  value={testCommand}
                  onChange={(e) => setTestCommand(e.target.value)}
                  placeholder="npm test"
                  aria-label="Test command"
                  className={cn(INPUT, 'font-mono text-xs')}
                />
              </Field>
            </div>
          )}
        </>
      )}

      {error && <p className="text-sm text-bad">{error}</p>}
    </Dialog>
  );
}

/** A project's own settings, and removing it. */
export function ProjectSettingsDialog({
  project,
  onClose,
  onSave,
  onRemove,
}: {
  project: ProjectSummary;
  onClose: () => void;
  onSave: (patch: {
    name?: string;
    testCommand?: string | null;
    linkDirs?: string[] | null;
  }) => Promise<void>;
  onRemove: (deleteMemory: boolean) => Promise<void>;
}) {
  const [name, setName] = useState(project.name);
  const [testCommand, setTestCommand] = useState(project.testCommand ?? '');
  const [linkDirs, setLinkDirs] = useState(project.linkDirs?.join(', ') ?? '');
  const [confirming, setConfirming] = useState(false);
  const [deleteMemory, setDeleteMemory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = async (op: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await op();
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const save = () =>
    run(() =>
      onSave({
        name,
        testCommand: testCommand.trim() || null,
        linkDirs: linkDirs.trim()
          ? linkDirs
              .split(',')
              .map((d) => d.trim())
              .filter(Boolean)
          : null,
      }),
    );

  return (
    <Dialog
      title="Project settings"
      subtitle={project.repoPath}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className={GHOST}>
            Cancel
          </button>
          <button disabled={busy || !name.trim()} onClick={() => void save()} className={PRIMARY}>
            Save
          </button>
        </>
      }
    >
      <Field label="Name">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Project name"
          className={INPUT}
        />
      </Field>
      <Field
        label="Test command"
        hint="How a finished task is verified. Empty uses the shared default."
      >
        <input
          value={testCommand}
          onChange={(e) => setTestCommand(e.target.value)}
          placeholder="npm test"
          aria-label="Test command"
          className={cn(INPUT, 'font-mono text-xs')}
        />
      </Field>
      <Field
        label="Linked folders"
        hint="Git-ignored folders that every task's checkout needs, separated by commas. Empty uses node_modules."
      >
        <input
          value={linkDirs}
          onChange={(e) => setLinkDirs(e.target.value)}
          placeholder="node_modules"
          aria-label="Linked folders"
          className={cn(INPUT, 'font-mono text-xs')}
        />
      </Field>

      <div className="rounded-md border border-bad/25 bg-bad/5 p-4">
        <div className="text-sm font-medium">Remove this project</div>
        <p className="mt-1 text-[0.8125rem] leading-snug text-ink-3">
          Puff forgets it. Your folder and files are never touched.
        </p>
        {!confirming ? (
          <button
            onClick={() => setConfirming(true)}
            className="mt-3 inline-flex items-center gap-2 rounded-sm border border-bad/30 px-3 py-1.5 text-sm text-bad hover:bg-bad/10"
          >
            <Trash2 className="size-4" />
            Remove…
          </button>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            <label className="flex cursor-pointer items-start gap-2.5 text-[0.8125rem] text-ink-2">
              <input
                type="checkbox"
                checked={deleteMemory}
                onChange={(e) => setDeleteMemory(e.target.checked)}
                className="mt-0.5 accent-[var(--color-bad)]"
              />
              Also delete its memory: every task, failure, decision and handoff recorded for it.
              This cannot be undone.
            </label>
            <div className="flex gap-2">
              <button
                disabled={busy}
                onClick={() => void run(() => onRemove(deleteMemory))}
                className="rounded-sm bg-bad px-3 py-1.5 text-sm font-semibold text-abyss hover:brightness-110 disabled:opacity-50"
              >
                {deleteMemory ? 'Remove and delete memory' : 'Remove project'}
              </button>
              <button onClick={() => setConfirming(false)} className={GHOST}>
                Keep it
              </button>
            </div>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-bad">{error}</p>}
    </Dialog>
  );
}
