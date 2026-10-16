// Projects: the registry file, what inspecting a folder says, making a folder a git repository, and
// opening a project against a real FalkorDB.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import { connect, loadDotEnv } from '../src/db/client';
import { git } from '../src/git/repo';
import {
  applyProject,
  deleteProjectMemory,
  initRepo,
  inspectRepo,
  openProject,
  projectCounts,
} from '../src/index';
import {
  activeProject,
  addProject,
  findProject,
  loadRegistry,
  removeProject,
  setActiveProject,
  updateProject,
} from '../src/projects/registry';

const rel = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const DEMO = rel('../../../demo/shop-api');
const config = parseConfig(readFileSync(rel('../../../puff.config.yaml'), 'utf8'));

const tmp: string[] = [];
const folder = (name = 'p') => {
  const dir = mkdtempSync(join(tmpdir(), `puff-proj-${name}-`));
  tmp.push(dir);
  return dir;
};
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 5 })));

const commit = async (dir: string, message = 'init') => {
  const id = ['-c', 'user.name=T', '-c', 'user.email=t@t'];
  await git(['add', '-A'], dir, id);
  await git(['commit', '-q', '-m', message], dir, id);
};

describe('registry', () => {
  it('adds a project once, gives clashing names their own graph, and keeps one active', async () => {
    const file = join(folder('reg'), 'projects.json');
    const a = folder('a');
    const b = folder('b');
    const first = await addProject({ repoPath: a, name: 'api' }, file);
    expect(first.created).toBe(true);
    expect(first.entry.slug).toBe('api');

    // the same folder again updates, it does not duplicate
    const again = await addProject({ repoPath: a, testCommand: 'pnpm test' }, file);
    expect(again.created).toBe(false);
    expect(again.entry.testCommand).toBe('pnpm test');

    // another folder with the same name must not share the first one's graph
    const second = await addProject({ repoPath: b, name: 'api' }, file);
    expect(second.entry.slug).toBe('api_2');

    const reg = await loadRegistry(file);
    expect(reg.projects).toHaveLength(2);
    expect(activeProject(reg)?.slug).toBe('api'); // the first one added is active

    await setActiveProject('api_2', file);
    expect(activeProject(await loadRegistry(file))?.slug).toBe('api_2');
    expect(findProject(reg, 'API')?.slug).toBe('api');
    expect(findProject(reg, b)?.slug).toBe('api_2');
  });

  it('updates settings (and clears them), and removing the active project picks another', async () => {
    const file = join(folder('reg2'), 'projects.json');
    const a = await addProject({ repoPath: folder('a'), name: 'one' }, file);
    await addProject({ repoPath: folder('b'), name: 'two' }, file);

    const patched = await updateProject(
      a.entry.slug,
      { name: 'uno', testCommand: 'yarn test', linkDirs: ['node_modules', '.venv'] },
      file,
    );
    expect(patched).toMatchObject({ name: 'uno', testCommand: 'yarn test' });
    expect((await updateProject('one', { testCommand: null }, file)).testCommand).toBeUndefined();
    await expect(updateProject('one', { name: '  ' }, file)).rejects.toThrow(/needs a name/);
    await expect(updateProject('nope', {}, file)).rejects.toThrow(/Unknown project/);

    await removeProject('one', file);
    const reg = await loadRegistry(file);
    expect(reg.projects.map((p) => p.slug)).toEqual(['two']);
    expect(reg.active).toBe('two');
    await expect(removeProject('one', file)).rejects.toThrow(/Unknown project/);
  });

  it('starts empty when there is no file, and refuses to guess when the file is broken', async () => {
    const dir = folder('reg3');
    expect((await loadRegistry(join(dir, 'missing.json'))).projects).toEqual([]);
    writeFileSync(join(dir, 'bad.json'), '{"version": 2}');
    await expect(loadRegistry(join(dir, 'bad.json'))).rejects.toThrow(/not a valid project list/);
  });

  it("applies a project's own test command and linked folders over the shared configuration", () => {
    const entry = {
      slug: 'x',
      name: 'x',
      repoPath: '/x',
      addedAt: 0,
      testCommand: 'pnpm test',
      linkDirs: ['node_modules', 'vendor'],
    };
    const merged = applyProject(config, entry);
    expect(merged.verify.testCommand).toBe('pnpm test');
    expect(merged.worktrees.linkDirs).toEqual(['node_modules', 'vendor']);
    expect(merged.harnesses).toEqual(config.harnesses); // everything else is shared
    expect(applyProject(config, { ...entry, testCommand: undefined, linkDirs: undefined })).toEqual(
      config,
    );
  });
});

describe('inspecting a folder', { timeout: 30_000 }, () => {
  it('says plainly when a folder is missing, a file, or has nothing Puff can read', async () => {
    const dir = folder('i1');
    expect((await inspectRepo(join(dir, 'nope'))).problems[0]).toMatch(/does not exist/);

    writeFileSync(join(dir, 'a.txt'), 'x');
    expect((await inspectRepo(join(dir, 'a.txt'))).problems[0]).toMatch(/is a file/);

    const py = folder('py');
    writeFileSync(join(py, 'main.py'), 'print(1)');
    writeFileSync(join(py, 'util.py'), 'x = 1');
    const info = await inspectRepo(py);
    expect(info.problems[0]).toMatch(/TypeScript and JavaScript.*py/);
    expect(info.files.unsupported).toEqual({ py: 2 });
  });

  it('a folder that is not a repository can be added, but agents are blocked until it is one', async () => {
    const dir = folder('i2');
    writeFileSync(join(dir, 'index.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'main.py'), 'x = 1');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    const info = await inspectRepo(dir);
    expect(info.problems).toEqual([]);
    expect(info.git.isRepo).toBe(false);
    expect(info.canInitGit).toBe(true);
    expect(info.runBlockers[0]).toMatch(/Not a git repository/);
    expect(info.files.supported).toBe(1);
    expect(info.packageManager).toBe('pnpm');
    expect(info.testCommand).toBe('pnpm test');
    expect(info.warnings.join(' ')).toMatch(/\.py/); // a language Puff cannot read
    expect(info.warnings.join(' ')).toMatch(/node_modules/);
  });

  it('a clean repository with a commit is ready; edits are a warning; a subfolder is a blocker', async () => {
    const dir = folder('i3');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'a.ts'), 'export const b = 1;\n');
    await git(['init', '-q', '-b', 'main'], dir);

    // no commits yet
    let info = await inspectRepo(dir);
    expect(info.git).toMatchObject({ isRepo: true, isRoot: true, hasCommits: false });
    expect(info.runBlockers[0]).toMatch(/no commits/);

    await commit(dir);
    info = await inspectRepo(dir);
    expect(info.runBlockers).toEqual([]);
    expect(info.git).toMatchObject({
      isRoot: true,
      hasCommits: true,
      dirty: false,
      branch: 'main',
    });

    writeFileSync(join(dir, 'a.ts'), 'export const b = 2;\n');
    expect((await inspectRepo(dir)).warnings.join(' ')).toMatch(/uncommitted changes/);

    const sub = await inspectRepo(join(dir, 'sub'));
    expect(sub.git).toMatchObject({ isRepo: true, isRoot: false });
    expect(sub.runBlockers[0]).toMatch(/inside the repository/);
    expect(sub.canInitGit).toBe(false);
  });

  it('does not mistake the placeholder test script for a test command', async () => {
    const dir = folder('i4');
    writeFileSync(join(dir, 'a.js'), 'module.exports = 1;\n');
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
    );
    const info = await inspectRepo(dir);
    expect(info.testCommand).toBeUndefined();
    expect(info.warnings.join(' ')).toMatch(/placeholder/);
  });
});

describe('making a folder a repository', () => {
  it('runs git init and a first commit, adds a .gitignore, and never touches existing history', async () => {
    const dir = folder('init');
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    const r = await initRepo(dir);
    expect(r.created).toEqual(['git repository', '.gitignore', 'first commit']);

    const info = await inspectRepo(dir);
    expect(info.git).toMatchObject({ isRoot: true, hasCommits: true, dirty: false });
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toContain('node_modules');
    await expect(initRepo(dir)).rejects.toThrow(/already has commits/);
  });

  it('keeps an existing .gitignore and commits into an existing empty repository', async () => {
    const dir = folder('init2');
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, '.gitignore'), 'secret.txt\n');
    writeFileSync(join(dir, 'secret.txt'), 'keep me out');
    await git(['init', '-q', '-b', 'main'], dir);
    const r = await initRepo(dir);
    expect(r.created).toEqual(['first commit']);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('secret.txt\n');
    const files = (await git(['ls-files'], dir)).out;
    expect(files).toContain('a.ts');
    expect(files).not.toContain('secret.txt');
  });

  it('refuses a folder with nothing to read, and a folder inside another repository', async () => {
    await expect(initRepo(join(folder('init3'), 'nope'))).rejects.toThrow(/does not exist/);

    const outer = folder('outer');
    mkdirSync(join(outer, 'inner'));
    writeFileSync(join(outer, 'inner', 'a.ts'), 'export const a = 1;\n');
    await git(['init', '-q', '-b', 'main'], outer);
    await expect(initRepo(join(outer, 'inner'))).rejects.toThrow(/inside another repository/);
  });
});

loadDotEnv(rel('../../../.env'));
const db = await connect().catch(() => undefined);

describe.skipIf(!db)('opening a project against FalkorDB', () => {
  const slug = `test_projects_${process.pid}`;
  const repo = join(folder('open'), 'shop');

  beforeAll(() => {
    mkdirSync(repo);
    cpSync(join(DEMO, 'src'), join(repo, 'src'), { recursive: true });
    cpSync(join(DEMO, 'package.json'), join(repo, 'package.json'));
  });
  afterAll(async () => {
    await deleteProjectMemory(db!, slug);
    await db!.close();
  });

  it('creates the graph and indexes on first open only, with the project test command applied', async () => {
    const entry = {
      slug,
      name: 'shop',
      repoPath: repo,
      addedAt: Date.now(),
      testCommand: 'pnpm test',
    };
    const first = await openProject(db!, entry, config);
    expect(first.indexed?.files).toBeGreaterThan(10);
    expect(first.config.verify.testCommand).toBe('pnpm test');

    const second = await openProject(db!, entry, config);
    expect(second.indexed).toBeUndefined(); // already indexed: no second parse

    const counts = await projectCounts(db!, slug);
    expect(counts?.files).toBeGreaterThan(10);
    expect(counts?.symbols).toBeGreaterThan(50);
    expect(counts?.tasks).toBe(0);
  }, 60_000);

  it('removing the memory deletes the graph, and counts come back undefined for a missing one', async () => {
    await deleteProjectMemory(db!, slug);
    expect(await db!.list()).not.toContain(`puff_${slug}`);
    expect(await projectCounts(db!, slug)).toBeUndefined();
  });
});
