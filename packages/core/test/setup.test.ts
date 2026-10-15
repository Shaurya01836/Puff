// First-run setup: what the check reports, how a remembered database port is stored, and that the
// indexer can read its grammars from a folder (how the installed app ships them).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseSource, setWasmDirectory } from '../src/indexer/parser';
import { checkSetup, explainDatabaseError, saveUserEnv, userEnvPath } from '../src/setup/setup';

let home: string;
const saved = { home: process.env.PUFF_HOME, url: process.env.FALKORDB_URL };

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'puff-setup-'));
  process.env.PUFF_HOME = home;
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  if (saved.home === undefined) delete process.env.PUFF_HOME;
  else process.env.PUFF_HOME = saved.home;
});
afterEach(() => {
  setWasmDirectory(undefined);
  if (saved.url === undefined) delete process.env.FALKORDB_URL;
  else process.env.FALKORDB_URL = saved.url;
});

describe('setup check', { timeout: 30_000 }, () => {
  it('says the database is unreachable (and why) without throwing', async () => {
    process.env.FALKORDB_URL = 'falkor://127.0.0.1:1';
    const status = await checkSetup({});
    expect(status.databaseOk).toBe(false);
    expect(status.databaseUrl).toBe('falkor://127.0.0.1:1');
    expect(status.databaseError).toContain('Nothing is answering');
    expect(['missing', 'stopped', 'ready']).toContain(status.docker);
    expect(status.homePath).toBe(home);
  });

  it('finds an installed agent command and reports a missing one with how to install it', async () => {
    process.env.FALKORDB_URL = 'falkor://127.0.0.1:1';
    const status = await checkSetup({
      // node is certainly installed where these tests run
      opencode: { command: process.execPath },
      codex: { command: 'puff-no-such-agent-cli' },
    });
    const byId = Object.fromEntries(status.agents.map((a) => [a.id, a]));
    expect(byId.opencode?.installed).toBe(true);
    expect(byId.opencode?.version).toMatch(/^v\d+/);
    expect(byId.codex?.installed).toBe(false);
    expect(byId.codex?.installHint).toContain('@openai/codex');
  });

  it('explains database errors in words that fit an installed app', () => {
    const url = 'falkor://localhost:6379';
    expect(
      explainDatabaseError(
        url,
        `${url} is a Redis server without the FalkorDB module (npm run db:up)`,
      ),
    ).toMatch(/plain Redis/);
    expect(
      explainDatabaseError(url, `Could not connect to FalkorDB at ${url}. Is it running?`),
    ).toBe(`Nothing is answering at ${url}.`);
    expect(explainDatabaseError(url, 'something odd')).toBe('something odd');
  });
});

describe('remembered settings', () => {
  it('stores a value in ~/.puff/.env and replaces it, keeping other lines', async () => {
    await saveUserEnv('FALKORDB_URL', 'falkor://localhost:6380');
    await saveUserEnv('OTHER', '1');
    await saveUserEnv('FALKORDB_URL', 'falkor://localhost:6381');
    const lines = readFileSync(userEnvPath(), 'utf8').trim().split('\n');
    expect(lines).toEqual(['OTHER=1', 'FALKORDB_URL=falkor://localhost:6381']);
  });
});

describe('grammar folder', () => {
  it('parses with grammars loaded from a folder instead of the package', async () => {
    const out = join(
      dirname(createRequire(import.meta.url).resolve('tree-sitter-wasms/package.json')),
      'out',
    );
    setWasmDirectory(out);
    const parsed = await parseSource('export function hello() { return 1; }\n', 'typescript');
    expect(parsed.defs.map((d) => d.name)).toEqual(['hello']);
  });
});
