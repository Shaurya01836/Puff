// What counts as the code failing its check, as opposed to the check not being able to run.
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  explainTestError,
  looksLikeCodeFailure,
  runVerification,
} from '../src/orchestrator/verify';
import { isLimitError } from '../src/agents/parse';

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

describe('saying why a check could not run', () => {
  it("turns Windows' huge unsigned codes into the real number and a plain reason", () => {
    expect(explainTestError(4294963238, '')).toMatch(/could not find a file or program.*-4058/);
    expect(explainTestError(4294963238, '')).not.toContain('4294963238');
  });

  it('says plainly when npm found no package.json', () => {
    const output =
      'npm error code ENOENT\nnpm error path D:\\proj\\package.json\nnpm error enoent Could not read package.json';
    expect(explainTestError(4294963238, output)).toMatch(/could not find a package\.json/);
  });

  it('otherwise includes the last line the command printed', () => {
    expect(explainTestError(3, 'starting\nboom: out of memory\n')).toBe(
      'The test command exited with code 3: boom: out of memory.',
    );
  });
});

describe('agents that have hit a limit', () => {
  const api = (message: string) => ({ kind: 'api' as const, message });
  it('recognises usage, session and rate limits', () => {
    expect(isLimitError(api("You've hit your session limit · resets 5:10am"))).toBe(true);
    expect(isLimitError(api('Rate limit exceeded, retry later'))).toBe(true);
    expect(isLimitError(api('429 Too Many Requests'))).toBe(true);
    expect(isLimitError(api('Your credit balance is too low'))).toBe(true);
  });
  it('does not mistake other failures for a limit', () => {
    expect(isLimitError(api('Model not found'))).toBe(false);
    expect(isLimitError({ kind: 'crash', message: 'session limit' })).toBe(false);
  });
});
