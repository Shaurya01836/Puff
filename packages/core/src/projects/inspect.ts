// Look at a folder before it becomes a project, and say plainly what will and will not work.
//
// Three levels, so the app can be honest instead of refusing:
//   problems     the folder cannot be added at all (it does not exist, there is nothing Puff can read)
//   runBlockers  it can be added and explored, but agents cannot run (Puff works in git worktrees,
//                so the folder must be the top of its own repository with at least one commit)
//   warnings     worth knowing (uncommitted changes would make Puff refuse a merge, no test command)
import { existsSync } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { RepoInspection } from '@puff/shared';
import { git } from '../git/repo';
import { scanRepoFiles } from '../indexer/walk';
import { detectSetup } from './detect';
import { samePath } from './registry';

export async function inspectRepo(path: string): Promise<RepoInspection> {
  const abs = resolve(path);
  const out: RepoInspection = {
    path: abs,
    name: basename(abs),
    exists: false,
    isDirectory: false,
    git: { isRepo: false, isRoot: false, hasCommits: false, dirty: false },
    hasNodeModules: false,
    files: { supported: 0, unsupported: {} },
    problems: [],
    runBlockers: [],
    warnings: [],
    canInitGit: false,
  };

  const info = await stat(abs).catch(() => undefined);
  if (!info) {
    out.problems.push(`${abs} does not exist.`);
    return out;
  }
  out.exists = true;
  out.isDirectory = info.isDirectory();
  if (!out.isDirectory) {
    out.problems.push(`${abs} is a file, not a folder.`);
    return out;
  }

  // git
  const top = await git(['rev-parse', '--show-toplevel'], abs).catch(() => undefined);
  if (top && top.code === 0) {
    const root = top.out.trim();
    out.git.isRepo = true;
    out.git.root = root;
    out.git.isRoot = samePath(root, abs);
    const head = await git(['rev-parse', '--verify', 'HEAD'], abs);
    out.git.hasCommits = head.code === 0;
    if (out.git.isRoot) {
      const branch = await git(['branch', '--show-current'], abs);
      out.git.branch = branch.out.trim() || undefined;
      const status = await git(['status', '--porcelain'], abs);
      out.git.dirty = status.out.trim().length > 0;
    }
  }
  if (!out.git.isRepo) {
    out.runBlockers.push(
      'Not a git repository. Agents work in git worktrees, so Puff can set one up (git init and a first commit) if you agree.',
    );
    out.canInitGit = true;
  } else if (!out.git.isRoot) {
    out.runBlockers.push(
      `This folder is inside the repository at ${out.git.root}. Add that folder instead: agents need a project that is the top of its own repository.`,
    );
  } else if (!out.git.hasCommits) {
    out.runBlockers.push(
      'The repository has no commits yet. Puff can make a first commit if you agree.',
    );
    out.canInitGit = true;
  } else if (out.git.dirty) {
    out.warnings.push(
      'There are uncommitted changes. Agents can run, but a finished task will not be merged until the main checkout is clean.',
    );
  }

  // code
  const files = await scanRepoFiles(abs);
  out.files = { supported: files.supported.length, unsupported: files.unsupported };
  if (files.supported.length === 0) {
    const other = Object.keys(files.unsupported);
    out.problems.push(
      other.length
        ? `Puff reads TypeScript and JavaScript for now, and found only ${other.join(', ')} files here.`
        : 'No TypeScript or JavaScript files were found.',
    );
  } else if (Object.keys(files.unsupported).length) {
    const list = Object.entries(files.unsupported)
      .map(([ext, n]) => `${n} .${ext}`)
      .join(', ');
    out.warnings.push(
      `Puff reads TypeScript and JavaScript only. These files will not be in the code graph: ${list}.`,
    );
  }

  // how to test
  // The app may live in a folder (my-app/, packages/web): find it, its check command and its dependencies
  const setup = await detectSetup(abs);
  out.hasNodeModules = setup ? setup.hasNodeModules : existsSync(join(abs, 'node_modules'));
  if (setup) {
    out.appDir = setup.appDir;
    out.packageManager = setup.packageManager;
    out.testCommand = setup.testCommand;
    out.linkDirs = setup.linkDirs;
    const where = setup.appDir ? `${setup.appDir}/` : 'the top folder';
    if (setup.appDir)
      out.warnings.push(
        `The app is in ${where}, not at the top of the repository. Puff will check changes and link dependencies there.`,
      );
    if (setup.others.length)
      out.warnings.push(
        `Other folders also have a package.json (${setup.others.join(', ')}). Puff chose ${where}; if that is wrong, set the test command and linked folders in the project's settings.`,
      );
    if (setup.checkKind === 'type-check')
      out.warnings.push(
        'This project has no tests, so Puff will type-check the code instead. A pass means it compiles, not that it works.',
      );
    else if (setup.placeholderTest)
      out.warnings.push(
        'package.json has the placeholder test script. Set a test command, or agents cannot be verified.',
      );
    else if (!setup.testCommand)
      out.warnings.push(
        'No test script (and no TypeScript setup to type-check). Set a test command so agents can be verified.',
      );
    if (!setup.hasNodeModules)
      out.warnings.push(
        `Dependencies are not installed (no node_modules${setup.appDir ? ` in ${where}` : ''}). Run your package manager install, or the checks will fail.`,
      );
  } else {
    out.warnings.push('No package.json: set a test command so agents can be verified.');
  }
  return out;
}

/**
 * Make the folder a git repository with a first commit, so agents can work in worktrees. Only called
 * after the person agreed. It never touches a repository that already has commits, and it commits
 * only what a `.gitignore` allows (a `.gitignore` for node_modules is created if there is none).
 */
export async function initRepo(path: string): Promise<{ created: string[] }> {
  const abs = resolve(path);
  const info = await inspectRepo(abs);
  if (info.problems.length) throw new Error(info.problems[0]);
  if (info.git.isRepo && !info.git.isRoot)
    throw new Error(
      `${abs} is inside another repository (${info.git.root}); add that folder instead.`,
    );
  if (info.git.hasCommits) throw new Error('This repository already has commits.');

  const created: string[] = [];
  const identity = (await git(['config', 'user.email'], abs)).out.trim()
    ? []
    : ['-c', 'user.name=Puff', '-c', 'user.email=puff@localhost'];
  const must = async (args: string[]) => {
    const r = await git(args, abs, identity);
    if (r.code !== 0)
      throw new Error(`git ${args[0]} failed: ${(r.err || r.out).trim().slice(0, 300)}`);
  };

  if (!info.git.isRepo) {
    await must(['init', '-q', '-b', 'main']);
    created.push('git repository');
  }
  if (!existsSync(join(abs, '.gitignore'))) {
    await writeFile(join(abs, '.gitignore'), 'node_modules/\n');
    created.push('.gitignore');
  }
  await must(['add', '-A']);
  await must(['commit', '-q', '--allow-empty', '-m', 'Initial commit']);
  created.push('first commit');
  return { created };
}
