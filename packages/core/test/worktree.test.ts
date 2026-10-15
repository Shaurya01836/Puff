// Real git, in temp directories. The important guarantee: removing a task worktree must never
// reach into the real node_modules it links to.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitRepo } from '../src/git/repo';

/** Git for Windows checks files out with CRLF; compare content, not line endings. */
const text = (path: string): string => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

// Real git on a real disk: these are slow when other test files run beside them.
describe('GitRepo worktrees', { timeout: 30_000 }, () => {
  let root: string;
  let repo: GitRepo;
  const tmp: string[] = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'puff-git-'));
    tmp.push(root);
    git(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'x.ts'), 'export const x = 1;\n');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'dep.txt'), 'precious');
    git(root, 'add', 'a.txt', 'src');
    git(root, 'commit', '-q', '-m', 'init');
    repo = await GitRepo.open(root, ['node_modules']);
  });
  afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('refuses a folder that is not the root of its own repository, or has no commits', async () => {
    await expect(GitRepo.open(join(root, 'src'))).rejects.toThrow(/inside the git repository/);
    const plain = mkdtempSync(join(tmpdir(), 'puff-nogit-'));
    tmp.push(plain);
    await expect(GitRepo.open(plain)).rejects.toThrow(
      /not a git repository|inside the git repository/,
    );
    const empty = mkdtempSync(join(tmpdir(), 'puff-empty-'));
    tmp.push(empty);
    git(empty, 'init', '-q');
    await expect(GitRepo.open(empty)).rejects.toThrow(/no commits/);
  });

  it('keeps .puff and linked folders out of status, and gives each attempt its own checkout', async () => {
    expect(git(root, 'status', '--porcelain')).toBe('');
    const wt = await repo.createWorktree('task_1-a1', ['node_modules']);
    expect(existsSync(join(wt.path, 'a.txt'))).toBe(true);
    expect(readFileSync(join(wt.path, 'node_modules', 'dep.txt'), 'utf8')).toBe('precious'); // linked, so tests can run
    expect(wt.branch).toBe('puff/task_1-a1');
    expect(git(root, 'status', '--porcelain')).toBe(''); // the main checkout never sees it
    await repo.remove(wt, { deleteBranch: true });
  });

  it('reports exactly what changed, including new files, and merges after tests would pass', async () => {
    const wt = await repo.createWorktree('task_2-a1', ['node_modules']);
    writeFileSync(join(wt.path, 'a.txt'), 'one\nTWO\nthree\n');
    writeFileSync(join(wt.path, 'src', 'new.ts'), 'export const n = 2;\n');
    const { files, diff } = await repo.changes(wt);
    expect(files.sort()).toEqual(['a.txt', 'src/new.ts']);
    expect(diff).toContain('-two');
    expect(diff).toContain('+TWO');
    expect(files).not.toContain('node_modules');

    expect(await repo.commit(wt, 'puff: task 2')).toMatch(/^[0-9a-f]{40}$/);
    const merged = await repo.merge(wt, 'Merge task 2');
    expect(merged).toMatchObject({ merged: true });
    expect(text(join(root, 'a.txt'))).toBe('one\nTWO\nthree\n');
    expect(existsSync(join(root, 'src', 'new.ts'))).toBe(true);
    await repo.remove(wt, { deleteBranch: true });
  });

  it('never deletes the real node_modules when a worktree is removed', async () => {
    const wt = await repo.createWorktree('task_3-a1', ['node_modules']);
    expect(lstatSync(join(wt.path, 'node_modules')).isSymbolicLink()).toBe(true);
    await repo.remove(wt, { deleteBranch: true });
    expect(existsSync(wt.path)).toBe(false);
    expect(readFileSync(join(root, 'node_modules', 'dep.txt'), 'utf8')).toBe('precious');
  });

  it('aborts a conflicting merge cleanly and leaves the main checkout untouched', async () => {
    const a = await repo.createWorktree('task_4-a1');
    const b = await repo.createWorktree('task_5-a1');
    writeFileSync(join(a.path, 'a.txt'), 'A\nTWO\nthree\n');
    writeFileSync(join(b.path, 'a.txt'), 'B\nTWO\nthree\n');
    await repo.changes(a);
    await repo.changes(b);
    await repo.commit(a, 'a');
    await repo.commit(b, 'b');
    expect(await repo.merge(a, 'merge a')).toMatchObject({ merged: true });
    const second = await repo.merge(b, 'merge b');
    expect(second).toMatchObject({ merged: false, conflict: true });
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(text(join(root, 'a.txt'))).toBe('A\nTWO\nthree\n');
    await repo.remove(a, { deleteBranch: true });
    await repo.remove(b, { deleteBranch: false }); // a failed attempt keeps its branch for inspection
    expect(git(root, 'branch', '--list', 'puff/task_5-a1')).toContain('puff/task_5-a1');
  });

  it('serialises merges and refuses to merge into a dirty main checkout', async () => {
    const a = await repo.createWorktree('task_6-a1');
    const b = await repo.createWorktree('task_7-a1');
    writeFileSync(join(a.path, 'six.txt'), '6');
    writeFileSync(join(b.path, 'seven.txt'), '7');
    for (const w of [a, b]) {
      await repo.changes(w);
      await repo.commit(w, w.name);
    }
    const results = await Promise.all([repo.merge(a, 'm6'), repo.merge(b, 'm7')]);
    expect(results.map((r) => r.merged)).toEqual([true, true]);

    writeFileSync(join(root, 'a.txt'), 'dirty edit by the user');
    const c = await repo.createWorktree('task_8-a1');
    writeFileSync(join(c.path, 'eight.txt'), '8');
    await repo.changes(c);
    await repo.commit(c, 'c');
    const refused = await repo.merge(c, 'm8');
    expect(refused).toMatchObject({ merged: false });
    expect(refused.reason).toMatch(/uncommitted/);
    git(root, 'checkout', '--', 'a.txt');
    for (const w of [a, b, c]) await repo.remove(w, { deleteBranch: true });
  });

  it('returns nothing to commit when the agent changed nothing', async () => {
    const wt = await repo.createWorktree('task_9-a1');
    expect(await repo.changes(wt)).toEqual({ files: [], diff: '' });
    expect(await repo.commit(wt, 'nothing')).toBeUndefined();
    await repo.remove(wt, { deleteBranch: true });
  });
});
