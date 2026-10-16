// Modules and expertise (P17): which folder a function is in, how modules depend on each other (Q27),
// what each agent has done in each module (Q28), how that changes routing, and which tasks may not run
// side by side in the same module as a choke point (Q29).
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import { connect, loadDotEnv, read } from '../src/db/client';
import { initProjectGraph } from '../src/db/init';
import { graphName } from '../src/ids';
import { indexRepo } from '../src/indexer/index';
import { finishSession, startSession } from '../src/memory/sessions';
import { createTask, updateTask } from '../src/memory/tasks';
import { routeTask } from '../src/orchestrator/routing';
import { overlapDetails, overlappingTasks } from '../src/orchestrator/schedule';
import { agentProfiles } from '../src/queries/explain';
import {
  agentExpertise,
  commonDirPrefix,
  computeModules,
  moduleOf,
  smoothedRate,
} from '../src/queries/modules';

const rel = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const DEMO = rel('../../../demo/shop-api');
const config = parseConfig(readFileSync(rel('../../../puff.config.yaml'), 'utf8'));

loadDotEnv(rel('../../../.env'));
const db = await connect().catch(() => undefined);

describe('naming a module from a path', () => {
  it('is the first folder below the source root', () => {
    const files = ['src/auth/login.ts', 'src/cart/cart.ts', 'src/app.ts'];
    const prefix = commonDirPrefix(files);
    expect(prefix).toEqual(['src']);
    expect(files.map((f) => moduleOf(f, prefix))).toEqual(['auth', 'cart', '(root)']);
  });

  it('skips the folder a whole app lives in (Kite keeps everything in my-app)', () => {
    const files = ['my-app/components/ui/Button.tsx', 'my-app/lib/wagmi.ts', 'my-app/app/page.tsx'];
    const prefix = commonDirPrefix(files);
    expect(prefix).toEqual(['my-app']);
    expect(files.map((f) => moduleOf(f, prefix))).toEqual(['components', 'lib', 'app']);
  });

  it('names a monorepo package, and the folder inside it', () => {
    const files = [
      'packages/core/src/orchestrator/run.ts',
      'packages/core/src/index.ts',
      'packages/mcp/src/chat.ts',
      'apps/desktop/src/main/backend.ts',
    ];
    const prefix = commonDirPrefix(files);
    expect(prefix).toEqual([]);
    expect(files.map((f) => moduleOf(f, prefix))).toEqual([
      'core/orchestrator',
      'core',
      'mcp',
      'desktop/main',
    ]);
  });

  it('smooths a win rate toward 0.5 when there are few runs behind it', () => {
    expect(smoothedRate(0, 0)).toBe(0.5);
    expect(smoothedRate(1, 1)).toBeCloseTo(0.667, 3);
    expect(smoothedRate(4, 4)).toBeCloseTo(0.833, 3);
    expect(smoothedRate(0, 4)).toBeCloseTo(0.167, 3);
  });
});

describe.skipIf(!db)('modules, expertise and choke points (real FalkorDB)', () => {
  const slug = `test_modules_${process.pid}`;
  const project = { slug, name: slug, repoPath: '' };
  let graph: Awaited<ReturnType<typeof initProjectGraph>>;

  const CART = 'src/cart/cart.ts::cartTotal';
  const ADD_ITEM = 'src/cart/cart.ts::addItem';
  const TAX = 'src/cart/tax.ts::taxFor';
  const LOGIN = 'src/auth/login.ts::login';
  const CHECK_USER = 'src/auth/login.ts::checkUser';
  const AUDIT = 'src/auth/audit.ts::audit';

  beforeAll(async () => {
    const repo = mkdtempSync(join(tmpdir(), 'puff-modules-'));
    cpSync(join(DEMO, 'src'), join(repo, 'src'), { recursive: true });
    cpSync(join(DEMO, 'package.json'), join(repo, 'package.json'));
    project.repoPath = repo;
    graph = await initProjectGraph(db!, project, config);
    await indexRepo(graph, project);
  });

  afterAll(async () => {
    await db!
      .selectGraph(graphName(slug))
      .delete()
      .catch(() => {});
    rmSync(project.repoPath, { recursive: true, force: true });
    await db!.close();
  });

  /** One finished session by `agent` on a task in `target`'s module */
  async function ran(agent: string, target: string, outcome: 'success' | 'failure') {
    const t = await createTask(graph, slug, config, {
      title: `${agent} on ${target}`,
      type: 'implement',
      targets: [target],
    });
    const s = await startSession(graph, { agent: agent as never, taskId: t.id, role: 'coder' });
    await finishSession(graph, s, { outcome });
    return t;
  }

  it('Q27: indexing puts every function in a module and counts the calls between modules', async () => {
    const mods = await computeModules(graph);
    const byName = Object.fromEntries(mods.map((m) => [m.id, m]));
    expect(Object.keys(byName)).toEqual(
      expect.arrayContaining(['auth', 'cart', 'lib', 'products', 'users', 'routes']),
    );
    expect(byName.auth!.size).toBeGreaterThan(10);
    // cart calls into products (findProduct) and lib (db); routes call into cart
    expect(byName.cart!.dependsOn.map((d) => d.module)).toEqual(
      expect.arrayContaining(['products', 'lib']),
    );
    expect(byName.routes!.dependsOn.map((d) => d.module)).toContain('cart');
    const [member] = await read<{ m: string }>(
      graph,
      `MATCH (:Symbol {id: $id})-[:IN_MODULE]->(m:Module) RETURN m.id AS m`,
      { id: CART },
    );
    expect(member!.m).toBe('cart');
    // running it again changes nothing
    const again = await computeModules(graph);
    expect(again.map((m) => [m.id, m.size])).toEqual(mods.map((m) => [m.id, m.size]));
    const n = await read<{ n: number }>(graph, `MATCH (m:Module) RETURN count(m) AS n`);
    expect(Number(n[0]!.n)).toBe(mods.length);
  });

  it('Q28: what an agent did in a module is stored as KNOWS and shows on its profile; errors count for nothing', async () => {
    for (let i = 0; i < 5; i++) await ran('opencode', ADD_ITEM, 'success');
    await ran('opencode', TAX, 'failure');
    const t = await createTask(graph, slug, config, {
      title: 'could not start',
      targets: [ADD_ITEM],
    });
    const s = await startSession(graph, { agent: 'opencode', taskId: t.id, role: 'coder' });
    await finishSession(graph, s, { outcome: 'error' });

    const record = (await agentExpertise(graph, ['cart'])).get('opencode');
    expect(record).toEqual([{ module: 'cart', runs: 6, wins: 5 }]);
    const profiles = await agentProfiles(graph, config);
    expect(profiles.find((p) => p.name === 'opencode')!.modules).toEqual([
      { module: 'cart', runs: 6, wins: 5 },
    ]);
    expect(profiles.find((p) => p.name === 'claude-code')!.modules).toEqual([]);
  });

  it('Q28 in routing: a record in the module puts that agent first over the declared best, and says so', async () => {
    // codex declares `implementation`; opencode has won 5 of 6 in the cart module, codex has never worked there
    // a cart function that is not load-bearing (the risk rule would send load-bearing code to claude-code)
    const [quiet] = await read<{ id: string }>(
      graph,
      `MATCH (s:Symbol)-[:IN_MODULE]->(:Module {id: 'cart'}) WHERE s.risk < 0.5
       RETURN s.id AS id ORDER BY s.risk, s.id LIMIT 1`,
    );
    expect(quiet, 'a low-risk function in the cart module').toBeDefined();
    const task = await createTask(graph, slug, config, {
      title: 'Add a cart discount',
      type: 'implement',
      targets: [quiet!.id],
    });
    const route = await routeTask(graph, config, task.id);
    expect(route.agents[0]).toBe('opencode');
    expect(route.expertise).toMatchObject({ agent: 'opencode', module: 'cart', runs: 6, wins: 5 });
    expect(route.reason).toBe(
      "opencode has won 5 of 6 runs in the cart module (codex has not worked there), so it goes first even though codex declares 1 of the task's capabilities (no earlier runs)",
    );

    // a different module has no such record: the declared strength decides as before
    const other = await createTask(graph, slug, config, {
      title: 'Change the audit log',
      type: 'implement',
      targets: [AUDIT],
    });
    const plain = await routeTask(graph, config, other.id);
    expect(plain.agents[0]).toBe('codex');
    expect(plain.expertise).toBeUndefined();
  });

  it('Q28 needs evidence: two lucky runs do not take the lead', async () => {
    for (let i = 0; i < 2; i++) await ran('claude-code', CHECK_USER, 'success');
    const task = await createTask(graph, slug, config, {
      title: 'Change checkUser',
      type: 'implement',
      targets: [CHECK_USER],
    });
    const route = await routeTask(graph, config, task.id);
    expect(route.expertise).toBeUndefined();
    expect(route.agents[0]).toBe('codex');
  });

  it('Q29: tasks in the same module as a choke point do not run side by side; other modules and non-choke code still do', async () => {
    const choke = await read<{ id: string }>(
      graph,
      `MATCH (s:Symbol) WHERE s.betweenness > 0 AND coalesce(s.removed, false) = false
       RETURN s.id AS id ORDER BY s.betweenness DESC, s.id LIMIT 3`,
    );
    expect(choke.length).toBeGreaterThan(0);
    const [top] = choke;
    const module = top!.id.split('/')[1]!;
    // a function in the same module as the top choke point that is not itself a choke point and is not
    // connected to it by a call
    const [neighbour] = await read<{ id: string }>(
      graph,
      `MATCH (c:Symbol {id: $choke})-[:IN_MODULE]->(m:Module)<-[:IN_MODULE]-(n:Symbol)
       WHERE n.id <> c.id AND NOT n.id IN $chokes AND NOT (n)-[:CALLS]-(c)
         AND NOT n.name ENDS WITH '.constructor'
       RETURN n.id AS id ORDER BY n.id LIMIT 1`,
      { choke: top!.id, chokes: choke.map((c) => c.id) },
    );
    expect(neighbour, `a quiet function next to ${top!.id}`).toBeDefined();

    const a = await createTask(graph, slug, config, {
      title: 'Change the choke point',
      type: 'implement',
      targets: [top!.id],
    });
    const b = await createTask(graph, slug, config, {
      title: 'Change something next to it',
      type: 'implement',
      targets: [neighbour!.id],
    });
    await updateTask(graph, a.id, { status: 'running' });
    const waits = await overlapDetails(graph, b);
    expect(waits).toEqual([
      { id: a.id, why: `${top!.id.split('::')[1]}() is a choke point in the ${module} module` },
    ]);
    // with the graph off it is only the file, so these two (different files or not) may differ
    // another module is free to go
    const elsewhere = await createTask(graph, slug, config, {
      title: 'Change the lib clock',
      type: 'implement',
      targets: ['src/lib/clock.ts::nowSeconds'],
    });
    if (module !== 'lib') expect(await overlappingTasks(graph, elsewhere)).toEqual([]);
    await updateTask(graph, a.id, { status: 'done' });

    // two tasks in a module with no choke point in either run together
    const x = await createTask(graph, slug, config, {
      title: 'tax a',
      type: 'implement',
      targets: [TAX],
    });
    const y = await createTask(graph, slug, config, {
      title: 'discount b',
      type: 'implement',
      targets: ['src/cart/discounts.ts::findDiscount'],
    });
    await updateTask(graph, x.id, { status: 'running' });
    expect(await overlappingTasks(graph, y)).toEqual([]);
    await updateTask(graph, x.id, { status: 'done' });
    void LOGIN;
  });
});
