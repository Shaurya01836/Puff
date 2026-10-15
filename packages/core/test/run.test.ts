// The P3 loop with fake agents standing in for the CLIs: real git worktrees, real FalkorDB, and for
// the headline scenario the demo repo's real test suite. The fakes are deterministic, so what is
// being tested is Puff: context, verification, failure memory, retry, escalation and merging.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
import { getContextPack } from '../src/context/compiler';
import { connect, loadDotEnv, read } from '../src/db/client';
import { initProjectGraph } from '../src/db/init';
import { removeLink, GitRepo } from '../src/git/repo';
import { graphName } from '../src/ids';
import { indexRepo } from '../src/indexer/index';
import { parsePuffReport } from '../src/memory/report';
import { listSessions } from '../src/memory/sessions';
import { createTask, getTask, listTasks } from '../src/memory/tasks';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { runTask, type RunDeps } from '../src/orchestrator/run';

const rel = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const DEMO = rel('../../../demo/shop-api');
const config = parseConfig(readFileSync(rel('../../../puff.config.yaml'), 'utf8'));
// Scenarios that are not about the tests themselves use a command that passes instantly.
const FAST: PuffConfig = {
  ...config,
  verify: { ...config.verify, testCommand: `node -e "console.log('Tests  3 passed (3)')"` },
};

loadDotEnv(rel('../../../.env'));
const db = await connect().catch(() => undefined);
const hasDemoDeps = existsSync(join(DEMO, 'node_modules', 'vitest'));
const ready = Boolean(db) && hasDemoDeps;

type Fake = HarnessAdapter & { calls: RunOptions[] };

/** An agent whose behaviour is a function. Tokens are fixed so totals are predictable. */
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
      // Real adapters parse the <puff-report> block out of the agent's text; the fake must too.
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

const edit = (cwd: string, file: string, from: string, to: string) => {
  const path = join(cwd, file);
  const src = readFileSync(path, 'utf8');
  if (!src.includes(from)) throw new Error(`fake agent: "${from}" not found in ${file}`);
  writeFileSync(path, src.replace(from, to));
};

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

describe.skipIf(!ready)('the run loop (fake agents, real git, real FalkorDB)', () => {
  const cleanups: (() => Promise<void>)[] = [];
  let counter = 0;
  afterAll(async () => {
    for (const c of cleanups) await c();
    await db?.close();
  });

  /** A fresh git project from the demo repo, with its own graph. */
  async function fixture(cfg: PuffConfig, adapters: Adapters) {
    const slug = `test_run_${process.pid}_${++counter}`;
    const repoPath = mkdtempSync(join(tmpdir(), 'puff-run-'));
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
      createTask(graph, slug, cfg, { title, targets: ['login'], ...extra });
    const statuses = (taskId: string) =>
      events.flatMap((e) =>
        e.type === 'task:update' && e.task.id === taskId ? [e.task.status] : [],
      );
    return { deps, graph, repoPath, events, logs, task, statuses, slug };
  }

  it('attempt 1 trips the password trap, the failure lands on the right function, attempt 2 gets the lesson and passes', async () => {
    const lessonSeen: boolean[] = [];
    const codex = fakeAgent('codex', (o, n) => {
      lessonSeen.push(o.prompt.includes('never writes a password to the logs'));
      const logCall = "audit('login.failed', { email });";
      if (n === 1)
        edit(o.cwd, 'src/auth/login.ts', logCall, "audit('login.failed', { email, password });");
      else
        edit(
          o.cwd,
          'src/auth/login.ts',
          logCall,
          "audit('login.failed', { email, reason: 'invalid credentials' });",
        );
      return {
        output:
          'Audited failed logins.\n<puff-report>{"decisions":[{"symbol":"checkUser","text":"Failed logins are audited with the email and a reason, never request data"}],"notes":"Audit failed logins with the email and a reason only"}</puff-report>',
      };
    });
    const f = await fixture(config, { codex });
    const t = await f.task('Log failed login attempts', { targets: ['login', 'checkUser'] });

    const result = await runTask(f.deps, t.id);

    expect(result.status).toBe('done');
    expect(result.attempts.map((a) => [a.agent, a.outcome])).toEqual([
      ['codex', 'failure'],
      ['codex', 'success'],
    ]);
    expect(lessonSeen).toEqual([false, true]); // attempt 2's prompt carried what attempt 1 taught
    expect(codex.calls[1]!.prompt).toContain('no fix recorded yet, avoid repeating it');

    // The failure is anchored to the function that contains the bad line, found through the diff.
    const failures = await read<{ message: string; by: string; symbol: string; stale: boolean }>(
      f.graph,
      `MATCH (f:Failure)-[:IN]->(s:Symbol) RETURN f.message AS message, f.anchoredBy AS by, s.id AS symbol, f.stale AS stale`,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      by: 'diff',
      symbol: 'src/auth/login.ts::checkUser',
      stale: false,
    });
    expect(failures[0]!.message).toMatch(/never writes a password to the logs/);

    // Attempt 2's recorded context says why the failure was included.
    const [s1, s2] = await listSessions(f.graph, t.id);
    expect([s1!.outcome, s2!.outcome]).toEqual(['failure', 'success']);
    const pack = await getContextPack(f.graph, s2!.id);
    expect(pack!.items.find((i) => i.kind === 'Failure')?.reason).toMatch(
      /^failed in checkUser\(\)/,
    );

    // The fix was learned: failure --FIXED_BY--> solution, with the merge commit.
    const fixes = await read<{ summary: string; commit: string }>(
      f.graph,
      `MATCH (:Failure)-[:FIXED_BY]->(s:Solution) RETURN s.summary AS summary, s.commit AS commit`,
    );
    expect(fixes).toEqual([
      {
        summary: 'Audit failed logins with the email and a reason only',
        commit: gitIn(f.repoPath, 'rev-parse', 'HEAD'),
      },
    ]);
    // The agent's decision from its puff-report was recorded too.
    const decisions = await read<{ text: string }>(
      f.graph,
      `MATCH (d:Decision)-[:ABOUT]->(:Symbol {id: 'src/auth/login.ts::checkUser'}) RETURN d.text AS text`,
    );
    expect(decisions.map((d) => d.text)).toEqual([
      'Failed logins are audited with the email and a reason, never request data',
    ]);

    // The task, its totals and its live status trail.
    expect(await getTask(f.graph, t.id)).toMatchObject({
      status: 'done',
      assignedAgent: 'codex',
      tokens: { in: 2000, out: 200 },
      testSummary: { passed: 25, total: 25 },
    });
    const trail = f.statuses(t.id);
    const order = ['running', 'verifying', 'retrying', 'running', 'verifying', 'done'];
    let at = -1;
    for (const s of order) {
      at = trail.indexOf(s as never, at + 1);
      expect(at, `${s} in ${trail.join(' → ')}`).toBeGreaterThan(-1);
    }
    expect(f.events.some((e) => e.type === 'session:update')).toBe(true);
    expect(f.events.some((e) => e.type === 'memory' && e.event.type === 'failure_recorded')).toBe(
      true,
    );

    // Git: the fix is merged, the passing branch is gone, the failed attempt's branch is kept, no worktrees remain.
    expect(readFileSync(join(f.repoPath, 'src/auth/login.ts'), 'utf8')).toContain(
      "reason: 'invalid credentials'",
    );
    expect(gitIn(f.repoPath, 'log', '--oneline')).toMatch(/Merge puff task/);
    expect(gitIn(f.repoPath, 'branch', '--list', 'puff/*')).toContain(`puff/${t.id}-a1`);
    expect(gitIn(f.repoPath, 'branch', '--list', 'puff/*')).not.toContain(`-a2`);
    const leftover = existsSync(join(f.repoPath, '.puff', 'worktrees'))
      ? readdirSync(join(f.repoPath, '.puff', 'worktrees'))
      : [];
    expect(leftover).toEqual([]);
    expect(existsSync(join(DEMO, 'node_modules', 'vitest'))).toBe(true); // worktree cleanup never touched the real dependencies
  }, 240_000);

  it('an agent that cannot run (not signed in) is an error, not a failure lesson, and the task escalates', async () => {
    const opencode = fakeAgent('opencode', () => ({
      output: '',
      error: { kind: 'auth', message: 'Failed to authenticate: session expired' },
      tokensIn: 0,
      tokensOut: 0,
    }));
    const codex = fakeAgent('codex', (o) => {
      edit(
        o.cwd,
        'src/cart/tax.ts',
        'export function taxFor',
        '// documented\nexport function taxFor',
      );
      return { output: 'Added a comment.' };
    });
    const f = await fixture(FAST, { opencode, codex });
    const t = await f.task('Document taxFor', { targets: ['taxFor'] });

    const result = await runTask(f.deps, t.id, { agent: 'opencode' });

    expect(result.status).toBe('done');
    expect(result.attempts.map((a) => [a.agent, a.outcome])).toEqual([
      ['opencode', 'error'],
      ['codex', 'success'],
    ]);
    expect(f.deps.unavailable?.get('opencode')).toMatch(/authenticate/);
    expect((await listSessions(f.graph, t.id)).map((s) => s.outcome)).toEqual(['error', 'success']);
    expect(await read(f.graph, `MATCH (f:Failure) RETURN f.id`)).toEqual([]); // a login problem teaches nothing about code
    expect(f.statuses(t.id)).toContain('escalated');
  }, 120_000);

  it('a writer that changes nothing is a failure (it must not pass on the old tests), with no lesson recorded', async () => {
    const codex = fakeAgent('codex', () => ({ output: 'I looked and everything seems fine.' }));
    const f = await fixture(FAST, { codex });
    const t = await f.task('Add lockout');

    const result = await runTask(f.deps, t.id);

    expect(result.status).toBe('failed');
    expect(result.attempts).toHaveLength(1);
    expect(result.reason).toMatch(/changed no files/);
    expect((await listSessions(f.graph, t.id))[0]!.outcome).toBe('failure');
    expect(await read(f.graph, `MATCH (f:Failure) RETURN f.id`)).toEqual([]);
    expect(await getTask(f.graph, t.id)).toMatchObject({ status: 'failed' });
  }, 120_000);

  it('stops cleanly when asked: the agent is told, the task goes back to the queue, nothing is left behind', async () => {
    const codex = fakeAgent(
      'codex',
      (o) =>
        new Promise((resolve) =>
          o.signal!.addEventListener('abort', () =>
            resolve({ output: '', error: { kind: 'aborted', message: 'Stopped by the user' } }),
          ),
        ),
    );
    const f = await fixture(FAST, { codex });
    const t = await f.task('Slow task');
    const ctl = new AbortController();
    const running = runTask({ ...f.deps, signal: ctl.signal }, t.id);
    setTimeout(() => ctl.abort(), 1500);

    expect((await running).status).toBe('aborted');
    expect((await getTask(f.graph, t.id))!.status).toBe('planned');
    expect((await listSessions(f.graph, t.id))[0]).toMatchObject({ outcome: 'error' });
    expect(readdirSync(join(f.repoPath, '.puff', 'worktrees'))).toEqual([]);
  }, 60_000);

  it('read-only roles (the planner) produce a plan: no worktree changes, no merge', async () => {
    const claude = fakeAgent('claude-code', () => ({
      output:
        'Plan: audit failed logins.\n<puff-report>{"tasks":[{"title":"Audit failed logins","targets":["login"]}]}</puff-report>',
    }));
    const f = await fixture(FAST, { 'claude-code': claude });
    const t = await f.task('Plan: harden login', { type: 'plan', complexity: 'high', targets: [] });
    const head = gitIn(f.repoPath, 'rev-parse', 'HEAD');

    const result = await runTask(f.deps, t.id);

    expect(result.status).toBe('done');
    expect((await listTasks(f.graph)).map((x) => x.title)).toContain('Audit failed logins');
    expect(claude.calls[0]).toMatchObject({ role: 'planner' });
    expect(claude.calls[0]!.prompt).toContain('You are the planner');
    expect(gitIn(f.repoPath, 'rev-parse', 'HEAD')).toBe(head);
    expect(await getTask(f.graph, t.id)).toMatchObject({
      status: 'done',
      assignedAgent: 'claude-code',
      role: 'planner',
    });
  }, 60_000);

  it('the orchestrator works through ready tasks in dependency order and leaves blocked ones waiting', async () => {
    const codex = fakeAgent('codex', (o) => {
      if (o.prompt.includes('TASK: fail me')) return { output: 'no change' };
      edit(
        o.cwd,
        'src/cart/tax.ts',
        'export function taxFor',
        `// ${o.prompt.match(/TASK: (.+)/)![1]}\nexport function taxFor`,
      );
      return { output: 'ok' };
    });
    const f = await fixture(FAST, { codex });
    const a = await f.task('first', { targets: ['taxFor'] });
    const b = await f.task('second', { targets: ['taxFor'], dependsOn: [a.id] });
    const bad = await f.task('fail me', { targets: ['taxFor'] });
    const z = await f.task('blocked behind the failure', {
      targets: ['taxFor'],
      dependsOn: [bad.id],
    });
    const { repo, graph, project, config: cfg, adapters, emit, log } = f.deps;

    const orch = new Orchestrator({ repo, graph, project, config: cfg, adapters, emit, log });
    const results = await orch.start();

    expect(results.map((r) => [r.taskId, r.status])).toEqual([
      [a.id, 'done'],
      [b.id, 'done'],
      [bad.id, 'failed'],
    ]);
    expect((await listTasks(graph)).map((t) => [t.title, t.status])).toEqual([
      ['first', 'done'],
      ['second', 'done'],
      ['fail me', 'failed'],
      ['blocked behind the failure', 'planned'],
    ]);
    expect(z.status).toBe('planned');
    expect(f.logs.join('\n')).toMatch(/1 task\(s\) are waiting/);
    expect(orch.running).toBe(false);
    // both merged changes are in main: second ran on top of first
    const tax = readFileSync(join(f.repoPath, 'src/cart/tax.ts'), 'utf8');
    expect(tax).toContain('// first');
    expect(tax).toContain('// second');
  }, 120_000);

  it('stop() ends the loop, and tasks left half-run by a crash are put back in the queue on the next start', async () => {
    const hang = fakeAgent(
      'codex',
      (o) =>
        new Promise((resolve) =>
          o.signal!.addEventListener('abort', () =>
            resolve({ output: '', error: { kind: 'aborted', message: 'stop' } }),
          ),
        ),
    );
    const f = await fixture(FAST, { codex: hang });
    const t = await f.task('hangs');
    const { repo, graph, project, config: cfg, adapters, emit, log } = f.deps;
    const orch = new Orchestrator({ repo, graph, project, config: cfg, adapters, emit, log });

    const done = orch.start();
    await new Promise((r) => setTimeout(r, 1500));
    expect(orch.running).toBe(true);
    await orch.stop();
    expect((await done).map((r) => r.status)).toEqual(['aborted']);
    expect(orch.running).toBe(false);

    // simulate a crash: the task is stuck 'running' with a session that never finished
    await read(graph, `RETURN 1`);
    const { updateTask } = await import('../src/memory/tasks');
    const { startSession } = await import('../src/memory/sessions');
    await updateTask(graph, t.id, { status: 'running' });
    await startSession(graph, { agent: 'codex', taskId: t.id, role: 'coder' });
    const again = new Orchestrator({
      repo,
      graph,
      project,
      config: cfg,
      adapters: { codex: fakeAgent('codex', () => ({ output: 'nothing' })) },
      emit,
      log,
    });
    await again.start();
    expect(f.logs.join('\n')).toMatch(/reset 1 interrupted task/);
    const outcomes = (await listSessions(graph, t.id)).map((s) => s.outcome);
    expect(outcomes).not.toContain('running'); // the orphaned session was closed
  }, 120_000);
});
