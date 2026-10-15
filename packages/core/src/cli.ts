// Puff CLI: everything the desktop app does, without Electron. Run with `npm run puff -- <command>`.
import { basename, resolve } from 'node:path';
import { Command } from 'commander';
import type { FalkorDB } from 'falkordb';
import { loadConfig } from './config';
import { connect, loadDotEnv, projectGraph } from './db/client';
import { graphStats, initProjectGraph, type ProjectInfo } from './db/init';
import { graphName, slugify } from './ids';
import { indexRepo } from './indexer/index';
import { findSymbols, impactOf } from './queries/code';

loadDotEnv();

const program = new Command()
  .name('puff')
  .description('Shared graph memory for a team of coding agents')
  .option('-c, --config <path>', 'config file', process.env.PUFF_CONFIG ?? 'puff.config.yaml')
  .option('--db <url>', 'FalkorDB url (default: $FALKORDB_URL or falkor://localhost:6379)');

function projectFrom(repo: string, name?: string): ProjectInfo {
  const repoPath = resolve(repo);
  const projectName = name ?? basename(repoPath);
  return { slug: slugify(process.env.PUFF_PROJECT ?? projectName), name: projectName, repoPath };
}

function printStats(stats: Awaited<ReturnType<typeof graphStats>>): void {
  const line = (rec: Record<string, number>) =>
    Object.entries(rec)
      .map(([k, v]) => `${k}=${v}`)
      .join('  ') || '(empty)';
  console.log(`  nodes: ${line(stats.labels)}`);
  console.log(`  edges: ${line(stats.relationships)}`);
}

async function withDb<T>(fn: (db: FalkorDB) => Promise<T>): Promise<T> {
  const { db: url } = program.opts<{ db?: string }>();
  const db = await connect(url);
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

/** Fail early with a helpful message instead of FalkorDB's "empty key" error on reads. */
async function requireGraph(db: FalkorDB, project: ProjectInfo, repo: string): Promise<void> {
  if (!(await db.list()).includes(graphName(project.slug))) {
    throw new Error(
      `${graphName(project.slug)} does not exist yet. Run: npm run puff -- init ${repo}`,
    );
  }
}

const repoArg = ['[repo]', 'path to the repository', '.'] as const;
const nameOpt = ['-n, --name <name>', 'project name (default: repo folder name)'] as const;

program
  .command('init')
  .description('create the project graph, indexes and agent pool (idempotent)')
  .argument(...repoArg)
  .option(...nameOpt)
  .action(async (repo: string, cmd: { name?: string }) => {
    const config = await loadConfig(program.opts<{ config: string }>().config);
    const project = projectFrom(repo, cmd.name);
    await withDb(async (db) => {
      const graph = await initProjectGraph(db, project, config);
      console.log(`✔ ${graphName(project.slug)} ready for ${project.repoPath}`);
      printStats(await graphStats(graph));
    });
  });

program
  .command('index')
  .description(
    'parse the repo with tree-sitter and write files, symbols, calls and imports to the graph',
  )
  .argument(...repoArg)
  .option(...nameOpt)
  .option('-f, --force', 'rewrite every file, even unchanged ones')
  .action(async (repo: string, cmd: { name?: string; force?: boolean }) => {
    const config = await loadConfig(program.opts<{ config: string }>().config);
    const project = projectFrom(repo, cmd.name);
    await withDb(async (db) => {
      const graph = await initProjectGraph(db, project, config);
      const s = await indexRepo(graph, project, { force: cmd.force });
      console.log(
        `✔ indexed ${s.files} files (${s.changed} changed, ${s.removed} removed) in ${s.durationMs} ms\n` +
          `  ${s.symbols} symbols · ${s.calls} calls · ${s.imports} imports · ${s.technologies} technologies` +
          (s.staleFlagged ? `\n  ⚠ ${s.staleFlagged} memories marked stale` : ''),
      );
    });
  });

program
  .command('symbols')
  .description('find symbols by name or id')
  .argument('<term>', 'part of a name or id, e.g. login or auth/')
  .argument(...repoArg)
  .option(...nameOpt)
  .action(async (term: string, repo: string, cmd: { name?: string }) => {
    const project = projectFrom(repo, cmd.name);
    await withDb(async (db) => {
      await requireGraph(db, project, repo);
      const rows = await findSymbols(projectGraph(db, project.slug), term);
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
  .option(...nameOpt)
  .action(async (symbol: string, repo: string, cmd: { name?: string }) => {
    const project = projectFrom(repo, cmd.name);
    await withDb(async (db) => {
      await requireGraph(db, project, repo);
      const graph = projectGraph(db, project.slug);
      let id = symbol;
      if (!symbol.includes('::')) {
        const matches = (await findSymbols(graph, symbol)).filter((s) => s.name === symbol);
        if (matches.length !== 1) {
          throw new Error(
            matches.length
              ? `"${symbol}" is ambiguous: ${matches.map((m) => m.id).join(', ')}`
              : `No symbol named "${symbol}"`,
          );
        }
        id = matches[0]!.id;
      }
      const rows = await impactOf(graph, id);
      console.log(`Changing ${id} may affect ${rows.length} file(s):`);
      for (const r of rows) console.log(`  ${r.file}\n    ← ${r.callers.join(', ')}`);
    });
  });

program
  .command('status')
  .description('show node and edge counts for a project graph')
  .argument(...repoArg)
  .option(...nameOpt)
  .action(async (repo: string, cmd: { name?: string }) => {
    const project = projectFrom(repo, cmd.name);
    await withDb(async (db) => {
      await requireGraph(db, project, repo);
      console.log(graphName(project.slug));
      printStats(await graphStats(projectGraph(db, project.slug)));
    });
  });

program
  .command('graphs')
  .description('list Puff project graphs in FalkorDB')
  .action(async () => {
    await withDb(async (db) => {
      const graphs = (await db.list()).filter((g) => g.startsWith('puff_'));
      console.log(graphs.length ? graphs.join('\n') : '(no Puff graphs yet)');
    });
  });

program.parseAsync().catch((err: Error) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
