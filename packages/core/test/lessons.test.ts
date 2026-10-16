// The Memory screen's list (listMemory) against a real FalkorDB: every failure, fix, decision and procedure,
// with the code it is about, who learned it, how often agents were given it, whether it still holds, and trust.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import { compileContext } from '../src/context/compiler';
import { connect, loadDotEnv, run } from '../src/db/client';
import { initProjectGraph } from '../src/db/init';
import { graphName } from '../src/ids';
import { indexRepo } from '../src/indexer/index';
import {
  recordDecision,
  recordFailure,
  recordProcedure,
  recordSolution,
} from '../src/memory/memory';
import { recordMerge, recordRevert } from '../src/memory/provenance';
import { startSession } from '../src/memory/sessions';
import { createTask } from '../src/memory/tasks';
import { listMemory, memoryState } from '../src/queries/lessons';

const rel = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const DEMO = rel('../../../demo/shop-api');
const config = parseConfig(readFileSync(rel('../../../puff.config.yaml'), 'utf8'));

loadDotEnv(rel('../../../.env'));
const db = await connect().catch(() => undefined);

const LOGIN = 'src/auth/login.ts::login';
const CHECK_USER = 'src/auth/login.ts::checkUser';

describe('a lesson state', () => {
  it('names the worst thing that happened to it', () => {
    const none = { stale: false, status: null, revertedIn: null, downgradedBy: null };
    expect(memoryState(none)).toBe('current');
    expect(memoryState({ ...none, stale: true })).toBe('outdated');
    expect(memoryState({ ...none, stale: true, status: 'superseded' })).toBe('superseded');
    expect(memoryState({ ...none, status: 'superseded', downgradedBy: 'a' })).toBe('downgraded');
    expect(memoryState({ ...none, status: 'reverted' })).toBe('reverted');
    expect(memoryState({ ...none, downgradedBy: 'a', revertedIn: 'b' })).toBe('reverted');
  });
});

describe.skipIf(!db)('listMemory (real FalkorDB)', () => {
  const slug = `test_lessons_${process.pid}`;
  const project = { slug, name: slug, repoPath: '' };
  let graph: Awaited<ReturnType<typeof initProjectGraph>>;

  beforeAll(async () => {
    const repo = mkdtempSync(join(tmpdir(), 'puff-lessons-'));
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

  it('lists failures, fixes, decisions and procedures with what they are about, their state and trust', async () => {
    expect(await listMemory(graph)).toEqual([]);

    const task = await createTask(graph, slug, config, {
      title: 'Change login',
      type: 'implement',
      targets: [LOGIN],
    });
    const s1 = await startSession(graph, { agent: 'opencode', taskId: task.id, role: 'coder' });
    const failure = await recordFailure(graph, {
      sessionId: s1,
      message: 'login.spec: password appears in audit log',
      symbolIds: [LOGIN],
    });
    const s2 = await startSession(graph, { agent: 'codex', taskId: task.id, role: 'coder' });
    const sha = 'aaaaaaa1111111111111111111111111111111aa';
    await recordMerge(graph, s2, sha);
    const fix = await recordSolution(graph, {
      failureId: failure.id,
      summary: 'Redact credentials before audit()',
      commit: sha,
      sessionId: s2,
    });
    const old = await recordDecision(graph, {
      text: 'Tokens in localStorage',
      symbolIds: [CHECK_USER],
      sessionId: s1,
    });
    const now = await recordDecision(graph, {
      text: 'Tokens in httpOnly cookies',
      supersedes: old.id,
    });
    await recordProcedure(graph, slug, {
      text: 'Run the auth tests before merging',
      technology: 'Jest',
    });
    await recordProcedure(graph, slug, { text: 'Never log request bodies' });
    // the next agent on login() is given the failure
    const s3 = await startSession(graph, { agent: 'claude-code', taskId: task.id, role: 'coder' });
    await compileContext(graph, task.id, { role: 'coder', sessionId: s3 });

    const items = await listMemory(graph);
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(items.map((i) => i.kind).sort()).toEqual([
      'Decision',
      'Decision',
      'Failure',
      'Procedure',
      'Procedure',
      'Solution',
    ]);
    expect(byId.get(failure.id)).toMatchObject({
      kind: 'Failure',
      text: 'login.spec: password appears in audit log',
      about: [LOGIN],
      agent: 'opencode',
      hits: 1,
      usedIn: 1,
      related: { id: fix, text: 'Redact credentials before audit()' },
      state: 'current',
    });
    expect(byId.get(failure.id)!.trust).toBeGreaterThan(0);
    expect(byId.get(fix)).toMatchObject({
      kind: 'Solution',
      about: [LOGIN],
      agent: 'codex',
      related: { id: failure.id },
      state: 'current',
    });
    expect(byId.get(old.id)).toMatchObject({ state: 'superseded', about: [CHECK_USER] });
    expect(byId.get(now.id)).toMatchObject({
      state: 'current',
      about: [CHECK_USER],
      related: { id: old.id, text: 'Tokens in localStorage' },
    });
    const procedures = items.filter((i) => i.kind === 'Procedure');
    expect(procedures.map((p) => p.appliesTo).sort()).toEqual(['Jest', 'the whole project']);
    // newest first
    expect(items.map((i) => i.at)).toEqual([...items.map((i) => i.at)].sort((a, b) => b - a));

    // the merge the fix landed in is reverted: the fix says so
    await recordRevert(graph, sha, 'bbbbbbb2222222222222222222222222222222bb');
    const after = new Map((await listMemory(graph)).map((i) => [i.id, i]));
    expect(after.get(fix)!.state).toBe('reverted');

    // editing the code a decision is about makes it possibly outdated
    await run(graph, `MATCH (d:Decision {id: $id}) SET d.stale = true`, { id: now.id });
    const edited = (await listMemory(graph)).find((i) => i.id === now.id)!;
    expect(edited.state).toBe('outdated');
    expect(edited.trust).toBeLessThan(byId.get(now.id)!.trust!);
  });
});
