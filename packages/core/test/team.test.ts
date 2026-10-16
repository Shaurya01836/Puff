// P4: the planner, follow-up tasks, overlap-aware parallel runs, agent slots and atomic claims.
// Fake agents stand in for the CLIs, so what is tested is Puff's coordination.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentName, PuffEvent } from '@puff/shared';
import { afterAll, describe, expect, it } from 'vitest';
import type { Adapters } from '../src/agents/adapters';
import type { HarnessAdapter, HarnessResult, RunOptions } from '../src/agents/types';
import { parseConfig, type PuffConfig } from '../src/config';
import { renderPrompt, type PromptInput } from '../src/context/prompt';
import { connect, loadDotEnv, read } from '../src/db/client';
import { initProjectGraph } from '../src/db/init';
import { GitRepo, removeLink } from '../src/git/repo';
import { graphName } from '../src/ids';
import { indexRepo } from '../src/indexer/index';
import { spawnTasks } from '../src/memory/plan';
import { parsePuffReport } from '../src/memory/report';
import { createTask, claimTask, getTask, listTasks, updateTask } from '../src/memory/tasks';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { runTask, type RunDeps } from '../src/orchestrator/run';
import { SlotPool, overlappingTasks } from '../src/orchestrator/schedule';

const rel = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const DEMO = rel('../../../demo/shop-api');
const config = parseConfig(readFileSync(rel('../../../puff.config.yaml'), 'utf8'));
const FAST: PuffConfig = {
  ...config,
  verify: { ...config.verify, testCommand: `node -e "console.log('Tests  3 passed (3)')"` },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// No database needed
// ---------------------------------------------------------------------------------------------

describe('SlotPool', () => {
  it('lets an agent run only as many tasks at once as it has slots, in order', async () => {
    const pool = new SlotPool({ codex: 2 });
    const a = await pool.acquire('codex');
    const b = await pool.acquire('codex');
    expect(pool.inUse('codex')).toBe(2);

    const order: string[] = [];
    const c = pool.acquire('codex').then((r) => (order.push('c'), r));
    const d = pool.acquire('codex').then((r) => (order.push('d'), r));
    await sleep(30);
    expect(order).toEqual([]); // both still waiting

    a();
    const releaseC = await c;
    expect(order).toEqual(['c']);
    expect(pool.inUse('codex')).toBe(2);
    b();
    const releaseD = await d;
    expect(order).toEqual(['c', 'd']);
    releaseC();
    releaseD();
    releaseD(); // releasing twice must not free a slot twice
    expect(pool.inUse('codex')).toBe(0);
  });

  it('keeps agents separate and cancels a wait when aborted', async () => {
    const pool = new SlotPool({ opencode: 1 });
    const held = await pool.acquire('opencode');
    await expect(pool.acquire('claude-code')).resolves.toBeTypeOf('function'); // unlisted agents get 1
    const ctl = new AbortController();
    const waiting = pool.acquire('opencode', ctl.signal);
    ctl.abort();
    await expect(waiting).rejects.toThrow(/aborted/);
    held();
    expect(pool.inUse('opencode')).toBe(0); // the cancelled waiter never took the slot
    await expect(pool.acquire('opencode', ctl.signal)).rejects.toThrow(/aborted/);
  });
});

describe('puff-report: plans and follow-up tasks', () => {
  it('reads a plan, and is forgiving about the loose JSON models write', () => {
    const { report, error } = parsePuffReport(
      `<puff-report>{"tasks":[
        {"title":"A","type":"implement","targets":["login"],"dependsOn":[]},
        {"title":"B","type":"banana","complexity":"huge","targets":"cartTotal","dependsOn":["0"]}
      ],"handoffs":[{"toRole":"coder","summary":"start with A"}],"notes":"n"}</puff-report>`,
    );
    expect(error).toBeUndefined();
    expect(report?.tasks).toEqual([
      { title: 'A', type: 'implement', targets: ['login'], dependsOn: [] },
      {
        title: 'B',
        type: undefined,
        complexity: undefined,
        targets: ['cartTotal'],
        dependsOn: [0],
      },
    ]);
    expect(report?.handoffs).toEqual([{ toRole: 'coder', summary: 'start with A' }]);
  });

  it('rejects a task with no title but keeps explaining why', () => {
    expect(
      parsePuffReport('<puff-report>{"tasks":[{"type":"chore"}]}</puff-report>').error,
    ).toMatch(/Invalid/);
  });
});

describe('prompts', () => {
  const base: PromptInput = {
    role: 'planner',
    title: 'Add rate limiting to login',
    targets: [],
    callers: [],
    failures: [],
    decisions: [],
    procedures: [],
    handoffs: [],
    technologies: ['Express'],
    codeMap: [
      { file: 'src/auth/login.ts', symbols: ['login', 'checkUser'] },
      { file: 'src/cart/cart.ts', symbols: ['cartTotal'] },
    ],
    boardTitles: ['Document the API'],
    maxTasks: 5,
  };

  it('gives the planner a code map, the board, the exact format and the safety rules', () => {
    const p = renderPrompt(base);
    expect(p).toContain('GOAL: Add rate limiting to login');
    expect(p).toContain('- src/auth/login.ts: login, checkUser');
    expect(p).toContain('TASKS ALREADY ON THE BOARD');
    expect(p).toContain('- Document the API');
    expect(p).toContain('<puff-report>{"tasks":[{"title"');
    expect(p).toContain('At most 5 tasks');
    expect(p).toContain('MUST depend on each other');
    expect(p).toContain('Do not change any files');
    expect(p).not.toContain('WHEN DONE'); // the coder footer does not apply to a planner
  });

  it('tells a coder about code the plan mentions that does not exist yet', () => {
    const p = renderPrompt({
      ...base,
      role: 'coder',
      title: 'Add a limiter',
      hints: ['rateLimit'],
    });
    expect(p).toContain('NEW OR UNRESOLVED CODE THIS TASK MENTIONS: rateLimit');
    expect(p).toContain('WHEN DONE');
  });
});

// ---------------------------------------------------------------------------------------------
// With FalkorDB, git and the demo's dependencies
// ---------------------------------------------------------------------------------------------

loadDotEnv(rel('../../../.env'));
const db = await connect().catch(() => undefined);
const ready = Boolean(db) && existsSync(join(DEMO, 'node_modules', 'vitest'));

type Fake = HarnessAdapter & { calls: RunOptions[] };

function fakeAgent(
  name: AgentName,
  behave: (o: RunOptions, n: number) => Promise<Partial<HarnessResult>> | Partial<HarnessResult>,
): Fake {
  const calls: RunOptions[] = [];
  return {
    name,
    calls,
    available: async () => ({ ok: true, detail: 'fake' }),
    async run(o) {
      calls.push(o);
      const r = await behave(o, calls.length);
      const output = r.output ?? 'done';
      const { report, error: reportError } = parsePuffReport(output);
      return {
        exitCode: 0,
        output,
        report,
        reportError,
        durationMs: 5,
        raw: '',
        tokensIn: 1000,
        tokensOut: 100,
        ...r,
      };
    },
  };
}

const appendComment = (cwd: string, file: string, text: string) => {
  const path = join(cwd, file);
  writeFileSync(path, `${readFileSync(path, 'utf8')}\n// ${text}\n`);
};
const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
const titleOf = (o: RunOptions) => o.prompt.match(/TASK: (.+)/)?.[1] ?? '';

describe.skipIf(!ready)('coordination (fake agents, real git, real FalkorDB)', () => {
  const cleanups: (() => Promise<void>)[] = [];
  let counter = 0;
  afterAll(async () => {
    for (const c of cleanups) await c();
    await db?.close();
  });

  async function fixture(cfg: PuffConfig, adapters: Adapters) {
    const slug = `test_team_${process.pid}_${++counter}`;
    const repoPath = mkdtempSync(join(tmpdir(), 'puff-team-'));
    for (const f of ['src', 'test', 'package.json', 'tsconfig.json'])
      cpSync(join(DEMO, f), join(repoPath, f), { recursive: true });
    writeFileSync(join(repoPath, '.gitignore'), 'node_modules\n');
    symlinkSync(
      join(DEMO, 'node_modules'),
      join(repoPath, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    gitIn(repoPath, 'init', '-q', '-b', 'main');
    gitIn(repoPath, 'add', '-A');
    gitIn(repoPath, 'commit', '-q', '-m', 'initial');
    const project = { slug, name: slug, repoPath };
    const graph = await initProjectGraph(db!, project, cfg);
    await indexRepo(graph, project);
    const repo = await GitRepo.open(repoPath, cfg.worktrees.linkDirs);
    const events: PuffEvent[] = [];
    const logs: string[] = [];
    const deps: RunDeps = {
      graph,
      project,
      config: cfg,
      repo,
      adapters,
      emit: (e) => events.push(e),
      log: (l) => logs.push(l),
    };
    cleanups.push(async () => {
      await db!
        .selectGraph(graphName(slug))
        .delete()
        .catch(() => {});
      await removeLink(join(repoPath, 'node_modules'));
      rmSync(repoPath, { recursive: true, force: true });
    });
    const task = (title: string, extra: Partial<Parameters<typeof createTask>[3]> = {}) =>
      createTask(graph, slug, cfg, { title, ...extra });
    const orchestrator = () => {
      const { repo: r, graph: g, project: p, config: c, adapters: a, emit, log } = deps;
      return new Orchestrator({ repo: r, graph: g, project: p, config: c, adapters: a, emit, log });
    };
    return { deps, graph, repoPath, events, logs, task, orchestrator, slug };
  }

  it('spawnTasks: dependencies only point backwards, duplicates and oversized plans are cut, unknown names become hints', async () => {
    const f = await fixture(FAST, {});
    const plan = await f.task('Plan', { type: 'plan' });
    const ctx = { projectId: f.slug, config: FAST, sessionId: 'ses_none', parent: plan };
    // a session is needed for the SPAWNED edge; create one properly
    const { startSession } = await import('../src/memory/sessions');
    const sessionId = await startSession(f.graph, {
      agent: 'claude-code',
      taskId: plan.id,
      role: 'planner',
    });

    const result = await spawnTasks(f.graph, { ...ctx, sessionId }, [
      { title: 'First', targets: ['login'] },
      { title: 'Second', targets: ['checkUser'], dependsOn: [0] },
      { title: 'Third', targets: ['brandNewHelper'], dependsOn: [1, 0, 2, 9, -1] }, // self (2), future (9) and negative are dropped
      { title: 'first' }, // same title as an existing task: skipped
    ]);
    const [a, b, c] = result.created;
    expect(result.created.map((t) => t.title)).toEqual(['First', 'Second', 'Third']);
    expect(a!.targets).toEqual(['src/auth/login.ts::login']);
    expect(b!.dependsOn).toEqual([a!.id]);
    expect(c!.dependsOn.sort()).toEqual([a!.id, b!.id].sort());
    expect(c!.hints).toEqual(['brandNewHelper']);
    expect(c!.targets).toEqual([]);
    expect(result.skipped).toEqual([
      { title: 'first', reason: expect.stringContaining('already on the board') },
    ]);
    expect(result.created.every((t) => t.depth === 1)).toBe(true);
    const spawned = await read<{ n: number }>(
      f.graph,
      `MATCH (:Session {id: $s})-[:SPAWNED]->(t:Task) RETURN count(t) AS n`,
      { s: sessionId },
    );
    expect(spawned[0]!.n).toBe(3);

    // size cap
    const many = await spawnTasks(
      f.graph,
      { ...ctx, sessionId },
      Array.from({ length: 12 }, (_, i) => ({ title: `bulk ${i}` })),
    );
    expect(many.created).toHaveLength(FAST.limits.maxTasksPerPlan);
    expect(many.skipped).toHaveLength(12 - FAST.limits.maxTasksPerPlan);
  }, 60_000);

  it('spawnTasks: agents cannot spawn work forever (depth limit)', async () => {
    const f = await fixture(FAST, {});
    const deep = { ...(await f.task('Deep task')), depth: FAST.limits.maxSpawnDepth };
    const { startSession } = await import('../src/memory/sessions');
    const sessionId = await startSession(f.graph, {
      agent: 'codex',
      taskId: deep.id,
      role: 'coder',
    });
    const result = await spawnTasks(
      f.graph,
      { projectId: f.slug, config: FAST, sessionId, parent: deep },
      [{ title: 'one more' }],
    );
    expect(result.created).toEqual([]);
    expect(result.skipped[0]!.reason).toMatch(/level\(s\) deep/);
  }, 60_000);

  it('Q8: tasks overlap when they share a target or targets a call apart; read-only tasks and unrelated code do not', async () => {
    const f = await fixture(FAST, {});
    const running = await f.task('Edit login', { targets: ['login'] });
    await updateTask(f.graph, running.id, { status: 'running' });

    const sameTarget = await f.task('Also login', { targets: ['login'] });
    const callee = await f.task('Edit checkUser (login calls it)', { targets: ['checkUser'] });
    const caller = await f.task('Edit authRouter (calls login)', { targets: ['authRouter'] });
    const unrelated = await f.task('Edit cartTotal', { targets: ['cartTotal'] });
    const planner = await f.task('Plan', { type: 'plan', targets: ['login'] });
    const noTargets = await f.task('Somewhere in the code', { targets: [] });

    expect(await overlappingTasks(f.graph, (await getTask(f.graph, sameTarget.id))!)).toEqual([
      running.id,
    ]);
    expect(await overlappingTasks(f.graph, (await getTask(f.graph, callee.id))!)).toEqual([
      running.id,
    ]);
    expect(await overlappingTasks(f.graph, (await getTask(f.graph, caller.id))!)).toEqual([
      running.id,
    ]);
    expect(await overlappingTasks(f.graph, (await getTask(f.graph, unrelated.id))!)).toEqual([]);
    expect(await overlappingTasks(f.graph, (await getTask(f.graph, planner.id))!)).toEqual([]);
    // unknown footprint: waits for every other writer
    expect(await overlappingTasks(f.graph, (await getTask(f.graph, noTargets.id))!)).toEqual([
      running.id,
    ]);
    // a docs chore with no targets edits files outside the code graph: it runs next to code tasks
    const docs = await f.task('Document the route', { type: 'chore', targets: [] });
    expect(await overlappingTasks(f.graph, (await getTask(f.graph, docs.id))!)).toEqual([]);
    // and a running task with unknown footprint blocks everything that writes
    await updateTask(f.graph, running.id, { status: 'done' });
    await updateTask(f.graph, noTargets.id, { status: 'running' });
    expect(await overlappingTasks(f.graph, (await getTask(f.graph, unrelated.id))!)).toEqual([
      noTargets.id,
    ]);
    expect(await overlappingTasks(f.graph, (await getTask(f.graph, docs.id))!)).toEqual([
      noTargets.id,
    ]);
    // two docs chores still take turns
    await updateTask(f.graph, noTargets.id, { status: 'done' });
    await updateTask(f.graph, docs.id, { status: 'running' });
    const moreDocs = await f.task('Fix README typos', { type: 'chore', targets: [] });
    expect(await overlappingTasks(f.graph, (await getTask(f.graph, moreDocs.id))!)).toEqual([
      docs.id,
    ]);
    expect(await overlappingTasks(f.graph, (await getTask(f.graph, unrelated.id))!)).toEqual([]);
  }, 60_000);

  it('Q9: when two schedulers race for one task, exactly one wins', async () => {
    const f = await fixture(FAST, {});
    const t = await f.task('Contested', { targets: ['login'] });
    await updateTask(f.graph, t.id, { status: 'ready', blockedBy: ['task_x'] });
    const wins = await Promise.all(
      Array.from({ length: 8 }, (_, i) => claimTask(f.graph, t.id, `owner-${i}`)),
    );
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(await getTask(f.graph, t.id)).toMatchObject({ status: 'running', blockedBy: undefined });
    expect(await claimTask(f.graph, t.id, 'late')).toBe(false); // no longer ready
  }, 60_000);

  it('a planner turns a goal into tasks with dependencies; the team then runs them, each with the right agent', async () => {
    const claude = fakeAgent('claude-code', () => ({
      output:
        'Plan: lockout first, docs after, and a helper that does not exist yet.\n' +
        '<puff-report>{"tasks":[' +
        '{"title":"Add login lockout","type":"implement","targets":["login"]},' +
        '{"title":"Document the lockout","type":"chore","targets":["authRouter"],"dependsOn":[0]},' +
        '{"title":"Add a brand new helper","type":"implement","targets":["notYetThere"],"dependsOn":[0,1]}' +
        ']}</puff-report>',
    }));
    const codex = fakeAgent('codex', (o) => {
      appendComment(
        o.cwd,
        titleOf(o).includes('helper') ? 'src/cart/tax.ts' : 'src/auth/login.ts',
        titleOf(o),
      );
      return { output: 'done' };
    });
    const opencode = fakeAgent('opencode', (o) => {
      appendComment(o.cwd, 'src/routes/auth.ts', titleOf(o));
      return { output: 'documented' };
    });
    const f = await fixture(FAST, { 'claude-code': claude, codex, opencode });
    const goal = await f.task('Plan: harden login', {
      type: 'plan',
      complexity: 'high',
      targets: [],
    });

    const results = await f.orchestrator().start();

    expect(results.map((r) => r.status)).toEqual(['done', 'done', 'done', 'done']);
    const tasks = await listTasks(f.graph);
    expect(tasks.map((t) => [t.title, t.status, t.assignedAgent])).toEqual([
      ['Plan: harden login', 'done', 'claude-code'],
      ['Add login lockout', 'done', 'codex'],
      ['Document the lockout', 'done', 'opencode'], // chore: simple-edit/docs belong to OpenCode
      ['Add a brand new helper', 'done', 'codex'],
    ]);
    const [, lock, docs, helper] = tasks;
    expect(docs!.dependsOn).toEqual([lock!.id]);
    expect(helper!.dependsOn.sort()).toEqual([lock!.id, docs!.id].sort());
    expect(helper!.hints).toEqual(['notYetThere']);
    expect(codex.calls.find((c) => titleOf(c).includes('helper'))!.prompt).toContain(
      'NEW OR UNRESOLVED CODE THIS TASK MENTIONS: notYetThere',
    );
    // the planner saw the code map and was read-only
    expect(claude.calls[0]).toMatchObject({ role: 'planner' });
    expect(claude.calls[0]!.prompt).toMatch(/- src\/auth\/login\.ts: .*\blogin\b/);
    expect(claude.calls[0]!.prompt).not.toContain('.constructor');
    // who asked for what is recorded
    const spawned = await read<{ n: number }>(
      f.graph,
      `MATCH (:Session)-[:SPAWNED]->(t:Task) RETURN count(t) AS n`,
    );
    expect(spawned[0]!.n).toBe(3);
    expect(tasks[0]!.id).toBe(goal.id);
    // all three changes were merged, one on top of the other
    const log = gitIn(f.repoPath, 'log', '--oneline');
    expect(log.match(/Merge puff task/g)).toHaveLength(3);
  }, 120_000);

  it('a plan that creates no tasks is a failure, not a success', async () => {
    const claude = fakeAgent('claude-code', () => ({
      output: 'I think we should just be careful.',
    }));
    const f = await fixture(FAST, { 'claude-code': claude });
    const goal = await f.task('Plan: vague', { type: 'plan', targets: [] });
    const result = await runTask(f.deps, goal.id, { agent: 'claude-code' });
    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/no plan/);
    expect(await listTasks(f.graph)).toHaveLength(1);
  }, 60_000);

  it('independent tasks run in parallel, overlapping ones wait (and say what for), and an agent never exceeds its slots', async () => {
    const spans: Record<string, { start: number; end: number }> = {};
    let active = 0;
    let peak = 0;
    const codex = fakeAgent('codex', async (o) => {
      const title = titleOf(o);
      active++;
      peak = Math.max(peak, active);
      spans[title] = { start: Date.now(), end: 0 };
      await sleep(2500); // long enough that two slow worktree creations still overlap
      const file = title.includes('login')
        ? 'src/auth/login.ts'
        : title.includes('cart')
          ? 'src/cart/cart.ts'
          : 'src/products/products.ts';
      appendComment(o.cwd, file, title);
      spans[title]!.end = Date.now();
      active--;
      return { output: 'ok' };
    });
    const f = await fixture(FAST, { codex });
    const a = await f.task('login one', { targets: ['login'] });
    const b = await f.task('login two', { targets: ['login'] }); // overlaps a
    const c = await f.task('cart work', { targets: ['cartTotal'] });
    const d = await f.task('products work', { targets: ['listProducts'] });

    const results = await f.orchestrator().start();

    expect(results.map((r) => r.status).sort()).toEqual(['done', 'done', 'done', 'done']);
    // a and c ran at the same time; b started only after a had finished
    expect(spans['cart work']!.start).toBeLessThan(spans['login one']!.end);
    expect(spans['login one']!.start).toBeLessThan(spans['cart work']!.end);
    expect(spans['login two']!.start).toBeGreaterThanOrEqual(spans['login one']!.end);
    // codex has 2 instances: three runnable tasks (a, c, d) never ran three at once
    expect(peak).toBe(2);
    // the board was told what b waited for, and cleared it when b started
    const blocked = f.events.filter(
      (e) => e.type === 'task:update' && e.task.id === b.id && e.task.blockedBy?.length,
    );
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked[0]!.type === 'task:update' && blocked[0]!.task.blockedBy).toEqual([a.id]);
    expect((await getTask(f.graph, b.id))!.blockedBy).toBeUndefined();
    expect(f.logs.some((l) => l.includes(`${b.id} waits for ${a.id}`))).toBe(true);
    void c;
    void d;
  }, 120_000);

  it('a coder can ask for follow-up work; it is created, attributed and run, and handoffs are recorded', async () => {
    const codex = fakeAgent('codex', (o) => {
      const title = titleOf(o);
      appendComment(
        o.cwd,
        title.startsWith('Add') ? 'src/auth/login.ts' : 'src/cart/tax.ts',
        title,
      );
      return title.startsWith('Add')
        ? {
            output:
              'Done. The API docs now need updating.\n<puff-report>{"tasks":[{"title":"Update the API docs for lockout","type":"chore","targets":["authRouter"]}],"handoffs":[{"toRole":"chore","summary":"Lockout returns 423 after 5 failures"}]}</puff-report>',
          }
        : { output: 'ok' };
    });
    const opencode = fakeAgent(
      'opencode',
      (o) => (appendComment(o.cwd, 'src/routes/auth.ts', titleOf(o)), { output: 'documented' }),
    );
    const f = await fixture(FAST, { codex, opencode });
    const origin = await f.task('Add lockout', { targets: ['login'] });

    const results = await f.orchestrator().start();

    expect(results).toHaveLength(2);
    const followUp = (await listTasks(f.graph)).find((t) =>
      t.title.startsWith('Update the API docs'),
    )!;
    expect(followUp).toMatchObject({ status: 'done', assignedAgent: 'opencode', depth: 1 });
    expect(origin.depth).toBe(0);
    // the handoff the coder left was delivered to the follow-up's context
    expect(opencode.calls[0]!.prompt).toContain('Lockout returns 423 after 5 failures');
  }, 120_000);

  it("honours a person's choice of agent and model for a task", async () => {
    const codex = fakeAgent(
      'codex',
      (o) => (appendComment(o.cwd, 'src/cart/tax.ts', 'x'), { output: 'ok' }),
    );
    const opencode = fakeAgent(
      'opencode',
      (o) => (appendComment(o.cwd, 'src/cart/tax.ts', 'y'), { output: 'ok' }),
    );
    const f = await fixture(FAST, { codex, opencode });
    const t = await f.task('Tweak tax', {
      targets: ['taxFor'],
      preferredAgent: 'opencode',
      model: 'opencode/big-pickle',
    });

    const results = await f.orchestrator().start();

    expect(results[0]!.status).toBe('done');
    expect(codex.calls).toHaveLength(0); // routing would have chosen codex
    expect(opencode.calls[0]).toMatchObject({ model: 'opencode/big-pickle' });
    expect(await getTask(f.graph, t.id)).toMatchObject({
      assignedAgent: 'opencode',
      preferredAgent: 'opencode',
      model: 'opencode/big-pickle',
    });
  }, 60_000);
});
