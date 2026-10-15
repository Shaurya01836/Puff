// The controller: finding tasks the way a person names them, editing / retrying / removing them, and
// reading what a task changed from git. Fake agents stand in for the CLIs; git and FalkorDB are real.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentName, PuffEvent, Task } from '@puff/shared';
import { afterAll, describe, expect, it } from 'vitest';
import type { Adapters } from '../src/agents/adapters';
import type { HarnessAdapter, HarnessResult, RunOptions } from '../src/agents/types';
import { parseConfig, type PuffConfig } from '../src/config';
import { matchCommands, parseSlashCommand, SLASH_COMMANDS } from '@puff/shared';
import { helpText, runSlashCommand, type ProjectHooks } from '../src/control/commands';
import { resolveTask, shortId } from '../src/control/resolve';
import { ProjectController } from '../src/control/controller';
import { connect, loadDotEnv } from '../src/db/client';
import { initProjectGraph } from '../src/db/init';
import { GitRepo, removeLink } from '../src/git/repo';
import { graphName } from '../src/ids';
import { indexRepo } from '../src/indexer/index';
import { parsePuffReport } from '../src/memory/report';
import { startSession } from '../src/memory/sessions';
import { createTask, getTask, updateTask } from '../src/memory/tasks';

const rel = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const DEMO = rel('../../../demo/shop-api');
const config = parseConfig(readFileSync(rel('../../../puff.config.yaml'), 'utf8'));
const PASS = `node -e "console.log('Tests  3 passed (3)')"`;
const FAIL = `node -e "console.log('Tests  1 failed | 2 passed (3)'); process.exit(1)"`;
const cfg = (testCommand: string): PuffConfig => ({
  ...config,
  verify: { ...config.verify, testCommand },
  limits: { ...config.limits, maxAttempts: 1 },
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// No database needed
// ---------------------------------------------------------------------------------------------

const task = (id: string, title: string): Task => ({
  id,
  title,
  type: 'implement',
  complexity: 'low',
  status: 'planned',
  targets: [],
  dependsOn: [],
  depth: 0,
  createdAt: 0,
  updatedAt: 0,
});

describe('resolveTask: naming a task like a person', () => {
  const tasks = [
    task('task_01M4ZY4DF9ZKTTG06R5NAH39K2', 'Plan: add a /products/count endpoint'),
    task('task_01M4ZY7BRZ2H69JA1YTZZMGSBH', 'Add GET /products/count to productsRouter'),
    task('task_01M4ZY7BSCTYY3GKQY7WFTC3FT', 'Document GET /products/count in docs/API.md'),
  ];

  it('takes the exact id, the end of an id, a middle part of one, or a word from the title', () => {
    expect(resolveTask(tasks, 'task_01M4ZY4DF9ZKTTG06R5NAH39K2').id).toBe(tasks[0]!.id);
    expect(resolveTask(tasks, shortId(tasks[1]!.id)).id).toBe(tasks[1]!.id); // the last six
    expect(resolveTask(tasks, 'ZY7BSC').id).toBe(tasks[2]!.id); // the middle
    expect(resolveTask(tasks, 'document').id).toBe(tasks[2]!.id); // a title word
    expect(resolveTask(tasks, '#h39k2').id).toBe(tasks[0]!.id); // # and case do not matter
  });

  it('refuses to guess when several match, and says which', () => {
    expect(() => resolveTask(tasks, 'count')).toThrow(/matches 3 tasks/);
    expect(() => resolveTask(tasks, 'task_01M4ZY')).toThrow(/matches 3 tasks/);
  });

  it('says so when nothing matches, and when nothing was given', () => {
    expect(() => resolveTask(tasks, 'banana')).toThrow(/No task matches "banana"/);
    expect(() => resolveTask(tasks, '  ')).toThrow(/Which task/);
    // under four characters an id part is not used (too ambiguous); the title still can be
    expect(() => resolveTask(tasks, 'ZY7')).toThrow(/No task matches/);
  });
});

describe('slash commands: parsing and completion', () => {
  it('reads a command and its arguments, and leaves ordinary sentences alone', () => {
    expect(parseSlashCommand('/run')).toEqual({ name: 'run', args: '' });
    expect(parseSlashCommand('  /Goal add a health check, then document it ')).toEqual({
      name: 'goal',
      args: 'add a health check, then document it',
    });
    expect(parseSlashCommand('please /run it')).toBeUndefined();
    expect(parseSlashCommand('add a /health endpoint')).toBeUndefined();
    expect(parseSlashCommand('/')).toBeUndefined();
  });

  it('offers the commands that start with what was typed', () => {
    expect(matchCommands('/').length).toBe(SLASH_COMMANDS.length);
    expect(matchCommands('/pro').map((c) => c.name)).toEqual(['projects', 'project']);
    expect(matchCommands('/ru later').map((c) => c.name)).toEqual(['run']); // only the first word counts
    expect(matchCommands('/xyz')).toEqual([]);
  });

  it('marks the commands that spend tokens, and describes every command in /help', () => {
    expect(SLASH_COMMANDS.filter((c) => c.spends).map((c) => c.name)).toEqual(['run']);
    for (const c of SLASH_COMMANDS) expect(helpText()).toContain(c.usage);
  });
});

// ---------------------------------------------------------------------------------------------
// With FalkorDB, git and the demo's dependencies
// ---------------------------------------------------------------------------------------------

loadDotEnv(rel('../../../.env'));
const db = await connect().catch(() => undefined);
const ready = Boolean(db) && existsSync(join(DEMO, 'node_modules', 'vitest'));

type Fake = HarnessAdapter & { calls: RunOptions[] };
function fakeAgent(
  name: AgentName,
  behave: (o: RunOptions) => Partial<HarnessResult> | Promise<Partial<HarnessResult>>,
): Fake {
  const calls: RunOptions[] = [];
  return {
    name,
    calls,
    available: async () => ({ ok: true, detail: 'fake' }),
    async run(o) {
      calls.push(o);
      const r = await behave(o);
      const output = r.output ?? 'done';
      const { report, error: reportError } = parsePuffReport(output);
      return {
        exitCode: 0,
        output,
        report,
        reportError,
        durationMs: 5,
        raw: '',
        tokensIn: 1000,
        tokensOut: 100,
        ...r,
      };
    },
  };
}

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

describe.skipIf(!ready)('the controller (real git, real FalkorDB, fake agents)', () => {
  const cleanups: (() => Promise<void>)[] = [];
  let counter = 0;
  afterAll(async () => {
    for (const c of cleanups) await c();
    await db?.close();
  });

  async function fixture(testCommand: string, adapters: Adapters = {}) {
    const slug = `test_control_${process.pid}_${++counter}`;
    const repoPath = mkdtempSync(join(tmpdir(), 'puff-control-'));
    for (const f of ['src', 'test', 'package.json', 'tsconfig.json'])
      cpSync(join(DEMO, f), join(repoPath, f), { recursive: true });
    writeFileSync(join(repoPath, '.gitignore'), 'node_modules\n');
    symlinkSync(
      join(DEMO, 'node_modules'),
      join(repoPath, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    gitIn(repoPath, 'init', '-q', '-b', 'main');
    gitIn(repoPath, 'add', '-A');
    gitIn(repoPath, 'commit', '-q', '-m', 'initial');

    const config = cfg(testCommand);
    const project = { slug, name: slug, repoPath };
    const graph = await initProjectGraph(db!, project, config);
    await indexRepo(graph, project);
    const repo = await GitRepo.open(repoPath, config.worktrees.linkDirs);
    const events: PuffEvent[] = [];
    const controller = await ProjectController.create({
      graph,
      project,
      config,
      emit: (e) => events.push(e),
      runDeps: { graph, project, config, repo, adapters, emit: (e) => events.push(e) },
    });
    cleanups.push(async () => {
      await db!
        .selectGraph(graphName(slug))
        .delete()
        .catch(() => {});
      await removeLink(join(repoPath, 'node_modules'));
      rmSync(repoPath, { recursive: true, force: true });
    });
    return { controller, graph, slug, repoPath, events };
  }

  const finished = async (events: PuffEvent[]) => {
    for (let i = 0; i < 600; i++) {
      if (events.some((e) => e.type === 'run' && !e.running)) return;
      await sleep(100);
    }
    throw new Error('the run did not finish');
  };

  it('edits a task that is not being worked on, and refuses one that is', async () => {
    const { controller, graph } = await fixture(PASS);
    const t = await controller.createTask({ title: 'Do a thing', targets: ['login'] });

    const edited = await controller.editTask(shortId(t.id), {
      title: 'Do a better thing',
      complexity: 'high',
      preferredAgent: 'codex',
      model: 'gpt-x',
      targets: ['cartTotal'],
    });
    expect(edited).toMatchObject({
      title: 'Do a better thing',
      complexity: 'high',
      preferredAgent: 'codex',
      model: 'gpt-x',
    });
    expect(edited.targets).toEqual(['src/cart/cart.ts::cartTotal']); // replaced, not added to

    const cleared = await controller.editTask(t.id, { preferredAgent: null, model: null });
    expect(cleared.preferredAgent).toBeUndefined();
    expect(cleared.model).toBeUndefined();

    // a bad target changes nothing at all
    await expect(
      controller.editTask(t.id, { title: 'x', targets: ['noSuchThing'] }),
    ).rejects.toThrow(/No symbol named/);
    expect((await getTask(graph, t.id))!.title).toBe('Do a better thing');

    await updateTask(graph, t.id, { status: 'running' });
    await expect(controller.editTask(t.id, { title: 'y' })).rejects.toThrow(
      /Only planned, ready or failed/,
    );
  }, 60_000);

  it('removes a task that never ran, and keeps one with history or with dependents', async () => {
    const { controller, graph, events } = await fixture(PASS);
    const first = await controller.createTask({ title: 'First' });
    const second = await controller.createTask({ title: 'Second', dependsOn: [first.id] });

    await expect(controller.removeTask(first.id)).rejects.toThrow(/Other tasks wait for/);
    await controller.removeTask(second.id);
    expect(events).toContainEqual({ type: 'task:removed', taskId: second.id });
    expect(await getTask(graph, second.id)).toBeUndefined();

    await startSession(graph, { agent: 'codex', taskId: first.id, role: 'coder' });
    await expect(controller.removeTask(first.id)).rejects.toThrow(/history is kept/);

    const running = await controller.createTask({ title: 'Busy' });
    await updateTask(graph, running.id, { status: 'running' });
    await expect(controller.removeTask(running.id)).rejects.toThrow(/has not run/);
  }, 60_000);

  it('retries only a failed task, and waits if what it depends on is not done', async () => {
    const { controller, graph } = await fixture(PASS);
    const base = await controller.createTask({ title: 'Base' });
    const t = await controller.createTask({ title: 'Needs base', dependsOn: [base.id] });

    await expect(controller.retryTask(t.id)).rejects.toThrow(/only a failed task/);

    await updateTask(graph, t.id, { status: 'failed', blockedBy: [base.id] });
    expect((await controller.retryTask(t.id)).status).toBe('planned'); // base is not done yet
    expect((await getTask(graph, t.id))!.blockedBy).toBeUndefined();

    await updateTask(graph, base.id, { status: 'done' });
    await updateTask(graph, t.id, { status: 'failed' });
    expect((await controller.retryTask(t.id)).status).toBe('ready');
  }, 60_000);

  it('summarises the project and explains why agents cannot run when they cannot', async () => {
    const { controller, graph } = await fixture(PASS);
    const a = await controller.createTask({ title: 'A' });
    await controller.createTask({ title: 'B' });
    await updateTask(graph, a.id, { status: 'running' });
    const s = await controller.status();
    expect(s.total).toBe(2);
    expect(s.counts).toMatchObject({ planned: 1, running: 1, done: 0, failed: 0 });
    expect(s.running).toBe(false); // a task says running, but the team is not running
    expect(s.runBlocked).toBeUndefined();

    // a folder that is not a git repository: the reason comes back, and starting says the same
    const notGit = mkdtempSync(join(tmpdir(), 'puff-nogit-'));
    try {
      const blocked = await ProjectController.create({
        graph,
        project: { slug: 'x', name: 'x', repoPath: notGit },
        config: cfg(PASS),
      });
      expect(blocked.runBlocked).toMatch(/not a git repository/);
      await expect(blocked.start()).rejects.toThrow(/not a git repository/);
    } finally {
      rmSync(notGit, { recursive: true, force: true });
    }
  }, 60_000);

  it('runs the team, reports what a finished task changed, and does not start twice', async () => {
    const agent = fakeAgent('opencode', async (o) => {
      writeFileSync(
        join(o.cwd, 'src/lib/errors.ts'),
        `${readFileSync(join(o.cwd, 'src/lib/errors.ts'), 'utf8')}\n// added by the fake agent\n`,
      );
      await sleep(300); // long enough to try starting again while it works
      return { output: 'Added a comment.' };
    });
    const { controller, events } = await fixture(PASS, { opencode: agent });
    const t = await controller.createTask({ title: 'Touch errors', preferredAgent: 'opencode' });

    expect(await controller.start()).toBe(true);
    expect(controller.running).toBe(true);
    expect(await controller.start()).toBe(false); // already running
    await finished(events);

    expect(controller.running).toBe(false);
    const after = await controller.find(shortId(t.id));
    expect(after.status).toBe('done');
    expect(events.find((e) => e.type === 'run' && !e.running)).toMatchObject({
      message: expect.stringContaining('1/1 task(s) done'),
      tone: 'good',
    });

    const { diff } = await controller.diff(t.id);
    expect(diff?.source).toBe('merge');
    expect(diff?.files).toEqual(['src/lib/errors.ts']);
    expect(diff?.diff).toContain('+// added by the fake agent');
  }, 90_000);

  it('shows the kept attempt of a task whose tests failed', async () => {
    const agent = fakeAgent('opencode', (o) => {
      writeFileSync(
        join(o.cwd, 'src/lib/errors.ts'),
        `${readFileSync(join(o.cwd, 'src/lib/errors.ts'), 'utf8')}\n// a change that breaks\n`,
      );
      return { output: 'Changed it.' };
    });
    const { controller, events } = await fixture(FAIL, { opencode: agent });
    const t = await controller.createTask({ title: 'Break it', preferredAgent: 'opencode' });

    await controller.start({ agent: 'opencode' });
    await finished(events);
    expect((await controller.find(t.id)).status).toBe('failed');

    const { diff } = await controller.diff(t.id);
    expect(diff).toMatchObject({ source: 'attempt', label: expect.stringMatching(/Attempt 1/) });
    expect(diff?.diff).toContain('+// a change that breaks');

    // and a task that never ran has nothing to show
    const idle = await controller.createTask({ title: 'Idle' });
    expect((await controller.diff(idle.id)).diff).toBeUndefined();
  }, 90_000);

  it('answers slash commands in plain words and never throws', async () => {
    const { controller, graph } = await fixture(PASS);
    const say = async (text: string, hooks?: ProjectHooks) =>
      runSlashCommand(controller, text, hooks);

    expect((await say('/help')).text).toContain('/goal <what you want>');
    expect(await say('/tasks')).toEqual({ ok: true, text: 'No tasks.' });
    expect((await say('/status')).text).toMatch(/no tasks yet\.\nThe team is idle\./);

    const goal = await say('/goal add a health check endpoint');
    expect(goal.ok).toBe(true);
    expect(goal.text).toMatch(/^Added the goal as \w{6}\./);
    expect((await say('/goal')).ok).toBe(false);

    const added = await say('/task Write the docs');
    const id = /Added (\w{6}):/.exec(added.text)![1]!;
    expect((await say('/tasks')).text).toContain(`${id}  planned   Write the docs`);
    expect((await say('/tasks planned')).text.split('\n')).toHaveLength(2);
    expect((await say('/tasks failed')).text).toBe('No tasks.');
    expect((await say('/tasks banana')).text).toMatch(/Unknown state "banana"/);
    expect((await say('/status')).text).toContain('2 task(s), 2 planned');

    // retry only works on a failed task, and says so
    expect((await say(`/retry ${id}`)).text).toMatch(/only a failed task can be retried/);
    await updateTask(graph, (await controller.find(id)).id, { status: 'failed' });
    expect((await say(`/retry ${id}`)).text).toMatch(/back in the queue as ready/);

    expect((await say('/why Write the docs')).text).toContain('Write the docs');
    expect((await say('/diff Write the docs')).text).toMatch(/no changes to show yet/);
    expect((await say('/index')).text).toMatch(/Indexed \d+ files/);
    expect((await say('/stop')).text).toBe('The team is stopped.');

    // unknown command and a task that does not exist
    expect((await say('/nope')).ok).toBe(false);
    expect((await say('/retry zzzzzz')).text).toMatch(/No task matches/);

    // projects need the application
    expect((await say('/projects')).ok).toBe(false);
    const hooks: ProjectHooks = {
      list: async () => [
        { id: 'a', name: 'alpha', active: true, repoPath: '/a' },
        { id: 'b', name: 'beta', active: false, repoPath: '/b' },
      ],
      switchTo: async (ref) => {
        if (ref !== 'beta') throw new Error(`No project "${ref}"`);
        return 'beta';
      },
    };
    expect((await say('/projects', hooks)).text).toBe('* alpha  /a\n  beta  /b');
    expect((await say('/project beta', hooks)).text).toBe('Switched to beta.');
    expect((await say('/project gamma', hooks)).text).toBe('No project "gamma"');
  }, 90_000);
});
