import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { langForPath } from './parser';

const ALWAYS_SKIP = [
  'node_modules/',
  '.git/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.next/',
  '.puff/',
  '*.min.js',
  '*.d.ts',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
];

async function loadIgnore(root: string): Promise<Ignore> {
  const ig = ignore().add(ALWAYS_SKIP);
  try {
    ig.add(await readFile(join(root, '.gitignore'), 'utf8'));
  } catch {
    // no .gitignore
  }
  return ig;
}

/** Repo-relative POSIX paths of every source file Puff can parse, respecting .gitignore. */
export async function listSourceFiles(root: string): Promise<string[]> {
  const ig = await loadIgnore(root);
  const out: string[] = [];

  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs).split(sep).join('/');
      if (ig.ignores(entry.isDirectory() ? `${rel}/` : rel)) continue;
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile() && langForPath(rel)) out.push(rel);
    }
  }

  await walk(root);
  return out.sort();
}

export const isTestFile = (path: string): boolean =>
  /(^|\/)(test|tests|__tests__)\//.test(path) || /\.(spec|test)\.[cm]?[jt]sx?$/.test(path);
