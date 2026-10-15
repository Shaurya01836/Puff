// Git worktrees: every task attempt gets its own checkout and branch, so agents never touch the
// main checkout or each other. Only Puff merges, one task at a time, after the tests pass.
import { existsSync } from 'node:fs';
import { appendFile, lstat, mkdir, readFile, rm, rmdir, symlink, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runProcess } from '../agents/spawn';

export interface Worktree {
  path: string;
  branch: string;
  name: string;
  /** Directories linked in from the main checkout, e.g. node_modules */
  links: string[];
}

export interface MergeResult {
  merged: boolean;
  sha?: string;
  conflict?: boolean;
  reason?: string;
}

const MAX_DIFF_BYTES = 1_000_000;
const safeName = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, '_');
const samePath = (a: string, b: string): boolean =>
  resolve(a).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() ===
  resolve(b).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export interface GitResult {
  code: number | null;
  out: string;
  err: string;
}

export async function git(
  args: string[],
  cwd: string,
  identity: string[] = [],
): Promise<GitResult> {
  const r = await runProcess({
    command: 'git',
    args: [...identity, ...args],
    cwd,
    timeoutMs: 120_000,
    env: { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', LC_ALL: 'C' },
  });
  if (r.spawnError) throw new Error(`git failed to start: ${r.spawnError}`);
  return { code: r.exitCode, out: r.stdout, err: r.stderr };
}

async function must(args: string[], cwd: string, identity: string[] = []): Promise<string> {
  const r = await git(args, cwd, identity);
  if (r.code !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${(r.err || r.out).trim().slice(0, 400)}`);
  return r.out;
}

/** Remove a link without ever touching what it points at. */
export async function removeLink(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat) return;
  if (!stat.isSymbolicLink())
    throw new Error(`${path} is not a link; refusing to delete it as one`);
  try {
    await unlink(path);
  } catch {
    // Windows directory junctions are removed like empty directories
    await rmdir(path);
  }
}

/** What a task changed. */
export interface TaskDiff {
  source: 'merge' | 'attempt';
  /** The merge commit or the attempt branch */
  ref: string;
  label: string;
  files: string[];
  diff: string;
}

export class GitRepo {
  private mergeLock: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly root: string,
    private readonly identity: string[],
  ) {}

  /** The project must be the root of its own git repository and have at least one commit. */
  static async open(root: string, linkDirs: string[] = []): Promise<GitRepo> {
    const abs = resolve(root);
    const top = await git(['rev-parse', '--show-toplevel'], abs).catch(() => undefined);
    if (!top || top.code !== 0)
      throw new Error(`${abs} is not a git repository. Run git init and make a first commit.`);
    if (!samePath(top.out.trim(), abs)) {
      throw new Error(
        `${abs} is inside the git repository at ${top.out.trim()}, not its root. ` +
          `Puff needs the project to be its own repository (for the demo: npm run puff -- demo setup).`,
      );
    }
    const head = await git(['rev-parse', '--verify', 'HEAD'], abs);
    if (head.code !== 0) throw new Error(`${abs} has no commits yet. Make a first commit.`);

    // Use the user's identity when they have one; otherwise commit as Puff, locally.
    const email = await git(['config', 'user.email'], abs);
    const identity = email.out.trim()
      ? []
      : ['-c', 'user.name=Puff', '-c', 'user.email=puff@localhost'];

    const repo = new GitRepo(abs, identity);
    await repo.exclude(['.puff/', ...linkDirs.map((d) => `/${d}`)]);
    return repo;
  }

  /** Keep Puff's own files and linked directories out of every status and diff (repo-local, not committed). */
  private async exclude(patterns: string[]): Promise<void> {
    const file = join(
      (await must(['rev-parse', '--git-common-dir'], this.root))
        .trim()
        .replace(/^(?!\/|[A-Za-z]:)/, `${this.root}/`),
      'info',
      'exclude',
    );
    await mkdir(join(file, '..'), { recursive: true });
    const current = existsSync(file) ? await readFile(file, 'utf8') : '';
    const missing = patterns.filter((p) => !current.split(/\r?\n/).includes(p));
    if (missing.length)
      await appendFile(
        file,
        `${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`,
      );
  }

  async currentBranch(): Promise<string> {
    return (await must(['rev-parse', '--abbrev-ref', 'HEAD'], this.root)).trim();
  }

  async headSha(cwd = this.root): Promise<string> {
    return (await must(['rev-parse', 'HEAD'], cwd)).trim();
  }

  worktreePath(name: string): string {
    return join(this.root, '.puff', 'worktrees', safeName(name));
  }

  /** A fresh checkout of the current HEAD on its own branch, with dependency folders linked in. */
  async createWorktree(name: string, linkDirs: string[] = []): Promise<Worktree> {
    const n = safeName(name);
    const path = this.worktreePath(n);
    const branch = `puff/${n}`;
    // A leftover from an earlier crash would block `worktree add`.
    if (existsSync(path))
      await this.remove({ path, branch, name: n, links: linkDirs }, { deleteBranch: true });
    await git(['branch', '-D', branch], this.root);
    await mkdir(join(this.root, '.puff', 'worktrees'), { recursive: true });
    await must(['worktree', 'add', '-b', branch, path, 'HEAD'], this.root);

    const links: string[] = [];
    for (const dir of linkDirs) {
      const source = join(this.root, dir);
      if (!existsSync(source)) continue;
      await symlink(source, join(path, dir), process.platform === 'win32' ? 'junction' : 'dir');
      links.push(dir);
    }
    return { path, branch, name: n, links };
  }

  /**
   * Run `fn` in a clean, detached checkout of the current HEAD (no branch, dependency folders linked in),
   * then remove it. This is how the merged result is tested: the main checkout also holds `.puff/worktrees`,
   * where test runners find other tasks' half-finished copies and run them too.
   */
  async withCleanCheckout<T>(
    name: string,
    linkDirs: string[],
    fn: (path: string) => Promise<T>,
  ): Promise<T> {
    const n = safeName(name);
    const path = this.worktreePath(n);
    const wt: Worktree = { path, branch: '', name: n, links: [] };
    if (existsSync(path)) await this.remove(wt, { deleteBranch: false });
    await mkdir(join(this.root, '.puff', 'worktrees'), { recursive: true });
    await must(['worktree', 'add', '--detach', path, 'HEAD'], this.root);
    try {
      for (const dir of linkDirs) {
        const source = join(this.root, dir);
        if (!existsSync(source)) continue;
        await symlink(source, join(path, dir), process.platform === 'win32' ? 'junction' : 'dir');
        wt.links.push(dir);
      }
      return await fn(path);
    } finally {
      await this.remove(wt, { deleteBranch: false });
    }
  }

  /** What the agent changed: stages everything (new files included) and reads the staged diff. */
  async changes(wt: Worktree): Promise<{ files: string[]; diff: string }> {
    await must(['add', '-A'], wt.path);
    const names = await must(['diff', '--cached', '--name-only', '--no-color'], wt.path);
    const diff = await must(['diff', '--cached', '--no-color', '--no-ext-diff'], wt.path);
    return {
      files: names
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
      diff:
        diff.length > MAX_DIFF_BYTES
          ? `${diff.slice(0, MAX_DIFF_BYTES)}\n… (diff truncated)`
          : diff,
    };
  }

  /** Commit what is staged on the task branch. Returns undefined when there is nothing to commit. */
  async commit(wt: Worktree, message: string): Promise<string | undefined> {
    await must(['add', '-A'], wt.path);
    const status = await must(['status', '--porcelain'], wt.path);
    if (!status.trim()) return undefined;
    await must(['commit', '-m', message], wt.path, this.identity);
    return this.headSha(wt.path);
  }

  /**
   * Run `fn` while holding the repository lock, so no two tasks change or read the main checkout at
   * once. Merging and the re-index that follows it must happen together, or a re-index could read the
   * checkout halfway through another task's merge.
   */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.mergeLock.then(fn, fn);
    this.mergeLock = result.catch(() => {});
    return result;
  }

  /** Merge a task branch into the checked-out branch. One at a time. */
  merge(wt: Worktree, message: string): Promise<MergeResult> {
    return this.serial(() => this.mergeNow(wt, message));
  }

  /** The merge itself, for callers that already hold the lock through serial(). */
  async mergeNow(wt: Worktree, message: string): Promise<MergeResult> {
    const dirty = (await must(['status', '--porcelain'], this.root)).trim();
    if (dirty) {
      return {
        merged: false,
        reason: 'the main checkout has uncommitted changes; commit or stash them first',
      };
    }
    const r = await git(['merge', '--no-ff', '-m', message, wt.branch], this.root, this.identity);
    if (r.code === 0) return { merged: true, sha: await this.headSha() };
    await git(['merge', '--abort'], this.root);
    const conflict = /conflict/i.test(r.out + r.err);
    return { merged: false, conflict, reason: (r.out + r.err).trim().slice(0, 400) };
  }

  /**
   * Undo a merge Puff just made, with a revert commit (history is kept, nothing is rewritten). For
   * callers that hold the lock through serial(). On a conflict the revert is aborted and says why.
   */
  async revertMerge(sha: string): Promise<{ reverted: boolean; reason?: string }> {
    const r = await git(['revert', '-m', '1', '--no-edit', sha], this.root, this.identity);
    if (r.code === 0) return { reverted: true };
    await git(['revert', '--abort'], this.root);
    return { reverted: false, reason: (r.out + r.err).trim().slice(0, 400) };
  }

  /**
   * What a task changed, for people to read. A finished task is found through the commit that merged
   * it; otherwise the newest attempt branch that was kept (failed attempts keep theirs).
   */
  async taskDiff(taskId: string): Promise<TaskDiff | undefined> {
    const clip = (diff: string) =>
      diff.length > MAX_DIFF_BYTES ? `${diff.slice(0, MAX_DIFF_BYTES)}\n… (diff truncated)` : diff;
    // trim() also removes the carriage return git prints on Windows
    const names = (out: string) =>
      out
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);

    const merged = await git(
      ['log', '--all', `--grep=^Merge puff task ${taskId}:`, '--format=%H', '-n', '1'],
      this.root,
    );
    const sha = names(merged.out)[0];
    if (merged.code === 0 && sha) {
      return {
        source: 'merge',
        ref: sha.slice(0, 10),
        label: 'Merged into the main branch',
        files: names(await must(['diff', '--name-only', '--no-color', `${sha}^1`, sha], this.root)),
        diff: clip(await must(['diff', '--no-color', '--no-ext-diff', `${sha}^1`, sha], this.root)),
      };
    }

    const prefix = `puff/${safeName(taskId)}-a`;
    const branches = names(
      await must(['for-each-ref', '--format=%(refname:short)', `refs/heads/${prefix}*`], this.root),
    )
      .map((b) => ({ b, n: Number(b.slice(prefix.length)) }))
      .filter((x) => Number.isInteger(x.n))
      .sort((x, y) => y.n - x.n);
    const newest = branches[0];
    if (!newest) return undefined;
    const base = (await must(['merge-base', 'HEAD', newest.b], this.root)).trim();
    return {
      source: 'attempt',
      ref: newest.b,
      label: `Attempt ${newest.n}, not merged`,
      files: names(await must(['diff', '--name-only', '--no-color', base, newest.b], this.root)),
      diff: clip(await must(['diff', '--no-color', '--no-ext-diff', base, newest.b], this.root)),
    };
  }

  /** Remove the worktree. The branch is kept unless asked otherwise, so a failed attempt can be inspected. */
  async remove(wt: Worktree, { deleteBranch }: { deleteBranch: boolean }): Promise<void> {
    // Unlink dependency folders first: removing a worktree must never reach into the real node_modules.
    for (const dir of wt.links) await removeLink(join(wt.path, dir));
    if (existsSync(wt.path)) {
      const r = await git(['worktree', 'remove', '--force', wt.path], this.root);
      if (r.code !== 0) await rm(wt.path, { recursive: true, force: true });
    }
    await git(['worktree', 'prune'], this.root);
    if (deleteBranch) await git(['branch', '-D', wt.branch], this.root);
  }
}
