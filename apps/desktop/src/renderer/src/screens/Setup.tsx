import { useState } from 'react';
import {
  Check,
  CircleAlert,
  Database,
  LoaderCircle,
  RefreshCw,
  TerminalSquare,
} from 'lucide-react';
import type { AgentCliStatus, SetupStatus } from '@puff/shared';
import { Mascot } from '@/components/Mascot';
import { cn } from '@/lib/cn';

/** What the agent list says: which CLIs Puff found on this computer. Shared by the setup and welcome screens. */
export function AgentChecklist({ agents }: { agents: AgentCliStatus[] }) {
  return (
    <ul className="flex flex-col gap-2 text-left">
      {agents.map((a) => (
        <li key={a.id} className="flex items-start gap-3 text-[13px] leading-snug">
          {a.installed ? (
            <Check className="mt-0.5 size-4 shrink-0 text-good" />
          ) : (
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
          )}
          <span className="min-w-0">
            <b className="font-medium text-ink-2">{a.command}</b>{' '}
            <span className="text-ink-3">
              {a.installed ? (a.version ?? 'installed') : 'not found. ' + a.installHint}
            </span>
          </span>
        </li>
      ))}
    </ul>
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
}: {
  status?: SetupStatus;
  onStart: () => Promise<void>;
  onRetry: () => Promise<void>;
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

        <div className="mt-6 w-full rounded-2xl border border-line bg-surface p-5 text-left">
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
                  'inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-brand to-brand-deep px-4 py-2 text-sm font-semibold text-white hover:brightness-110',
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
              className="inline-flex items-center gap-2 rounded-xl border border-line-strong bg-surface-2 px-4 py-2 text-sm font-medium hover:bg-surface-3 disabled:opacity-60"
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
          <div className="mt-4 w-full rounded-2xl border border-line bg-surface p-5">
            <div className="mb-3 flex items-center gap-2.5 text-sm font-medium">
              <TerminalSquare className="size-4 text-brand-soft" />
              Agent tools
            </div>
            <AgentChecklist agents={status.agents} />
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
