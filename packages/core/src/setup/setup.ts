// First-run setup: is the database reachable, is Docker there to start it, which agent CLIs are installed.
// The installed app has no repository checkout and no .env, so it needs to find these out and, with the
// person's click, start the one thing it can start for them (FalkorDB in Docker).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AGENT_NAMES, type AgentCliStatus, type AgentName, type SetupStatus } from '@puff/shared';
import { runProcess } from '../agents/spawn';
import { connect, DEFAULT_FALKORDB_URL } from '../db/client';
import { puffHome } from '../paths';
import { SIGN_IN_AGENTS, signInState } from './auth';

/** The container Puff starts (the same name docker-compose.yml uses, so a developer's database is reused) */
export const FALKORDB_CONTAINER = 'puff-falkordb';
const FALKORDB_IMAGE = 'falkordb/falkordb:latest';

const INSTALL_HINTS: Record<string, string> = {
  'claude-code': 'npm install -g @anthropic-ai/claude-code, then run `claude` once to sign in',
  codex: 'npm install -g @openai/codex, then run `codex` once to sign in',
  opencode: 'npm install -g opencode-ai',
};

/** Puff's own settings file, next to the user's config: values here fill in for a missing real environment variable. */
export const userEnvPath = (): string => join(puffHome(), '.env');

/** Remember `KEY=value` in ~/.puff/.env (replacing an earlier value for the same key). */
export async function saveUserEnv(key: string, value: string): Promise<void> {
  const file = userEnvPath();
  await mkdir(dirname(file), { recursive: true });
  const kept = existsSync(file)
    ? readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.trim() && !line.startsWith(`${key}=`))
    : [];
  writeFileSync(file, [...kept, `${key}=${value}`].join('\n') + '\n');
}

const docker = (args: string[], timeoutMs = 20_000) =>
  runProcess({ command: 'docker', args, cwd: tmpdir(), timeoutMs });

async function dockerState(): Promise<SetupStatus['docker']> {
  const version = await docker(['--version'], 10_000);
  if (version.spawnError || version.exitCode !== 0) return 'missing';
  // `docker info` needs the daemon; without it Docker Desktop is installed but not started
  const info = await docker(['info', '--format', '{{.ServerVersion}}'], 15_000);
  return info.exitCode === 0 && !info.timedOut ? 'ready' : 'stopped';
}

async function agentStatus(id: string, command: string): Promise<AgentCliStatus> {
  const res = await runProcess({
    command,
    args: ['--version'],
    cwd: tmpdir(),
    timeoutMs: 15_000,
  });
  const installed = !res.spawnError && res.exitCode === 0;
  const version = res.stdout.trim().split(/\r?\n/)[0]?.slice(0, 60);
  return {
    id,
    command,
    installed,
    version: installed && version ? version : undefined,
    installHint: INSTALL_HINTS[id] ?? `Install ${command} and make sure it is on your PATH`,
    signedIn:
      installed && AGENT_NAMES.includes(id as AgentName)
        ? await signInState(id as AgentName, command)
        : undefined,
    canSignIn: id in SIGN_IN_AGENTS,
  };
}

/**
 * What `connect` says, in words for the setup screen. Its own messages talk about `.env` and npm
 * scripts, which mean nothing to someone who installed the app.
 */
export function explainDatabaseError(url: string, message: string): string {
  if (/without the FalkorDB module/i.test(message))
    return `Something else (a plain Redis) is answering at ${url}, and it is not FalkorDB. Puff can start FalkorDB on a free port.`;
  if (/Could not connect/i.test(message)) return `Nothing is answering at ${url}.`;
  return message;
}

/** Everything the setup screen shows. Never throws: a problem is part of the answer. */
export async function checkSetup(
  harnesses: Record<string, { command: string }>,
): Promise<SetupStatus> {
  const url = process.env.FALKORDB_URL ?? DEFAULT_FALKORDB_URL;
  const [database, dockerStatus, agents] = await Promise.all([
    connect(url).then(
      async (db) => {
        await db.close().catch(() => {});
        return undefined;
      },
      (err: Error) => explainDatabaseError(url, err.message),
    ),
    dockerState(),
    Promise.all(Object.entries(harnesses).map(([id, h]) => agentStatus(id, h.command))),
  ]);
  return {
    databaseOk: database === undefined,
    databaseUrl: url,
    databaseError: database,
    docker: dockerStatus,
    agents,
    homePath: puffHome(),
  };
}

/** Is something already listening on this local port? */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** The first free port from 6379 up (a Redis of the person's own is often on 6379). */
async function freePort(): Promise<number> {
  for (let port = 6379; port < 6400; port++) if (!(await listening(port))) return port;
  throw new Error('No free port between 6379 and 6399 for the database.');
}

/** The host port an existing container publishes for the database, if it has one. */
async function containerPort(): Promise<number | undefined> {
  const res = await docker(['port', FALKORDB_CONTAINER, '6379/tcp']);
  const match = /:(\d+)\s*$/m.exec(res.stdout);
  return match ? Number(match[1]) : undefined;
}

async function waitForDatabase(url: string, seconds: number): Promise<void> {
  let last = '';
  for (let i = 0; i < seconds; i++) {
    try {
      const db = await connect(url);
      await db.close().catch(() => {});
      return;
    } catch (err) {
      last = (err as Error).message;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`FalkorDB started but did not answer at ${url} within ${seconds}s.\n  ${last}`);
}

/**
 * Start FalkorDB in Docker: start the `puff-falkordb` container if there is one, otherwise create it
 * (the first time downloads the image). Remembers the port in ~/.puff/.env when it is not 6379.
 * Only runs because the person pressed the button; every message is fit to show them.
 */
export async function startDatabase(log: (line: string) => void = () => {}): Promise<string> {
  const state = await dockerState();
  if (state === 'missing')
    throw new Error(
      'Docker is not installed. Install Docker Desktop (docker.com), start it, then try again.',
    );
  if (state === 'stopped')
    throw new Error('Docker is installed but not running. Start Docker Desktop, then try again.');

  const existing = await docker([
    'ps',
    '-a',
    '--filter',
    `name=^/${FALKORDB_CONTAINER}$`,
    '--format',
    '{{.Names}}',
  ]);
  let port: number;
  if (existing.stdout.trim() === FALKORDB_CONTAINER) {
    log(`Starting the existing ${FALKORDB_CONTAINER} container…`);
    const started = await docker(['start', FALKORDB_CONTAINER], 60_000);
    if (started.exitCode !== 0)
      throw new Error(`docker start failed: ${(started.stderr || started.stdout).trim()}`);
    port = (await containerPort()) ?? 6379;
  } else {
    port = await freePort();
    log(`Creating ${FALKORDB_CONTAINER} on port ${port} (the first time downloads the image)…`);
    const created = await docker(
      [
        'run',
        '-d',
        '--name',
        FALKORDB_CONTAINER,
        '--restart',
        'unless-stopped',
        '-p',
        `${port}:6379`,
        '-v',
        `${FALKORDB_CONTAINER}:/data`,
        FALKORDB_IMAGE,
      ],
      15 * 60_000,
    );
    if (created.exitCode !== 0)
      throw new Error(`docker run failed: ${(created.stderr || created.stdout).trim()}`);
  }

  const url = `falkor://localhost:${port}`;
  process.env.FALKORDB_URL = url;
  if (url !== DEFAULT_FALKORDB_URL) await saveUserEnv('FALKORDB_URL', url);
  await waitForDatabase(url, 40);
  return url;
}

/**
 * The URL of your hosted/demo FalkorDB Cloud instance.
 * Update this to your real FalkorDB Cloud connection string before shipping.
 */
export const getDemoCloudUrl = (): string =>
  process.env.PUFF_DEMO_CLOUD_URL ?? 'rediss://demo.falkordb.cloud:6380';
export const DEMO_CLOUD_URL = process.env.PUFF_DEMO_CLOUD_URL ?? 'rediss://demo.falkordb.cloud:6380';

/**
 * Connect to a caller-supplied FalkorDB URL (own cloud or the shared demo instance).
 * Validates connectivity, then persists the URL in ~/.puff/.env so it survives restarts.
 * Throws a human-readable error if the URL is unreachable.
 */
export async function connectToDatabase(url: string): Promise<void> {
  let db;
  try {
    db = await connect(url);
  } catch (err) {
    throw new Error(
      `Could not connect to FalkorDB at ${url}.\n${(err as Error).message}`,
    );
  }
  await db.close().catch(() => {});
  process.env.FALKORDB_URL = url;
  if (url !== DEFAULT_FALKORDB_URL) await saveUserEnv('FALKORDB_URL', url);
}

