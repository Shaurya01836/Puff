// Finding the app inside a repository: where its package.json is, how to check it, which dependency
// folder to link into agents' worktrees. Folders are built to look like real projects (Kite keeps a
// Next.js app in my-app/ with nothing at the top).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectSetup } from '../src/projects/detect';
import { inspectRepo } from '../src/projects/inspect';
import { withDetectedSettings } from '../src/projects/open';
import type { ProjectEntry } from '../src/projects/registry';

const made: string[] = [];
afterAll(() => made.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A temporary folder with these files (paths relative to it; a trailing / makes an empty folder). */
function project(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(tmpdir(), 'puff-detect-'));
  made.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    if (rel.endsWith('/')) {
      mkdirSync(path, { recursive: true });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const pkg = (scripts: Record<string, string> = {}) => ({ name: 'x', scripts });

describe('detecting the app and how to check it', () => {
  it('an app at the top of the repository is checked with its own test script, nothing special linked', async () => {
    const root = project({
      'package.json': pkg({ test: 'vitest run' }),
      'node_modules/': '',
    });
    expect(await detectSetup(root)).toMatchObject({
      appDir: '',
      packageManager: 'npm',
      testCommand: 'npm test',
      checkKind: 'tests',
      linkDirs: undefined,
      hasNodeModules: true,
    });
  });

  it('Kite: no package.json at the top, an app with no tests in my-app/ → type-check it, link its node_modules', async () => {
    const root = project({
      'README.md': '# Kite',
      'my-app/package.json': pkg({ dev: 'next dev', build: 'next build', lint: 'next lint' }),
      'my-app/tsconfig.json': {},
      'my-app/node_modules/typescript/package.json': {},
      'my-app/app/page.tsx': 'export default 1;',
    });
    const found = await detectSetup(root);
    expect(found).toMatchObject({
      appDir: 'my-app',
      checkKind: 'type-check',
      testCommand: 'npm --prefix my-app exec -- tsc --noEmit -p my-app',
      linkDirs: ['my-app/node_modules'],
      hasNodeModules: true,
    });
  });

  it('uses the package manager the app uses, run from the top of the repository', async () => {
    const test = pkg({ test: 'vitest run' });
    expect(
      (await detectSetup(project({ 'web/package.json': test, 'web/pnpm-lock.yaml': '' })))
        ?.testCommand,
    ).toBe('pnpm --dir web test');
    expect(
      (await detectSetup(project({ 'web/package.json': test, 'web/yarn.lock': '' })))?.testCommand,
    ).toBe('yarn --cwd web test');
    expect((await detectSetup(project({ 'web/package.json': test })))?.testCommand).toBe(
      'npm --prefix web test',
    );
  });

  it('a monorepo: picks the package with real tests, and says which others it passed over', async () => {
    const root = project({
      'packages/ui/package.json': pkg(),
      'packages/api/package.json': pkg({ test: 'vitest run' }),
      'packages/api/src/deep/package.json': pkg({ test: 'x' }), // inside a package: not another package
    });
    const found = await detectSetup(root);
    expect(found?.appDir).toBe('packages/api');
    expect(found?.testCommand).toBe('npm --prefix packages/api test');
    expect(found?.others).toEqual(['packages/ui']);
  });

  it('between packages that look alike, the one with most of the source code is the app', async () => {
    const root = project({
      'tools/package.json': pkg(),
      'tools/cli.ts': 'export const a = 1;',
      'site/package.json': pkg(),
      'site/a.ts': 'export const a = 1;',
      'site/b.ts': 'export const b = 1;',
      'site/c.tsx': 'export const c = 1;',
    });
    const found = await detectSetup(root);
    expect(found?.appDir).toBe('site');
    expect(found?.others).toEqual(['tools']);
  });

  it('never looks inside node_modules, build output or hidden folders', async () => {
    const root = project({
      'node_modules/dep/package.json': pkg({ test: 'x' }),
      '.cache/package.json': pkg({ test: 'x' }),
      'dist/package.json': pkg({ test: 'x' }),
    });
    expect(await detectSetup(root)).toBeUndefined();
  });

  it('the npm init placeholder is not a test command, and TypeScript without a compiler installed is not checkable', async () => {
    const root = project({
      'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1' }),
      'tsconfig.json': {},
    });
    expect(await detectSetup(root)).toMatchObject({
      placeholderTest: true,
      testCommand: undefined,
      checkKind: undefined,
    });
  });

  it('a top-level app without tests but with TypeScript installed is type-checked from the top', async () => {
    const root = project({
      'package.json': pkg(),
      'tsconfig.json': {},
      'node_modules/typescript/package.json': {},
    });
    expect((await detectSetup(root))?.testCommand).toBe('npm exec -- tsc --noEmit');
  });
});

describe('what the person set wins; the rest is filled in', () => {
  const root = () =>
    project({
      'my-app/package.json': pkg(),
      'my-app/tsconfig.json': {},
      'my-app/node_modules/typescript/package.json': {},
    });
  const entry = (repoPath: string, extra: Partial<ProjectEntry> = {}): ProjectEntry => ({
    slug: 'kite',
    name: 'Kite',
    repoPath,
    addedAt: 0,
    ...extra,
  });

  it('fills in a project that has no settings of its own', async () => {
    const e = await withDetectedSettings(entry(root()));
    expect(e.testCommand).toBe('npm --prefix my-app exec -- tsc --noEmit -p my-app');
    expect(e.linkDirs).toEqual(['my-app/node_modules']);
  });

  it('keeps what the person typed', async () => {
    const mine = entry(root(), { testCommand: 'make check', linkDirs: ['vendor'] });
    expect(await withDetectedSettings(mine)).toEqual(mine);
    const partly = await withDetectedSettings(entry(root(), { testCommand: 'make check' }));
    expect(partly.testCommand).toBe('make check');
    expect(partly.linkDirs).toEqual(['my-app/node_modules']);
  });

  it('leaves a project alone when there is nothing to detect', async () => {
    const e = entry(project({ 'README.md': 'x' }));
    expect(await withDetectedSettings(e)).toEqual(e);
  });
});

describe('inspecting a repository whose app is in a folder', () => {
  it('reports the folder, the check and the linked dependencies, and tells the person plainly', async () => {
    const root = project({
      'README.md': '# Kite',
      '.gitignore': 'node_modules\n',
      'my-app/package.json': pkg({ dev: 'next dev' }),
      'my-app/tsconfig.json': {},
      'my-app/node_modules/typescript/package.json': {},
      'my-app/app/page.tsx': 'export default function Page() { return null; }\n',
    });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], {
      cwd: root,
    });

    const info = await inspectRepo(root);
    expect(info.appDir).toBe('my-app');
    expect(info.testCommand).toBe('npm --prefix my-app exec -- tsc --noEmit -p my-app');
    expect(info.linkDirs).toEqual(['my-app/node_modules']);
    expect(info.hasNodeModules).toBe(true);
    expect(info.problems).toEqual([]);
    expect(info.runBlockers).toEqual([]);
    const said = info.warnings.join('\n');
    expect(said).toMatch(/The app is in my-app\//);
    expect(said).toMatch(/no tests, so Puff will type-check/);
    expect(said).not.toMatch(/No package.json/);
  }, 30_000);
});
