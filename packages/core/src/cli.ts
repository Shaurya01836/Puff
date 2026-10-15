// Puff CLI: everything the desktop app does, without Electron. Run with `npm run puff -- <command>`.
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Command } from 'commander';
import type { FalkorDB, Graph } from 'falkordb';
import { AGENT_NAMES, type AgentName, type Role, type TaskType } from '@puff/shared';
import { loadConfig, type PuffConfig } from './config';
import { compileContext } from './context/compiler';
import { connect, loadDotEnv, projectGraph } from './db/client';
import { graphStats, initProjectGraph, type ProjectInfo } from './db/init';
import { graphName, slugify } from './ids';
import { indexRepo } from './indexer/index';
import { recordTestFailures } from './memory/failures';
import {
  recordDecision,
  recordFailure,
  recordHandoff,
  recordProcedure,
  recordSolution,
} from './memory/memory';
import { finishSession, listSessions, startSession } from './memory/sessions';
import { createTask, listTasks } from './memory/tasks';
import { findSymbols, impactOf, resolveSymbols } from './queries/code';
import { getMemoryFeed, getWhy } from './queries/explain';
import { clearMemory, seedDemoMemory } from './seed/demo';

loadDotEnv();

const program = new Command()
  .name('puff')
  .description('Shared graph memory for a team of coding agents')
  .option('-c, --config <path>', 'config file', process.env.PUFF_CONFIG ?? 'puff.config.yaml')
  .option('--db <url>', 'FalkorDB url (default: $FALKORDB_URL or falkor://localhost:6379)')
  .option(
    '-r, --repo <path>',
    'repository (default: $PUFF_REPO or .)',
    process.env.PUFF_REPO ?? '.',
  )
  .option('-n, --name <name>', 'project name (default: repo folder name)');

interface Ctx {
  db: FalkorDB;
  graph: Graph;
  project: ProjectInfo;
  config: PuffConfig;
}

function projectFrom(repo: string, name?: string): ProjectInfo {
  const repoPath = resolve(repo);
  const projectName = name ?? basename(repoPath);
  return { slug: slugify(process.env.PUFF_PROJECT ?? projectName), name: projectName, repoPath };
}

/**
 * Connect, resolve the project and run `fn`. `init: true` creates the graph if needed; otherwise a
 * missing graph is reported clearly (FalkorDB's own error for it is cryptic).
 */
async function withProject<T>(
  repoArg: string | undefined,
  fn: (ctx: Ctx) => Promise<T>,
  { init = false }: { init?: boolean } = {},
): Promise<T> {
  const opts = program.opts<{ config: string; db?: string; repo: string; name?: string }>();
  const repo = repoArg ?? opts.repo;
  const config = await loadConfig(opts.config);
  const project = projectFrom(repo, opts.name);
  const db = await connect(opts.db);
  try {
    if (!init && !(await db.list()).includes(graphName(project.slug))) {
      throw new Error(
        `${graphName(project.slug)} does not exist yet. Run: npm run puff -- index ${repo}`,
      );
    }
    const graph = init
      ? await initProjectGraph(db, project, config)
      : projectGraph(db, project.slug);
    return await fn({ db, graph, project, config });
  } finally {
    await db.close();
  }
}

const collect = (value: string, prev: string[]): string[] => [...prev, value];
const repoArg = ['[repo]', 'path to the repository (default: --repo)'] as const;

function printStats(stats: Awaited<ReturnType<typeof graphStats>>): void {
  const line = (rec: Record<string, number>) =>
    Object.entries(rec)
      .map(([k, v]) => `${k}=${v}`)
      .join('  ') || '(empty)';
  console.log(`  nodes: ${line(stats.labels)}`);
  console.log(`  edges: ${line(stats.relationships)}`);
}

function agentOf(name: string): AgentName {
  if (!AGENT_NAMES.includes(name as AgentName)) {
    throw new Error(`Unknown agent "${name}". Use one of: ${AGENT_NAMES.join(', ')}`);
  }
  return name as AgentName;
}

const num = (v?: string): number | undefined => (v === undefined ? undefined : Number(v));

// ---------------------------------------------------------------------------------------------
// Graph and code
// ---------------------------------------------------------------------------------------------

program
  .command('init')
  .description('create the project graph, indexes and agent pool (idempotent)')
  .argument(...repoArg)
  .action(async (repo?: string) => {
    await withProject(
      repo,
      async ({ graph, project }) => {
        console.log(`✔ ${graphName(project.slug)} ready for ${project.repoPath}`);
        printStats(await graphStats(graph));
      },
      { init: true },
    );
  });

program
  .command('index')
  .description('parse the repo with tree-sitter and write files, symbols, calls and imports')
  .argument(...repoArg)
  .option('-f, --force', 'rewrite every file, even unchanged ones')
  .action(async (repo: string | undefined, cmd: { force?: boolean }) => {
    await withProject(
      repo,
      async ({ graph, project }) => {
        const s = await indexRepo(graph, project, { force: cmd.force });
        console.log(
          `✔ indexed ${s.files} files (${s.changed} changed, ${s.removed} removed) in ${s.durationMs} ms\n` +
            `  ${s.symbols} symbols · ${s.calls} calls · ${s.imports} imports · ${s.technologies} technologies` +
            (s.staleFlagged ? `\n  ⚠ ${s.staleFlagged} memories marked stale` : ''),
        );
      },
      { init: true },
    );
  });

program
  .command('symbols')
  .description('find symbols by name or id')
  .argument('<term>', 'part of a name or id, e.g. login or auth/')
  .argument(...repoArg)
  .action(async (term: string, repo?: string) => {
    await withProject(repo, async ({ graph }) => {
      const rows = await findSymbols(graph, term);
      if (!rows.length) console.log('(no matches)');
      for (const r of rows)
        console.log(`${r.kind.padEnd(8)} ${r.id}  L${r.startLine}-${r.endLine}`);
    });
  });

program
  .command('impact')
  .description('what may break if this symbol changes (callers up to 3 hops)')
  .argument('<symbol>', 'symbol id, e.g. src/auth/login.ts::login (or a unique name)')
  .argument(...repoArg)
  .action(async (symbol: string, repo?: string) => {
    await withProject(repo, async ({ graph }) => {
      const [id] = await resolveSymbols(graph, [symbol]);
      const rows = await impactOf(graph, id!);
      console.log(`Changing ${id} may affect ${rows.length} file(s):`);
      for (const r of rows) console.log(`  ${r.file}\n    ← ${r.callers.join(', ')}`);
    });
  });

program
  .command('status')
  .description('show node and edge counts for a project graph')
  .argument(...repoArg)
  .action(async (repo?: string) => {
    await withProject(repo, async ({ graph, project }) => {
      console.log(graphName(project.slug));
      printStats(await graphStats(graph));
    });
  });

program
  .command('graphs')
  .description('list Puff project graphs in FalkorDB')
  .action(async () => {
    const db = await connect(program.opts<{ db?: string }>().db);
    try {
      const graphs = (await db.list()).filter((g) => g.startsWith('puff_'));
      console.log(graphs.length ? graphs.join('\n') : '(no Puff graphs yet)');
    } finally {
      await db.close();
    }
  });

// ---------------------------------------------------------------------------------------------
// Tasks, sessions and context
// ---------------------------------------------------------------------------------------------

const task = program.command('task').description('create and list tasks');

task
  .command('add')
  .description('create a task that targets symbols')
  .argument('<title>', 'what needs doing')
  .option('-t, --target <symbol>', 'symbol id or unique name (repeatable)', collect, [])
  .option('--type <type>', 'plan | implement | verify | chore', 'implement')
  .option('--complexity <level>', 'low | medium | high', 'medium')
  .option('--depends-on <taskId>', 'task this one waits for (repeatable)', collect, [])
  .action(
    async (
      title: string,
      o: {
        target: string[];
        type: TaskType;
        complexity: 'low' | 'medium' | 'high';
        dependsOn: string[];
      },
    ) => {
      await withProject(undefined, async ({ graph, project, config }) => {
        const t = await createTask(graph, project.slug, config, {
          title,
          type: o.type,
          complexity: o.complexity,
          targets: o.target,
          dependsOn: o.dependsOn,
        });
        console.log(`✔ ${t.id}  ${t.title}\n  targets: ${t.targets.join(', ') || '(none)'}`);
      });
    },
  );

task
  .command('list')
  .description('list tasks')
  .action(async () => {
    await withProject(undefined, async ({ graph }) => {
      const tasks = await listTasks(graph);
      if (!tasks.length) console.log('(no tasks yet: puff task add "…" -t login)');
      for (const t of tasks) {
        console.log(
          `${t.id}  ${t.status.padEnd(9)} ${t.type.padEnd(9)} ${t.assignedAgent ?? '-'.padEnd(6)}  ${t.title}`,
        );
      }
    });
  });

program
  .command('context')
  .description(
    'build the context an agent would receive for a task, and show why each item is in it',
  )
  .argument('<taskId>')
  .option('--role <role>', 'planner | coder | verifier | chore', 'coder')
  .option(
    '--agent <agent>',
    'start a session for this agent and record the context pack (default: preview only)',
  )
  .option('--budget <tokens>', 'token budget (default from config)')
  .option('--no-prompt', 'show the items only')
  .action(
    async (taskId: string, o: { role: Role; agent?: string; budget?: string; prompt: boolean }) => {
      await withProject(undefined, async ({ graph, config }) => {
        const sessionId = o.agent
          ? await startSession(graph, { agent: agentOf(o.agent), taskId, role: o.role })
          : undefined;
        const pack = await compileContext(graph, taskId, {
          role: o.role,
          sessionId,
          preview: !sessionId,
          budgetTokens: num(o.budget) ?? config.limits.contextTokenBudget,
        });
        console.log(
          `Context for ${taskId} as ${o.role}: ${pack.items.length} items, ~${pack.tokenEstimate} tokens` +
            (pack.dropped ? `, ${pack.dropped} left out to fit the budget` : '') +
            (sessionId
              ? `\n  session ${sessionId}, pack ${pack.id} recorded`
              : '  (preview, nothing recorded)'),
        );
        for (const i of pack.items) {
          console.log(
            `  ${i.kind.padEnd(9)} ${i.text.slice(0, 80)}\n  ${' '.repeat(9)} ↳ ${i.reason}${i.stale ? '  [possibly outdated]' : ''}`,
          );
        }
        if (o.prompt) console.log(`\n${'─'.repeat(20)} prompt ${'─'.repeat(20)}\n${pack.prompt}`);
      });
    },
  );

const session = program.command('session').description('finish a session and record what happened');

session
  .command('finish')
  .description('record the outcome of a session (what Puff observed)')
  .argument('<sessionId>')
  .requiredOption('--outcome <outcome>', 'success | failure | error')
  .option('--tokens-in <n>')
  .option('--tokens-out <n>')
  .option('--duration <ms>')
  .option('--summary <text>')
  .option('--changed <path>', 'file the agent changed (repeatable)', collect, [])
  .action(
    async (
      sessionId: string,
      o: {
        outcome: 'success' | 'failure' | 'error';
        tokensIn?: string;
        tokensOut?: string;
        duration?: string;
        summary?: string;
        changed: string[];
      },
    ) => {
      await withProject(undefined, async ({ graph }) => {
        await finishSession(graph, sessionId, {
          outcome: o.outcome,
          tokensIn: num(o.tokensIn),
          tokensOut: num(o.tokensOut),
          durationMs: num(o.duration),
          summary: o.summary,
          changedFiles: o.changed,
        });
        console.log(`✔ ${sessionId} finished: ${o.outcome}`);
      });
    },
  );

// ---------------------------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------------------------

const failure = program.command('failure').description('record failures, tied to code');

failure
  .command('add')
  .description('record failures from test output (located automatically) or a manual one')
  .requiredOption('--session <id>', 'session that hit the failure')
  .option(
    '--test-output <file>',
    'file with the failing test output; failures are located in code for you',
  )
  .option('--root <dir>', 'working tree the tests ran in (default: the repo)')
  .option('--diff <file>', 'unified diff of what the agent changed (improves locating)')
  .option('--changed <path>', 'file the agent changed (repeatable)', collect, [])
  .option('--message <text>', 'manual failure message (with --symbol)')
  .option('--symbol <symbol>', 'manual anchor: symbol id or unique name (repeatable)', collect, [])
  .action(
    async (o: {
      session: string;
      testOutput?: string;
      root?: string;
      diff?: string;
      changed: string[];
      message?: string;
      symbol: string[];
    }) => {
      await withProject(undefined, async ({ graph, project }) => {
        if (o.message) {
          const symbolIds = await resolveSymbols(graph, o.symbol);
          const r = await recordFailure(graph, {
            sessionId: o.session,
            message: o.message,
            symbolIds,
            anchoredBy: 'manual',
          });
          console.log(
            `✔ ${r.id}${r.repeated ? ' (seen before)' : ''} in ${r.symbolIds.join(', ')}`,
          );
          return;
        }
        if (!o.testOutput) throw new Error('Give --test-output <file>, or --message with --symbol');
        const [s] = (await listSessions(graph)).filter((x) => x.id === o.session);
        if (!s) throw new Error(`Unknown session ${o.session}`);
        const recorded = await recordTestFailures(graph, {
          sessionId: o.session,
          taskId: s.taskId,
          output: await readFile(o.testOutput, 'utf8'),
          root: resolve(o.root ?? project.repoPath),
          diff: o.diff ? await readFile(o.diff, 'utf8') : undefined,
          changedFiles: o.changed.length ? o.changed : s.changedFiles,
        });
        if (!recorded.length)
          console.log('No failures could be tied to code, so nothing was recorded.');
        for (const r of recorded) {
          console.log(
            `✔ ${r.id}${r.repeated ? ' (seen before)' : ''}  ${r.message}\n  in ${r.symbolIds.join(', ')}  (located by ${r.via})`,
          );
        }
      });
    },
  );

program
  .command('fix')
  .description('record what fixed a failure')
  .argument('<failureId>')
  .argument('<summary>')
  .action(async (failureId: string, summary: string) => {
    await withProject(undefined, async ({ graph }) => {
      console.log(`✔ ${await recordSolution(graph, { failureId, summary })}`);
    });
  });

program
  .command('decision')
  .description('record a decision about a symbol, or supersede an earlier one')
  .argument('<symbol>', 'symbol id or unique name')
  .argument('<text>')
  .option('--supersedes <decisionId>')
  .action(async (symbol: string, text: string, o: { supersedes?: string }) => {
    await withProject(undefined, async ({ graph }) => {
      const symbolIds = await resolveSymbols(graph, [symbol]);
      const { id } = await recordDecision(graph, { symbolIds, text, supersedes: o.supersedes });
      console.log(`✔ ${id}${o.supersedes ? ` (supersedes ${o.supersedes})` : ''}`);
    });
  });

program
  .command('procedure')
  .description('record how things are done here')
  .argument('<text>')
  .option('--tech <name>', 'technology it applies to (default: the whole project)')
  .action(async (text: string, o: { tech?: string }) => {
    await withProject(undefined, async ({ graph, project }) => {
      console.log(`✔ ${await recordProcedure(graph, project.slug, { text, technology: o.tech })}`);
    });
  });

program
  .command('handoff')
  .description('leave a note for whoever works next on this task or its dependents')
  .argument('<sessionId>')
  .argument('<summary>')
  .option('--to-role <role>')
  .action(async (sessionId: string, summary: string, o: { toRole?: string }) => {
    await withProject(undefined, async ({ graph }) => {
      console.log(
        `✔ ${await recordHandoff(graph, { fromSessionId: sessionId, payload: { summary }, toRole: o.toRole })}`,
      );
    });
  });

program
  .command('memory')
  .description('show the memory feed, newest first')
  .option('--limit <n>', 'how many events', '25')
  .action(async (o: { limit: string }) => {
    await withProject(undefined, async ({ graph }) => {
      const feed = await getMemoryFeed(graph, Number(o.limit));
      if (!feed.length) console.log('(nothing recorded yet)');
      for (const e of feed) {
        console.log(
          `${new Date(e.at).toLocaleTimeString()}  ${e.type.replaceAll('_', ' ').padEnd(20)} ${e.text.slice(0, 110)}`,
        );
      }
    });
  });

program
  .command('why')
  .description('why a task went to its agent and why each item of context was included')
  .argument('<taskId>')
  .action(async (taskId: string) => {
    await withProject(undefined, async ({ graph }) => {
      const why = await getWhy(graph, taskId);
      console.log(why.summary);
      const label = new Map(why.nodes.map((n) => [n.id, `${n.kind}: ${n.label.slice(0, 50)}`]));
      for (const e of why.edges) {
        const reason = e.props?.reason ? `   ← ${e.props.reason}` : '';
        console.log(`  ${label.get(e.source)}  -[${e.type}]->  ${label.get(e.target)}${reason}`);
      }
    });
  });

// ---------------------------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------------------------

program
  .command('seed')
  .description('write sample tasks, sessions and memory for the demo repo (flagged as seeded)')
  .option('-f, --force', 'remove existing tasks and memory first')
  .action(async (o: { force?: boolean }) => {
    await withProject(
      undefined,
      async ({ graph, project, config }) => {
        const r = await seedDemoMemory(graph, project.slug, config, { force: o.force });
        console.log(
          r.skipped
            ? `Skipped: ${r.skipped}`
            : `✔ seeded ${r.tasks} tasks, ${r.sessions} sessions, ${r.failures} failures (sample data, flagged seeded)`,
        );
      },
      { init: true },
    );
  });

program
  .command('reset-memory')
  .description('development only: delete tasks, sessions and memory (keeps the code graph)')
  .action(async () => {
    await withProject(undefined, async ({ graph }) => {
      await clearMemory(graph);
      console.log('✔ memory cleared; the code graph is untouched');
    });
  });

program.parseAsync().catch((err: Error) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
