import { useState, type FormEvent } from 'react';
import { CornerDownLeft, Pause, Play, Sparkles } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Kbd, MockBadge } from './ui';

export function TopBar({
  title,
  subtitle,
  running,
  onToggleRun,
  onGoal,
  mock,
}: {
  title: string;
  subtitle: string;
  running: boolean;
  onToggleRun: () => void;
  onGoal: (goal: string) => Promise<void>;
  mock: boolean;
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
    <header className="flex items-center gap-6 border-b border-line bg-abyss/60 px-6 py-3.5 backdrop-blur">
      <div className="min-w-0">
        <h1 className="font-display text-lg leading-tight font-semibold tracking-tight">{title}</h1>
        <p className="truncate text-xs text-ink-3">{subtitle}</p>
      </div>

      <form
        onSubmit={submit}
        className="group mx-auto flex h-10 w-full max-w-xl items-center gap-2.5 rounded-xl border border-line bg-surface px-3 transition-colors focus-within:border-brand/60 focus-within:shadow-[0_0_0_4px_rgb(139_124_246/0.12)]"
      >
        <Sparkles className="size-4 shrink-0 text-brand-soft" />
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Give the team a goal, e.g. “Add rate limiting to login and update docs”"
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
          aria-label="New goal"
        />
        <Kbd>
          <CornerDownLeft className="inline size-3" />
        </Kbd>
      </form>

      <div className="flex shrink-0 items-center gap-3">
        {mock && <MockBadge />}
        <button
          onClick={onToggleRun}
          className={cn(
            'inline-flex h-10 items-center gap-2 rounded-xl px-4 text-sm font-semibold transition-all',
            running
              ? 'border border-line-strong bg-surface-2 text-ink hover:bg-surface-3'
              : 'bg-gradient-to-br from-brand to-brand-deep text-white shadow-[0_6px_20px_-6px_rgb(139_124_246/0.7)] hover:brightness-110',
          )}
        >
          {running ? <Pause className="size-4" /> : <Play className="size-4 fill-current" />}
          {running ? 'Pause team' : 'Run team'}
        </button>
      </div>
    </header>
  );
}
