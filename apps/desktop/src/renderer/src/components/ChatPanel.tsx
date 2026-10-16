import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Check,
  CircleX,
  CornerDownLeft,
  LoaderCircle,
  LogIn,
  Play,
  RotateCcw,
  Sparkles,
  Terminal,
  X,
} from 'lucide-react';
import {
  matchCommands,
  type AgentName,
  type ChatInfo,
  type ChatMessage,
  type TeamEvent,
} from '@puff/shared';
import { Team } from '@/screens/Team';
import { cn } from '@/lib/cn';
import { formatTokens } from '@/lib/theme';
import { PuffMark } from './landing/puff-logo';

const SUGGESTIONS = [
  'What is on the board?',
  '/status',
  'Add a goal: write tests for the cart totals',
  '/help',
];

/** The conversation with the orchestrator: slash commands answer at once, sentences go to the agent. */
export function ChatPanel({
  open = true,
  messages,
  info,
  busy,
  error,
  onSend,
  onApprove,
  onReset,
  onSetAgent,
  onClose,
  tab,
  onTab,
  team,
  onOpenTask,
  teamBusy,
}: {
  open?: boolean;
  messages: ChatMessage[];
  info?: ChatInfo;
  busy: boolean;
  error?: string;
  onSend: (text: string) => void;
  onApprove: (approvalId: string, approve: boolean) => void;
  onReset: () => void;
  /** Talk to a different agent */
  onSetAgent: (agent: AgentName) => void;
  onClose: () => void;
  /** Which half of the panel shows: the conversation, or what the team has been doing */
  tab: 'chat' | 'team';
  onTab: (tab: 'chat' | 'team') => void;
  team?: TeamEvent[];
  onOpenTask: (taskId: string) => void;
  /** Agents are working right now (a pulse on the Team tab) */
  teamBusy: boolean;
}) {
  const [text, setText] = useState('');
  const [pick, setPick] = useState(0);
  const messagesBoxRef = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  // Auto-focus without causing any scroll jumps or shakes
  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => {
        input.current?.focus({ preventScroll: true });
      }, 200);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // Press Esc to dismiss smoothly
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // Scroll ONLY the internal messages box, never trigger ancestor or window scrolling
  useEffect(() => {
    if (open && messagesBoxRef.current) {
      messagesBoxRef.current.scrollTop = messagesBoxRef.current.scrollHeight;
    }
  }, [messages.length, busy, open]);

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
    input.current?.focus({ preventScroll: true });
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
      aria-label="Ask Puff and the team"
      aria-hidden={!open}
      style={{
        willChange: 'transform',
        contain: 'paint layout',
      }}
      className={cn(
        'absolute top-0 right-0 bottom-0 z-40 flex w-[390px] sm:w-[410px] max-w-[calc(100vw-4rem)] flex-col',
        'border-l border-line-strong bg-surface/95 backdrop-blur-2xl',
        'shadow-[-20px_0_50px_rgba(0,0,0,0.7)]',
        'transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)]',
        open
          ? 'translate-x-0 pointer-events-auto visible'
          : 'translate-x-full pointer-events-none invisible',
      )}
    >
      {/* Top Header */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-surface-2/60 px-4 select-none">
        <div className="shrink-0">
          <PuffMark className="size-6 shrink-0" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-display text-xs font-bold tracking-tight text-white">
              Ask Puff
            </span>
            <span className="inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/15 px-1.5 py-0.2 font-mono text-[9px] font-semibold uppercase tracking-wider text-emerald-400">
              <span className="size-1 rounded-full bg-emerald-400 animate-pulse-dot" />
              Agent
            </span>
          </div>
          <div className="flex items-center gap-1.5 truncate font-mono text-[10px] text-slate-400">
            <span>Talking to</span>
            {info?.choices && info.agent && tab === 'chat' ? (
              <select
                value={info.agent}
                onChange={(e) => onSetAgent(e.target.value as AgentName)}
                disabled={busy}
                aria-label="Which agent answers"
                title="Which agent answers in Ask Puff. Changing it starts a new conversation."
                className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[10px] text-slate-200 outline-none focus:border-emerald-500/60 disabled:opacity-50"
              >
                {info.choices.map((c) => (
                  <option key={c.id} value={c.id} disabled={!c.installed}>
                    {c.label}
                    {c.installed ? '' : ' (not installed)'}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-slate-200">{info?.brain ?? 'your agent'}</span>
            )}
            {info?.autoApprove ? <span>· auto-run enabled</span> : null}
          </div>
        </div>

        <div className="flex items-center gap-1">
          {tab === 'chat' && (
            <button
              onClick={onReset}
              title="Start a new conversation"
              aria-label="New conversation"
              className="rounded border border-line bg-surface p-1.5 text-slate-400 hover:border-slate-600 hover:bg-surface-3 hover:text-white transition-colors"
            >
              <RotateCcw className="size-3.5" />
            </button>
          )}
          <button
            onClick={onClose}
            title="Close panel (Esc)"
            aria-label="Close chat"
            className="rounded border border-line bg-surface p-1.5 text-slate-400 hover:border-slate-600 hover:bg-surface-3 hover:text-white transition-colors"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </header>

      {/* Tabs */}
      <div
        role="tablist"
        aria-label="Panel"
        className="flex gap-1 border-b border-line bg-surface-2/40 px-4"
      >
        {(
          [
            ['chat', 'Ask Puff'],
            ['team', 'Team'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => onTab(id)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-xs font-medium transition-colors',
              tab === id
                ? 'border-emerald-400 text-white font-semibold'
                : 'border-transparent text-slate-400 hover:text-slate-200',
            )}
          >
            {label}
            {id === 'team' && teamBusy && (
              <span className="ml-1.5 inline-block size-1.5 animate-pulse rounded-full bg-emerald-400 align-middle" />
            )}
          </button>
        ))}
      </div>

      {tab === 'team' && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Team compact events={team} onOpenTask={onOpenTask} />
        </div>
      )}

      {tab === 'chat' && info && (!info.ready || info.needsSignIn) && (
        <div className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 font-mono text-[11px] leading-snug text-amber-300">
          <p>{info.note ?? `${info.brain} is not available.`}</p>
          {info.needsSignIn && (
            <button
              onClick={() => onSend('/login')}
              disabled={busy}
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-amber-500/20 px-2.5 py-1 text-xs font-semibold text-amber-300 hover:bg-amber-500/30 disabled:opacity-50"
            >
              <LogIn className="size-3.5" />
              Sign in
            </button>
          )}
        </div>
      )}

      {/* Messages Feed */}
      {tab === 'chat' && (
        <div
          ref={messagesBoxRef}
          className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
          aria-live="polite"
        >
          {messages.length === 0 && !busy ? (
            <div className="flex h-full flex-col justify-center gap-5 px-1">
              <div className="rounded-xl border border-line bg-surface-2/60 p-4">
                <div className="flex items-center gap-2 text-xs font-semibold text-white">
                  <Sparkles className="size-3.5 text-emerald-400" />
                  Orchestrate your team
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-300">
                  Tell Puff what you want in plain words. It coordinates Claude Code, Codex, and
                  OpenCode, writes goals, and reviews graph diffs.
                </p>
                <p className="mt-2 font-mono text-[11px] text-slate-400">
                  Start with <b className="font-semibold text-emerald-400">/</b> for instant
                  zero-token commands.
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-slate-400">
                  <Terminal className="size-3 text-emerald-400" />
                  Suggested prompts
                </div>
                <div className="grid grid-cols-1 gap-1.5">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => (s.startsWith('/') ? send(s) : setText(s))}
                      className="group flex items-center justify-between rounded-lg border border-line bg-surface-2 px-3 py-2 text-left text-xs text-slate-300 hover:border-emerald-500/40 hover:bg-surface-3 hover:text-white transition-all"
                    >
                      <span
                        className={cn(
                          s.startsWith('/') ? 'font-mono text-emerald-400' : 'text-slate-200',
                        )}
                      >
                        {s}
                      </span>
                      <CornerDownLeft className="size-3 text-slate-500 opacity-0 group-hover:opacity-100 transition-opacity" />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <ol className="flex flex-col gap-3">
              {messages.map((m) => (
                <li key={m.id} className="animate-fade-in">
                  <Bubble message={m} onApprove={onApprove} />
                </li>
              ))}
              {busy && (
                <li className="flex items-center gap-2 rounded-lg border border-line bg-surface-2/50 px-3 py-2 text-xs text-slate-400">
                  <LoaderCircle className="size-3.5 animate-spin text-emerald-400" />
                  <span>Orchestrating agent run…</span>
                </li>
              )}
            </ol>
          )}
          {error && <p className="mt-3 font-mono text-xs text-red-400">{error}</p>}
        </div>
      )}

      {/* Input Dock */}
      {tab === 'chat' && (
        <div className="relative border-t border-line bg-surface-2/80 p-3 backdrop-blur-md">
          {completions.length > 0 && (
            <ul
              role="listbox"
              aria-label="Commands"
              className="absolute right-3 bottom-full left-3 mb-2 max-h-60 overflow-y-auto rounded-xl border border-line-strong bg-surface p-1.5 shadow-[0_20px_50px_rgba(0,0,0,0.9)]"
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
                      'flex w-full items-baseline gap-3 rounded-lg px-2.5 py-1.5 text-left transition-colors',
                      i === pick ? 'bg-surface-3' : 'hover:bg-surface-2',
                    )}
                  >
                    <span className="font-mono text-xs font-semibold text-emerald-400">
                      {c.usage}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[11px] text-slate-300">
                      {c.summary}
                    </span>
                    {c.spends && (
                      <span className="font-mono text-[9px] uppercase tracking-wider text-amber-400">
                        tokens
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="rounded-xl border border-line-strong bg-surface p-2.5 transition-all focus-within:border-emerald-500/60 focus-within:ring-1 focus-within:ring-emerald-500/20">
            <textarea
              ref={input}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKey}
              rows={Math.min(5, Math.max(1, text.split('\n').length))}
              placeholder="Ask Puff anything, or type / for commands..."
              aria-label="Message"
              className="max-h-32 min-h-10 w-full resize-none bg-transparent font-sans text-xs text-slate-100 outline-none placeholder:text-slate-500"
            />
            <div className="mt-1 flex items-center justify-between border-t border-line/60 pt-2">
              <div className="flex items-center gap-2 font-mono text-[10px] text-slate-500">
                <span>↵ to send</span>
                <span>·</span>
                <span>/ for commands</span>
                <span>·</span>
                <span>Esc to close</span>
              </div>
              <button
                onClick={() => send()}
                disabled={!text.trim() || busy}
                aria-label="Send"
                className="grid size-6 shrink-0 place-items-center rounded bg-emerald-500 text-slate-950 transition-all hover:bg-emerald-400 disabled:opacity-30 disabled:hover:bg-emerald-500"
              >
                <CornerDownLeft className="size-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
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
      <div className="ml-8 flex flex-col items-end">
        <div className="rounded-xl rounded-br-xs border border-emerald-500/30 bg-emerald-950/40 px-3.5 py-2.5 text-xs leading-relaxed text-emerald-100 shadow-sm backdrop-blur-sm whitespace-pre-wrap">
          {m.text}
        </div>
        <span className="mt-1 font-mono text-[9px] uppercase tracking-wider text-slate-500">
          You
        </span>
      </div>
    );
  }

  if (m.role === 'assistant') {
    return (
      <div className="mr-6 flex flex-col items-start">
        <div className="mb-1 flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wider text-slate-400">
          <span className="size-1 rounded-full bg-emerald-400" />
          Puff Orchestrator
        </div>
        <div className="rounded-xl rounded-bl-xs border border-line-strong bg-surface-2 px-3.5 py-2.5 text-xs leading-relaxed text-slate-200 shadow-sm whitespace-pre-wrap">
          {m.text}
        </div>
        {m.tokens && (
          <div className="mt-1 font-mono text-[9px] text-slate-500 tabular-nums">
            ⚡ {formatTokens(m.tokens.in + m.tokens.out)} tokens used
          </div>
        )}
      </div>
    );
  }

  if (m.role === 'action') {
    return (
      <div
        className={cn(
          'flex items-start gap-2 rounded-lg border px-3 py-2 font-mono text-xs leading-snug',
          m.ok === false
            ? 'border-red-500/30 bg-red-950/20 text-red-300'
            : 'border-emerald-500/30 bg-emerald-950/20 text-emerald-300',
        )}
      >
        {m.ok === false ? (
          <CircleX className="mt-0.5 size-3.5 shrink-0 text-red-400" />
        ) : (
          <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-400" />
        )}
        <span className="min-w-0 break-words">{m.text}</span>
      </div>
    );
  }

  if (m.role === 'approval' && m.approval) {
    const a = m.approval;
    return (
      <div className="rounded-xl border border-emerald-500/30 bg-surface-2 p-3.5 shadow-lg">
        <div className="flex items-center gap-2 text-xs font-semibold text-white">
          <span className="grid size-5 place-items-center rounded bg-emerald-500/20 text-emerald-400">
            <Play className="size-3 fill-current" />
          </span>
          {m.text}
        </div>
        <p className="mt-2 font-mono text-xs leading-snug text-slate-300">{a.summary}</p>
        {a.state === 'pending' ? (
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => onApprove(a.id, true)}
              className="flex-1 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 transition-colors"
            >
              Approve & Run
            </button>
            <button
              onClick={() => onApprove(a.id, false)}
              className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-surface-3 transition-colors"
            >
              Decline
            </button>
          </div>
        ) : (
          <p className="mt-2 font-mono text-[10px] uppercase tracking-wider text-slate-500">
            {a.state === 'approved' ? '✓ Run approved' : '✕ Run declined'}
          </p>
        )}
      </div>
    );
  }

  // system: a slash command's answer, or a problem
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 font-mono text-xs leading-relaxed',
        m.ok === false
          ? 'border-amber-500/30 bg-amber-950/20 text-amber-300'
          : 'border-line bg-abyss text-slate-300',
      )}
    >
      <Terminal className="mr-1.5 mb-0.5 inline size-3 text-slate-500" />
      <span className="whitespace-pre-wrap">{m.text}</span>
    </div>
  );
}
