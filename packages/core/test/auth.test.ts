// Signing in from inside Puff, against a stand-in for the `claude` command: it prints what the real one
// prints (the browser message, a link, "Paste code here"), waits for a code on stdin and records the
// sign-in in a file. The real command is never used, so no account is touched.
import { chmodSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PuffEvent } from '@puff/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SignInManager, isLoginUrl, signInState } from '../src/setup/auth';

let dir: string;
let command: string;
let stateFile: string;

const FAKE = `
const fs = require('fs');
const [a, b] = process.argv.slice(2);
const state = process.env.FAKE_STATE;
if (a === 'auth' && b === 'status') {
  console.log(JSON.stringify({ loggedIn: fs.existsSync(state), authMethod: 'none' }));
} else if (a === 'auth' && b === 'login') {
  console.log('Opening browser to sign in…');
  console.log("If the browser didn't open, visit: " + (process.env.FAKE_URL || 'https://claude.com/cai/oauth/authorize?code=true'));
  process.stdout.write('Paste code here if prompted > ');
  process.stdin.once('data', (d) => {
    if (d.toString().trim() === 'good-code') { fs.writeFileSync(state, 'in'); process.exit(0); }
    console.error('Invalid code');
    process.exit(1);
  });
} else {
  process.exit(2);
}
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'puff-auth-'));
  stateFile = join(dir, 'signed-in');
  process.env.FAKE_STATE = stateFile;
  writeFileSync(join(dir, 'fake-claude.js'), FAKE);
  if (process.platform === 'win32') {
    // The same shape as an npm shim, which is what Puff unwraps on Windows
    writeFileSync(join(dir, 'fake-claude.cmd'), '@ECHO off\r\n"%dp0%\\fake-claude.js" %*\r\n');
    command = join(dir, 'fake-claude.cmd');
  } else {
    writeFileSync(join(dir, 'fake-claude'), `#!/usr/bin/env node\n${FAKE}`);
    chmodSync(join(dir, 'fake-claude'), 0o755);
    command = join(dir, 'fake-claude');
  }
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.FAKE_STATE;
});
afterEach(() => {
  rmSync(stateFile, { force: true });
  delete process.env.FAKE_URL;
});

describe('sign-in state', () => {
  it('asks the CLI itself', async () => {
    expect(await signInState('claude-code', command)).toBe('signed-out');
    writeFileSync(stateFile, 'in');
    expect(await signInState('claude-code', command)).toBe('signed-in');
  }, 30_000);

  it('is unknown when the CLI is missing or has no way to tell', async () => {
    expect(await signInState('claude-code', 'puff-no-such-cli-xyz')).toBe('unknown');
    expect(await signInState('opencode', command)).toBe('unknown');
  }, 30_000);
});

describe('login pages that may be shown as a link', () => {
  it('only https pages on the providers', () => {
    expect(isLoginUrl('https://claude.com/cai/oauth/authorize?code=true')).toBe(true);
    expect(isLoginUrl('https://auth.openai.com/oauth/authorize')).toBe(true);
    expect(isLoginUrl('http://claude.com/login')).toBe(false);
    expect(isLoginUrl('https://claude.com.evil.example/login')).toBe(false);
    expect(isLoginUrl('https://evil.example/claude.com')).toBe(false);
    expect(isLoginUrl('not a url')).toBe(false);
  });
});

describe('signing in from Puff', () => {
  const manager = (events: PuffEvent[] = []) =>
    new SignInManager(
      (agent) => (agent === 'claude-code' ? command : undefined),
      (e) => events.push(e),
      60_000,
      1_500,
    );

  it('opens the sign-in, gives the link, and finishes when the code is accepted', async () => {
    const events: PuffEvent[] = [];
    const m = manager(events);
    const started = await m.start('claude-code');
    expect(started.url).toBe('https://claude.com/cai/oauth/authorize?code=true');
    expect(m.signingIn).toBe('claude-code');

    expect(m.submitCode('good-code')).toBe(true);
    expect(await started.done).toEqual({ ok: true, message: 'Signed in to Claude Code.' });
    expect(existsSync(stateFile)).toBe(true);
    expect(m.signingIn).toBeUndefined();
    expect(events).toEqual([
      { type: 'signin', agent: 'claude-code', ok: true, message: 'Signed in to Claude Code.' },
    ]);
  }, 60_000);

  it('a wrong code is a failed sign-in that says how to go on, not a crash', async () => {
    const events: PuffEvent[] = [];
    const m = manager(events);
    const started = await m.start('claude-code');
    m.submitCode('wrong');
    const result = await started.done;
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/did not finish.*Try again/s);
    expect(events[0]).toMatchObject({ type: 'signin', ok: false });
  }, 60_000);

  it('never shows a link to a page that is not a known login page', async () => {
    process.env.FAKE_URL = 'https://evil.example/login';
    const m = manager();
    const started = await m.start('claude-code');
    expect(started.url).toBeUndefined();
    m.cancel();
    await started.done;
  }, 60_000);

  it('starting again cancels the first, quietly; a code with nothing waiting is refused', async () => {
    const events: PuffEvent[] = [];
    const m = manager(events);
    expect(m.submitCode('x')).toBe(false);
    const first = await m.start('claude-code');
    const second = await m.start('claude-code');
    expect(await first.done).toEqual({ ok: false, message: 'Cancelled.' });
    expect(events).toEqual([]); // the cancelled one says nothing
    m.submitCode('good-code');
    expect((await second.done).ok).toBe(true);
  }, 60_000);

  it('refuses an agent it cannot sign in, and a command that is not installed', async () => {
    await expect(manager().start('opencode')).rejects.toThrow(/cannot sign in to opencode/);
    const missing = new SignInManager(() => 'puff-no-such-cli-xyz');
    await expect(missing.start('claude-code')).rejects.toThrow(/not found on PATH/);
  }, 30_000);
});
