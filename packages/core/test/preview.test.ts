// Previews on a copy of the graph (P18) against a real FalkorDB: GRAPH.COPY, change the copy, compare,
// delete the copy. The real graph must come out exactly as it went in.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import { connect, loadDotEnv, read } from '../src/db/client';
import { initProjectGraph } from '../src/db/init';
import { graphName } from '../src/ids';
import { indexRepo } from '../src/indexer/index';
import { recordFailure } from '../src/memory/memory';
import { startSession } from '../src/memory/sessions';
import { createTask, getTask } from '../src/memory/tasks';
import {
  getMergePreview,
  isPreviewGraph,
  previewMerge,
  previewPlan,
  saveMergePreview,
} from '../src/queries/preview';

const rel = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const DEMO = rel('../../../demo/shop-api');
const config = parseConfig(readFileSync(rel('../../../puff.config.yaml'), 'utf8'));

loadDotEnv(rel('../../../.env'));
const db = await connect().catch(() => undefined);

const CHECK_USER = 'src/auth/login.ts::checkUser';
const AUDIT = 'src/auth/audit.ts::audit';
const LOGIN = 'src/auth/login.ts::login';

describe.skipIf(!db)('previews on a copy of the graph (real FalkorDB)', () => {
  const slug = `test_preview_${process.pid}`;
  const project = { slug, name: slug, repoPath: '' };
  const made: string[] = [];
  let graph: Awaited<ReturnType<typeof initProjectGraph>>;

  beforeAll(async () => {
    const repo = mkdtempSync(join(tmpdir(), 'puff-preview-'));
    made.push(repo);
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
    for (const d of made) rmSync(d, { recursive: true, force: true });
    await db!.close();
  });

  const hashOf = async (id: string) =>
    (
      await read<{ h: string }>(graph, `MATCH (s:Symbol {id: $id}) RETURN s.bodyHash AS h`, { id })
    )[0]?.h;

  it('Q25: a branch indexed into a copy shows what it adds, changes and calls, and which lessons it would outdate; the real graph is untouched', async () => {
    const task = await createTask(graph, slug, config, {
      title: 'Audit login attempts',
      type: 'implement',
      targets: [CHECK_USER],
    });
    const ses = await startSession(graph, { agent: 'codex', taskId: task.id, role: 'coder' });
    const lesson = await recordFailure(graph, {
      sessionId: ses,
      message: 'never writes a password to the logs',
      kind: 'test',
      symbolIds: [CHECK_USER],
    });
    // the branch: checkUser changes and calls a new function that calls audit()
    const branch = mkdtempSync(join(tmpdir(), 'puff-preview-branch-'));
    made.push(branch);
    cpSync(project.repoPath, branch, { recursive: true });
    const file = join(branch, 'src/auth/login.ts');
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(
        "audit('login.failed', { email });",
        "audit('login.failed', { email });\n    logAttempt(email);",
      ) +
        "\nexport function logAttempt(email: string): void {\n  audit('login.attempt', { email });\n}\n",
    );
    const auditRisk = (
      await read<{ r: number }>(graph, `MATCH (s:Symbol {id: $id}) RETURN s.risk AS r`, {
        id: AUDIT,
      })
    )[0]!.r;
    const hashBefore = await hashOf(CHECK_USER);

    const p = await previewMerge(graph, {
      slug,
      taskId: task.id,
      branchPath: branch,
      riskThreshold: Number(auditRisk) - 1e-9, // treat audit() as load-bearing for this test
    });

    expect(p.symbolsAdded).toEqual(['src/auth/login.ts::logAttempt']);
    expect(p.symbolsChanged).toContain(CHECK_USER);
    expect(p.symbolsRemoved).toEqual([]);
    expect(p.callsAdded).toEqual(
      expect.arrayContaining([
        { from: CHECK_USER, to: 'src/auth/login.ts::logAttempt' },
        { from: 'src/auth/login.ts::logAttempt', to: AUDIT },
      ]),
    );
    expect(p.wouldGoStale.map((m) => m.id)).toContain(lesson.id);
    expect(p.newCallersOfRisky).toEqual([
      {
        from: 'src/auth/login.ts::logAttempt',
        to: AUDIT,
        risk: expect.closeTo(Number(auditRisk), 6),
      },
    ]);
    expect(p.summary).toMatch(/1 function\(s\) added; 1 changed; 2 call\(s\) added/);
    expect(p.summary).toMatch(/1 lesson\(s\) would become possibly outdated/);

    // the real graph: same function, nothing marked stale, no copy left behind
    expect(await hashOf(CHECK_USER)).toBe(hashBefore);
    const [f] = await read<{ stale: boolean }>(
      graph,
      `MATCH (f:Failure {id: $id}) RETURN coalesce(f.stale, false) AS stale`,
      { id: lesson.id },
    );
    expect(f!.stale).toBe(false);
    expect(
      (await db!.list()).filter((g) => isPreviewGraph(g) && g.startsWith(graphName(slug))),
    ).toEqual([]);

    // stored on the task, newest only
    await saveMergePreview(graph, p);
    await saveMergePreview(graph, { ...p, summary: 'newer' });
    expect((await getMergePreview(graph, task.id))?.summary).toBe('newer');
  });

  it('Q26: a dry run of the scheduler on a copy says which tasks start together and which wait, and why', async () => {
    const make = (title: string, targets: string[], dependsOn: string[] = []) =>
      createTask(graph, slug, config, { title, type: 'implement', targets, dependsOn });
    const a = await make('Change audit', [AUDIT]);
    const b = await make('Change login', [LOGIN]); // login() calls audit(): overlaps a
    const c = await make('Change listProducts', ['src/products/products.ts::listProducts']);
    const d = await make('After audit', ['src/auth/tokens.ts::verifyToken'], [a.id]);

    const plan = await previewPlan(graph, {
      slug,
      taskIds: [a.id, b.id, c.id, d.id],
      maxParallel: 3,
    });

    expect(plan.waves[0]!.start.sort()).toEqual([a.id, c.id].sort());
    const waits = Object.fromEntries(plan.waves[0]!.waits.map((w) => [w.task, w.reason]));
    expect(waits[b.id]).toBe('touches the same code as "Change audit"');
    expect(waits[d.id]).toBe('depends on "Change audit"');
    expect(plan.waves[1]!.start.sort()).toEqual([b.id, d.id].sort());
    expect(plan.stuck).toEqual([]);

    // nothing real moved: every task is still where it was, and the copy is gone
    for (const t of [a, b, c, d]) expect((await getTask(graph, t.id))!.status).toBe(t.status);
    expect(
      (await db!.list()).filter((g) => isPreviewGraph(g) && g.startsWith(graphName(slug))),
    ).toEqual([]);
  });

  it('Q26: with at most one at a time, independent tasks queue up and say so', async () => {
    const x = await createTask(graph, slug, config, {
      title: 'X',
      type: 'implement',
      targets: ['src/cart/tax.ts::taxFor'],
    });
    const y = await createTask(graph, slug, config, {
      title: 'Y',
      type: 'implement',
      targets: ['src/lib/ids.ts::newId'],
    });
    const plan = await previewPlan(graph, { slug, taskIds: [x.id, y.id], maxParallel: 1 });
    expect(plan.waves.map((w) => w.start)).toEqual([[x.id], [y.id]]);
    expect(plan.waves[0]!.waits).toEqual([{ task: y.id, for: [], reason: 'at most 1 at a time' }]);
  });
});
