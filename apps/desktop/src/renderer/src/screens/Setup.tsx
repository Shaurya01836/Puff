import { useEffect, useState } from 'react';
import {
  Check,
  CircleAlert,
  Cloud,
  Container,
  Database,
  ExternalLink,
  LoaderCircle,
  LogIn,
  RefreshCw,
} from 'lucide-react';
import type { AgentCliStatus, AgentName, ConnectMode, SetupStatus } from '@puff/shared';
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
          <li key={a.id} className="text-[0.8125rem] leading-snug">
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
 * Sign in to an agent from here.
 */
function SignIn({ agent, onChanged }: { agent: AgentCliStatus; onChanged?: () => void }) {
  const [state, setState] = useState<'idle' | 'opening' | 'waiting'>('idle');
  const [url, setUrl] = useState<string>();
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string>();

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
          className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface-2 px-2.5 py-1 text-xs font-medium hover:bg-surface-3 disabled:opacity-60"
        >
          {state === 'opening' ? <LoaderCircle className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />}
          Sign in
        </button>
      )}
      {state === 'waiting' && (
        <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface-2/60 p-3 text-[0.75rem] leading-snug text-ink-2">
          <p className="flex items-center gap-2">
            <LoaderCircle className="size-3.5 shrink-0 animate-spin text-info" />
            Your browser opened. Approve the sign-in there.
          </p>
          {url && (
            <p className="text-ink-3">
              If it did not open, go to{' '}
              <a href={url} target="_blank" rel="noreferrer" className="break-all underline">the sign-in page</a>.
            </p>
          )}
          <p className="text-ink-3">If the page shows a one-time code, paste it here:</p>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
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
              className="rounded-lg bg-brand px-3 py-1 text-xs font-semibold text-white disabled:opacity-40"
            >
              Send
            </button>
          </form>
        </div>
      )}
      {problem && <p className="mt-1.5 text-[0.75rem] text-bad">{problem}</p>}
    </div>
  );
}

/** One selectable connection-mode card */
function ModeCard({
  id, selected, icon: Icon, title, description, badge, onSelect,
}: {
  id: ConnectMode;
  selected: boolean;
  icon: React.ElementType;
  title: string;
  description: string;
  badge?: string;
  onSelect: (id: ConnectMode) => void;
}) {
  return (
    <button
      type="button"
      id={`connect-mode-${id}`}
      onClick={() => onSelect(id)}
      className={cn(
        'relative flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-all',
        selected ? 'border-brand/60 bg-brand/10 ring-1 ring-brand/30' : 'border-line bg-surface-2 hover:border-line-strong hover:bg-surface-3',
      )}
    >
      <div className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg', selected ? 'bg-brand/20 text-brand' : 'bg-surface-3 text-ink-3')}>
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink">{title}</span>
          {badge && <span className="rounded-full bg-brand/20 px-2 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wide text-brand">{badge}</span>}
        </div>
        <p className="mt-0.5 text-[0.75rem] leading-snug text-ink-3">{description}</p>
      </div>
      <div className={cn('mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors', selected ? 'border-brand bg-brand' : 'border-line-strong')}>
        {selected && <Check className="size-3 text-white" strokeWidth={3} />}
      </div>
    </button>
  );
}

/**
 * Shown when the database is not reachable. Presents three connection options:
 * local Docker, own FalkorDB Cloud URL, or the hosted demo instance.
 */
export function Setup({
  status, onStart, onRetry, onRefresh, canClose, onClose,
}: {
  status?: SetupStatus;
  onStart: () => Promise<void>;
  onRetry: () => Promise<void>;
  onRefresh?: () => void;
  canClose?: boolean;
  onClose?: () => void;
}) {
  const [mode, setMode] = useState<ConnectMode>('docker');
  const [cloudUrl, setCloudUrl] = useState('');
  const [working, setWorking] = useState<'connect' | 'retry'>();
  const [error, setError] = useState<string>();

  const docker = status?.docker;

  const handleConnect = async () => {
    setWorking('connect');
    setError(undefined);
    try {
      if (mode === 'docker') {
        await onStart();
      } else {
        await puff.connectToCloud(mode, mode === 'own-cloud' ? cloudUrl.trim() : undefined);
      }
      onClose?.();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(undefined);
    }
  };

  const handleRetry = async () => {
    setWorking('retry');
    setError(undefined);
    try {
      await onRetry();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(undefined);
    }
  };

  const canConnect =
    mode === 'docker' ? docker === 'ready'
    : mode === 'demo-cloud' ? true
    : cloudUrl.trim().length > 0;

  const connectLabel =
    working === 'connect' ? 'Connecting...'
    : mode === 'docker' ? (docker === 'ready' ? 'Start the database' : 'Start Docker first')
    : mode === 'demo-cloud' ? 'Connect to demo'
    : 'Connect';

  return (
    <div className="relative grid h-full place-items-center overflow-auto p-10">
      {canClose && (
        <button
          type="button"
          onClick={onClose}
          className="absolute top-6 left-6 inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-3 transition-colors cursor-pointer"
        >
          ← Back to app
        </button>
      )}
      <div className="flex w-full max-w-xl flex-col items-center text-center">
        <Mascot state={error ? 'worried' : 'idle'} size={84} />
        <h2 className="mt-5 font-display text-2xl font-semibold">Connect to FalkorDB</h2>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-2">
          Puff keeps its memory in <b className="font-medium text-ink">FalkorDB</b>, a graph database.
          Choose how you want to connect.
        </p>

        <div className="mt-6 flex w-full flex-col gap-2.5">
          <ModeCard id="docker" selected={mode === 'docker'} icon={Container} title="Run locally with Docker" description="Puff starts FalkorDB in a Docker container on your machine. Requires Docker Desktop." onSelect={setMode} />
          <ModeCard id="own-cloud" selected={mode === 'own-cloud'} icon={Cloud} title="Use your own FalkorDB Cloud" description="Connect to a FalkorDB Cloud instance you control. Paste your connection URL below." onSelect={setMode} />
          {/* The hosted demo card returns once a real shared instance exists (PUFF_DEMO_CLOUD_URL) */}
        </div>

        {mode === 'docker' && (
          <div className="mt-4 w-full rounded-xl border border-line bg-surface p-4 text-left">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Database className="size-4 text-brand-soft" />
              Database
              <span className="ml-auto font-mono text-[0.6875rem] text-ink-3">{status?.databaseUrl}</span>
            </div>
            {status?.databaseError && <p className="mt-2 text-[0.75rem] leading-snug whitespace-pre-wrap text-ink-3">{status.databaseError}</p>}
            {docker === 'ready' && <p className="mt-2 text-[0.8125rem] leading-snug text-ink-2">Docker is running. Puff will start FalkorDB in a container named <code className="font-mono text-xs">puff-falkordb</code>. The first time downloads the image (a few minutes).</p>}
            {docker === 'stopped' && <p className="mt-2 text-[0.8125rem] leading-snug text-warn">Docker is installed but not running. Start Docker Desktop, wait until it says it is running, then press Try again.</p>}
            {docker === 'missing' && <p className="mt-2 text-[0.8125rem] leading-snug text-warn">Docker was not found. <a href="https://www.docker.com/products/docker-desktop/" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">Install Docker Desktop <ExternalLink className="size-3" /></a> and start it, or choose another option above.</p>}
          </div>
        )}

        {mode === 'own-cloud' && (
          <div className="mt-4 w-full rounded-xl border border-line bg-surface p-4 text-left">
            <label htmlFor="cloud-url" className="text-sm font-medium text-ink">FalkorDB connection URL</label>
            <p className="mt-0.5 text-[0.75rem] text-ink-3">Format: <code className="font-mono">rediss://&lt;user&gt;:&lt;password&gt;@host:port</code></p>
            <input
              id="cloud-url"
              type="text"
              value={cloudUrl}
              onChange={(e) => setCloudUrl(e.target.value)}
              placeholder="rediss://default:password@my-instance.falkordb.cloud:6380"
              spellCheck={false}
              autoComplete="off"
              className="mt-2.5 w-full rounded-lg border border-line bg-abyss px-3 py-2 font-mono text-xs text-ink outline-none focus:border-brand/60"
            />
            <p className="mt-2 text-[0.6875rem] text-ink-3">
              Find this in your <a href="https://app.falkordb.cloud" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">FalkorDB Cloud dashboard <ExternalLink className="size-3" /></a>
            </p>
          </div>
        )}

        {mode === 'demo-cloud' && (
          <div className="mt-4 w-full rounded-xl border border-brand/20 bg-brand/5 p-4 text-left text-[0.8125rem] leading-snug text-ink-2">
            <p>You will connect to a shared hosted FalkorDB instance maintained by the Puff team. Ideal for exploring without any local setup.</p>
            <p className="mt-2 text-[0.75rem] text-ink-3">Note: the demo instance is shared and resets periodically. For persistent memory, use your own cloud or local Docker.</p>
          </div>
        )}

        <div className="mt-5 flex w-full flex-wrap gap-2.5">
          <button
            id="connect-btn"
            onClick={() => void handleConnect()}
            disabled={!!working || !canConnect}
            className={cn('inline-flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition-all bg-gradient-to-br from-brand to-brand-deep hover:brightness-110 disabled:cursor-wait disabled:opacity-60')}
          >
            {working === 'connect' ? <LoaderCircle className="size-4 animate-spin" /> : mode === 'docker' ? <Container className="size-4" /> : mode === 'demo-cloud' ? <Database className="size-4" /> : <Cloud className="size-4" />}
            {connectLabel}
          </button>
          <button
            id="retry-setup-btn"
            onClick={() => void handleRetry()}
            disabled={!!working}
            className="inline-flex items-center gap-2 rounded-xl border border-line-strong bg-surface-2 px-4 py-2.5 text-sm font-medium hover:bg-surface-3 disabled:opacity-60"
          >
            {working === 'retry' ? <LoaderCircle className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            Try again
          </button>
        </div>

        {error && <p role="alert" className="mt-3 w-full text-left text-[0.8125rem] leading-snug whitespace-pre-wrap text-bad">{error}</p>}

        {status && (
          <div className="mt-4 w-full rounded-lg border border-line bg-surface p-5">
            <div className="mb-3 text-sm font-medium">Agent tools</div>
            <AgentChecklist agents={status.agents} onChanged={onRefresh} />
            <p className="mt-3 text-left text-[0.75rem] leading-snug text-ink-3">
              Puff drives these command-line agents. You need at least one, signed in. You can explore the graph without any.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
