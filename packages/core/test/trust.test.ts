// Trustworthy memory (P16) against a real FalkorDB: every lesson knows where it came from, a revert of
// the merge it came from downgrades it and what was derived from it (Q23), and trust (Q24) decides
// whether a lesson reaches the next agent, and how it is worded.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import { compileContext } from '../src/context/compiler';
import { connect, loadDotEnv, read, run } from '../src/db/client';
import { initProjectGraph } from '../src/db/init';
import { graphName } from '../src/ids';
import { indexRepo } from '../src/indexer/index';
import { confirmMemory, recordDecision, recordFailure, recordSolution } from '../src/memory/memory';
import {
  backfillProvenance,
  memoryTrust,
  recordMerge,
  recordRevert,
  TRUST_FLOOR,
  trustScore,
  type TrustFactors,
} from '../src/memory/provenance';
import { finishSession, startSession } from '../src/memory/sessions';
import { createTask } from '../src/memory/tasks';
import { getMemoryFeed } from '../src/queries/explain';

const rel = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const DEMO = rel('../../../demo/shop-api');
const config = parseConfig(readFileSync(rel('../../../puff.config.yaml'), 'utf8'));

loadDotEnv(rel('../../../.env'));
const db = await connect().catch(() => undefined);

const CHECK_USER = 'src/auth/login.ts::checkUser';

describe('the trust score', () => {
  const base: TrustFactors = {
    id: 'x',
    agentRuns: 0,
    agentWins: 0,
    confirmations: 0,
    helped: 0,
    repeated: 0,
    stale: false,
  };

  it('starts neutral and moves with what happened, saying why', () => {
    expect(trustScore(base)).toEqual({ trust: 0.6, why: [] });
    expect(trustScore({ ...base, confirmations: 1, helped: 2 }).trust).toBe(0.86);
    expect(trustScore({ ...base, repeated: 1 })).toEqual({
      trust: 0.6,
      why: ['hit again 1× even when it was shown'],
    });
    expect(trustScore({ ...base, stale: true }).trust).toBe(0.4);
    const reverted = trustScore({ ...base, revertedIn: 'abcdef1234' });
    expect(reverted).toEqual({ trust: 0.2, why: ['learned in abcdef1, which was reverted'] });
    expect(trustScore({ ...base, downgradedBy: 'abcdef1234' }).trust).toBe(0.3);
    // an agent's track record counts only once it has one
    expect(trustScore({ ...base, agent: 'codex', agentRuns: 2, agentWins: 0 }).trust).toBe(0.6);
    expect(trustScore({ ...base, agent: 'codex', agentRuns: 4, agentWins: 4 }).trust).toBe(0.7);
    expect(trustScore({ ...base, confirmations: 9, helped: 9 }).trust).toBe(1);
  });

  it('leaves out what was reverted or derived from it, and a confirmation brings it back', () => {
    expect(trustScore({ ...base, revertedIn: 'a' }).trust).toBeLessThan(TRUST_FLOOR);
    expect(trustScore({ ...base, downgradedBy: 'a' }).trust).toBeLessThan(TRUST_FLOOR);
    expect(
      trustScore({ ...base, downgradedBy: 'a', confirmations: 1 }).trust,
    ).toBeGreaterThanOrEqual(TRUST_FLOOR);
  });
});

describe.skipIf(!db)('provenance, revert repair and trust (real FalkorDB)', () => {
  const slug = `test_trust_${process.pid}`;
  const project = { slug, name: slug, repoPath: '' };
  let graph: Awaited<ReturnType<typeof initProjectGraph>>;

  beforeAll(async () => {
    const repo = mkdtempSync(join(tmpdir(), 'puff-trust-'));
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

  /** A task with one failed session (it learned F) and one that fixed it and merged commit `sha`. */
  async function story(sha: string, message: string) {
    const task = await createTask(graph, slug, config, {
      title: `Story ${sha}`,
      type: 'implement',
      targets: [CHECK_USER],
    });
    const s1 = await startSession(graph, { agent: 'codex', taskId: task.id, role: 'coder' });
    const f = await recordFailure(graph, {
      sessionId: s1,
      message,
      kind: 'test',
      symbolIds: [CHECK_USER],
    });
    await finishSession(graph, s1, { outcome: 'failure' });
    const s2 = await startSession(graph, { agent: 'codex', taskId: task.id, role: 'coder' });
    await recordMerge(graph, s2, sha);
    const sol = await recordSolution(graph, {
      failureId: f.id,
      summary: `fixed in ${sha}`,
      commit: sha,
      sessionId: s2,
    });
    const d = await recordDecision(graph, {
      symbolIds: [CHECK_USER],
      text: `Decision written while fixing ${sha}`,
      sessionId: s2,
      derivedFrom: [f.id, sol],
    });
    await finishSession(graph, s2, { outcome: 'success' });
    // a later decision built on that one
    const later = await recordDecision(graph, {
      symbolIds: [CHECK_USER],
      text: `Follow-up built on ${sha}`,
      derivedFrom: [d.id],
    });
    await run(
      graph,
      `MATCH (a:Decision {id: $a}), (b:Decision {id: $b}) MERGE (a)-[:DERIVED_FROM]->(b)`,
      { a: later.id, b: d.id },
    );
    return { task, s1, s2, failure: f.id, solution: sol, decision: d.id, later: later.id };
  }

  it('every lesson records where it came from: session, commit, and what a decision was derived from', async () => {
    const s = await story('aaaaaaa1111111111111111111111111111111aa', 'the first lesson');
    const rows = await read<{ rel: string; to: string }>(
      graph,
      `MATCH (m)-[r:LEARNED_IN|IN_COMMIT|DERIVED_FROM]->(x)
       WHERE m.id IN $ids
       RETURN m.id + ' ' + type(r) AS rel, coalesce(x.id, x.sha) AS to ORDER BY rel, to`,
      { ids: [s.failure, s.solution, s.decision] },
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { rel: `${s.failure} LEARNED_IN`, to: s.s1 },
        { rel: `${s.solution} IN_COMMIT`, to: 'aaaaaaa1111111111111111111111111111111aa' },
        { rel: `${s.solution} LEARNED_IN`, to: s.s2 },
        { rel: `${s.decision} LEARNED_IN`, to: s.s2 },
        { rel: `${s.decision} DERIVED_FROM`, to: s.failure },
        { rel: `${s.decision} DERIVED_FROM`, to: s.solution },
      ]),
    );
  });

  it('backfills provenance for memory recorded before it existed, and doing it twice changes nothing', async () => {
    const task = await createTask(graph, slug, config, { title: 'Old', targets: [CHECK_USER] });
    const se = await startSession(graph, { agent: 'opencode', taskId: task.id, role: 'coder' });
    await run(
      graph,
      `MATCH (se:Session {id: $se}) CREATE (se)-[:HIT]->(:Failure {id: 'fail_old', message: 'old'})`,
      { se },
    );
    await run(graph, `CREATE (:Solution {id: 'sol_old', summary: 'old fix', commit: 'cafe1234'})`);
    await backfillProvenance(graph);
    await backfillProvenance(graph);
    const count = await read<{ n: number }>(
      graph,
      `MATCH (m)-[r:LEARNED_IN|IN_COMMIT]->() WHERE m.id IN ['fail_old', 'sol_old'] RETURN count(r) AS n`,
    );
    expect(Number(count[0]!.n)).toBe(2);
  });

  it('Q23: a revert marks the fix reverted, flags its decision, downgrades what was derived from it, once', async () => {
    const sha = 'bbbbbbb2222222222222222222222222222222bb';
    const s = await story(sha, 'the second lesson');
    const first = await recordRevert(graph, sha, 'ccccccc3333333333333333333333333333333cc');
    expect(first).toMatchObject({
      isNew: true,
      solutions: [s.solution],
      decisions: [s.decision],
      downgraded: [s.later],
    });
    const again = await recordRevert(graph, sha, 'ccccccc3333333333333333333333333333333cc');
    expect(again.isNew).toBe(false);
    const [sol] = await read<{ status: string }>(
      graph,
      `MATCH (s:Solution {id: $id}) RETURN s.status AS status`,
      { id: s.solution },
    );
    expect(sol!.status).toBe('reverted');

    const feed = await getMemoryFeed(graph, 100);
    expect(feed.find((e) => e.type === 'memory_downgraded' && e.id.includes(sha))?.text).toBe(
      '3 lessons downgraded because bbbbbbb was reverted',
    );

    // Q24: the decision from the reverted merge and the one built on it lose trust; the failure itself
    // (the mistake was real) keeps it
    const trust = await memoryTrust(graph, {
      Failure: [s.failure],
      Decision: [s.decision, s.later],
    });
    expect(trust.get(s.decision)!.trust).toBe(0.2);
    expect(trust.get(s.later)!.trust).toBe(0.3);
    expect(trust.get(s.failure)!.trust).toBeGreaterThanOrEqual(0.6);
  });

  it('Q24 in context: a reverted fix is not offered, distrusted decisions are left out with why, confirming brings one back', async () => {
    const sha = 'ddddddd4444444444444444444444444444444dd';
    const s = await story(sha, 'never trust the third lesson blindly');
    await recordRevert(graph, sha, 'eeeeeee5555555555555555555555555555555ee');
    const task = await createTask(graph, slug, config, {
      title: 'Change checkUser again',
      type: 'implement',
      targets: [CHECK_USER],
    });

    const ctx = await compileContext(graph, task.id, { role: 'coder', preview: true });
    const failure = ctx.items.find((i) => i.id === s.failure);
    expect(failure?.reason).toMatch(/its earlier fix was reverted$/);
    expect(ctx.items.some((i) => i.id === s.solution)).toBe(false);
    expect(ctx.prompt).toContain(
      'never trust the third lesson blindly → its earlier fix was reverted, so find another way',
    );
    expect(ctx.items.some((i) => i.id === s.decision || i.id === s.later)).toBe(false);
    const left = ctx.distrusted.find((d) => d.id === s.decision);
    expect(left).toMatchObject({ trust: 0.2 });
    expect(left!.why[0]).toBe('learned in ddddddd, which was reverted');

    await confirmMemory(graph, s.later);
    const after = await compileContext(graph, task.id, { role: 'coder', preview: true });
    const back = after.items.find((i) => i.id === s.later);
    expect(back?.trust).toBe(0.4);
    expect(after.prompt).toContain(`Follow-up built on ${sha} (low confidence: confirmed 1×`);
  });
});
