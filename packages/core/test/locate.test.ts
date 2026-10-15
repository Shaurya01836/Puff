import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  innermost,
  isNoiseFrame,
  locateFailure,
  normalizePath,
  parseStackFrames,
  parseTestFailures,
  parseUnifiedDiff,
  worktreeSymbols,
} from '../src/memory/locate';
import { sanitizeMessage } from '../src/memory/memory';
import { applyReport, parsePuffReport } from '../src/memory/report';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
const DEMO = fileURLToPath(new URL('../../../demo/shop-api', import.meta.url));
const ROOT = '/work/shop-api';

const allExist = async (ids: string[]) => new Set(ids);

describe('stack frame parsing', () => {
  it('reads Vitest frames, with and without a function name', () => {
    const frames = parseStackFrames(
      ' ❯ taxFor src/cart/tax.ts:5:30\n ❯ test/cart.spec.ts:32:12\n ❯ Server.<anonymous> node_modules/supertest/lib/test.js:227:13',
    );
    expect(frames).toEqual([
      { fn: 'taxFor', file: 'src/cart/tax.ts', line: 5, col: 30 },
      { fn: undefined, file: 'test/cart.spec.ts', line: 32, col: 12 },
      { fn: 'Server.<anonymous>', file: 'node_modules/supertest/lib/test.js', line: 227, col: 13 },
    ]);
  });

  it('reads Node and Jest frames, Windows paths and file URLs', () => {
    const frames = parseStackFrames(
      [
        '    at taxFor (C:\\work\\shop-api\\src\\cart\\tax.ts:5:30)',
        '    at Object.<anonymous> (file:///C:/work/shop-api/src/cart/cart.ts:67:20)',
        '    at /work/shop-api/src/app.ts:3:1',
        '    at async Promise.all (index 0)',
      ].join('\n'),
      'C:\\work\\shop-api',
    );
    expect(frames.map((f) => `${f.file}:${f.line}`)).toEqual([
      'src/cart/tax.ts:5',
      'src/cart/cart.ts:67',
      '/work/shop-api/src/app.ts:3',
    ]);
  });

  it('normalises paths', () => {
    expect(normalizePath('./src/a.ts')).toBe('src/a.ts');
    expect(normalizePath('D:\\repo\\src\\a.ts', 'D:\\repo')).toBe('src/a.ts');
    expect(normalizePath('d:/REPO/src/a.ts', 'D:/repo/')).toBe('src/a.ts');
  });

  it('treats dependencies, internals, outside paths and tests as noise', () => {
    const f = (file: string) => isNoiseFrame({ file, line: 1, col: 1 });
    expect(f('node_modules/x/index.js')).toBe(true);
    expect(f('node:internal/process')).toBe(true);
    expect(f('/usr/lib/x.js')).toBe(true);
    expect(f('test/auth.spec.ts')).toBe(true);
    expect(f('src/auth/login.ts')).toBe(false);
  });
});

describe('test failure parsing (real Vitest output)', () => {
  it('finds both failures in a runtime-error run and keeps the source frames', () => {
    const failures = parseTestFailures(fixture('vitest-runtime-error.txt'), ROOT);
    expect(failures.map((f) => f.test)).toEqual([
      'cart > applies the discount before tax',
      'cart routes > adds an item through the API',
    ]);
    expect(failures[0]!.message).toBe('Error: tax table unavailable');
    expect(
      failures[0]!.frames.filter((f) => !isNoiseFrame(f)).map((f) => `${f.fn}@${f.file}`),
    ).toEqual(['taxFor@src/cart/tax.ts', 'cartTotal@src/cart/cart.ts']);
  });

  it('keeps only the headline of an assertion failure (never the Received value)', () => {
    const [failure] = parseTestFailures(fixture('vitest-assertion-in-test.txt'), ROOT);
    expect(failure!.test).toBe('login > never writes a password to the logs');
    expect(failure!.message.startsWith('AssertionError: expected')).toBe(true);
    expect(failure!.message).not.toContain('Received');
    expect(failure!.message.length).toBeLessThanOrEqual(300);
    // the only stack frame is in the test file, which is exactly why a diff fallback is needed
    expect(failure!.frames.filter((f) => !isNoiseFrame(f))).toEqual([]);
  });

  it('returns nothing for output without failures', () => {
    expect(parseTestFailures(' ✓ test/a.spec.ts (3 tests)\n Tests  3 passed (3)')).toEqual([]);
  });

  it('strips ANSI and caps long messages', () => {
    expect(sanitizeMessage('\x1b[31mError:\x1b[0m   boom\nsecret: hunter2')).toBe('Error: boom');
    expect(sanitizeMessage('x'.repeat(500))).toHaveLength(300);
  });

  it('redacts values of sensitive keys, but leaves ordinary words alone', () => {
    expect(sanitizeMessage('got {"data":{"email":"a@b.co","password":"hunter2"}}')).toBe(
      'got {"data":{"email":"a@b.co","password":[redacted]}}',
    );
    expect(sanitizeMessage('token=abc123 and Bearer abcdefgh12345 sent')).toBe(
      'token=[redacted] and Bearer [redacted] sent',
    );
    expect(sanitizeMessage('expected token to be valid; password must be set')).toBe(
      'expected token to be valid; password must be set',
    );
  });
});

describe('diff parsing', () => {
  it('maps hunks to changed lines in the new file', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3,3 +3,4 @@ ctx',
      ' keep',
      '-old',
      '+new1',
      '+new2',
      ' keep2',
      '@@ -20,2 +21,1 @@',
      '--- not a header, just a removed line starting with --',
      ' tail',
    ].join('\n');
    expect(parseUnifiedDiff(diff).get('src/a.ts')).toEqual([4, 4, 5, 21]);
  });

  it('ignores deleted files', () => {
    expect(parseUnifiedDiff('--- a/x.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone').size).toBe(0);
  });
});

describe('locating a failure (against the real demo repo)', () => {
  const symbols = worktreeSymbols(DEMO);
  const base = { symbols, exists: allExist };

  it('finds the innermost symbol containing a line', async () => {
    const syms = await symbols('src/cart/tax.ts');
    expect(innermost(syms, 5)?.id).toBe('src/cart/tax.ts::taxFor');
    expect(innermost(syms, 1)).toBeUndefined();
  });

  it('stack: a runtime error lands on the function that threw, plus the targeted caller', async () => {
    const [failure] = parseTestFailures(fixture('vitest-runtime-error.txt'), ROOT);
    const where = await locateFailure({
      ...base,
      frames: failure!.frames,
      targets: ['src/cart/cart.ts::cartTotal'],
    });
    expect(where).toEqual({
      via: 'stack',
      symbolIds: ['src/cart/tax.ts::taxFor', 'src/cart/cart.ts::cartTotal'],
    });
  });

  it('diff: an assertion failure lands on the code the agent changed, not on the test', async () => {
    const [failure] = parseTestFailures(fixture('vitest-assertion-in-test.txt'), ROOT);
    const src = readFileSync(`${DEMO}/src/auth/login.ts`, 'utf8').split('\n');
    const line = src.findIndex((l) => l.includes("audit('login.failed'")) + 1;
    const diff = [
      '--- a/src/auth/login.ts',
      '+++ b/src/auth/login.ts',
      `@@ -${line},1 +${line},1 @@`,
      "-    audit('login.failed', { email });",
      "+    audit('login.failed', { email, password });",
    ].join('\n');
    const where = await locateFailure({
      ...base,
      frames: failure!.frames,
      diff,
      targets: ['src/auth/login.ts::login'],
    });
    // checkUser is the function that actually contains the changed line; login is the task target
    expect(where).toEqual({ via: 'diff', symbolIds: ['src/auth/login.ts::checkUser'] });
  });

  it('diff: prefers touched symbols that are task targets', async () => {
    const src = readFileSync(`${DEMO}/src/auth/login.ts`, 'utf8').split('\n');
    const loginLine = src.findIndex((l) => l.includes("audit('login.success'")) + 1;
    const checkLine = src.findIndex((l) => l.includes("audit('login.failed'")) + 1;
    const diff = [
      '+++ b/src/auth/login.ts',
      `@@ -${loginLine},1 +${loginLine},1 @@`,
      '-x',
      '+y',
      `@@ -${checkLine},1 +${checkLine},1 @@`,
      '-x',
      '+y',
    ].join('\n');
    const where = await locateFailure({
      ...base,
      frames: [],
      diff,
      targets: ['src/auth/login.ts::login'],
    });
    expect(where).toEqual({ via: 'diff', symbolIds: ['src/auth/login.ts::login'] });
  });

  it('changed-target: falls back to targets in files the agent changed', async () => {
    const where = await locateFailure({
      ...base,
      frames: [],
      targets: ['src/cart/cart.ts::cartTotal', 'src/auth/login.ts::login'],
      changedFiles: ['src/auth/login.ts'],
    });
    expect(where).toEqual({ via: 'changed-target', symbolIds: ['src/auth/login.ts::login'] });
  });

  it('target: last resort is the task target; with nothing at all there is no anchor', async () => {
    expect(
      await locateFailure({ ...base, frames: [], targets: ['src/cart/cart.ts::cartTotal'] }),
    ).toEqual({
      via: 'target',
      symbolIds: ['src/cart/cart.ts::cartTotal'],
    });
    expect(await locateFailure({ ...base, frames: [], targets: [] })).toBeUndefined();
  });

  it('never anchors to a symbol that is not in the graph', async () => {
    const where = await locateFailure({
      symbols,
      exists: async () => new Set<string>(),
      frames: [{ file: 'src/cart/tax.ts', line: 5, col: 1 }],
      targets: ['src/cart/cart.ts::cartTotal'],
    });
    expect(where).toBeUndefined();
  });
});

describe('puff-report', () => {
  it('parses the last block and validates it', () => {
    const out = [
      'did stuff',
      '<puff-report>{"notes":"first"}</puff-report>',
      'more',
      '<puff-report>\n{"decisions":[{"symbol":"login","text":"log email only"}],"notes":"done"}\n</puff-report>',
    ].join('\n');
    expect(parsePuffReport(out).report).toEqual({
      decisions: [{ symbol: 'login', text: 'log email only' }],
      notes: 'done',
    });
  });

  it('reports a bad block instead of throwing, and ignores output without one', () => {
    expect(parsePuffReport('nothing here')).toEqual({});
    expect(parsePuffReport('<puff-report>{nope</puff-report>').error).toMatch(/not valid JSON/);
    expect(
      parsePuffReport('<puff-report>{"decisions":[{"symbol":"x"}]}</puff-report>').error,
    ).toMatch(/Invalid/);
  });

  it('applyReport is exported for the orchestrator', () => {
    expect(typeof applyReport).toBe('function');
  });
});
