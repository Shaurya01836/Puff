// What counts as the code failing its check, as opposed to the check not being able to run.
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { looksLikeCodeFailure, runVerification } from '../src/orchestrator/verify';

const run = (script: string) => runVerification(tmpdir(), `node -e "${script}"`, 30_000);

describe('verification verdicts', () => {
  it('compiler errors from a type check are the code failing, so they can become a lesson', async () => {
    const verdict = await run(
      "console.log('app/page.tsx(12,3): error TS2322: Type string is not assignable to number'); process.exit(2)",
    );
    expect(verdict).toMatchObject({ ok: false, kind: 'tests-failed' });
  }, 30_000);

  it('a check that crashes without saying the code is wrong is a harness error, not a lesson', async () => {
    const verdict = await run(
      "console.error('ENOENT: no such file or directory'); process.exit(1)",
    );
    expect(verdict).toMatchObject({ ok: false, kind: 'error' });
  }, 30_000);

  it('exit code 0 passes whatever it prints', async () => {
    expect((await run("console.log('all fine')")).kind).toBe('passed');
  }, 30_000);

  it('recognises failing tests and compiler errors in output', () => {
    expect(looksLikeCodeFailure('FAIL  test/a.spec.ts')).toBe(true);
    expect(looksLikeCodeFailure('1 test failed')).toBe(true);
    expect(looksLikeCodeFailure('src/a.ts(1,1): error TS2304: Cannot find name x')).toBe(true);
    expect(looksLikeCodeFailure('npm error code ENOENT')).toBe(false);
  });
});
