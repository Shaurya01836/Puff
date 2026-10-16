// Verification: run the project's own test command in the task's worktree and read the result.
// Puff trusts the exit code and the test output, never the agent's claim that it passed.
import { runProcess } from '../agents/spawn';
import { stripAnsi } from '../memory/locate';

export interface TestSummary {
  passed: number;
  failed: number;
  total: number;
}

/** Counts from Vitest (`Tests  1 failed | 5 passed (6)`) or Jest (`Tests:  1 failed, 5 passed, 6 total`). */
export function parseTestSummary(output: string): TestSummary | undefined {
  const text = stripAnsi(output);
  const count = (parts: string, label: string): number =>
    Number(new RegExp(`(\\d+)\\s+${label}`).exec(parts)?.[1] ?? 0);

  const vitest = /^\s*Tests\s{2,}(.+?)\s*\((\d+)\)\s*$/m.exec(text);
  if (vitest) {
    return {
      passed: count(vitest[1]!, 'passed'),
      failed: count(vitest[1]!, 'failed'),
      total: Number(vitest[2]),
    };
  }
  const jest = /^\s*Tests:\s+(.+)$/m.exec(text);
  if (jest) {
    const total = Number(/(\d+)\s+total/.exec(jest[1]!)?.[1]);
    if (Number.isFinite(total)) {
      return { passed: count(jest[1]!, 'passed'), failed: count(jest[1]!, 'failed'), total };
    }
  }
  return undefined;
}

/**
 * Output of a check that ran and found problems in the code: failing tests, or compiler errors when the
 * "test command" is a type check (`tsc`), which is all some projects have. A command that crashed without
 * saying either is a harness problem instead.
 */
export function looksLikeCodeFailure(output: string): boolean {
  return /FAIL|failed|error TS\d+/i.test(output);
}

/**
 * Say why a test command failed to run in words a person can act on. Windows reports some failures as
 * huge unsigned numbers (4294963238 is really -4058, "not found"), and npm's own message is buried.
 */
export function explainTestError(exitCode: number | null, output: string): string {
  const code = exitCode !== null && exitCode > 0x7fffffff ? exitCode - 0x100000000 : exitCode;
  if (/ENOENT/.test(output) && /package\.json/.test(output))
    return 'The test command could not find a package.json where it ran (the top folder of the project).';
  if (code === -4058)
    return 'The test command could not find a file or program it needs (code -4058, "not found").';
  const last = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  return `The test command exited with code ${code}${last ? `: ${last.slice(0, 160)}` : ''}.`;
}

export interface Verdict {
  ok: boolean;
  /** `tests-failed`: the tests ran and some failed. `error`: the command crashed, timed out or never ran. */
  kind: 'passed' | 'tests-failed' | 'error';
  output: string;
  exitCode: number | null;
  summary?: TestSummary;
  durationMs: number;
  message?: string;
}

/**
 * The command comes from the project's own config, not from model output, so it runs through the
 * shell (that is how `npm test` resolves on every OS). Agents cannot change it.
 */
export async function runVerification(
  cwd: string,
  testCommand: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Verdict> {
  const r = await runProcess({
    command: testCommand,
    cwd,
    timeoutMs,
    signal,
    shell: true,
    env: { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  const output = `${r.stdout}\n${r.stderr}`.trim();
  const summary = parseTestSummary(output);
  const base = { output, exitCode: r.exitCode, summary, durationMs: r.durationMs };

  if (r.timedOut)
    return {
      ...base,
      ok: false,
      kind: 'error',
      message: `Tests did not finish within ${Math.round(timeoutMs / 1000)} s`,
    };
  if (r.aborted) return { ...base, ok: false, kind: 'error', message: 'Stopped by the user' };
  if (r.spawnError) return { ...base, ok: false, kind: 'error', message: r.spawnError };
  if (r.exitCode === 0) return { ...base, ok: true, kind: 'passed' };
  // A non-zero exit with failing tests in the output is a code problem; anything else is the harness.
  if (summary ? summary.failed > 0 : looksLikeCodeFailure(output)) {
    return { ...base, ok: false, kind: 'tests-failed', message: 'Tests failed' };
  }
  return { ...base, ok: false, kind: 'error', message: explainTestError(r.exitCode, output) };
}
