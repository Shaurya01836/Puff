// Separate memory per project (the "tenant" of Track 02): every project is its own FalkorDB graph, so
// what one project learned can never reach another, and deleting one leaves the other alone. Real FalkorDB.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import { compileContext } from '../src/context/compiler';
import { connect, loadDotEnv, read } from '../src/db/client';
import { initProjectGraph } from '../src/db/init';
import { graphName } from '../src/ids';
import { indexRepo } from '../src/indexer/index';
import { recordDecision, recordFailure } from '../src/memory/memory';
import { startSession } from '../src/memory/sessions';
import { createTask, listTasks } from '../src/memory/tasks';
import { similarFailures } from '../src/queries/insights';
import { listMemory } from '../src/queries/lessons';

const rel = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const DEMO = rel('../../../demo/shop-api');
const config = parseConfig(readFileSync(rel('../../../puff.config.yaml'), 'utf8'));

loadDotEnv(rel('../../../.env'));
const db = await connect().catch(() => undefined);

const LOGIN = 'src/auth/login.ts::login';

describe.skipIf(!db)('one graph per project (real FalkorDB)', () => {
  const mine = `test_iso_a_${process.pid}`;
  const theirs = `test_iso_b_${process.pid}`;
  const repos: string[] = [];
  const open = async (slug: string) => {
    const repo = mkdtempSync(join(tmpdir(), 'puff-iso-'));
    repos.push(repo);
    cpSync(join(DEMO, 'src'), join(repo, 'src'), { recursive: true });
    cpSync(join(DEMO, 'package.json'), join(repo, 'package.json'));
    const project = { slug, name: slug, repoPath: repo };
    const graph = await initProjectGraph(db!, project, config);
    await indexRepo(graph, project);
    return graph;
  };
  let a: Awaited<ReturnType<typeof open>>;
  let b: Awaited<ReturnType<typeof open>>;

  beforeAll(async () => {
    a = await open(mine);
    b = await open(theirs);
  });

  afterAll(async () => {
    for (const slug of [mine, theirs])
      await db!
        .selectGraph(graphName(slug))
        .delete()
        .catch(() => {});
    for (const r of repos) rmSync(r, { recursive: true, force: true });
    await db!.close();
  });

  it('a lesson learned in one project is invisible in the other, even on the same function', async () => {
    const task = await createTask(a, mine, config, {
      title: 'Add a reason to the failed-login log',
      type: 'implement',
      targets: [LOGIN],
    });
    const s = await startSession(a, { agent: 'codex', taskId: task.id, role: 'coder' });
    await recordFailure(a, {
      sessionId: s,
      message: 'login.spec: password appears in audit log',
      symbolIds: [LOGIN],
    });
    await recordDecision(a, { text: 'Never log credentials', symbolIds: [LOGIN], sessionId: s });

    expect((await listMemory(a)).map((i) => i.kind).sort()).toEqual(['Decision', 'Failure']);
    expect(await listMemory(b)).toEqual([]);
    expect(await listTasks(b)).toEqual([]);
    expect(await similarFailures(b, 'password appears in audit log')).toEqual([]);

    // the other project has the same function and a task on it: its context holds no lesson from A
    const other = await createTask(b, theirs, config, {
      title: 'Add a reason to the failed-login log',
      type: 'implement',
      targets: [LOGIN],
    });
    const pack = await compileContext(b, other.id, { role: 'coder', preview: true });
    expect(pack.items.filter((i) => i.kind === 'Failure' || i.kind === 'Decision')).toEqual([]);
    const [n] = await read<{ n: number }>(b, `MATCH (f:Failure) RETURN count(f) AS n`);
    expect(Number(n!.n)).toBe(0);
  });

  it('every project is its own graph, and deleting one leaves the other alone', async () => {
    const names = await db!.list();
    expect(names).toContain(graphName(mine));
    expect(names).toContain(graphName(theirs));
    await db!.selectGraph(graphName(mine)).delete();
    expect(await db!.list()).not.toContain(graphName(mine));
    expect(
      (await read<{ n: number }>(b, `MATCH (s:Symbol) RETURN count(s) AS n`))[0]!.n,
    ).toBeGreaterThan(0);
  });
});
