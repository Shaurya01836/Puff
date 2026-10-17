import { useEffect, useState } from 'react';
import { Check, CircleAlert, Database, LoaderCircle, LogIn, RefreshCw } from 'lucide-react';
import type { AgentCliStatus, AgentName, SetupStatus } from '@puff/shared';
import { Mascot } from '@/components/Mascot';
import { puff } from '@/lib/api';
import { cn } from '@/lib/cn';

/** What the agent list says: which CLIs Puff found, and whether they are signed in. Shared by the setup and welcome screens. */
export function AgentChecklist({
  agents,
  onChanged,
}: {
  agents: AgentCliStatus[];
  /** Called when a sign-in finished, so the caller can read the status again */
  onChanged?: () => void;
}) {
  return (
    <ul className="flex flex-col gap-2.5 text-left">
      {agents.map((a) => {
        const signedOut = a.installed && a.signedIn === 'signed-out';
        return (
          <li key={a.id} className="text-[13px] leading-snug">
            <div className="flex items-start gap-3">
              {a.installed && !signedOut ? (
                <Check className="mt-0.5 size-4 shrink-0 text-good" />
              ) : (
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
              )}
              <span className="min-w-0">
                <b className="font-medium text-ink-2">{a.command}</b>{' '}
                <span className="text-ink-3">
                  {!a.installed
                    ? 'not found. ' + a.installHint
                    : signedOut
                      ? 'installed, not signed in'
                      : `${a.version ?? 'installed'}${a.signedIn === 'signed-in' ? ', signed in' : ''}`}
                </span>
              </span>
            </div>
            {signedOut && a.canSignIn && <SignIn agent={a} onChanged={onChanged} />}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Sign in to an agent from here. The button starts the agent's own sign-in, which opens the browser on
 * the provider's page. If the page ends by showing a one-time code, it is pasted into the box below.
 */
function SignIn({ agent, onChanged }: { agent: AgentCliStatus; onChanged?: () => void }) {
  const [state, setState] = useState<'idle' | 'opening' | 'waiting'>('idle');
  const [url, setUrl] = useState<string>();
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string>();

  // The sign-in ends on its own (the browser step finished, or it gave up)
  useEffect(() => {
    if (state !== 'waiting') return;
    return puff.onEvent((e) => {
      if (e.type !== 'signin' || e.agent !== agent.id) return;
      setState('idle');
      if (e.ok) onChanged?.();
      else setProblem(e.message);
    });
  }, [state, agent.id, onChanged]);

  const start = async () => {
    setState('opening');
    setProblem(undefined);
    try {
      const started = await puff.startSignIn(agent.id as AgentName);
      setUrl(started.url);
      setState('waiting');
    } catch (err) {
      setProblem((err as Error).message);
      setState('idle');
    }
  };

  const send = async () => {
    const value = code.trim();
    if (!value) return;
    setCode('');
    try {
      await puff.submitSignInCode(value);
    } catch (err) {
      setProblem((err as Error).message);
    }
  };

  return (
    <div className="mt-2 ml-7">
      {state !== 'waiting' && (
        <button
          onClick={() => void start()}
          disabled={state === 'opening'}
          className="inline-flex items-center gap-1.5 rounded-sm border border-line-strong bg-surface-2 px-2.5 py-1 text-xs font-medium hover:bg-surface-3 disabled:opacity-60"
        >
          {state === 'opening' ? (
            <LoaderCircle className="size-3.5 animate-spin" />
          ) : (
            <LogIn className="size-3.5" />
          )}
          Sign in
        </button>
      )}
      {state === 'waiting' && (
        <div className="flex flex-col gap-2 rounded-md border border-line bg-surface-2/60 p-3 text-[12px] leading-snug text-ink-2">
          <p className="flex items-center gap-2">
            <LoaderCircle className="size-3.5 shrink-0 animate-spin text-brand" />
            Your browser opened. Approve the sign-in there.
          </p>
          {url && (
            <p className="text-ink-3">
              If it did not open, go to{' '}
              <a href={url} target="_blank" rel="noreferrer" className="break-all underline">
                the sign-in page
              </a>
              .
            </p>
          )}
          <p className="text-ink-3">If the page shows a one-time code, paste it here:</p>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="Code from the browser"
              aria-label="One-time sign-in code"
              className="min-w-0 flex-1 rounded-sm border border-line bg-abyss px-2.5 py-1 font-mono text-xs outline-none focus:border-brand/60"
            />
            <button
              type="submit"
              disabled={!code.trim()}
              className="rounded-sm bg-brand px-3 py-1 text-xs font-semibold text-abyss disabled:opacity-40"
            >
              Send
            </button>
          </form>
        </div>
      )}
      {problem && <p className="mt-1.5 text-[12px] text-bad">{problem}</p>}
    </div>
  );
}

/**
 * Shown when the database is not reachable (every first run of an installed app). Puff's memory lives in
 * FalkorDB; the one button here starts it in Docker, which only happens because the person pressed it.
 */
export function Setup({
  status,
  onStart,
  onRetry,
  onRefresh,
}: {
  status?: SetupStatus;
  onStart: () => Promise<void>;
  onRetry: () => Promise<void>;
  /** Read the status again (a sign-in finished) */
  onRefresh?: () => void;
}) {
  const [working, setWorking] = useState<'start' | 'retry'>();
  const [error, setError] = useState<string>();

  const run = (kind: 'start' | 'retry', action: () => Promise<void>) => async () => {
    setWorking(kind);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(undefined);
    }
  };

  const docker = status?.docker;
  return (
    <div className="grid h-full place-items-center overflow-auto p-10">
      <div className="flex w-full max-w-xl flex-col items-center text-center">
        <Mascot state={error ? 'worried' : 'idle'} size={84} />
        <h2 className="mt-5 font-display text-2xl font-semibold">One thing to set up</h2>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-2">
          Puff keeps its memory in <b className="font-medium text-ink">FalkorDB</b>, a graph
          database that runs on your computer. It is not running yet.
        </p>

        <div className="mt-6 w-full rounded-lg border border-line bg-surface p-5 text-left">
          <div className="flex items-center gap-2.5 text-sm font-medium">
            <Database className="size-4 text-brand-soft" />
            Database
            <span className="ml-auto font-mono text-[11px] text-ink-3">{status?.databaseUrl}</span>
          </div>
          {status?.databaseError && (
            <p className="mt-2 text-[12px] leading-snug whitespace-pre-wrap text-ink-3">
              {status.databaseError}
            </p>
          )}

          {docker === 'ready' && (
            <p className="mt-4 text-[13px] leading-snug text-ink-2">
              Docker is running. Puff can start the database for you in a container named{' '}
              <code className="font-mono text-xs">puff-falkordb</code>. The first time downloads the
              image, which can take a few minutes.
            </p>
          )}
          {docker === 'stopped' && (
            <p className="mt-4 text-[13px] leading-snug text-warn">
              Docker is installed but not running. Start Docker Desktop, wait until it says it is
              running, then press Try again.
            </p>
          )}
          {docker === 'missing' && (
            <p className="mt-4 text-[13px] leading-snug text-warn">
              Docker was not found. Install{' '}
              <a
                href="https://www.docker.com/products/docker-desktop/"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Docker Desktop
              </a>{' '}
              and start it, or run FalkorDB yourself and press Try again.
            </p>
          )}

          <div className="mt-4 flex flex-wrap gap-2.5">
            {docker === 'ready' && (
              <button
                onClick={run('start', onStart)}
                disabled={!!working}
                className={cn(
                  'inline-flex items-center gap-2 rounded-md bg-brand px-4 py-2 text-sm font-semibold text-abyss hover:bg-brand-soft',
                  'disabled:cursor-wait disabled:opacity-60',
                )}
              >
                {working === 'start' ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Database className="size-4" />
                )}
                {working === 'start' ? 'Starting the database…' : 'Start the database'}
              </button>
            )}
            <button
              onClick={run('retry', onRetry)}
              disabled={!!working}
              className="inline-flex items-center gap-2 rounded-md border border-line-strong bg-surface-2 px-4 py-2 text-sm font-medium hover:bg-surface-3 disabled:opacity-60"
            >
              {working === 'retry' ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Try again
            </button>
          </div>
          {error && (
            <p role="alert" className="mt-3 text-[13px] leading-snug whitespace-pre-wrap text-bad">
              {error}
            </p>
          )}
        </div>

        {status && (
          <div className="mt-4 w-full rounded-lg border border-line bg-surface p-5">
            <div className="mb-3 text-sm font-medium">Agent tools</div>
            <AgentChecklist agents={status.agents} onChanged={onRefresh} />
            <p className="mt-3 text-left text-[12px] leading-snug text-ink-3">
              Puff drives these command-line agents. You need at least one, signed in. You can
              explore the graph without any.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
