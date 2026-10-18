import { useState, type FormEvent } from 'react';
import { CornerDownLeft, MessageSquare, Pause, Play, Plus, Square } from 'lucide-react';
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
        <h1 className="truncate font-display text-base font-bold tracking-tight text-ink">
          {title}
        </h1>
        <p className="hidden truncate text-[0.6875rem] text-ink-2 xl:block">{subtitle}</p>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2.5">
        {badge && (
          <span className="hidden xl:inline-flex">
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
              ? 'border-brand/40 bg-brand/10 text-ink'
              : 'border-line bg-surface text-ink hover:bg-surface-3 hover:text-ink',
          )}
        >
          <MessageSquare className="size-3.5" />
          <span className="hidden xl:inline">Ask Puff</span>
        </button>
        <button
          onClick={onNewTask}
          className="inline-flex h-8 items-center gap-1.5 bg-brand px-3 text-xs font-semibold text-abyss transition-colors hover:bg-brand-soft"
        >
          <Plus className="size-3.5" />
          New task
        </button>
        {running && onPause && (
          <button
            onClick={onPause}
            disabled={pausing}
            title="Let the running tasks finish, then stop. Nothing new starts."
            className="inline-flex h-8 items-center gap-1.5 border border-line-strong bg-surface px-3 text-xs font-medium text-ink transition-colors hover:bg-surface-3 hover:text-ink disabled:cursor-default disabled:opacity-60"
          >
            <Pause className="size-3.5" />
            <span className="hidden xl:inline">{pausing ? 'Pausing…' : 'Pause after current'}</span>
          </button>
        )}
        <button
          onClick={onToggleRun}
          disabled={!!runBlockedReason}
          title={runBlockedReason ? `Can't run yet: ${runBlockedReason}` : undefined}
          className={cn(
            'disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none',
            'inline-flex h-8 items-center gap-1.5 px-3.5 text-xs font-semibold transition-colors',
            running
              ? 'border border-line bg-surface-3 text-ink hover:bg-line-strong'
              : 'bg-brand text-abyss hover:bg-brand-soft',
          )}
        >
          {running ? <Square className="size-3.5" /> : <Play className="size-3.5 fill-current" />}
          {running ? 'Stop now' : 'Run team'}
        </button>
      </div>
    </header>
  );
}
