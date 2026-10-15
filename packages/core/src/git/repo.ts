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
