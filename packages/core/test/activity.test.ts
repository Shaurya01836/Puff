// What an agent is doing, read from the events its CLI prints. The codex and opencode fixtures are
// output captured from the real CLIs (one read, one edit, one command each); the Claude Code lines
// follow the documented `--output-format stream-json` events, with the real init/assistant/result framing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { activityFromLine, relativePath, unwrapShell } from '../src/agents/activity';
import { streamClaude } from '../src/agents/adapters';
import { parseClaude } from '../src/agents/parse';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/agents/${name}`, import.meta.url)), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean);

describe('activity from real CLI output', () => {
  it('codex: commands are shown when they start (without the PowerShell wrapper), edits when they land', () => {
    const steps = fixture('codex-activity.jsonl').flatMap((l) =>
      activityFromLine('codex', l, 'C:\\Users\\me\\proj'),
    );
    expect(steps.map((s) => [s.kind, s.text])).toEqual([
      ['message', 'I’ll read `hello.txt`, append the requested line, then run `node -v`.'],
      ['command', 'Ran Get-Content -LiteralPath .\\hello.txt'],
      ['edit', 'Edited hello.txt'],
      ['command', 'Ran node -v'],
      ['message', 'done'],
    ]);
    expect(steps[2]!.path).toBe('hello.txt');
  });

  it('opencode: read, edit and command each become a step, with paths relative to the worktree', () => {
    const steps = fixture('opencode-activity.jsonl').flatMap((l) =>
      activityFromLine('opencode', l, 'C:\\Users\\me\\proj'),
    );
    expect(steps.map((s) => [s.kind, s.text, s.ok])).toEqual([
      ['read', 'Read hello.txt', undefined],
      ['edit', 'Edited hello.txt', undefined],
      ['command', 'Ran node -v', true],
      ['message', 'done', undefined],
    ]);
  });

  it('opencode: searching and unknown tools are named, a failing command is marked', () => {
    const tool = (part: object) =>
      JSON.stringify({ type: 'tool_use', part: { type: 'tool', ...part } });
    expect(
      activityFromLine('opencode', tool({ tool: 'grep', state: { input: { pattern: 'login' } } })),
    ).toEqual([{ kind: 'search', text: 'Searched login' }]);
    expect(activityFromLine('opencode', tool({ tool: 'todowrite', state: { input: {} } }))).toEqual(
      [{ kind: 'tool', text: 'Used todowrite' }],
    );
    const failed = activityFromLine(
      'opencode',
      tool({ tool: 'bash', state: { input: { command: 'npm test' }, metadata: { exit: 1 } } }),
    );
    expect(failed[0]).toMatchObject({ kind: 'command', ok: false });
  });

  it('codex: a command that exits non-zero is reported as a failure step', () => {
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'command_execution', command: 'npm test', exit_code: 1 },
    });
    expect(activityFromLine('codex', line)).toEqual([
      { kind: 'command', text: 'That command exited with code 1', ok: false },
    ]);
  });

  it('claude: text and tool calls inside an assistant message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Reading the login code' },
          { type: 'tool_use', name: 'Read', input: { file_path: 'C:\\w\\src\\auth.ts' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'C:\\w\\src\\auth.ts' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
          { type: 'tool_use', name: 'Grep', input: { pattern: 'audit' } },
        ],
      },
    });
    expect(activityFromLine('claude-code', line, 'C:\\w').map((s) => [s.kind, s.text])).toEqual([
      ['message', 'Reading the login code'],
      ['read', 'Read src/auth.ts'],
      ['edit', 'Edited src/auth.ts'],
      ['command', 'Ran npm test'],
      ['search', 'Searched audit'],
    ]);
    // init and result events say nothing a person needs
    expect(activityFromLine('claude-code', '{"type":"system","subtype":"init"}')).toEqual([]);
    expect(activityFromLine('claude-code', '{"type":"result","subtype":"success"}')).toEqual([]);
  });

  it('messages drop the machine-readable report and reasoning tags; nothing left means no step', () => {
    const text = (t: string) => JSON.stringify({ type: 'text', part: { text: t } });
    expect(
      activityFromLine('opencode', text('</think>Done. <puff-report>{"notes":"x"}</puff-report>')),
    ).toEqual([{ kind: 'message', text: 'Done.' }]);
    // an answer cut off inside the report block
    expect(activityFromLine('opencode', text('Done <puff-report>{"notes":'))).toEqual([
      { kind: 'message', text: 'Done' },
    ]);
    expect(activityFromLine('opencode', text('<puff-report>{}</puff-report>'))).toEqual([]);
  });

  it('lines that are not JSON events give no steps', () => {
    for (const agent of ['claude-code', 'codex', 'opencode'] as const) {
      expect(activityFromLine(agent, 'Reading prompt from stdin...')).toEqual([]);
      expect(activityFromLine(agent, '{"broken":')).toEqual([]);
    }
  });
});

describe('helpers', () => {
  it('unwraps the shell an agent ran a command in', () => {
    expect(
      unwrapShell(
        '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command \'node -v\'',
      ),
    ).toBe('node -v');
    expect(unwrapShell('/bin/bash -lc "npm test"')).toBe('npm test');
    expect(unwrapShell('npm test')).toBe('npm test');
  });

  it('shows paths relative to the worktree, with forward slashes', () => {
    expect(relativePath('C:\\w\\src\\a.ts', 'C:\\w')).toBe('src/a.ts');
    expect(relativePath('c:\\W\\src\\a.ts', 'C:\\w\\')).toBe('src/a.ts');
    expect(relativePath('/etc/hosts', '/work/tree')).toBe('/etc/hosts');
  });
});

describe('claude streaming', () => {
  it('asks Claude Code for stream-json (with --verbose) only when someone is watching', () => {
    expect(streamClaude(['-p', '--output-format', 'json', '--no-session-persistence'])).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--no-session-persistence',
      '--verbose',
    ]);
    expect(streamClaude(['-p'])).toEqual(['-p', '--output-format', 'stream-json', '--verbose']);
  });

  it('the result is read from the last event of a stream, the same as from the single json object', () => {
    const result = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'All done',
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
    };
    const stream = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}',
      JSON.stringify(result),
    ].join('\n');
    expect(parseClaude(stream)).toEqual(parseClaude(JSON.stringify(result)));
    expect(parseClaude(stream)).toMatchObject({ output: 'All done', tokensIn: 110, tokensOut: 5 });
    expect(parseClaude('not json').error?.kind).toBe('crash');
  });
});
