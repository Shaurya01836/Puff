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
import { connect, loadDotEnv, read, run as runQuery } from '../src/db/client';
import { initProjectGraph } from '../src/db/init';
import { listTraces } from '../src/db/trace';
import { removeLink, GitRepo } from '../src/git/repo';
import { graphName } from '../src/ids';
import { indexRepo } from '../src/indexer/index';
import { parsePuffReport } from '../src/memory/report';
import { listSessions, startSession } from '../src/memory/sessions';
import {
  createTask,
  getTask,
  listTasks,
  recoverInterrupted,
  updateTask,
} from '../src/memory/tasks';
import { ProjectController } from '../src/control/controller';
import { Orchestrator } from '../src/orchestrator/orchestrator';
import { readVerdict, runTask, type RunDeps } from '../src/orchestrator/run';

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

describe("reading a reviewer's verdict", () => {
  it('takes the last "verdict" line, bold or not, else a bare PASS or FAIL line', () => {
    expect(readVerdict('**Verdict: FAIL.** I could not run any checks.')).toBe('fail');
    expect(readVerdict('Looks good.\nVERDICT: PASS')).toBe('pass');
    expect(readVerdict('First verdict: pass\n...on second thought, verdict - FAIL')).toBe('fail');
    expect(readVerdict('Findings...\n\nFAIL\n')).toBe('fail');
    expect(readVerdict('Everything passed and nothing failed.')).toBeUndefined();
  });
});

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

    // Q19: every decision on the way left its queries behind, timed, with the decision in words.
    const traces = await listTraces(f.graph, t.id);
    const kinds = new Set(traces.map((x) => x.kind));
    expect([...kinds].sort()).toEqual(['context', 'locate', 'route', 'stale']);
    for (const x of traces) {
      expect(x.reason.length, x.kind).toBeGreaterThan(5);
      expect(x.steps.length, x.kind).toBeGreaterThan(0);
      expect(x.ms, x.kind).toBeGreaterThan(0);
      expect(x.steps[0]!.cypher).toMatch(/MATCH|CALL|UNWIND/);
    }
    expect(
      traces
        .filter((x) => x.kind === 'context')
        .map((x) => x.sessionId)
        .sort(),
    ).toEqual([s1!.id, s2!.id].sort());
    expect(traces.find((x) => x.kind === 'locate')).toMatchObject({ sessionId: s1!.id });
    expect(traces.find((x) => x.kind === 'locate')!.reason).toMatch(
      /pinned to checkUser\(\) by diff/,
    );
    expect(traces.find((x) => x.kind === 'route')!.reason).toMatch(/codex/);

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

  it('two agents in a row that change nothing stop the task, instead of a third one trying', async () => {
    const nothing = () => ({ output: 'Nothing needed changing: it is already there.' });
    const codex = fakeAgent('codex', nothing);
    const claude = fakeAgent('claude-code', nothing);
    const opencode = fakeAgent('opencode', nothing);
    const f = await fixture(FAST, { codex, 'claude-code': claude, opencode });
    const t = await f.task('Add lockout');

    const result = await runTask(f.deps, t.id);

    expect(result.status).toBe('failed');
    expect(result.attempts).toHaveLength(2);
    expect(result.reason).toMatch(/Two agents in a row found nothing to change/);
    expect(codex.calls.length + claude.calls.length + opencode.calls.length).toBe(2);
  }, 120_000);

  it('a task whose work already merged (the app closed before it was marked done) is done, not run again', async () => {
    const codex = fakeAgent('codex', (o) => {
      edit(
        o.cwd,
        'src/auth/login.ts',
        "audit('login.failed', { email });",
        "audit('login.failed', { email, reason: 'bad' });",
      );
      return { output: 'Added a reason.' };
    });
    const f = await fixture(FAST, { codex });
    const t = await f.task('Add a reason to failed logins');
    expect((await runTask(f.deps, t.id)).status).toBe('done');
    // the app closed between the merge and "done": the task is back in the queue
    await updateTask(f.graph, t.id, { status: 'ready' });

    const again = await runTask(f.deps, t.id);

    expect(again).toMatchObject({ status: 'done', attempts: [] });
    expect(again.reason).toMatch(/^Already merged in [0-9a-f]{7}/);
    expect(codex.calls).toHaveLength(1); // no agent was asked a second time
    expect((await getTask(f.graph, t.id))!.status).toBe('done');
  }, 120_000);

  it('a merge that was reverted does not count as done', async () => {
    const codex = fakeAgent('codex', (o) => {
      edit(
        o.cwd,
        'src/auth/login.ts',
        "audit('login.failed', { email });",
        "audit('login.failed', { email, reason: 'bad' });",
      );
      return { output: 'Added a reason.' };
    });
    const f = await fixture(FAST, { codex });
    const t = await f.task('Add a reason to failed logins');
    await runTask(f.deps, t.id);
    const sha = await f.deps.repo.landedMerge(t.id);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    gitIn(
      f.repoPath,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'revert',
      '--no-edit',
      '-m',
      '1',
      sha!,
    );
    expect(await f.deps.repo.landedMerge(t.id)).toBeUndefined();
  }, 120_000);

  it('a reviewer that ends with VERDICT: FAIL fails the review, and no other agent re-reviews it; it may run the checks', async () => {
    const claude = fakeAgent('claude-code', () => ({
      output: 'I ran the checks.\n1. Lint config does not match ESLint 8.\n\n**Verdict: FAIL**',
    }));
    const codex = fakeAgent('codex', () => ({ output: 'VERDICT: PASS' }));
    const f = await fixture(FAST, { 'claude-code': claude, codex });
    const t = await f.task('Review the copy buttons', { type: 'verify', targets: [] });

    const result = await runTask(f.deps, t.id);

    expect(result.status).toBe('failed');
    expect(result.attempts).toHaveLength(1);
    expect(result.reason).toMatch(/^review: FAIL/);
    expect(codex.calls).toHaveLength(0);
    expect((await listSessions(f.graph, t.id))[0]!.outcome).toBe('failure');
    expect(claude.calls[0]!.prompt).toContain('VERDICT: PASS or VERDICT: FAIL');
    expect(claude.calls[0]!.allowCommands).toContain(FAST.verify.testCommand);
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

  /**
   * Two tasks that each pass their tests alone but fail together: the project's check fails when both
   * a.txt and b.txt say X. Both agents finish before either merges (a gate), so both worktrees start
   * from the same code, which is exactly how two parallel tasks collide.
   */
  async function collidingTasks(cfg: PuffConfig) {
    const check = [
      "const fs = require('fs');",
      "const x = ['a.txt', 'b.txt'].filter((f) => fs.readFileSync(f, 'utf8').includes('X')).length;",
      "console.log(x > 1 ? 'Tests  1 failed (1)' : 'Tests  1 passed (1)');",
      'process.exit(x > 1 ? 1 : 0);',
    ].join('\n');
    let arrived = 0;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const agent = fakeAgent('codex', async (o, n) => {
      o.onActivity?.({ kind: 'read', text: 'Read a.txt', path: 'a.txt' });
      writeFileSync(join(o.cwd, n === 1 ? 'a.txt' : 'b.txt'), 'X\n');
      o.onActivity?.({ kind: 'edit', text: `Edited ${n === 1 ? 'a.txt' : 'b.txt'}` });
      if (++arrived === 2) open();
      await gate;
      return {};
    });
    const f = await fixture(cfg, { codex: agent });
    writeFileSync(join(f.repoPath, 'check.cjs'), check);
    writeFileSync(join(f.repoPath, 'a.txt'), 'a\n');
    writeFileSync(join(f.repoPath, 'b.txt'), 'b\n');
    gitIn(f.repoPath, 'add', '-A');
    gitIn(f.repoPath, 'commit', '-q', '-m', 'add check');
    const one = await f.task('Change a');
    const two = await f.task('Change b');
    const results = await Promise.all([
      runTask(f.deps, one.id, { agent: 'codex' }),
      runTask(f.deps, two.id, { agent: 'codex' }),
    ]);
    return { f, results, ids: [one.id, two.id] };
  }

  const COLLIDE: PuffConfig = {
    ...config,
    limits: { ...config.limits, maxAttempts: 1 },
    verify: { ...config.verify, testCommand: 'node check.cjs' },
  };

  it('tasks that pass alone but break together: the second merge is caught by the re-test, reverted, and remembered', async () => {
    const { f, results, ids } = await collidingTasks(COLLIDE);

    // One task landed; the other passed in its own worktree, failed on the combined code, and was undone.
    expect(results.map((r) => r.status).sort()).toEqual(['done', 'failed']);
    const failedIdx = results.findIndex((r) => r.status === 'failed');
    const failedId = ids[failedIdx]!;
    expect(results[failedIdx]!.attempts[0]).toMatchObject({ outcome: 'failure' });
    expect(results[failedIdx]!.reason).toMatch(/combined tests/);

    // The main checkout is green again: only the first task's change is in it, the revert is in history.
    const ax = readFileSync(join(f.repoPath, 'a.txt'), 'utf8').includes('X');
    const bx = readFileSync(join(f.repoPath, 'b.txt'), 'utf8').includes('X');
    expect([ax, bx].filter(Boolean)).toHaveLength(1);
    expect(execFileSync('node', ['check.cjs'], { cwd: f.repoPath, encoding: 'utf8' })).toMatch(
      /passed/,
    );
    expect(gitIn(f.repoPath, 'log', '--format=%s')).toMatch(/Revert "Merge puff task/);
    expect(gitIn(f.repoPath, 'status', '--porcelain')).toBe('');

    // What happened is on the record: failure memory for the task, and the steps with their phases.
    const failures = await read<{ message: string; task: string }>(
      f.graph,
      `MATCH (fl:Failure) RETURN fl.message AS message, fl.taskId AS task`,
    );
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures.some((x) => /fail/i.test(x.message))).toBe(true);
    const [session] = await listSessions(f.graph, failedId);
    expect(session!.outcome).toBe('failure');
    expect(session!.output).toMatch(/combined tests failed and the merge was reverted/);
    const texts = (session!.activity ?? []).map((a) => a.text);
    expect(texts).toEqual(
      expect.arrayContaining([
        'Read a.txt',
        expect.stringMatching(/^Running the tests: node check.cjs/),
        expect.stringMatching(/^Tests passed/),
        'Merged. Re-testing the combined result',
        'The combined tests failed. Running them once more to be sure',
        'Still failing, so the merge was undone with a revert commit',
      ]),
    );
    expect((session!.activity ?? []).find((a) => a.text.startsWith('Still failing'))?.ok).toBe(
      false,
    );

    // The steps also reached the UI live, in order, tagged with the task.
    const live = f.events.flatMap((e) =>
      e.type === 'activity' && e.step.taskId === failedId ? [e.step.text] : [],
    );
    expect(live).toEqual(texts);
  }, 180_000);

  it('retestAfterMerge: false skips the second run, so the same collision lands both tasks', async () => {
    const off: PuffConfig = { ...COLLIDE, verify: { ...COLLIDE.verify, retestAfterMerge: false } };
    const { f, results } = await collidingTasks(off);
    expect(results.map((r) => r.status)).toEqual(['done', 'done']);
    expect(gitIn(f.repoPath, 'log', '--format=%s')).not.toMatch(/Revert/);
    expect(f.logs.join('\n')).not.toMatch(/combined/);
  }, 180_000);

  it('when the combined tests pass, that is said in the steps and the task keeps the combined result', async () => {
    const f = await fixture(FAST, {
      codex: fakeAgent('codex', (o) => {
        edit(
          o.cwd,
          'src/auth/login.ts',
          "audit('login.failed', { email });",
          "audit('login.failed', { email, reason: 'x' });",
        );
        return {};
      }),
    });
    const t = await f.task('Log a reason');
    const result = await runTask(f.deps, t.id, { agent: 'codex' });
    expect(result.status).toBe('done');
    const [session] = await listSessions(f.graph, t.id);
    const texts = (session!.activity ?? []).map((a) => a.text);
    expect(texts).toContain('Merged. Re-testing the combined result');
    expect(texts).toContain('Combined tests passed (3 of 3)');
    expect((await getTask(f.graph, t.id))?.testSummary).toEqual({ passed: 3, total: 3 });
  }, 120_000);

  it("the combined result is tested in a clean checkout, so a recursive test runner does not also run other tasks' worktrees", async () => {
    // Like Vitest, this "runner" finds every *.marker file under the folder it is run in. In the main
    // folder it would also find the copy inside .puff/worktrees (the task's own, still on disk).
    const count = [
      "const fs = require('fs'), path = require('path');",
      'let n = 0;',
      'const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {',
      "  if (e.name === 'node_modules' || e.name === '.git') continue;",
      '  const p = path.join(d, e.name);',
      "  if (e.isDirectory()) walk(p); else if (e.name.endsWith('.marker')) n++;",
      '} };',
      "walk('.');",
      "console.log('Tests  ' + n + ' passed (' + n + ')');",
    ].join('\n');
    const cfg: PuffConfig = {
      ...config,
      verify: { ...config.verify, testCommand: 'node count.cjs' },
    };
    const f = await fixture(cfg, {
      codex: fakeAgent('codex', (o) => {
        writeFileSync(join(o.cwd, 'x.marker'), 'changed\n');
        return {};
      }),
    });
    writeFileSync(join(f.repoPath, 'count.cjs'), count);
    writeFileSync(join(f.repoPath, 'x.marker'), 'x\n');
    gitIn(f.repoPath, 'add', '-A');
    gitIn(f.repoPath, 'commit', '-q', '-m', 'add runner');
    const t = await f.task('Change the marker');
    const result = await runTask(f.deps, t.id, { agent: 'codex' });
    expect(result.status).toBe('done');
    // 1 in the task's worktree, and still 1 on the merged result
    expect((await getTask(f.graph, t.id))?.testSummary).toEqual({ passed: 1, total: 1 });
    const [session] = await listSessions(f.graph, t.id);
    expect((session!.activity ?? []).map((a) => a.text)).toContain(
      'Combined tests passed (1 of 1)',
    );
    // and the clean checkout is gone afterwards
    expect(existsSync(join(f.repoPath, '.puff', 'worktrees', `combined-${t.id}`))).toBe(false);
  }, 120_000);

  it('a project whose check cannot run is refused before any agent is started: nothing is spent, the task stays ready', async () => {
    const broken: PuffConfig = {
      ...config,
      verify: { ...config.verify, testCommand: 'node no-such-file-anywhere.js' },
    };
    const codex = fakeAgent('codex', () => ({ output: 'should never be asked' }));
    const f = await fixture(broken, { codex });
    const t = await f.task('Anything', { targets: ['taxFor'] });
    const { repo, graph, project, config: cfg, adapters, emit, log } = f.deps;

    const orch = new Orchestrator({ repo, graph, project, config: cfg, adapters, emit, log });
    const results = await orch.start();

    expect(results).toEqual([]);
    expect(codex.calls).toHaveLength(0); // no tokens were spent
    expect(orch.problem).toMatch(/No agent was started, and nothing was spent/);
    expect(orch.problem).toContain('node no-such-file-anywhere.js');
    expect((await getTask(graph, t.id))?.status).toBe('ready'); // still there to run once it is fixed
    expect(f.logs.join('\n')).toMatch(/project's check cannot run/);
  }, 120_000);

  it('a project that already fails its tests still runs (the task may be the fix); a planner never needs the check', async () => {
    const red: PuffConfig = {
      ...config,
      verify: {
        ...config.verify,
        testCommand: `node -e "console.log('Tests  1 failed (1)'); process.exit(1)"`,
      },
    };
    const codex = fakeAgent('codex', () => ({ output: 'looked at it' }));
    const f = await fixture(red, { codex });
    await f.task('Fix it', { targets: ['taxFor'] });
    const { repo, graph, project, config: cfg, adapters, emit, log } = f.deps;
    const orch = new Orchestrator({ repo, graph, project, config: cfg, adapters, emit, log });
    await orch.start();
    expect(orch.problem).toBeUndefined();
    expect(codex.calls.length).toBeGreaterThan(0);
    expect(f.logs.join('\n')).toMatch(/already fails its check/);

    // a plan task reads code and writes none: the (broken) check is irrelevant to it
    const broken: PuffConfig = {
      ...config,
      verify: { ...config.verify, testCommand: 'node nope.js' },
    };
    const planner = fakeAgent('claude-code', () => ({ output: 'a plan, but no tasks' }));
    const g = await fixture(broken, { 'claude-code': planner });
    await g.task('Plan something', { type: 'plan', preferredAgent: 'claude-code' });
    const d = g.deps;
    const plan = new Orchestrator({
      repo: d.repo,
      graph: d.graph,
      project: d.project,
      config: d.config,
      adapters: d.adapters,
      emit: d.emit,
      log: d.log,
    });
    await plan.start();
    expect(plan.problem).toBeUndefined();
    expect(planner.calls).toHaveLength(1);
  }, 180_000);

  it('an agent that hit its usage limit is skipped for the rest of the run, not asked again on every task', async () => {
    const limited = fakeAgent('codex', () => ({
      output: '',
      error: { kind: 'api', message: "api: You've hit your session limit · resets 5:10am" },
    }));
    const other = fakeAgent('opencode', (o) => {
      edit(o.cwd, 'src/cart/tax.ts', 'export function taxFor', '// done\nexport function taxFor');
      return { output: 'ok' };
    });
    // one task at a time, so the second starts only after the first has hit the limit
    const serial: PuffConfig = { ...FAST, limits: { ...FAST.limits, maxParallel: 1 } };
    const f = await fixture(serial, { codex: limited, opencode: other });
    await f.task('first', { targets: ['taxFor'], preferredAgent: 'codex' });
    await f.task('second', { targets: ['applyDiscount'], preferredAgent: 'codex' });
    const { repo, graph, project, config: cfg, adapters, emit, log } = f.deps;
    const orch = new Orchestrator({ repo, graph, project, config: cfg, adapters, emit, log });
    await orch.start();
    expect(limited.calls).toHaveLength(1); // asked once, then never again this run
    expect(orch.blocked.get('codex')).toMatch(/session limit/);
  }, 180_000);

  it('a task left "running" by a closed app goes back to the queue when the project is opened; one still being worked on is left alone', async () => {
    const f = await fixture(FAST, {});
    const stale = await f.task('left behind');
    const live = await f.task('being worked on right now');
    for (const t of [stale, live]) await updateTask(f.graph, t.id, { status: 'running' });
    const staleSession = await startSession(f.graph, {
      agent: 'codex',
      taskId: stale.id,
      role: 'coder',
    });
    const liveSession = await startSession(f.graph, {
      agent: 'codex',
      taskId: live.id,
      role: 'coder',
    });
    // the first has been silent for hours
    await runQuery(f.graph, 'MATCH (t:Task {id: $id}) SET t.updatedAt = $at', {
      id: stale.id,
      at: Date.now() - 10 * 3_600_000,
    });

    expect(await recoverInterrupted(f.graph, { olderThanMs: 20 * 60_000 })).toBe(1);
    expect((await getTask(f.graph, stale.id))?.status).toBe('planned');
    expect((await getTask(f.graph, live.id))?.status).toBe('running');
    const outcome = async (id: string, taskId: string) =>
      (await listSessions(f.graph, taskId)).find((s) => s.id === id)?.outcome;
    expect(await outcome(staleSession, stale.id)).toBe('error');
    expect(await outcome(liveSession, live.id)).toBe('running');
  }, 60_000);

  // ---- taking control: the trail, stalls, stopping one task, notes, taking a task over ------------------
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 15_000) => {
    const until = Date.now() + ms;
    while (!(await cond())) {
      if (Date.now() > until) throw new Error('timed out waiting for the condition');
      await sleep(50);
    }
  };
  /** An agent that does nothing until it is told to stop (a hung agent) */
  const hangs = (name: AgentName) =>
    fakeAgent(
      name,
      (o) =>
        new Promise((resolve) =>
          o.signal?.addEventListener('abort', () =>
            resolve({ output: '', error: { kind: 'aborted', message: 'Stopped by the user' } }),
          ),
        ),
    );
  const orchestrate = (f: { deps: RunDeps }) => {
    const { repo, graph, project, config: cfg, adapters, emit, log } = f.deps;
    return new Orchestrator({ repo, graph, project, config: cfg, adapters, emit, log });
  };
  const controllerFor = (f: { deps: RunDeps }) =>
    ProjectController.create({
      graph: f.deps.graph,
      project: { name: f.deps.project.slug, ...f.deps.project },
      config: f.deps.config,
      emit: f.deps.emit,
      log: f.deps.log,
      runDeps: f.deps,
    });

  it('each task keeps a trail of who worked on it, so a card can say who failed and who took over', async () => {
    const opencode = fakeAgent('opencode', () => ({
      output: '',
      error: { kind: 'crash', message: 'it fell over' },
    }));
    const codex = fakeAgent('codex', (o) => {
      edit(o.cwd, 'src/cart/tax.ts', 'export function taxFor', '// ok\nexport function taxFor');
      return { output: 'done' };
    });
    const f = await fixture(FAST, { opencode, codex });
    const t = await f.task('first on opencode', {
      targets: ['taxFor'],
      preferredAgent: 'opencode',
    });
    await runTask(f.deps, t.id);
    const task = (await getTask(f.graph, t.id))!;
    expect(task.trail?.map((e) => [e.agent, e.outcome])).toEqual([
      ['opencode', 'error'],
      ['codex', 'success'],
    ]);
    expect(task.trail![0]!.detail).toMatch(/fell over/);
    expect(task.stalledAt).toBeUndefined();
  }, 120_000);

  it('an agent that goes quiet is marked stalled on the card, and unmarked when it finishes', async () => {
    const quick: PuffConfig = { ...FAST, limits: { ...FAST.limits, stallWarnMs: 300 } };
    const slow = fakeAgent('codex', async (o) => {
      await sleep(1500); // no output for far longer than stallWarnMs
      edit(o.cwd, 'src/cart/tax.ts', 'export function taxFor', '// slow\nexport function taxFor');
      return { output: 'done' };
    });
    const f = await fixture(quick, { codex: slow });
    const t = await f.task('slow one', { targets: ['taxFor'] });
    await runTask(f.deps, t.id);
    const flagged = f.events.some(
      (e) => e.type === 'task:update' && e.task.id === t.id && e.task.stalledAt !== undefined,
    );
    expect(flagged).toBe(true);
    const [session] = await listSessions(f.graph, t.id);
    expect(
      (session!.activity ?? []).some((a) => /No output for .* the agent may be stuck/.test(a.text)),
    ).toBe(true);
    expect((await getTask(f.graph, t.id))?.stalledAt).toBeUndefined();
  }, 120_000);

  it('with a stall limit, a hung agent is stopped and the task moves on to the next agent', async () => {
    const strict: PuffConfig = {
      ...FAST,
      limits: { ...FAST.limits, stallWarnMs: 200, stallKillMs: 600 },
    };
    const stuck = hangs('opencode');
    const codex = fakeAgent('codex', (o) => {
      edit(
        o.cwd,
        'src/cart/tax.ts',
        'export function taxFor',
        '// rescued\nexport function taxFor',
      );
      return { output: 'done' };
    });
    const f = await fixture(strict, { opencode: stuck, codex });
    const t = await f.task('hangs on opencode', {
      targets: ['taxFor'],
      preferredAgent: 'opencode',
    });
    const result = await runTask(f.deps, t.id);
    expect(result.status).toBe('done');
    const task = (await getTask(f.graph, t.id))!;
    expect(task.trail?.map((e) => [e.agent, e.outcome])).toEqual([
      ['opencode', 'stalled'],
      ['codex', 'success'],
    ]);
    expect(task.trail![0]!.detail).toMatch(/No output for/);
  }, 120_000);

  it('stopping one task kills its agent and marks it failed ("Stopped by you") while the rest keeps going', async () => {
    const stuck = hangs('codex');
    const quick = fakeAgent('opencode', (o) => {
      edit(
        o.cwd,
        'src/cart/discounts.ts',
        'export function applyDiscount',
        '// quick\nexport function applyDiscount',
      );
      return { output: 'done' };
    });
    const f = await fixture(FAST, { codex: stuck, opencode: quick });
    const a = await f.task('hangs', { targets: ['taxFor'], preferredAgent: 'codex' });
    const b = await f.task('quick', { targets: ['applyDiscount'], preferredAgent: 'opencode' });
    const orch = orchestrate(f);
    const run = orch.start();
    await waitFor(() => stuck.calls.length === 1);
    expect(orch.stopTask(a.id)).toBe(true);
    expect(orch.stopTask('no-such-task')).toBe(false);
    const results = await run;

    expect(Object.fromEntries(results.map((r) => [r.taskId, r.status]))).toEqual({
      [a.id]: 'failed',
      [b.id]: 'done',
    });
    expect(results.find((r) => r.taskId === a.id)?.reason).toBe('Stopped by you');
    const task = (await getTask(f.graph, a.id))!;
    expect(task.status).toBe('failed');
    expect(task.trail?.[0]).toMatchObject({ agent: 'codex', outcome: 'stopped' });
  }, 120_000);

  it('"finish what is running, then pause" starts nothing new', async () => {
    const serial: PuffConfig = { ...FAST, limits: { ...FAST.limits, maxParallel: 1 } };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const codex = fakeAgent('codex', async (o) => {
      await gate;
      edit(o.cwd, 'src/cart/tax.ts', 'export function taxFor', '// gated\nexport function taxFor');
      return { output: 'done' };
    });
    const f = await fixture(serial, { codex });
    const first = await f.task('first', { targets: ['taxFor'] });
    const second = await f.task('second', { targets: ['applyDiscount'] });
    const orch = orchestrate(f);
    const run = orch.start();
    await waitFor(() => codex.calls.length === 1);
    orch.drain();
    expect(orch.isDraining).toBe(true);
    release();
    const results = await run;

    expect(results.map((r) => [r.taskId, r.status])).toEqual([[first.id, 'done']]);
    expect((await getTask(f.graph, second.id))?.status).toBe('ready'); // waiting, not started, not lost
    expect(codex.calls).toHaveLength(1);
  }, 120_000);

  it("a note on a task reaches the next attempt's prompt; switching agent, marking done and stopping work through the controller", async () => {
    const codex = fakeAgent('codex', (o) => {
      edit(o.cwd, 'src/cart/tax.ts', 'export function taxFor', '// noted\nexport function taxFor');
      return { output: 'done' };
    });
    const opencode = fakeAgent('opencode', () => ({ output: 'never needed' }));
    const f = await fixture(FAST, { codex, opencode });
    const controller = await controllerFor(f);
    const t = await f.task('needs a note', { targets: ['taxFor'] });

    await controller.addNote(t.id, 'Reuse the existing rounding helper');
    await controller.reassignTask(t.id, 'codex');
    expect((await getTask(f.graph, t.id))?.preferredAgent).toBe('codex');
    await runTask(f.deps, t.id);
    expect(codex.calls[0]!.prompt).toContain(
      'NOTE FROM THE PERSON (follow it):\nReuse the existing rounding helper',
    );
    await expect(controller.reassignTask(t.id, 'opencode')).rejects.toThrow(/already done/);

    // mark done by hand: dependants are released
    const a = await f.task('did it myself', { targets: ['applyDiscount'] });
    const b = await f.task('waits for it', { targets: ['cartTotal'], dependsOn: [a.id] });
    expect((await getTask(f.graph, b.id))?.status).toBe('planned');
    const done = await controller.markDone(a.id, 'Done in my editor');
    expect(done).toMatchObject({ status: 'done', doneByHand: true });
    expect((await getTask(f.graph, b.id))?.status).toBe('ready');

    // stop is only for a task that is being worked on
    await expect(controller.stopTask(b.id)).rejects.toThrow(/only a task being worked on/);
  }, 120_000);

  it("taking a task over: the agent's last attempt becomes the person's folder, their fix is checked, merged and teaches the failure its fix", async () => {
    // The project's check fails while bad.txt exists
    const check = [
      "const fs = require('fs');",
      "const bad = fs.existsSync('bad.txt');",
      "console.log(bad ? 'Tests  1 failed (1)' : 'Tests  1 passed (1)');",
      'process.exit(bad ? 1 : 0);',
    ].join('\n');
    const cfg: PuffConfig = {
      ...config,
      limits: { ...config.limits, maxAttempts: 1 },
      verify: { ...config.verify, testCommand: 'node check.cjs' },
    };
    const codex = fakeAgent('codex', (o) => {
      writeFileSync(join(o.cwd, 'bad.txt'), 'oops\n');
      return { output: 'I added bad.txt' };
    });
    const f = await fixture(cfg, { codex });
    writeFileSync(join(f.repoPath, 'check.cjs'), check);
    gitIn(f.repoPath, 'add', '-A');
    gitIn(f.repoPath, 'commit', '-q', '-m', 'add check');
    const controller = await controllerFor(f);
    const t = await f.task('Add the feature', { targets: ['taxFor'] });
    const failed = await runTask(f.deps, t.id);
    expect(failed.status).toBe('failed');

    const over = await controller.takeOver(t.id);
    expect(over.startedFrom).toMatch(/the agent's last attempt/);
    expect(over.brief).toContain('Add the feature');
    expect(over.brief).toMatch(/codex: failure/);
    expect(existsSync(join(over.cwd, 'bad.txt'))).toBe(true); // they continue from the agent's work
    expect((await getTask(f.graph, t.id))?.worktree).toMatch(/-manual$/);

    // not fixed yet: the check fails, nothing merges, their folder stays
    const tryAgain = await controller.landManual(t.id);
    expect(tryAgain.status).toBe('failed');
    expect(existsSync(over.cwd)).toBe(true);

    // they fix it by hand
    rmSync(join(over.cwd, 'bad.txt'));
    writeFileSync(join(over.cwd, 'feature.txt'), 'the feature\n');
    const landed = await controller.landManual(t.id);
    expect(landed).toMatchObject({ status: 'done' });
    expect(existsSync(join(f.repoPath, 'feature.txt'))).toBe(true);
    expect(existsSync(join(f.repoPath, 'bad.txt'))).toBe(false);
    expect(existsSync(over.cwd)).toBe(false); // cleaned up once landed

    const task = (await getTask(f.graph, t.id))!;
    expect(task.status).toBe('done');
    expect(task.trail?.map((e) => [e.agent, e.outcome])).toEqual([
      ['codex', 'failure'],
      ['you', 'failure'],
      ['you', 'success'],
    ]);
    const sessions = await listSessions(f.graph, t.id);
    expect(sessions.at(-1)).toMatchObject({ agent: 'you', outcome: 'success' });
    // the failure the agent hit now has the person's fix
    const fixes = await read<{ summary: string }>(
      f.graph,
      `MATCH (:Failure)-[:FIXED_BY]->(s:Solution) RETURN s.summary AS summary`,
    );
    expect(fixes.length).toBeGreaterThanOrEqual(1);
    await expect(controller.landManual(t.id)).rejects.toThrow(/not taken this task over/);
  }, 240_000);

  it('taking over a task between two attempts still stops its agent: "retrying" does not mean nothing is running', async () => {
    const stuck = hangs('codex');
    const f = await fixture(FAST, { codex: stuck });
    const controller = await controllerFor(f);
    const t = await f.task('between attempts', { targets: ['taxFor'], preferredAgent: 'codex' });
    await controller.start();
    await waitFor(() => stuck.calls.length === 1);
    // what a task looks like in the moment between one attempt and the next
    await updateTask(f.graph, t.id, { status: 'retrying' });
    expect(controller.running).toBe(true);

    const over = await controller.takeOver(t.id);

    expect(over.cwd).toMatch(/-manual$/);
    await waitFor(() => !controller.running); // the run ended: nothing carries on behind the person's back
    const task = (await getTask(f.graph, t.id))!;
    expect(task.status).toBe('failed');
    expect(task.worktree).toMatch(/-manual$/);
    expect(stuck.calls).toHaveLength(1); // no second attempt was started
  }, 120_000);
});
