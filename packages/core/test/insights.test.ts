// The graph analytics against a real FalkorDB: PageRank hotspots over the demo's call graph, and
// full-text recall of past failures by wording, with the function each one is anchored to.
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import { connect, loadDotEnv, run } from '../src/db/client';
import { initProjectGraph } from '../src/db/init';
import { graphName } from '../src/ids';
import { indexRepo } from '../src/indexer/index';
import { hotspots, similarFailures } from '../src/queries/insights';

const rel = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const DEMO = rel('../../../demo/shop-api');
const config = parseConfig(readFileSync(rel('../../../puff.config.yaml'), 'utf8'));

loadDotEnv(rel('../../../.env'));
const db = await connect().catch(() => undefined);

const LOGIN = 'src/auth/login.ts::login';
const CHECK_USER = 'src/auth/login.ts::checkUser';

describe.skipIf(!db)('graph analytics against FalkorDB', () => {
  const slug = `test_insights_${process.pid}`;
  const project = { slug, name: slug, repoPath: '' };
  let graph: Awaited<ReturnType<typeof initProjectGraph>>;

  beforeAll(async () => {
    const repo = mkdtempSync(join(tmpdir(), 'puff-insights-'));
    cpSync(join(DEMO, 'src'), join(repo, 'src'), { recursive: true });
    cpSync(join(DEMO, 'package.json'), join(repo, 'package.json'));
    project.repoPath = repo;
    graph = await initProjectGraph(db!, project, config);
    await indexRepo(graph, project);

    // Two past failures, anchored to login(): one fresh, one already marked possibly outdated.
    await run(
      graph,
      `MATCH (s:Symbol {id: $sym})
       CREATE (:Failure {id: 'f_plain', message: 'password logged in plaintext by login()', stale: false, createdAt: timestamp()})-[:IN]->(s),
              (:Failure {id: 'f_rate', message: 'rate limit missing on the login route', stale: true, createdAt: timestamp()})-[:IN]->(s)`,
      { sym: LOGIN },
    );
    // The full-text index is updated in the background; give it a moment to see the new nodes.
    await new Promise((r) => setTimeout(r, 1500));
  });

  afterAll(async () => {
    await db!
      .selectGraph(graphName(slug))
      .delete()
      .catch(() => {});
    await db!.close();
  });

  it('ranks the symbols other code depends on, with the memory attached to each', async () => {
    const rows = await hotspots(graph, 100);
    expect(rows.length).toBeGreaterThan(0);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.score).toBeGreaterThanOrEqual(rows[i]!.score);
    }
    const login = rows.find((r) => r.id === LOGIN);
    expect(login).toMatchObject({ failures: 2, staleFailures: 1, name: 'login' });
    expect(rows.find((r) => r.id === CHECK_USER)?.failures).toBe(0);
  });

  it('honours the limit', async () => {
    expect(await hotspots(graph, 3)).toHaveLength(3);
  });

  it('finds past failures worded like a new task, with the function they are anchored to', async () => {
    const rows = await similarFailures(
      graph,
      'Fix: the password is being logged for login attempts',
    );
    expect(rows[0]).toMatchObject({ id: 'f_plain', symbol: LOGIN, stale: false });
  });

  it('flags failures that are possibly outdated', async () => {
    const rows = await similarFailures(graph, 'rate limit on login');
    expect(rows.find((r) => r.id === 'f_rate')).toMatchObject({ stale: true, symbol: LOGIN });
  });

  it('does not fail on punctuation or on text with nothing to search for', async () => {
    await expect(similarFailures(graph, 'login() -> "@#$" (broken')).resolves.toBeInstanceOf(Array);
    expect(await similarFailures(graph, 'the and for')).toEqual([]);
  });
});
