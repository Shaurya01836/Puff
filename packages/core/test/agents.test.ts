import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createAdapter } from '../src/agents/adapters';
import { classifyError, parseClaude, parseCodex, parseOpenCode } from '../src/agents/parse';
import { launchTarget, resolveExecutable, runProcess, shimTarget } from '../src/agents/spawn';
import { summarize } from '../src/orchestrator/run';
import { parseTestSummary } from '../src/orchestrator/verify';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

describe('parsers (real output captured from the CLIs)', () => {
  it('Codex: message, and tokens where input already includes the cached part', () => {
    expect(parseCodex(fixture('agents/codex-ok.jsonl'))).toEqual({
      output: 'ok',
      tokensIn: 15272,
      cachedIn: 9984,
      tokensOut: 5,
      error: undefined,
    });
  });

  it('OpenCode: text, and tokens where input excludes the cache', () => {
    expect(parseOpenCode(fixture('agents/opencode-ok.jsonl'))).toEqual({
      output: 'ok',
      tokensIn: 9073 + 1792, // input + cache read
      cachedIn: 1792,
      tokensOut: 2,
      costUsd: 0,
      error: undefined,
    });
  });

  it('Claude Code: a login problem is an auth error, not a code failure', () => {
    const parsed = parseClaude(fixture('agents/claude-auth-error.json'));
    expect(parsed.error).toEqual({
      kind: 'auth',
      message: expect.stringContaining('OAuth session expired'),
    });
    expect(parsed.tokensIn).toBe(0);
  });

  it('Claude Code: success normalises cache fields into one input total', () => {
    // Shape taken from the real result object above (is_error: false, usage.*, total_cost_usd).
    const parsed = parseClaude(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'done <puff-report>{"notes":"x"}</puff-report>',
        total_cost_usd: 0.0123,
        usage: {
          input_tokens: 3,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 50,
          output_tokens: 7,
        },
      }),
    );
    expect(parsed).toMatchObject({
      tokensIn: 153,
      cachedIn: 50,
      tokensOut: 7,
      costUsd: 0.0123,
    });
    expect(parsed.error).toBeUndefined();
    expect(parsed.output).toContain('done');
  });

  it('reports unreadable output as a crash instead of throwing', () => {
    expect(parseClaude('Segmentation fault').error?.kind).toBe('crash');
    expect(parseCodex('not json at all')).toMatchObject({ output: '', tokensIn: undefined });
    expect(parseOpenCode('').output).toBe('');
  });

  it('reads error events from Codex and OpenCode', () => {
    const codex = parseCodex(
      '{"type":"error","message":"The model is not supported when using Codex with a ChatGPT account"}\n{"type":"turn.failed","error":{"message":"again"}}',
    );
    expect(codex.error).toEqual({ kind: 'api', message: expect.stringContaining('not supported') });
    expect(
      parseOpenCode('{"type":"error","error":{"data":{"message":"401 unauthorized"}}}').error?.kind,
    ).toBe('auth');
  });

  it('sorts error messages into auth and everything else', () => {
    expect(classifyError('Failed to authenticate').kind).toBe('auth');
    expect(classifyError('Invalid API key provided').kind).toBe('auth');
    expect(classifyError('429 rate limit exceeded').kind).toBe('api');
    expect(classifyError('x'.repeat(900)).message).toHaveLength(500);
  });
});

describe('session summaries', () => {
  it('drop reasoning tags and the machine-readable report', () => {
    expect(
      summarize(
        '<think>hmm</think></think> Added the helper. <puff-report>{"notes":"x"}</puff-report>',
      ),
    ).toBe('Added the helper.');
    expect(summarize('x'.repeat(50), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});

describe('test summaries', () => {
  it('reads Vitest and Jest totals', () => {
    expect(parseTestSummary(fixture('vitest-assertion-in-test.txt'))).toEqual({
      passed: 5,
      failed: 1,
      total: 6,
    });
    expect(parseTestSummary('Tests:       2 failed, 8 passed, 10 total')).toEqual({
      passed: 8,
      failed: 2,
      total: 10,
    });
    expect(parseTestSummary('      Tests  25 passed (25)')).toEqual({
      passed: 25,
      failed: 0,
      total: 25,
    });
    expect(parseTestSummary('nothing useful')).toBeUndefined();
  });
});

describe('running programs without a shell', () => {
  const node = process.execPath;

  it('finds executables on PATH', () => {
    expect(resolveExecutable('node')).toBeTruthy();
    expect(resolveExecutable('definitely-not-a-real-program-xyz')).toBeUndefined();
  });

  it('delivers stdin intact and passes arguments literally (no shell to interpret them)', async () => {
    const nasty = 'a & echo pwned | "quoted" $(whoami) `id` %PATH% ^caret';
    const r = await runProcess({
      command: node,
      args: [
        '-e',
        'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.stringify({arg:process.argv[1],stdin:s})))',
        nasty,
      ],
      cwd: tmpdir(),
      stdin: 'line one\nline "two" & <three>\n',
      timeoutMs: 30_000,
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ arg: nasty, stdin: 'line one\nline "two" & <three>\n' });
  });

  it('kills a process that runs too long, and one that is aborted', async () => {
    const hang = ['-e', 'setInterval(()=>{},1000)'];
    const slow = await runProcess({ command: node, args: hang, cwd: tmpdir(), timeoutMs: 700 });
    // The exit code differs by platform (null when a signal kills it on Linux, a number from
    // taskkill on Windows), so assert what matters: it was flagged as timed out and stopped promptly.
    expect(slow.timedOut).toBe(true);
    expect(slow.durationMs).toBeLessThan(10_000);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 300);
    const stopped = await runProcess({
      command: node,
      args: hang,
      cwd: tmpdir(),
      timeoutMs: 30_000,
      signal: ctl.signal,
    });
    expect(stopped.aborted).toBe(true);
    expect(stopped.durationMs).toBeLessThan(10_000);
  });

  it('reports a missing program instead of throwing', async () => {
    const r = await runProcess({ command: 'no-such-program-xyz', cwd: tmpdir(), timeoutMs: 5000 });
    expect(r.spawnError).toMatch(/not found/);
  });

  it('finds the real target in npm shims captured from a machine (not the node.exe probe)', () => {
    expect(shimTarget(fixture('agents/codex.cmd.txt'))).toBe(
      'node_modules\\@openai\\codex\\bin\\codex.js',
    );
    expect(shimTarget(fixture('agents/opencode.cmd.txt'))).toBe(
      'node_modules\\opencode-ai\\bin\\opencode.exe',
    );
    expect(shimTarget('@echo hi')).toBeUndefined();
  });

  it.skipIf(process.platform !== 'win32')(
    'launches what an npm .cmd shim wraps, with no shell',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'puff-shim-'));
      try {
        writeFileSync(
          join(dir, 'tool.js'),
          'console.log("ran:" + process.argv.slice(2).join(","))',
        );
        writeFileSync(
          join(dir, 'tool.cmd'),
          '@ECHO off\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\tool.js" %*\r\nGOTO :EOF\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n',
        );
        const target = launchTarget(join(dir, 'tool.cmd'));
        expect(target.prefix[0]).toBe(join(dir, 'tool.js'));
        const r = await runProcess({
          command: join(dir, 'tool.cmd'),
          args: ['a', 'b c'],
          cwd: dir,
          timeoutMs: 30_000,
        });
        expect(r.stdout.trim()).toBe('ran:a,b c');
        writeFileSync(join(dir, 'weird.cmd'), '@echo hi\r\n');
        expect(() => launchTarget(join(dir, 'weird.cmd'))).toThrow(/without a shell/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe('adapters (a fake CLI stands in for the real one)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'puff-fake-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // Prints a Codex-style event stream that also echoes its own argv and the prompt it received.
  const script = join(dir, 'fake.mjs');
  writeFileSync(
    script,
    `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{
      const text=JSON.stringify({argv:process.argv.slice(2),prompt:s,cwd:process.cwd()});
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
      console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:40,output_tokens:9}}));
    })`,
  );
  const cfg = {
    command: process.execPath,
    args: [script, 'exec', '--json'],
    promptVia: 'stdin' as const,
    instances: 1,
    strengths: [],
  };

  it('Codex: stdin prompt, write sandbox for coders, read-only for planners', async () => {
    const adapter = createAdapter('codex', cfg);
    const prompt =
      'Fix it.\nUse "quotes" & <angle brackets>.\n<puff-report>{"notes":"hi"}</puff-report>';
    const coder = await adapter.run({ prompt, cwd: dir, role: 'coder', timeoutMs: 30_000 });
    expect(coder.error).toBeUndefined();
    const echoed = JSON.parse(coder.output) as { argv: string[]; prompt: string };
    expect(echoed.prompt).toBe(prompt);
    expect(echoed.argv).toEqual(['exec', '--json', '-s', 'workspace-write', '-C', dir, '-']);
    expect(coder).toMatchObject({ tokensIn: 100, cachedIn: 40, tokensOut: 9, report: undefined });

    const planner = await adapter.run({
      prompt,
      cwd: dir,
      role: 'planner',
      timeoutMs: 30_000,
      model: 'm-1',
    });
    expect((JSON.parse(planner.output) as { argv: string[] }).argv).toEqual([
      'exec',
      '--json',
      '-s',
      'read-only',
      '-C',
      dir,
      '-m',
      'm-1',
      '-',
    ]);
  });

  it('turns a missing CLI into an "unavailable" error and a crash into a crash', async () => {
    const missing = await createAdapter('codex', { ...cfg, command: 'no-such-cli-xyz' }).run({
      prompt: 'x',
      cwd: dir,
      role: 'coder',
      timeoutMs: 5000,
    });
    expect(missing.error?.kind).toBe('unavailable');
    expect(
      await createAdapter('codex', { ...cfg, command: 'no-such-cli-xyz' }).available(),
    ).toMatchObject({ ok: false });
    const crash = await createAdapter('opencode', { ...cfg, args: ['-e', 'process.exit(3)'] }).run({
      prompt: 'x',
      cwd: dir,
      role: 'coder',
      timeoutMs: 20_000,
    });
    expect(crash.error?.kind).toBe('crash');
    expect(existsSync(script)).toBe(true);
  });
});
