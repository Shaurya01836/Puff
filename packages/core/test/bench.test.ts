// The benchmark has to be sound before its numbers mean anything. For every task, on the real demo
// project with its real test command: the pristine repo fails the hidden acceptance spec (so doing
// nothing cannot pass), a correct change passes it, and the careless change that teaches Puff's
// memory fails the real tests.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { BENCH_TASKS } from '../src/bench/tasks';
import { applyEdits, plainPrompt, summarizeBench, writeAcceptance } from '../src/bench/runner';
import { removeLink } from '../src/git/repo';
import { setupDemoWorkspace } from '../src/git/demo';
import { runVerification } from '../src/orchestrator/verify';

const DEMO = fileURLToPath(new URL('../../../demo/shop-api', import.meta.url));
// Real test runs of the demo project: about two minutes, so opt in with PUFF_BENCH_CHECK=1.
const ready = existsSync(join(DEMO, 'node_modules')) && process.env.PUFF_BENCH_CHECK === '1';

describe.skipIf(!ready)('benchmark tasks', () => {
  const made: string[] = [];
  const copy = async (name: string) => {
    const root = mkdtempSync(join(tmpdir(), `puff-bench-test-${name}-`));
    made.push(root);
    const dest = join(root, 'shop-api');
    await setupDemoWorkspace({ source: DEMO, dest });
    return dest;
  };
  const verify = (dir: string) => runVerification(dir, 'npm test', 120_000);

  afterAll(async () => {
    for (const root of made) {
      await removeLink(join(root, 'shop-api', 'node_modules')).catch(() => {});
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it('the pristine demo passes its own tests', async () => {
    expect((await verify(await copy('pristine'))).ok).toBe(true);
  }, 120_000);

  for (const task of BENCH_TASKS) {
    it(`${task.id}: doing nothing fails, a correct change passes`, async () => {
      const idle = await copy(`${task.id}-idle`);
      await writeAcceptance(idle, task);
      expect((await verify(idle)).ok, 'the hidden spec must fail on the untouched repo').toBe(
        false,
      );

      const good = await copy(`${task.id}-golden`);
      applyEdits(good, task.golden);
      await writeAcceptance(good, task);
      const verdict = await verify(good);
      expect(verdict.ok, verdict.output.slice(-1500)).toBe(true);
    }, 240_000);

    if (task.lesson) {
      it(`${task.id}: the careless change fails the real tests`, async () => {
        const bad = await copy(`${task.id}-naive`);
        applyEdits(bad, task.lesson!.naive);
        await writeAcceptance(bad, task);
        const verdict = await verify(bad);
        expect(verdict.kind).toBe('tests-failed');
      }, 120_000);
    }
  }
});

describe('benchmark helpers', () => {
  it('the plain prompt is the task in the same template, with nothing from Puff', () => {
    const task = BENCH_TASKS[0]!;
    const prompt = plainPrompt(task);
    expect(prompt).toContain(`TASK: ${task.title}`);
    expect(prompt).not.toMatch(/PROJECT MEMORY|TARGET CODE|CALLERS/);
  });

  it('summarises each arm and counts files read only where they were reported', () => {
    const run = (arm: 'plain' | 'puff', passed: boolean, tokens: number, filesRead?: number) => ({
      task: 't',
      arm,
      run: 1,
      passed,
      changedFiles: 1,
      tokens,
      filesRead,
      durationMs: 1000,
      promptTokens: 10,
    });
    const s = summarizeBench({
      generatedAt: '',
      agent: 'opencode',
      model: 'm',
      runsPerArm: 1,
      tasks: ['t'],
      notes: [],
      runs: [run('plain', false, 1000, 10), run('plain', true, 3000, 20), run('puff', true, 900)],
    });
    expect(s.plain).toMatchObject({
      runs: 2,
      passed: 1,
      firstTryPassRate: 0.5,
      tokens: 2000,
      filesRead: 15,
    });
    expect(s.puff).toMatchObject({
      runs: 1,
      passed: 1,
      firstTryPassRate: 1,
      tokens: 900,
      filesRead: 0,
    });
  });
});
