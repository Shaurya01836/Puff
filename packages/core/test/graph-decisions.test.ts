// What the graph decides, against a real FalkorDB: the ablation switch (PUFF_GRAPH=off), risk from
// PageRank and betweenness (Q20) changing routing and the context budget, lessons two calls away
// (Q21), failures found by wording (Q22), and the trace every decision leaves behind (Q19).
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { graphOff, parseConfig } from '../src/config';
import { compileContext, DEFAULT_BUDGET_TOKENS, RISK_BUDGET_FACTOR } from '../src/context/compiler';
import { connect, loadDotEnv, read } from '../src/db/client';
import { initProjectGraph } from '../src/db/init';
import { listTraces, traced } from '../src/db/trace';
import { graphName } from '../src/ids';
import { indexRepo } from '../src/indexer/index';
import { recordFailure, recordSolution } from '../src/memory/memory';
import { startSession } from '../src/memory/sessions';
import { createTask, updateTask } from '../src/memory/tasks';
import { routeTask } from '../src/orchestrator/routing';
import { overlappingTasks } from '../src/orchestrator/schedule';
import { computeRisk, taskRisk } from '../src/queries/insights';

const rel = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const DEMO = rel('../../../demo/shop-api');
const config = parseConfig(readFileSync(rel('../../../puff.config.yaml'), 'utf8'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

loadDotEnv(rel('../../../.env'));
const db = await connect().catch(() => undefined);

const LOGIN = 'src/auth/login.ts::login';
const AUDIT = 'src/auth/audit.ts::audit';
const LOG = 'src/lib/logger.ts::log';
const LIST_PRODUCTS = 'src/products/products.ts::listProducts';

describe('the graph switch', () => {
  const saved = process.env.PUFF_GRAPH;
  afterEach(() => {
    if (saved === undefined) delete process.env.PUFF_GRAPH;
    else process.env.PUFF_GRAPH = saved;
  });

  it('is on unless PUFF_GRAPH says off or the config disables it; the variable wins', () => {
    delete process.env.PUFF_GRAPH;
    expect(graphOff(config)).toBe(false);
    expect(graphOff({ graph: { enabled: false, riskThreshold: 0.9 } })).toBe(true);
    for (const v of ['off', 'OFF', '0', 'false']) {
      process.env.PUFF_GRAPH = v;
      expect(graphOff(config)).toBe(true);
    }
    process.env.PUFF_GRAPH = 'on';
    expect(graphOff({ graph: { enabled: false, riskThreshold: 0.9 } })).toBe(false);
  });
});

describe.skipIf(!db)('what the graph decides (real FalkorDB)', () => {
  const slug = `test_decide_${process.pid}`;
  const project = { slug, name: slug, repoPath: '' };
  let graph: Awaited<ReturnType<typeof initProjectGraph>>;

  beforeAll(async () => {
    const repo = mkdtempSync(join(tmpdir(), 'puff-decide-'));
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

  /** The function with the highest and the lowest risk after indexing */
  const extremes = async () => {
    const rows = await read<{ id: string; risk: number }>(
      graph,
      `MATCH (s:Symbol) WHERE s.risk IS NOT NULL AND NOT s.name ENDS WITH '.constructor'
       RETURN s.id AS id, s.risk AS risk ORDER BY s.risk DESC, s.id`,
    );
    return { top: rows[0]!, bottom: rows.at(-1)!, count: rows.length };
  };

  it('Q20: indexing stores PageRank, betweenness and a percentile risk on every function', async () => {
    const { top, bottom, count } = await extremes();
    expect(count).toBeGreaterThan(50);
    expect(top.risk).toBe(1);
    expect(bottom.risk).toBe(0);
    const [row] = await read<{ pr: number; bt: number }>(
      graph,
      `MATCH (s:Symbol {id: $id}) RETURN s.pagerank AS pr, s.betweenness AS bt`,
      { id: top.id },
    );
    expect(Number(row!.pr) + Number(row!.bt)).toBeGreaterThan(0);
  });

  it('Q20: the scores are the same every time (FalkorDB samples betweenness at random unless seeded)', async () => {
    const read1 = () =>
      read<{ id: string; b: number; r: number }>(
        graph,
        `MATCH (s:Symbol) WHERE s.risk IS NOT NULL RETURN s.id AS id, s.betweenness AS b, s.risk AS r ORDER BY id`,
      );
    const first = await read1();
    for (let i = 0; i < 3; i++) {
      await computeRisk(graph);
      expect(await read1()).toEqual(first);
    }
  });

  it('Q20: a task on load-bearing code goes to an agent that declares reasoning, with a bigger context budget', async () => {
    const { top, bottom } = await extremes();
    const risky = await createTask(graph, slug, config, {
      title: 'Change the most depended-on function',
      type: 'implement',
      targets: [top.id],
    });
    const plain = await createTask(graph, slug, config, {
      title: 'Change a leaf function',
      type: 'implement',
      targets: [bottom.id],
    });

    const r1 = await routeTask(graph, config, risky.id);
    expect(r1.agents[0]).toBe('claude-code'); // the only agent declaring `reasoning`
    expect(r1.reason).toMatch(
      /in the top \d+% of this code by risk \(PageRank [\d.]+, betweenness \d+/,
    );
    expect((await taskRisk(graph, risky.id))!.risk).toBe(1);

    const r2 = await routeTask(graph, config, plain.id);
    expect(r2.agents[0]).toBe('codex'); // declares `implementation`, as before
    expect(r2.reason).toMatch(/codex declares 1 of the task's capabilities/);

    const big = await compileContext(graph, risky.id, { role: 'coder', preview: true });
    const normal = await compileContext(graph, plain.id, { role: 'coder', preview: true });
    expect(big.budgetTokens).toBe(DEFAULT_BUDGET_TOKENS * RISK_BUDGET_FACTOR);
    expect(normal.budgetTokens).toBe(DEFAULT_BUDGET_TOKENS);
  });

  it('the ablation: with the graph off, routing is the escalation order and context is the target only', async () => {
    const task = await createTask(graph, slug, config, {
      title: 'Log failed logins with a reason',
      type: 'implement',
      targets: [LOGIN],
    });
    const ses = await startSession(graph, { agent: 'codex', taskId: task.id, role: 'coder' });
    await recordFailure(graph, {
      sessionId: ses,
      message: 'never writes a password to the logs',
      kind: 'test',
      symbolIds: [AUDIT],
    });

    const on = await routeTask(graph, config, task.id);
    const onCtx = await compileContext(graph, task.id, { role: 'coder', preview: true });
    const offCtx = await compileContext(graph, task.id, {
      role: 'coder',
      preview: true,
      graphOff: true,
    });
    process.env.PUFF_GRAPH = 'off';
    let off;
    try {
      off = await routeTask(graph, config, task.id);
    } finally {
      delete process.env.PUFF_GRAPH;
    }

    expect(on.agents).not.toEqual(off.agents);
    expect(off.agents).toEqual(['opencode', 'codex', 'claude-code']);
    expect(off.reason).toMatch(/^graph off/);
    expect(off.graphOff).toBe(true);

    // on: the target, its callers and the lesson from audit(); off: the target and nothing else
    expect(onCtx.items.some((i) => i.kind === 'Failure')).toBe(true);
    expect(offCtx.items.map((i) => [i.kind, i.id])).toEqual([['Symbol', LOGIN]]);
    expect(offCtx.graphOff).toBe(true);
    expect(offCtx.prompt).not.toContain('never writes a password');
    expect(offCtx.prompt).toContain('src/auth/login.ts');
  });

  it('Q21: a lesson two calls down is included, ranked below closer ones, and says the path', async () => {
    const task = await createTask(graph, slug, config, {
      title: 'Add a remember-me option to login',
      type: 'implement',
      targets: [LOGIN],
    });
    const ses = await startSession(graph, { agent: 'codex', taskId: task.id, role: 'coder' });
    await recordFailure(graph, {
      sessionId: ses,
      message: 'log lines must not contain request bodies',
      kind: 'test',
      symbolIds: [LOG],
    });
    const ctx = await compileContext(graph, task.id, { role: 'coder', preview: true });
    const far = ctx.items.find((i) => i.text === 'log lines must not contain request bodies');
    expect(far?.reason).toBe('failed in log(), which the target login() reaches through audit()');
    // the failure on audit() (one call away) comes before the one on log() (two calls away)
    const order = ctx.items.filter((i) => i.kind === 'Failure').map((i) => i.text);
    expect(order.indexOf('never writes a password to the logs')).toBeLessThan(
      order.indexOf('log lines must not contain request bodies'),
    );
  });

  it('Q22: a failure worded like the task is included even when it is far away in the code', async () => {
    const task = await createTask(graph, slug, config, {
      title: 'Pagination breaks when the page size is zero',
      type: 'implement',
      targets: ['src/auth/tokens.ts::verifyToken'],
    });
    const ses = await startSession(graph, { agent: 'codex', taskId: task.id, role: 'coder' });
    const f = await recordFailure(graph, {
      sessionId: ses,
      message: 'pagination breaks for a zero page size',
      kind: 'test',
      symbolIds: [LIST_PRODUCTS],
    });
    await recordSolution(graph, { failureId: f.id, summary: 'Reject a page size below 1' });
    await sleep(1500); // the full-text index is updated asynchronously
    const ctx = await compileContext(graph, task.id, { role: 'coder', preview: true });
    const hit = ctx.items.find((i) => i.id === f.id);
    expect(hit?.reason).toBe('failed in listProducts(), worded like this task (full-text search)');
    expect(
      ctx.items.some((i) => i.kind === 'Solution' && i.text === 'Reject a page size below 1'),
    ).toBe(true);
  });

  it('Q8 with the graph off: overlap is by file only, so callers in other files no longer wait', async () => {
    // login() (login.ts) calls audit() (audit.ts): overlapping through the graph, not by file
    const a = await createTask(graph, slug, config, {
      title: 'a',
      type: 'implement',
      targets: [AUDIT],
    });
    const b = await createTask(graph, slug, config, {
      title: 'b',
      type: 'implement',
      targets: [LOGIN],
    });
    const c = await createTask(graph, slug, config, {
      title: 'c',
      type: 'implement',
      targets: ['src/auth/login.ts::checkUser'],
    });
    await updateTask(graph, a.id, { status: 'running' });
    const bOn = await overlappingTasks(graph, b);
    const bOff = await overlappingTasks(graph, b, { graphOff: true });
    expect(bOn).toContain(a.id);
    expect(bOff).not.toContain(a.id);
    // same file still waits with the graph off
    await updateTask(graph, a.id, { status: 'done' });
    await updateTask(graph, b.id, { status: 'running' });
    expect(await overlappingTasks(graph, c, { graphOff: true })).toEqual([b.id]);
    await updateTask(graph, b.id, { status: 'done' });
  });

  it('Q19: traced() collects every query a decision runs, with timings and row counts, and stores it once', async () => {
    const task = await createTask(graph, slug, config, {
      title: 'Trace me',
      type: 'implement',
      targets: [LOGIN],
    });
    const { value, steps } = await traced(() => routeTask(graph, config, task.id));
    expect(value.agents.length).toBeGreaterThan(0);
    expect(steps.length).toBeGreaterThanOrEqual(2); // rank agents, then the risk lookup
    expect(steps.every((s) => s.ms > 0 && s.rows >= 0)).toBe(true);
    expect(steps[0]!.params).toEqual(['id']);

    const ses = await startSession(graph, { agent: 'codex', taskId: task.id, role: 'coder' });
    await compileContext(graph, task.id, { role: 'coder', sessionId: ses });
    const [trace] = await listTraces(graph, task.id);
    expect(trace).toMatchObject({ kind: 'context', sessionId: ses });
    expect(trace!.reason).toMatch(/^\d+ items \(\d+ from memory\), ~\d+ of \d+ tokens/);
    expect(trace!.queries).toBeGreaterThan(5);
    // values never land in a trace, only parameter names
    expect(JSON.stringify(trace)).not.toContain(task.id.slice(-6) + '"');

    // a re-index that changes code leaves a stale trace on the task it is for
    await indexRepo(graph, project, { traceFor: { taskId: task.id } });
    expect((await listTraces(graph, task.id)).some((t) => t.kind === 'stale')).toBe(true);
  });
});
