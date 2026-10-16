// Find where a project's code actually lives and how to check it, so nobody has to type that in.
//
// Many repositories keep the app in a folder (Kite has its Next.js app in `my-app/`, a monorepo has
// `packages/*`) with no package.json at the top. Agents work in git worktrees of the top folder, so Puff
// needs three things from that app folder: the command that checks the code (run from the top), the
// dependency folder to link into every worktree, and a note for the person saying what it chose.
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { scanRepoFiles } from '../indexer/walk';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface DetectedSetup {
  /** The folder with the package.json, relative to the repository's top, with forward slashes; '' for the top itself */
  appDir: string;
  packageManager: PackageManager;
  /** How to check the code, to run from the top of the repository */
  testCommand?: string;
  /** What the check is, so the person is told honestly what a pass proves */
  checkKind?: 'tests' | 'type-check';
  /** Dependency folders to link into each worktree. Undefined when the shared default (node_modules at the top) is right. */
  linkDirs?: string[];
  /** The package.json has the `npm init` placeholder test script */
  placeholderTest: boolean;
  /** Other folders that have a package.json (the one chosen is `appDir`) */
  others: string[];
  hasNodeModules: boolean;
}

/** `npm init` writes a test script that always fails; it is not a real test command. */
const PLACEHOLDER_TEST = /no test specified/i;
/** Folders that never hold the project's own app */
const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'public']);
const MAX_DEPTH = 2;

export function detectPackageManager(dir: string): PackageManager {
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))) return 'bun';
  return 'npm';
}

interface Candidate {
  dir: string;
  depth: number;
  scripts: Record<string, string>;
  hasTsconfig: boolean;
  hasNodeModules: boolean;
  /** How many source files Puff reads are inside this package (filled in once, when there is a choice to make) */
  sources: number;
}

async function readCandidate(
  root: string,
  dir: string,
  depth: number,
): Promise<Candidate | undefined> {
  try {
    const abs = join(root, dir);
    const pkg = JSON.parse(await readFile(join(abs, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    return {
      dir,
      depth,
      scripts: pkg.scripts ?? {},
      hasTsconfig: existsSync(join(abs, 'tsconfig.json')),
      hasNodeModules: existsSync(join(abs, 'node_modules')),
      sources: 0,
    };
  } catch {
    return undefined;
  }
}

/** Every folder with a package.json, the top folder first, then down to MAX_DEPTH levels. */
async function findPackages(root: string): Promise<Candidate[]> {
  const found: Candidate[] = [];
  const top = await readCandidate(root, '', 0);
  if (top) found.push(top);
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP.has(e.name)) continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      const c = await readCandidate(root, rel, depth);
      if (c) found.push(c);
      // a package's own subfolders are part of it, not other packages
      else await walk(rel, depth + 1);
    }
  };
  await walk('', 1);
  return found;
}

const hasRealTest = (c: Candidate) =>
  Boolean(c.scripts.test && !PLACEHOLDER_TEST.test(c.scripts.test));

/**
 * Which package is "the app": one with real tests, then one that is TypeScript with its dependencies installed,
 * and between those, the one that holds most of the source code (its share of the files Puff reads).
 */
function rank(c: Candidate, totalSources: number): number {
  const share = totalSources > 0 ? c.sources / totalSources : 0;
  return (
    (hasRealTest(c) ? 4 : 0) +
    (c.hasTsconfig ? 2 : 0) +
    (c.hasNodeModules ? 1 : 0) +
    share * 1.5 -
    c.depth * 0.1
  );
}

/** Count the source files inside each package; a file belongs to the deepest package that contains it. */
async function countSources(root: string, packages: Candidate[]): Promise<number> {
  const files = (await scanRepoFiles(root).catch(() => ({ supported: [] as string[] }))).supported;
  const byDepth = [...packages].sort((a, b) => b.dir.length - a.dir.length);
  for (const file of files) {
    const owner = byDepth.find((p) => p.dir === '' || file.startsWith(`${p.dir}/`));
    if (owner) owner.sources++;
  }
  return files.length;
}

/** `npm --prefix app test`, `pnpm --dir app test`, `yarn --cwd app test`: the same thing run from the top. */
function inDir(pm: PackageManager, dir: string, rest: string): string {
  if (!dir) return `${pm} ${rest}`;
  if (pm === 'pnpm') return `pnpm --dir ${dir} ${rest}`;
  if (pm === 'yarn') return `yarn --cwd ${dir} ${rest}`;
  return `npm --prefix ${dir} ${rest}`;
}

/**
 * Work out the app folder, its check command and its dependency folder. Returns undefined when there is
 * no package.json anywhere near the top (nothing to detect: the person sets a command themselves).
 */
export async function detectSetup(root: string): Promise<DetectedSetup | undefined> {
  const packages = await findPackages(root);
  if (packages.length === 0) return undefined;
  // Only worth reading the whole tree when there is a choice to make
  const total = packages.length > 1 ? await countSources(root, packages) : 0;
  const chosen = [...packages].sort((a, b) => rank(b, total) - rank(a, total))[0]!;
  const abs = join(root, chosen.dir);
  const pm = detectPackageManager(abs);
  const inApp = chosen.dir !== '';

  let testCommand: string | undefined;
  let checkKind: DetectedSetup['checkKind'];
  if (hasRealTest(chosen)) {
    testCommand = inDir(pm === 'bun' ? 'npm' : pm, chosen.dir, 'test');
    checkKind = 'tests';
  } else if (
    chosen.hasTsconfig &&
    (existsSync(join(abs, 'node_modules', 'typescript')) ||
      existsSync(join(root, 'node_modules', 'typescript')))
  ) {
    // No tests, but the code can at least be type-checked. `npm exec` runs the project's own tsc.
    testCommand = inApp
      ? `npm --prefix ${chosen.dir} exec -- tsc --noEmit -p ${chosen.dir}`
      : 'npm exec -- tsc --noEmit';
    checkKind = 'type-check';
  }

  return {
    appDir: chosen.dir,
    packageManager: pm,
    testCommand,
    checkKind,
    // The shared default links node_modules at the top, which is right only when the app is the top
    linkDirs: inApp ? [`${chosen.dir}/node_modules`] : undefined,
    placeholderTest: Boolean(chosen.scripts.test && PLACEHOLDER_TEST.test(chosen.scripts.test)),
    others: packages.filter((p) => p.dir !== chosen.dir).map((p) => p.dir || '.'),
    hasNodeModules: chosen.hasNodeModules,
  };
}
