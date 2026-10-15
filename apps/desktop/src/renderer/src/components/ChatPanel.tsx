import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Check,
  CircleX,
  CornerDownLeft,
  LoaderCircle,
  LogIn,
  MessageSquare,
  Play,
  RotateCcw,
  Terminal,
  X,
} from 'lucide-react';
import { matchCommands, type ChatInfo, type ChatMessage } from '@puff/shared';
import { cn } from '@/lib/cn';
import { formatTokens } from '@/lib/theme';

const SUGGESTIONS = [
  'What is on the board?',
  '/status',
  'Add a goal: write tests for the cart totals',
  '/help',
];

/** The conversation with the orchestrator: slash commands answer at once, sentences go to the agent. */
export function ChatPanel({
  messages,
  info,
  busy,
  error,
  onSend,
  onApprove,
  onReset,
  onClose,
}: {
  messages: ChatMessage[];
  info?: ChatInfo;
  busy: boolean;
  error?: string;
  onSend: (text: string) => void;
  onApprove: (approvalId: string, approve: boolean) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [pick, setPick] = useState(0);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, busy]);

  // Offer the commands while the first word starts with a slash
  const typing = /^\s*\/[a-z]*$/i.test(text);
  const completions = useMemo(() => (typing ? matchCommands(text.trim()) : []), [typing, text]);
  useEffect(() => {
    setPick(0);
  }, [text]);

  const send = (value = text) => {
    const said = value.trim();
    if (!said || busy) return;
    setText('');
    onSend(said);
  };

  const complete = (name: string) => {
    setText(`/${name} `);
    input.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (completions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        return setPick((p) => (p + 1) % completions.length);
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        return setPick((p) => (p - 1 + completions.length) % completions.length);
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        return complete(completions[pick]!.name);
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        const chosen = completions[pick]!;
        e.preventDefault();
        // A command that needs no argument runs at once; one that needs an argument is completed first
        return chosen.usage === `/${chosen.name}` ? send(`/${chosen.name}`) : complete(chosen.name);
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <aside
      aria-label="Ask Puff"
      className="flex h-full w-[400px] shrink-0 animate-slide-in flex-col border-l border-line-strong bg-surface"
    >
      <header className="flex items-center gap-3 border-b border-line px-5 py-3.5">
        <span className="grid size-8 place-items-center rounded-lg bg-brand/15 text-brand-soft">
          <MessageSquare className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-display text-sm font-semibold">Ask Puff</div>
          <div className="truncate text-[11px] text-ink-3">
            {info ? `Orchestrator: ${info.brain}` : 'Orchestrator'}
            {info?.autoApprove ? ' · runs start without asking' : ''}
          </div>
        </div>
        <button
          onClick={onReset}
          title="Start a new conversation"
          aria-label="New conversation"
          className="rounded-lg p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink"
        >
          <RotateCcw className="size-4" />
        </button>
        <button
          onClick={onClose}
          aria-label="Close chat"
          className="rounded-lg p-1.5 text-ink-3 hover:bg-surface-3 hover:text-ink"
        >
          <X className="size-4" />
        </button>
      </header>

      {info && (!info.ready || info.needsSignIn) && (
        <div className="border-b border-warn/20 bg-warn/10 px-5 py-2.5 text-[12px] leading-snug text-warn">
          <p>{info.note ?? `${info.brain} is not available.`}</p>
          {info.needsSignIn && (
            <button
              onClick={() => onSend('/login')}
              disabled={busy}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-warn/20 px-2.5 py-1 text-xs font-semibold text-warn hover:bg-warn/30 disabled:opacity-50"
            >
              <LogIn className="size-3.5" />
              Sign in
            </button>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-live="polite">
        {messages.length === 0 && !busy ? (
          <div className="flex h-full flex-col justify-center gap-3 px-2">
            <p className="text-sm leading-relaxed text-ink-2">
              Tell Puff what you want, in plain words. It adds tasks and goals, retries failures and
              looks things up. Running the team always asks you first, because it spends tokens.
            </p>
            <p className="text-[12px] text-ink-3">
              Start with <b className="font-medium text-ink-2">/</b> for instant commands that cost
              nothing.
            </p>
            <div className="mt-1 flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => (s.startsWith('/') ? send(s) : setText(s))}
                  className="rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-left text-xs text-ink-2 hover:border-line-strong hover:text-ink"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <ol className="flex flex-col gap-2.5">
            {messages.map((m) => (
              <li key={m.id} className="animate-fade-in">
                <Bubble message={m} onApprove={onApprove} />
              </li>
            ))}
            {busy && (
              <li className="flex items-center gap-2 px-1 text-xs text-ink-3">
                <LoaderCircle className="size-3.5 animate-spin" />
                Working on it…
              </li>
            )}
          </ol>
        )}
        {error && <p className="mt-3 text-sm text-bad">{error}</p>}
        <div ref={end} />
      </div>

      <div className="relative border-t border-line p-3">
        {completions.length > 0 && (
          <ul
            role="listbox"
            aria-label="Commands"
            className="absolute right-3 bottom-full left-3 mb-2 max-h-64 overflow-y-auto rounded-xl border border-line-strong bg-surface p-1.5 shadow-[0_20px_50px_-15px_rgb(0_0_0/0.9)]"
          >
            {completions.map((c, i) => (
              <li key={c.name}>
                <button
                  role="option"
                  aria-selected={i === pick}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    complete(c.name);
                  }}
                  className={cn(
                    'flex w-full items-baseline gap-3 rounded-lg px-2.5 py-1.5 text-left',
                    i === pick ? 'bg-surface-3' : 'hover:bg-surface-2',
                  )}
                >
                  <span className="font-mono text-xs text-brand-soft">{c.usage}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-ink-3">
                    {c.summary}
                  </span>
                  {c.spends && <span className="text-[10px] text-warn">tokens</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 focus-within:border-brand/60">
          <textarea
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            rows={Math.min(5, Math.max(1, text.split('\n').length))}
            placeholder="Ask, or type / for commands"
            aria-label="Message"
            className="max-h-32 min-h-6 flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-ink-3"
          />
          <button
            onClick={() => send()}
            disabled={!text.trim() || busy}
            aria-label="Send"
            className="grid size-7 shrink-0 place-items-center rounded-lg bg-brand text-white disabled:opacity-40"
          >
            <CornerDownLeft className="size-3.5" />
          </button>
        </div>
      </div>
    </aside>
  );
}

function Bubble({
  message: m,
  onApprove,
}: {
  message: ChatMessage;
  onApprove: (approvalId: string, approve: boolean) => void;
}) {
  if (m.role === 'user') {
    return (
      <div className="ml-8 rounded-2xl rounded-br-md bg-brand/20 px-3.5 py-2.5 text-sm leading-snug whitespace-pre-wrap text-ink">
        {m.text}
      </div>
    );
  }

  if (m.role === 'assistant') {
    return (
      <div className="mr-4">
        <div className="rounded-2xl rounded-bl-md border border-line bg-surface-2 px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap text-ink">
          {m.text}
        </div>
        {m.tokens && (
          <div className="mt-1 px-1 text-[10px] text-ink-3 tabular-nums">
            {formatTokens(m.tokens.in + m.tokens.out)} tokens
          </div>
        )}
      </div>
    );
  }

  if (m.role === 'action') {
    return (
      <div
        className={cn(
          'flex items-start gap-2 rounded-lg border px-3 py-2 text-[12px] leading-snug',
          m.ok === false
            ? 'border-bad/25 bg-bad/5 text-bad'
            : 'border-line bg-surface-2/60 text-ink-2',
        )}
      >
        {m.ok === false ? (
          <CircleX className="mt-0.5 size-3.5 shrink-0" />
        ) : (
          <Check className="mt-0.5 size-3.5 shrink-0 text-good" />
        )}
        <span className="min-w-0 break-words">{m.text}</span>
      </div>
    );
  }

  if (m.role === 'approval' && m.approval) {
    const a = m.approval;
    return (
      <div className="rounded-xl border border-brand/30 bg-brand/10 p-3.5">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Play className="size-3.5 text-brand-soft" />
          {m.text}
        </div>
        <p className="mt-1 text-[12px] leading-snug text-ink-2">{a.summary}</p>
        {a.state === 'pending' ? (
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => onApprove(a.id, true)}
              className="rounded-lg bg-gradient-to-br from-brand to-brand-deep px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110"
            >
              Run now
            </button>
            <button
              onClick={() => onApprove(a.id, false)}
              className="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-ink-2 hover:bg-surface-3"
            >
              Not now
            </button>
          </div>
        ) : (
          <p className="mt-2 text-[11px] text-ink-3">
            {a.state === 'approved' ? 'You approved this run.' : 'You declined this run.'}
          </p>
        )}
      </div>
    );
  }

  // system: a slash command's answer, or a problem
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2.5 text-[12px] leading-relaxed',
        m.ok === false
          ? 'border-warn/25 bg-warn/5 text-warn'
          : 'border-line bg-abyss/50 text-ink-2',
      )}
    >
      <Terminal className="mr-1.5 mb-0.5 inline size-3 opacity-60" />
      <span className="font-mono whitespace-pre-wrap">{m.text}</span>
    </div>
  );
}
