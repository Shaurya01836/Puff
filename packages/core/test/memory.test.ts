// The P2 checkpoint as an executable story, against a real FalkorDB: session 1 fails on a trap,
// the failure lands on the right function, and a fresh session 2 is handed the lesson.
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import { compileContext, getContextPack } from '../src/context/compiler';
import { connect, loadDotEnv, read } from '../src/db/client';
import { initProjectGraph } from '../src/db/init';
import { graphName } from '../src/ids';
import { indexRepo } from '../src/indexer/index';
import { recordTestFailures } from '../src/memory/failures';
import {
  pendingHandoffs,
  recordDecision,
  recordFailure,
  recordHandoff,
  recordProcedure,
  recordSolution,
} from '../src/memory/memory';
import { applyReport } from '../src/memory/report';
import { finishSession, listSessions, startSession } from '../src/memory/sessions';
import { createTask, getTask, listTasks, updateTask } from '../src/memory/tasks';
import { agentProfiles, getMemoryFeed, getWhy } from '../src/queries/explain';
import { exportGraph } from '../src/queries/graph';

const rel = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const DEMO = rel('../../../demo/shop-api');
const config = parseConfig(readFileSync(rel('../../../puff.config.yaml'), 'utf8'));

loadDotEnv(rel('../../../.env'));
const db = await connect().catch(() => undefined);

describe.skipIf(!db)('memory and context against FalkorDB', () => {
  const slug = `test_memory_${process.pid}`;
  const project = { slug, name: slug, repoPath: '' };
  let graph: Awaited<ReturnType<typeof initProjectGraph>>;

  const LOGIN = 'src/auth/login.ts::login';
  const CHECK_USER = 'src/auth/login.ts::checkUser';
  let taskA: string;
  let taskB: string;
  let ses1: string;
  let failureId: string;

  beforeAll(async () => {
    const repo = mkdtempSync(join(tmpdir(), 'puff-mem-'));
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
    await db!.close();
    rmSync(project.repoPath, { recursive: true, force: true });
  });

  it('creates tasks that target symbols by name, require capabilities and depend on each other', async () => {
    taskA = (
      await createTask(graph, slug, config, {
        title: 'Log failed login attempts',
        targets: ['login'],
      })
    ).id;
    const b = await createTask(graph, slug, config, {
      title: 'Lock account after 5 failed logins',
      targets: [LOGIN],
      dependsOn: [taskA],
    });
    taskB = b.id;
    expect(b).toMatchObject({
      status: 'planned',
      type: 'implement',
      targets: [LOGIN],
      dependsOn: [taskA],
    });

    const required = await read<{ cap: string }>(
      graph,
      `MATCH (:Task {id: $id})-[:REQUIRES]->(c) RETURN c.name AS cap`,
      { id: taskA },
    );
    expect(required.map((r) => r.cap)).toEqual(['implementation']);
    await expect(
      createTask(graph, slug, config, { title: 'x', targets: ['nope'] }),
    ).rejects.toThrow(/No symbol named/);
    await expect(
      createTask(graph, slug, config, { title: 'x', dependsOn: ['task_missing'] }),
    ).rejects.toThrow(/Unknown task/);
    expect((await listTasks(graph)).map((t) => t.id)).toEqual([taskA, taskB]);
  });

  it('seeds procedures, then gives session 1 a context with no failures yet', async () => {
    await recordProcedure(graph, slug, {
      text: 'Run the tests with `npm test`; all must pass before you finish',
    });
    await recordProcedure(graph, slug, {
      text: 'Throw HttpError helpers from src/lib/errors.ts',
      technology: 'Express',
    });
    // idempotent on text
    const again = await recordProcedure(graph, slug, {
      text: 'Run the tests with `npm test`; all must pass before you finish',
    });
    expect(await read(graph, `MATCH (p:Procedure) RETURN p.id AS id`)).toHaveLength(2);
    expect(again).toMatch(/^proc_/);

    ses1 = await startSession(graph, { agent: 'codex', taskId: taskA, role: 'coder' });
    const pack = await compileContext(graph, taskA, { role: 'coder', sessionId: ses1 });
    expect(pack.items.filter((i) => i.kind === 'Failure')).toEqual([]);
    expect(pack.items.find((i) => i.id === LOGIN)?.reason).toBe('target of this task');
    expect(pack.items.map((i) => i.kind)).toContain('Procedure');
    expect(pack.prompt).toContain('TARGET CODE');
    expect(pack.prompt).toContain('src/auth/login.ts:');
    expect(pack.prompt).toMatch(/CALLERS THAT MAY BREAK: .*src\/routes\/auth\.ts::authRouter/);
    expect(pack.prompt).toContain('<puff-report>');
    expect(pack.tokenEstimate).toBeLessThanOrEqual(2000);
  });

  it('session 1 fails on the password-logging trap and the failure lands on the right function', async () => {
    const output = readFileSync(rel('./fixtures/vitest-assertion-in-test.txt'), 'utf8');
    const src = readFileSync(join(project.repoPath, 'src/auth/login.ts'), 'utf8').split('\n');
    const line = src.findIndex((l) => l.includes("audit('login.failed'")) + 1;
    const diff = [
      '--- a/src/auth/login.ts',
      '+++ b/src/auth/login.ts',
      `@@ -${line},1 +${line},1 @@`,
      "-    audit('login.failed', { email });",
      "+    audit('login.failed', { email, password });",
    ].join('\n');

    await finishSession(graph, ses1, {
      outcome: 'failure',
      tokensIn: 7400,
      tokensOut: 1600,
      durationMs: 61_000,
      changedFiles: ['src/auth/login.ts'],
      summary: 'Logged failed attempts via audit(); one test fails.',
    });
    const recorded = await recordTestFailures(graph, {
      sessionId: ses1,
      taskId: taskA,
      output,
      root: project.repoPath,
      diff,
      changedFiles: ['src/auth/login.ts'],
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ via: 'diff', repeated: false, symbolIds: [CHECK_USER] });
    expect(recorded[0]!.message).toMatch(
      /^login > never writes a password to the logs: AssertionError: expected/,
    );
    failureId = recorded[0]!.id;

    const stored = await read<{ message: string }>(
      graph,
      `MATCH (f:Failure {id: $id}) RETURN f.message AS message`,
      { id: failureId },
    );
    // only the headline is stored: the Received payload (which holds the logged credentials) is not
    expect(stored[0]!.message).not.toContain('"data"');
    expect(stored[0]!.message.split('\n')).toHaveLength(1);
    await updateTask(graph, taskA, {
      status: 'failed',
      assignedAgent: 'codex',
      role: 'coder',
      tokens: { in: 7400, out: 1600 },
      testSummary: { passed: 5, total: 6 },
    });
    expect(await getTask(graph, taskA)).toMatchObject({
      status: 'failed',
      assignedAgent: 'codex',
      tokens: { in: 7400, out: 1600 },
      testSummary: { passed: 5, total: 6 },
    });
    const [session] = await listSessions(graph, taskA);
    expect(session).toMatchObject({
      agent: 'codex',
      outcome: 'failure',
      changedFiles: ['src/auth/login.ts'],
    });
  });

  it('refuses a failure with nothing to anchor to', async () => {
    await expect(
      recordFailure(graph, {
        sessionId: ses1,
        message: 'floating',
        symbolIds: ['src/nope.ts::ghost'],
      }),
    ).rejects.toThrow(/anchored/);
    await expect(
      recordFailure(graph, { sessionId: 'ses_missing', message: 'x', symbolIds: [LOGIN] }),
    ).rejects.toThrow(/Unknown session/);
  });

  it('session 2, a fresh agent, gets the failure, its fix and the reasons, ranked and recorded', async () => {
    await recordSolution(graph, {
      failureId,
      summary: 'Log only the email; never the password or the request body',
    });
    await recordHandoff(graph, {
      fromSessionId: ses1,
      toRole: 'coder',
      payload: { summary: 'audit() logs whatever it is given: pass it only the email' },
    });
    expect(await pendingHandoffs(graph, taskB)).toHaveLength(1);

    const ses2 = await startSession(graph, { agent: 'claude-code', taskId: taskB, role: 'coder' });
    const pack = await compileContext(graph, taskB, { role: 'coder', sessionId: ses2 });
    const byKind = (k: string) => pack.items.filter((i) => i.kind === k);

    expect(byKind('Failure')).toEqual([
      expect.objectContaining({
        id: failureId,
        reason: 'failed in checkUser(), which the target login() calls',
      }),
    ]);
    expect(byKind('Solution')[0]).toMatchObject({
      text: expect.stringContaining('never the password'),
      reason: expect.stringContaining('fix for'),
    });
    expect(byKind('Handoff')[0]!.reason).toBe('handoff from codex (coder) waiting for this task');
    expect(pack.prompt).toContain('fixed by: Log only the email');
    expect(pack.prompt).toContain('Handoff notes from earlier work');
    // handoffs are delivered once
    expect(await pendingHandoffs(graph, taskB)).toHaveLength(0);

    // what was sent is what is stored
    const stored = await getContextPack(graph, ses2);
    expect(stored).toEqual({
      id: pack.id,
      sessionId: ses2,
      tokenEstimate: pack.tokenEstimate,
      prompt: pack.prompt,
      items: pack.items,
    });

    // the Why view: agent choice and the path from the lesson back to the code
    const why = await getWhy(graph, taskB);
    expect(why.summary).toContain('went to claude-code');
    const edge = (source: string, type: string, target: string) =>
      why.edges.some((e) => e.source === source && e.type === type && e.target === target);
    expect(edge(failureId, 'IN', CHECK_USER)).toBe(true);
    expect(edge(failureId, 'FIXED_BY', byKind('Solution')[0]!.id)).toBe(true);
    expect(
      why.edges.find((e) => e.type === 'INCLUDED' && e.target === failureId)?.props?.reason,
    ).toContain('checkUser()');
    expect(why.nodes.find((n) => n.id === 'agent:claude-code')?.kind).toBe('Agent');

    // session 2 hits the same trap again: counted, not duplicated
    const repeat = await recordFailure(graph, {
      sessionId: ses2,
      message: (
        await read<{ m: string }>(graph, `MATCH (f:Failure {id: $id}) RETURN f.message AS m`, {
          id: failureId,
        })
      )[0]!.m,
      symbolIds: [CHECK_USER],
    });
    expect(repeat).toMatchObject({ id: failureId, repeated: true });
    expect(await read(graph, `MATCH (f:Failure) RETURN f.id`)).toHaveLength(1);
    expect(
      (await compileContext(graph, taskB, { role: 'coder', preview: true })).items.find(
        (i) => i.id === failureId,
      )?.reason,
    ).toContain('seen 2 times');
  });

  it('keeps context inside the token budget and says what was dropped', async () => {
    const full = await compileContext(graph, taskB, { role: 'coder', preview: true });
    const tight = await compileContext(graph, taskB, {
      role: 'coder',
      preview: true,
      budgetTokens: full.tokenEstimate - 10,
    });
    expect(full.dropped).toBe(0);
    expect(tight.dropped).toBeGreaterThan(0);
    expect(tight.tokenEstimate).toBeLessThanOrEqual(full.tokenEstimate - 10);
    // the failure outranks procedures, so a procedure goes first
    expect(tight.items.some((i) => i.id === failureId)).toBe(true);
    expect(tight.items.filter((i) => i.kind === 'Procedure').length).toBeLessThan(
      full.items.filter((i) => i.kind === 'Procedure').length,
    );
  });

  it('renders role-specific prompts', async () => {
    const planner = await compileContext(graph, taskB, { role: 'planner', preview: true });
    expect(planner.prompt).toContain('GOAL: Lock account after 5 failed logins');
    expect(planner.prompt).toContain('PROJECT TECHNOLOGIES:');
    const verifier = await compileContext(graph, taskB, {
      role: 'verifier',
      preview: true,
      diff: '+++ b/x\n@@ -1 +1 @@\n-a\n+b',
      testCommand: 'npm test',
    });
    expect(verifier.prompt).toContain('TESTS TO RUN: npm test');
    expect(verifier.prompt).toContain('```diff');
    const chore = await compileContext(graph, taskB, { role: 'chore', preview: true });
    expect(chore.prompt).not.toContain('Past failures');
    await expect(compileContext(graph, taskB, { role: 'coder' })).rejects.toThrow(/sessionId/);
    await expect(
      compileContext(graph, taskA, { role: 'coder', sessionId: 'ses_missing' }),
    ).rejects.toThrow(/did not work/);
  });

  it('supersedes decisions without deleting them, and only active ones are sent', async () => {
    const old = await recordDecision(graph, {
      symbolIds: [LOGIN],
      text: 'Session tokens are stored in localStorage',
    });
    const next = await recordDecision(graph, {
      text: 'Session tokens live in an httpOnly cookie, never localStorage',
      supersedes: old.id,
    });
    await expect(recordDecision(graph, { text: 'again', supersedes: old.id })).rejects.toThrow(
      /already superseded/,
    );
    await expect(
      recordDecision(graph, { symbolIds: ['src/nope.ts::x'], text: 'floating' }),
    ).rejects.toThrow(/existing symbol/);

    const statuses = await read<{ id: string; status: string }>(
      graph,
      `MATCH (d:Decision) RETURN d.id AS id, d.status AS status`,
    );
    expect(statuses.find((s) => s.id === old.id)?.status).toBe('superseded');
    expect(statuses.find((s) => s.id === next.id)?.status).toBe('active');
    const pack = await compileContext(graph, taskB, { role: 'coder', preview: true });
    expect(pack.items.filter((i) => i.kind === 'Decision').map((i) => i.id)).toEqual([next.id]);
    expect(pack.items.find((i) => i.id === next.id)?.reason).toBe(
      'active decision about login(), which this task targets',
    );
  });

  it('applies a puff-report: decisions are recorded, unanchorable ones are skipped with a reason', async () => {
    const applied = await applyReport(graph, {
      decisions: [
        { symbol: 'checkUser', text: 'Failed logins are audited with the email only' },
        { symbol: 'doesNotExist', text: 'floating' },
      ],
      notes: 'done',
    });
    expect(applied.decisionIds).toHaveLength(1);
    expect(applied.skipped).toEqual([
      { symbol: 'doesNotExist', reason: expect.stringContaining('No symbol named') },
    ]);
  });

  it('flags memory stale when its code changes, labels it if nothing fresher exists, and drops it otherwise', async () => {
    // a comment after the functions changes the file, not what any function does
    const loginFile = join(project.repoPath, 'src/auth/login.ts');
    appendFileSync(loginFile, '\n// edited by a later change\n');
    expect((await indexRepo(graph, project)).staleFlagged).toBe(0);

    // changing the functions themselves flags what was learned about them
    writeFileSync(
      loginFile,
      readFileSync(loginFile, 'utf8')
        .replace("'login.success'", "'login.ok'")
        .replace("'login.failed'", "'login.rejected'"),
    );
    const stats = await indexRepo(graph, project);
    expect(stats.staleFlagged).toBeGreaterThanOrEqual(2); // the failure and the decisions

    const pack = await compileContext(graph, taskB, { role: 'coder', preview: true });
    // every memory is stale now, so they are kept but labelled
    const failure = pack.items.find((i) => i.id === failureId);
    expect(failure?.stale).toBe(true);
    expect(pack.prompt).toContain('possibly outdated');

    // a fresh decision appears: the stale ones are dropped
    const fresh = await recordDecision(graph, {
      symbolIds: [LOGIN],
      text: 'Lockout state lives in the session store',
    });
    const after = await compileContext(graph, taskB, { role: 'coder', preview: true });
    expect(after.items.some((i) => i.id === fresh.id)).toBe(true);
    expect(after.items.some((i) => i.id === failureId)).toBe(false);
    expect(after.dropped).toBeGreaterThan(0);

    // the same failure happening again revives it
    const [ses] = await listSessions(graph, taskA);
    const msg = (
      await read<{ m: string }>(graph, `MATCH (f:Failure {id: $id}) RETURN f.message AS m`, {
        id: failureId,
      })
    )[0]!.m;
    await recordFailure(graph, { sessionId: ses!.id, message: msg, symbolIds: [CHECK_USER] });
    const revived = await compileContext(graph, taskB, { role: 'coder', preview: true });
    expect(revived.items.find((i) => i.id === failureId)?.stale).toBeUndefined();
  });

  it('derives a memory feed and agent results from the graph', async () => {
    const feed = await getMemoryFeed(graph, 100);
    const types = new Set(feed.map((e) => e.type));
    for (const t of [
      'failure_recorded',
      'solution_recorded',
      'decision_recorded',
      'decision_superseded',
      'handoff',
      'context_compiled',
      'memory_stale',
    ]) {
      expect(types.has(t as never), t).toBe(true);
    }
    expect(feed.map((e) => e.at)).toEqual([...feed.map((e) => e.at)].sort((a, b) => b - a));
    // every event must be readable: FalkorDB returns null for some string expressions
    for (const e of feed)
      expect(typeof e.text === 'string' && e.text.length > 0, e.type).toBe(true);
    expect(feed.find((e) => e.type === 'context_compiled')?.text).toMatch(
      /^Context for “.+” \(.+\): \d+ items, ~\d+ tokens$/,
    );

    const agents = await agentProfiles(graph, config);
    expect(agents.find((a) => a.name === 'codex')).toMatchObject({
      busy: 0,
      stats: { runs: 1, wins: 0, successRate: 0 },
    });
    expect(agents.find((a) => a.name === 'claude-code')).toMatchObject({
      busy: 1,
      stats: { runs: 0 },
    });
    expect(agents.find((a) => a.name === 'opencode')?.instances).toBe(1);
  });

  it('exports tasks, sessions and memory to the UI graph', async () => {
    const g = await exportGraph(graph);
    expect(g.nodes.find((n) => n.id === taskA)?.label).toBe('Log failed login attempts');
    expect(g.nodes.find((n) => n.id === failureId)?.kind).toBe('Failure');
    const has = (source: string, type: string, target: string) =>
      g.edges.some((e) => e.source === source && e.type === type && e.target === target);
    expect(has(failureId, 'IN', CHECK_USER)).toBe(true);
    expect(has(taskB, 'TARGETS', LOGIN)).toBe(true);
    expect(has(taskB, 'DEPENDS_ON', taskA)).toBe(true);
    expect(g.nodes.some((n) => n.kind === 'ContextPack')).toBe(false); // bookkeeping stays hidden
  });
});
