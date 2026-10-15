// The benchmark: the same tasks, the same agent and model, a fresh copy of the demo repo for every run,
// with and without Puff.
//
//   plain  the task alone, in the same prompt template
//   puff   the same prompt plus what Puff adds: target code, callers, and what the team learned
//
// Each run is one attempt (so "first try" is exactly that). It passes only if the agent changed
// something AND the repository's whole test suite plus a hidden acceptance spec pass. Puff's memory
// is taught beforehand through the real pipeline: a careless change is run through the real tests,
// the real failure is located in code and recorded, with its fix and a decision (see tasks.ts).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FalkorDB } from 'falkordb';
import type { AgentName, Savings } from '@puff/shared';
import type { Adapters } from '../agents/adapters';
import type { PuffConfig } from '../config';
import { compileContext } from '../context/compiler';
import { estimateTokens, renderPrompt } from '../context/prompt';
import { projectGraph } from '../db/client';
import { initProjectGraph } from '../db/init';
import { git, removeLink } from '../git/repo';
import { setupDemoWorkspace } from '../git/demo';
import { indexRepo } from '../indexer/index';
import { recordTestFailures } from '../memory/failures';
import { recordDecision, recordSolution } from '../memory/memory';
import { finishSession, startSession } from '../memory/sessions';
import { createTask, updateTask } from '../memory/tasks';
import { resolveSymbols } from '../queries/code';
import { runVerification } from '../orchestrator/verify';
import { BENCH_TASKS, type BenchTask, type Edit } from './tasks';

export type Arm = 'plain' | 'puff';

export interface BenchRun {
  task: string;
  arm: Arm;
  /** 1-based repeat number for this task and arm */
  run: number;
  /** Changed something, and the whole suite plus the hidden acceptance spec passed */
  passed: boolean;
  /** Why it did not pass, when it did not */
  failure?: 'agent-error' | 'no-change' | 'tests';
  detail?: string;
  tests?: { passed: number; total: number };
  changedFiles: number;
  /** Input + output tokens as the harness reported them (input includes cached) */
  tokens?: number;
  cachedTokens?: number;
  /** Distinct files opened with the read tool; undefined when the harness does not report it */
  filesRead?: number;
  durationMs: number;
  /** Rough size of the prompt Puff or the plain template produced */
  promptTokens: number;
}

export interface BenchResults {
  generatedAt: string;
  agent: AgentName;
  model: string;
  runsPerArm: number;
  tasks: string[];
  runs: BenchRun[];
  /** Plain-language limits of this measurement, shown next to the numbers */
  notes: string[];
}

export interface BenchOptions {
  db: FalkorDB;
  config: PuffConfig;
  adapters: Adapters;
  agent: AgentName;
  /** Path of the demo project source (a folder with package.json) */
  source: string;
  runs?: number;
  /** Task ids to run; default all */
  only?: string[];
  arms?: Arm[];
  /** Where to put the temporary repositories; default the OS temp folder */
  workDir?: string;
  keep?: boolean;
  /** Extra tries when the harness itself fails (timeout, provider error, not signed in); default 2 */
  retries?: number;
  /** Called with everything measured so far after each run, so a crash never loses results */
  onProgress?: (partial: BenchResults) => Promise<void> | void;
  log?: (line: string) => void;
  signal?: AbortSignal;
}

/** Apply edits to files under `root`. An edit whose anchor is missing is a benchmark bug, so it throws. */
export function applyEdits(root: string, edits: Edit[]): void {
  for (const e of edits) {
    const path = join(root, e.file);
    if ('create' in e) {
      writeFileSync(path, e.create);
      continue;
    }
    const before = readFileSync(path, 'utf8');
    if (!before.includes(e.from))
      throw new Error(`Benchmark edit does not apply to ${e.file}: ${e.from.slice(0, 60)}`);
    writeFileSync(
      path,
      before.replace(e.from, () => e.to),
    );
  }
}

export async function writeAcceptance(root: string, task: BenchTask): Promise<void> {
  const path = join(root, task.acceptance.file);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, task.acceptance.content);
}

/** The task alone, in the same template Puff uses. */
export function plainPrompt(task: BenchTask): string {
  return renderPrompt({
    role: 'coder',
    title: task.title,
    targets: [],
    callers: [],
    failures: [],
    decisions: [],
    procedures: [],
    handoffs: [],
    technologies: [],
  });
}

const sum = (xs: (number | undefined)[]) => xs.reduce<number>((n, x) => n + (x ?? 0), 0);

/** Averages per arm, and the shape the Savings screen shows. */
export function summarizeBench(results: BenchResults) {
  const arm = (a: Arm) => {
    // A run the harness itself failed (timeout, provider error) says nothing about the arm
    const all = results.runs.filter((r) => r.arm === a);
    const runs = all.filter((r) => r.failure !== 'agent-error');
    const withFiles = runs.filter((r) => r.filesRead !== undefined);
    const n = Math.max(runs.length, 1);
    return {
      runs: runs.length,
      invalid: all.length - runs.length,
      passed: runs.filter((r) => r.passed).length,
      firstTryPassRate: runs.length ? runs.filter((r) => r.passed).length / runs.length : 0,
      tokens: Math.round(sum(runs.map((r) => r.tokens)) / n),
      filesRead: withFiles.length ? sum(withFiles.map((r) => r.filesRead)) / withFiles.length : 0,
      durationMs: Math.round(sum(runs.map((r) => r.durationMs)) / n),
    };
  };
  return { plain: arm('plain'), puff: arm('puff') };
}

export async function runBenchmark(opts: BenchOptions): Promise<BenchResults> {
  const { db, config, adapters, agent } = opts;
  const log = opts.log ?? (() => {});
  const adapter = adapters[agent];
  if (!adapter) throw new Error(`No adapter for ${agent}`);
  const tasks = BENCH_TASKS.filter((t) => !opts.only?.length || opts.only.includes(t.id));
  if (tasks.length === 0) throw new Error('No benchmark task matches');
  const arms = opts.arms ?? ['plain', 'puff'];
  const repeats = opts.runs ?? 1;
  const model = config.harnesses[agent]?.model ?? 'CLI default';

  const work = await mkdtemp(join(opts.workDir ?? tmpdir(), 'puff-bench-'));
  const slug = `bench_${Date.now().toString(36)}`;
  const runs: BenchRun[] = [];
  const snapshot = (): BenchResults => ({
    generatedAt: new Date().toISOString(),
    agent,
    model,
    runsPerArm: repeats,
    tasks: tasks.map((t) => t.id),
    runs: [...runs],
    notes: [
      'One agent and one model for both arms; a fresh copy of the demo repo for every run; one attempt per run.',
      'A run passes only if the agent changed files and the whole test suite plus a hidden acceptance spec pass.',
      "Puff's memory was taught by running a careless change through the real tests and recording the real failure; it stands in for an earlier teammate session.",
      'Tokens are input plus output as the harness reported them (input includes cached tokens). Files read is only counted where the harness prints its tool calls (OpenCode).',
      'A run where the harness itself failed (timeout, provider error) after retries is left out of the averages and counted as invalid, not as a failure of either arm.',
      'Small sample: treat differences as indications, not proof.',
    ],
  });
  try {
    // The graph Puff's arm reads: the demo code, what a teammate's agents learned, and the tasks.
    const base = join(work, 'base');
    await setupDemoWorkspace({ source: opts.source, dest: base });
    const project = { slug, name: slug, repoPath: base };
    const graph = await initProjectGraph(db, project, config);
    await indexRepo(graph, project);
    const taskIds = new Map<string, string>();

    if (arms.includes('puff')) {
      for (const task of tasks) {
        if (!task.lesson) continue;
        log(`teaching memory: ${task.id}`);
        const scratch = join(work, `teach-${task.id}`);
        await setupDemoWorkspace({ source: opts.source, dest: scratch });
        applyEdits(scratch, task.lesson.naive);
        await writeAcceptance(scratch, task);
        const verdict = await runVerification(
          scratch,
          config.verify.testCommand,
          config.limits.timeoutMs,
        );
        if (verdict.kind !== 'tests-failed')
          throw new Error(
            `The careless change for "${task.id}" did not fail the tests (${verdict.kind}); the lesson would be invented`,
          );
        const changedFiles = (await git(['diff', '--name-only'], scratch)).out
          .split(/\r?\n/)
          .filter(Boolean);
        const diff = (await git(['diff'], scratch)).out;

        const earlier = await createTask(graph, slug, config, {
          title: `Earlier attempt: ${task.title}`,
          type: 'implement',
          complexity: 'medium',
          targets: task.lesson.symbols,
        });
        const sessionId = await startSession(graph, { agent, taskId: earlier.id, role: 'coder' });
        const recorded = await recordTestFailures(graph, {
          sessionId,
          taskId: earlier.id,
          output: verdict.output,
          root: scratch,
          diff,
          changedFiles,
        });
        await finishSession(graph, sessionId, {
          outcome: 'failure',
          summary: recorded[0]?.message,
        });
        for (const f of recorded)
          await recordSolution(graph, { failureId: f.id, summary: task.lesson.fix });
        await recordDecision(graph, {
          symbolIds: await resolveSymbols(graph, task.lesson.symbols),
          text: task.lesson.decision,
        });
        await updateTask(graph, earlier.id, { status: 'done' });
        log(`  recorded ${recorded.length} failure(s) from the real test run`);
      }
      for (const task of tasks) {
        const t = await createTask(graph, slug, config, {
          title: task.title,
          type: 'implement',
          complexity: 'medium',
          targets: task.targets,
        });
        taskIds.set(task.id, t.id);
      }
    }

    for (const task of tasks) {
      for (let n = 1; n <= repeats; n++) {
        // alternate which arm goes first so slow drift (provider load) does not favour one arm
        const order = (task.id.length + n) % 2 === 0 ? arms : [...arms].reverse();
        for (const arm of order) {
          if (opts.signal?.aborted) throw new Error('Stopped');
          log(`${task.id} · ${arm} · run ${n}`);
          const dir = join(work, `${task.id}-${arm}-${n}`);
          await setupDemoWorkspace({ source: opts.source, dest: dir });

          const prompt =
            arm === 'plain'
              ? plainPrompt(task)
              : (
                  await compileContext(graph, taskIds.get(task.id)!, {
                    role: 'coder',
                    preview: true,
                    budgetTokens: config.limits.contextTokenBudget,
                    testCommand: config.verify.testCommand,
                  })
                ).prompt;

          let res = await adapter.run({
            prompt,
            cwd: dir,
            role: 'coder',
            timeoutMs: config.limits.timeoutMs,
            model: config.harnesses[agent]?.model,
            signal: opts.signal,
          });
          // The harness failing (timeout, provider error) is not the agent failing the task: start over
          // in a clean copy, a couple of times, before giving up on this run.
          for (
            let again = 1;
            res.error && res.error.kind !== 'aborted' && again <= (opts.retries ?? 2);
            again++
          ) {
            log(
              `  harness problem (${res.error.kind}): ${res.error.message}. Trying again (${again})`,
            );
            await removeLink(join(dir, 'node_modules')).catch(() => {});
            await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
            await setupDemoWorkspace({ source: opts.source, dest: dir });
            res = await adapter.run({
              prompt,
              cwd: dir,
              role: 'coder',
              timeoutMs: config.limits.timeoutMs,
              model: config.harnesses[agent]?.model,
              signal: opts.signal,
            });
          }

          const changed = (await git(['status', '--porcelain'], dir)).out
            .split(/\r?\n/)
            .filter((l) => l.trim() && !/node_modules/.test(l)).length;
          const base: Omit<BenchRun, 'passed'> = {
            task: task.id,
            arm,
            run: n,
            changedFiles: changed,
            tokens: res.tokensIn === undefined ? undefined : res.tokensIn + (res.tokensOut ?? 0),
            cachedTokens: res.cachedIn,
            filesRead: res.filesRead,
            durationMs: res.durationMs,
            promptTokens: estimateTokens(prompt),
          };
          let run: BenchRun;
          if (res.error) {
            run = {
              ...base,
              passed: false,
              failure: 'agent-error',
              detail: `${res.error.kind}: ${res.error.message}. Last output: ${res.raw.slice(-300).replace(/s+/g, ' ')}`,
            };
          } else if (changed === 0) {
            run = {
              ...base,
              passed: false,
              failure: 'no-change',
              detail: 'The agent changed no files',
            };
          } else {
            await writeAcceptance(dir, task);
            const verdict = await runVerification(
              dir,
              config.verify.testCommand,
              config.limits.timeoutMs,
            );
            const tests = verdict.summary && {
              passed: verdict.summary.passed,
              total: verdict.summary.total,
            };
            run = verdict.ok
              ? { ...base, passed: true, tests }
              : {
                  ...base,
                  passed: false,
                  failure: 'tests',
                  tests,
                  detail: verdict.message ?? 'Tests failed',
                };
          }
          runs.push(run);
          await opts.onProgress?.(snapshot());
          log(
            `  ${run.passed ? '✔ passed' : `✖ ${run.failure}`} · ${run.tokens ?? '?'} tokens · ${run.filesRead ?? '?'} files read · ${Math.round(run.durationMs / 1000)}s`,
          );
        }
      }
    }
  } finally {
    await projectGraph(db, slug)
      .delete()
      .catch(() => {});
    if (!opts.keep) {
      // node_modules in each copy is a link to the demo's real one: unlink before deleting
      for (const entry of await readdir(work).catch(() => [] as string[])) {
        const nm = join(work, entry, 'node_modules');
        if (existsSync(nm)) await removeLink(nm).catch(() => {});
      }
      await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch((e) =>
        log(`could not remove ${work}: ${(e as Error).message}`),
      );
    }
  }

  return snapshot();
}

/** The numbers the Savings screen shows, from a benchmark result. */
export function savingsFromBench(results: BenchResults): Savings {
  const s = summarizeBench(results);
  const perTask = results.tasks.map((id) => {
    const arm = (a: Arm) => {
      const runs = results.runs.filter((r) => r.task === id && r.arm === a);
      return {
        passed: runs.filter((r) => r.passed).length,
        runs: runs.length,
        tokens: Math.round(sum(runs.map((r) => r.tokens)) / Math.max(runs.length, 1)),
      };
    };
    return { id, plain: arm('plain'), puff: arm('puff') };
  });
  return {
    tasks: results.tasks.length,
    withPuff: {
      tokens: s.puff.tokens,
      filesRead: s.puff.filesRead,
      firstTryPassRate: s.puff.firstTryPassRate,
      durationMs: s.puff.durationMs,
      runs: s.puff.runs,
    },
    baseline: {
      tokens: s.plain.tokens,
      filesRead: s.plain.filesRead,
      firstTryPassRate: s.plain.firstTryPassRate,
      durationMs: s.plain.durationMs,
      runs: s.plain.runs,
    },
    measured: {
      agent: results.agent,
      model: results.model,
      runsPerArm: results.runsPerArm,
      generatedAt: results.generatedAt,
      filesReadReported: results.runs.some((r) => r.filesRead !== undefined),
      perTask,
      notes: results.notes,
    },
  };
}

/** Read bench/results.json; undefined when there is none or it is not a benchmark result. */
export async function loadBenchResults(path: string): Promise<BenchResults | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<BenchResults>;
    return Array.isArray(parsed.runs) && Array.isArray(parsed.tasks)
      ? (parsed as BenchResults)
      : undefined;
  } catch {
    return undefined;
  }
}
