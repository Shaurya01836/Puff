import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Check,
  FileCode2,
  FolderOpen,
  GitMerge,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  Square,
  StickyNote,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import type {
  AgentName,
  ContextPack,
  ManualResult,
  SessionInfo,
  Task,
  TaskDiffInfo,
  TerminalCli,
  WhyPath,
} from '@puff/shared';
import { ActivityFeed } from '@/components/ActivityFeed';
import { Menu } from '@/components/Menu';
import { NewTaskDialog, type SymbolOption } from '@/components/NewTaskDialog';
import { TerminalView } from '@/components/TerminalView';
import { AgentChip, SectionTitle, StatusPill } from '@/components/ui';
import { puff } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useActivity, useLoad } from '@/lib/hooks';
import { closeTerminal, openTerminal, useTerminals } from '@/lib/terminals';
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

export type Tab = 'activity' | 'terminal' | 'context' | 'changes' | 'why' | 'sessions';

const CLIS: { cli: TerminalCli; label: string }[] = [
  { cli: 'claude-code', label: 'Claude Code' },
  { cli: 'codex', label: 'Codex' },
  { cli: 'opencode', label: 'OpenCode' },
  { cli: 'shell', label: 'Plain terminal' },
];
const AGENTS: AgentName[] = ['claude-code', 'codex', 'opencode'];

/** The statuses in which an agent (or Puff's own checks) is working on the task right now */
const WORKING = new Set<Task['status']>(['running', 'verifying']);

export function TaskDetail({
  taskId,
  onClose,
  symbols,
  initialTab,
}: {
  taskId: string;
  onClose: () => void;
  symbols: SymbolOption[];
  /** Open on this tab (the board's Take over button opens the terminal) */
  initialTab?: Tab;
}) {
  // Bumped after an action, so what is shown is read again
  const [tick, setTick] = useState(0);
  const detail = useLoad(() => loadDetail(taskId), [taskId, tick]);
  const diff = useLoad(() => puff.getTaskDiff(taskId), [taskId, tick, detail?.task.status]);
  // The tab the person picked; until they pick one, a task being worked on opens on its activity
  const [picked, setPicked] = useState<Tab | undefined>(initialTab);
  const terms = useTerminals(taskId);
  const [noting, setNoting] = useState(false);
  const [noteText, setNoteText] = useState('');
  const activity = useActivity(taskId, detail?.sessions);
  const [editing, setEditing] = useState(false);
  const [problem, setProblem] = useState<string>();

  const act = async (action: () => Promise<unknown>, closeAfter = false) => {
    setProblem(undefined);
    try {
      await action();
      if (closeAfter) onClose();
      else setTick((t) => t + 1);
    } catch (err) {
      setProblem((err as Error).message);
    }
  };
  const status = detail?.task.status;
  const working = status !== undefined && WORKING.has(status);
  const tab: Tab = picked ?? (working ? 'activity' : 'context');
  const setTab = setPicked;
  const stepCount = activity.reduce((n, g) => n + g.steps.length, 0);
  const canEdit = status === 'planned' || status === 'ready' || status === 'failed';
  const canRemove = (status === 'planned' || status === 'ready') && detail?.sessions.length === 0;
  const mine = Boolean(detail?.task.worktree?.endsWith('-manual'));
  const openCli = async (cli: TerminalCli, start = false) => {
    setProblem(undefined);
    try {
      await openTerminal(taskId, cli, start);
      setPicked('terminal');
      setTick((t) => t + 1);
    } catch (err) {
      setProblem((err as Error).message);
    }
  };

  useEffect(
    () =>
      puff.onEvent((e) => {
        if (
          (e.type === 'task:update' && e.task.id === taskId) ||
          (e.type === 'session:update' && e.session.taskId === taskId)
        )
          setTick((t) => t + 1);
      }),
    [taskId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !editing && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, editing]);

  return (
    <div
      className="fixed inset-0 z-20 flex justify-end bg-abyss/60 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <aside
        className={cn(
          'flex h-full animate-slide-in flex-col border-l border-line-strong bg-surface shadow-[-30px_0_60px_-20px_rgb(0_0_0/0.7)]',
          tab === 'terminal' ? 'w-[min(1000px,94vw)]' : 'w-[620px]',
        )}
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

          {detail && status !== 'done' && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {working && (
                <ActionButton
                  icon={Square}
                  label="Stop"
                  title="Stop this task's agent. The rest of the team keeps working."
                  onClick={() => void act(() => puff.stopTask(taskId))}
                />
              )}
              {status === 'failed' && (
                <ActionButton
                  icon={RotateCcw}
                  label="Retry"
                  title="Put it back in the queue; the earlier attempts stay in its history"
                  onClick={() => void act(() => puff.retryTask(taskId))}
                />
              )}
              {canEdit && (
                <ActionButton icon={Pencil} label="Edit" onClick={() => setEditing(true)} />
              )}
              <Menu
                label="Switch agent"
                title="Give this task to another agent (it is stopped first if it is running)"
                items={AGENTS.map((a) => ({
                  label: AGENT_META[a].label,
                  hint:
                    a === (detail.task.assignedAgent ?? detail.task.preferredAgent)
                      ? 'current'
                      : undefined,
                  onSelect: () => void act(() => puff.reassignTask(taskId, a)),
                }))}
              />
              <Menu
                label="Take over"
                icon={<Terminal className="size-3.5" />}
                title="Stop the agent and work on it yourself in a real terminal"
                items={[
                  ...CLIS.filter((c) => c.cli !== 'shell').map((c) => ({
                    label: `Start ${c.label} on this task`,
                    hint: 'Watch it work in its own screen. Uses tokens.',
                    onSelect: () => void openCli(c.cli, true),
                  })),
                  ...CLIS.map((c) => ({
                    label: c.cli === 'shell' ? c.label : `Open ${c.label} and wait`,
                    hint:
                      c.cli === 'shell'
                        ? "A shell in the task's folder"
                        : "Its own screen, idle, in the task's folder",
                    onSelect: () => void openCli(c.cli),
                  })),
                ]}
              />
              <ActionButton
                icon={StickyNote}
                label={detail.task.note ? 'Edit note' : 'Add note'}
                title="A note the next attempt on this task must follow"
                onClick={() => {
                  setNoteText(detail.task.note ?? '');
                  setNoting((n) => !n);
                }}
              />
              <ActionButton
                icon={Check}
                label="Mark done"
                title="You finished it yourself"
                onClick={() => {
                  if (
                    window.confirm(
                      'Mark this task as done? Use this when you finished it yourself.',
                    )
                  )
                    void act(() => puff.markTaskDone(taskId));
                }}
              />
              {canRemove && (
                <ActionButton
                  icon={Trash2}
                  label="Remove"
                  title="Delete this task. It has never run, so nothing is lost."
                  danger
                  onClick={() => void act(() => puff.removeTask(taskId), true)}
                />
              )}
            </div>
          )}
          {noting && (
            <form
              className="mt-3 flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setNoting(false);
                void act(() => puff.addTaskNote(taskId, noteText));
              }}
            >
              <textarea
                autoFocus
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                rows={3}
                aria-label="Note for the next attempt"
                placeholder="Tell the next attempt something it must know or do, e.g. “reuse the existing rounding helper”"
                className="resize-none rounded-xl border border-line bg-surface-2 p-3 text-sm outline-none focus:border-brand/60"
              />
              <div className="flex gap-2">
                <button
                  type="submit"
                  className="rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white"
                >
                  Save note
                </button>
                <button
                  type="button"
                  onClick={() => setNoting(false)}
                  className="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-ink-2"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
          {!noting && detail?.task.note && (
            <p className="mt-3 rounded-xl border border-line bg-surface-2/60 p-3 text-[13px] leading-snug text-ink-2">
              <b className="font-medium text-ink">Your note: </b>
              {detail.task.note}
            </p>
          )}
          {mine && working && (
            <p
              role="alert"
              className="mt-3 rounded-xl border border-warn/40 bg-warn/10 p-3 text-[13px] leading-snug text-ink-2"
            >
              <b className="font-medium text-warn">
                An agent is also running this task in the background.
              </b>{' '}
              What you see under Activity is that background run, not your terminal. If it succeeds
              it merges its own result. Press <b className="font-medium">Stop</b> above if you want
              to work on it yourself.
            </p>
          )}
          {mine && !working && status !== 'done' && (
            <p className="mt-3 rounded-xl border border-brand/30 bg-brand/10 p-3 text-[13px] leading-snug text-ink-2">
              <b className="font-medium text-ink">You took this task over.</b> Puff will not run it.
              Work in its terminal, then press{' '}
              <b className="font-medium">Verify and merge my changes</b> in the Terminal tab.
            </p>
          )}
          {problem && <p className="mt-3 text-sm text-bad">{problem}</p>}

          <div className="mt-5 flex gap-1">
            {(
              [
                ['activity', `Activity${stepCount ? ` · ${stepCount}` : ''}`],
                ['terminal', `Terminal${terms.length ? ` · ${terms.length}` : ''}`],
                ['context', 'Context received'],
                ['changes', `Changes${diff ? ` · ${diff.files.length}` : ''}`],
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
                {id === 'activity' && working && (
                  <span className="ml-1.5 inline-block size-1.5 animate-pulse rounded-full bg-info align-middle" />
                )}
              </button>
            ))}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {detail && tab === 'activity' && <ActivityFeed groups={activity} active={working} />}
          {detail && tab === 'terminal' && (
            <TerminalTab
              taskId={taskId}
              terms={terms}
              onOpen={openCli}
              onLanded={() => setTick((t) => t + 1)}
            />
          )}
          {detail && tab === 'context' && <ContextTab task={detail.task} pack={detail.pack} />}
          {detail && tab === 'changes' && <ChangesTab diff={diff} status={detail.task.status} />}
          {detail && tab === 'why' && <WhyTab why={detail.why} />}
          {detail && tab === 'sessions' && <SessionsTab sessions={detail.sessions} />}
        </div>
      </aside>
      {editing && detail && (
        <div onClick={(e) => e.stopPropagation()}>
          <NewTaskDialog
            symbols={symbols}
            onClose={() => setEditing(false)}
            onCreate={async () => {}}
            edit={{
              task: detail.task,
              onSave: async (changes) => {
                await puff.editTask(taskId, changes);
                setTick((t) => t + 1);
              },
            }}
          />
        </div>
      )}
    </div>
  );
}

function ActionButton({
  icon: Icon,
  label,
  title,
  danger,
  onClick,
}: {
  icon: typeof Pencil;
  label: string;
  title?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors',
        danger
          ? 'border-bad/30 text-bad hover:bg-bad/10'
          : 'border-line-strong bg-surface-2 text-ink-2 hover:bg-surface-3 hover:text-ink',
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  );
}

/** What the task changed, as git shows it: green added, red removed. */
function ChangesTab({ diff, status }: { diff?: TaskDiffInfo; status: Task['status'] }) {
  if (!diff) {
    return (
      <p className="text-sm text-ink-3">
        {status === 'planned' || status === 'ready'
          ? 'Nothing yet: this task has not run.'
          : 'No changes were kept for this task. An attempt that changed nothing leaves nothing to show.'}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-sm font-medium">{diff.label}</div>
        <div className="mt-0.5 font-mono text-[11px] text-ink-3">{diff.ref}</div>
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {diff.files.map((f) => (
            <li
              key={f}
              className="rounded-md border border-line bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-ink-2"
            >
              {f}
            </li>
          ))}
        </ul>
      </div>
      <pre className="overflow-x-auto rounded-xl border border-line bg-abyss/60 p-3 font-mono text-[11px] leading-relaxed">
        {diff.diff.split('\n').map((line, i) => (
          <div
            key={i}
            className={cn(
              'whitespace-pre',
              line.startsWith('+') && !line.startsWith('+++') && 'bg-good/10 text-good',
              line.startsWith('-') && !line.startsWith('---') && 'bg-bad/10 text-bad',
              line.startsWith('@@') && 'text-brand-soft',
              (line.startsWith('diff ') || line.startsWith('+++') || line.startsWith('---')) &&
                'font-semibold text-ink-2',
              !/^[+@-]|^diff /.test(line) && 'text-ink-3',
            )}
          >
            {line || ' '}
          </div>
        ))}
      </pre>
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

/**
 * Take the task over in a real terminal. The agent's own CLI opens in the task's working folder, which starts
 * from the agent's last attempt, so the person continues from there with the program's own screen.
 */
function TerminalTab({
  taskId,
  terms,
  onOpen,
  onLanded,
}: {
  taskId: string;
  terms: ReturnType<typeof useTerminals>;
  onOpen: (cli: TerminalCli, start?: boolean) => Promise<void>;
  onLanded: () => void;
}) {
  const [active, setActive] = useState<string>();
  const [landing, setLanding] = useState(false);
  const [result, setResult] = useState<ManualResult>();
  const [opening, setOpening] = useState(false);
  const current = terms.find((t) => t.info.id === active) ?? terms.at(-1);

  const open = async (cli: TerminalCli, start = false) => {
    setOpening(true);
    try {
      await onOpen(cli, start);
      setActive(undefined);
    } finally {
      setOpening(false);
    }
  };

  const choice = (c: (typeof CLIS)[number], start: boolean) => (
    <button
      key={`${c.cli}-${start}`}
      disabled={opening}
      onClick={() => void open(c.cli, start)}
      className="inline-flex items-center gap-2 rounded-xl border border-line-strong bg-surface-2 px-3.5 py-2 text-sm font-medium hover:bg-surface-3 disabled:opacity-50"
    >
      {c.cli === 'shell' ? <Terminal className="size-4" /> : <AgentMini cli={c.cli} />}
      {c.cli === 'shell' ? c.label : start ? `Start ${c.label}` : `Open ${c.label}`}
    </button>
  );
  const picker = (
    <div className="flex flex-col gap-4">
      <div>
        <div className="mb-1.5 text-xs font-medium text-ink">
          Start an agent on this task, in its own screen
        </div>
        <p className="mb-2 text-[12px] text-ink-3">
          It begins working at once and you watch it in its real terminal. This uses tokens. When it
          is done, press Verify and merge.
        </p>
        <div className="flex flex-wrap gap-2">
          {CLIS.filter((c) => c.cli !== 'shell').map((c) => choice(c, true))}
        </div>
      </div>
      <div>
        <div className="mb-1.5 text-xs font-medium text-ink">Or open one and do it yourself</div>
        <p className="mb-2 text-[12px] text-ink-3">
          The program opens idle and waits for you. Nothing is sent until you type.
        </p>
        <div className="flex flex-wrap gap-2">{CLIS.map((c) => choice(c, false))}</div>
      </div>
    </div>
  );

  if (!current) {
    return (
      <div className="flex flex-col gap-5">
        <p className="text-sm leading-relaxed text-ink-2">
          Work on this task in a real terminal. Puff stops the agent if it is running and opens the
          program you choose, with its own screen, in the task's working folder. The folder starts
          from the agent's last attempt, so you continue from there. When you are done, press{' '}
          <b className="font-medium text-ink">Verify and merge my changes</b>: Puff runs the
          project's tests on your work like it does for an agent, then merges it.
        </p>
        {picker}
        {opening && (
          <p className="inline-flex items-center gap-2 text-sm text-ink-3">
            <LoaderCircle className="size-4 animate-spin" /> Opening…
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {terms.map((t) => (
          <span
            key={t.info.id}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs',
              t.info.id === current.info.id
                ? 'border-brand/50 bg-brand/15 text-ink'
                : 'border-line bg-surface-2 text-ink-2',
            )}
          >
            <button onClick={() => setActive(t.info.id)} className="max-w-52 truncate">
              {t.info.title}
              {t.ended ? ' (ended)' : ''}
            </button>
            <button
              onClick={() => void closeTerminal(t.info.id)}
              aria-label="Close this terminal"
              className="text-ink-3 hover:text-ink"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <Menu
          compact
          label="Another"
          icon={<Plus className="size-3" />}
          items={[
            ...CLIS.filter((c) => c.cli !== 'shell').map((c) => ({
              label: `Start ${c.label} on the task`,
              hint: 'Uses tokens',
              onSelect: () => void open(c.cli, true),
            })),
            ...CLIS.map((c) => ({
              label: c.cli === 'shell' ? c.label : `Open ${c.label} and wait`,
              onSelect: () => void open(c.cli),
            })),
          ]}
        />
      </div>

      <div className="h-[56vh] min-h-72">
        <TerminalView key={current.info.id} id={current.info.id} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          disabled={landing}
          onClick={async () => {
            setLanding(true);
            setResult(undefined);
            try {
              setResult(await puff.landManualChanges(taskId));
              onLanded();
            } catch (err) {
              setResult({ status: 'failed', message: (err as Error).message });
            } finally {
              setLanding(false);
            }
          }}
          className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-brand to-brand-deep px-3.5 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
        >
          {landing ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <GitMerge className="size-4" />
          )}
          {landing ? 'Checking your changes…' : 'Verify and merge my changes'}
        </button>
        {current.info.cli !== 'shell' && !current.ended && (
          <button
            onClick={() =>
              // as a paste, so its lines stay in the input box; the person presses Enter when ready
              void puff.terminalWrite(current.info.id, `\x1b[200~${current.info.brief}\x1b[201~`)
            }
            title="Type what the task is and what was tried into the program's input. Nothing is sent until you press Enter."
            className="inline-flex items-center gap-2 rounded-xl border border-line-strong bg-surface-2 px-3 py-2 text-sm hover:bg-surface-3"
          >
            <StickyNote className="size-4" /> Paste task brief
          </button>
        )}
        <button
          onClick={() => void puff.openTaskFolder(taskId).catch(() => {})}
          className="inline-flex items-center gap-2 rounded-xl border border-line-strong bg-surface-2 px-3 py-2 text-sm hover:bg-surface-3"
        >
          <FolderOpen className="size-4" /> Open folder
        </button>
        <span
          className="min-w-0 truncate font-mono text-[11px] text-ink-3"
          title={current.info.cwd}
        >
          {current.info.cwd} · started from {current.info.startedFrom}
        </span>
      </div>
      {result && (
        <p
          role="status"
          className={cn(
            'rounded-xl border p-3 text-[13px] leading-snug',
            result.status === 'done'
              ? 'border-good/30 bg-good/10 text-good'
              : 'border-bad/30 bg-bad/10 text-bad',
          )}
        >
          {result.message}
        </p>
      )}
    </div>
  );
}

function AgentMini({ cli }: { cli: AgentName }) {
  return (
    <span
      className="inline-grid size-5 place-items-center rounded-md text-[9px] font-bold"
      style={{
        color: AGENT_META[cli].color,
        background: `color-mix(in oklab, ${AGENT_META[cli].color} 16%, transparent)`,
      }}
    >
      {AGENT_META[cli].short}
    </span>
  );
}
