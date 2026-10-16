import { useState, type FormEvent } from 'react';
import { CornerDownLeft, MessageSquare, Pause, Play, Plus, Sparkles, Square } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Kbd, MockBadge } from './ui';

export function TopBar({
  title,
  subtitle,
  running,
  onToggleRun,
  onPause,
  pausing,
  onGoal,
  onNewTask,
  chatOpen,
  onToggleChat,
  badge,
  runBlockedReason,
}: {
  title: string;
  subtitle: string;
  running: boolean;
  onToggleRun: () => void;
  /** Finish what is running and start nothing new */
  onPause?: () => void;
  pausing?: boolean;
  onGoal: (goal: string) => Promise<void>;
  onNewTask: () => void;
  chatOpen: boolean;
  onToggleChat: () => void;
  badge?: string;
  /** When set, the run button is disabled and this explains why */
  runBlockedReason?: string;
}) {
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = goal.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await onGoal(text);
      setGoal('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="flex items-center gap-3 border-b border-line bg-surface-2 px-5 py-2.5">
      <div className="w-36 shrink-0 xl:w-56">
        <h1 className="truncate font-display text-base font-bold tracking-tight text-white">
          {title}
        </h1>
        <p className="hidden truncate text-[11px] text-slate-400 xl:block">{subtitle}</p>
      </div>

      <form
        onSubmit={submit}
        className="group mx-auto flex h-9 min-w-40 flex-1 items-center gap-2 border border-line bg-surface px-3 transition-colors focus-within:border-emerald-500/60 lg:max-w-lg"
      >
        <Sparkles className="size-3.5 shrink-0 text-emerald-400" />
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Give the team a goal, e.g. “Add rate limiting to login and update docs”"
          className="min-w-0 flex-1 bg-transparent font-sans text-xs text-slate-200 outline-none placeholder:text-slate-500"
          aria-label="New goal"
        />
        <Kbd>
          <CornerDownLeft className="inline size-3" />
        </Kbd>
      </form>

      <div className="flex shrink-0 items-center gap-2.5">
        {badge && (
          <span className="hidden lg:inline-flex">
            <MockBadge label={badge} />
          </span>
        )}
        <button
          onClick={onToggleChat}
          aria-pressed={chatOpen}
          title="Talk to Puff (Ctrl+K)"
          aria-label="Ask Puff"
          className={cn(
            'inline-flex h-8 items-center gap-1.5 border px-3 text-xs font-medium transition-colors',
            chatOpen
              ? 'border-emerald-500/50 bg-emerald-500/15 text-white'
              : 'border-line bg-surface text-slate-300 hover:bg-surface-3 hover:text-white',
          )}
        >
          <MessageSquare className="size-3.5" />
          <span className="hidden lg:inline">Ask Puff</span>
        </button>
        <button
          onClick={onNewTask}
          className="inline-flex h-8 items-center gap-1.5 bg-white px-3 text-xs font-semibold text-slate-950 transition-opacity hover:opacity-90"
        >
          <Plus className="size-3.5" />
          New task
        </button>
        {running && onPause && (
          <button
            onClick={onPause}
            disabled={pausing}
            title="Let the running tasks finish, then stop. Nothing new starts."
            className="inline-flex h-8 items-center gap-1.5 border border-line-strong bg-surface px-3 text-xs font-medium text-slate-300 transition-colors hover:bg-surface-3 hover:text-white disabled:cursor-default disabled:opacity-60"
          >
            <Pause className="size-3.5" />
            <span className="hidden lg:inline">{pausing ? 'Pausing…' : 'Pause after current'}</span>
          </button>
        )}
        <button
          onClick={onToggleRun}
          disabled={!!runBlockedReason}
          title={runBlockedReason ? `Can't run yet: ${runBlockedReason}` : undefined}
          className={cn(
            'disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none',
            'inline-flex h-8 items-center gap-1.5 px-3.5 text-xs font-semibold transition-all',
            running
              ? 'border border-line bg-surface-3 text-white hover:bg-line-strong'
              : 'bg-emerald-500 text-slate-950 hover:bg-emerald-400',
          )}
        >
          {running ? <Square className="size-3.5" /> : <Play className="size-3.5 fill-current" />}
          {running ? 'Stop now' : 'Run team'}
        </button>
      </div>
    </header>
  );
}
