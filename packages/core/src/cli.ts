// Puff CLI: everything the desktop app does, without Electron. Run with `npm run puff -- <command>`.
import { basename, resolve } from 'node:path';
import { Command } from 'commander';
import { loadConfig } from './config';
import { connect, loadDotEnv, projectGraph } from './db/client';
import { graphStats, initProjectGraph, type ProjectInfo } from './db/init';
import { graphName, slugify } from './ids';

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

program
  .command('init')
  .description('create the project graph, indexes and agent pool (idempotent)')
  .argument('[repo]', 'path to the repository', '.')
  .option('-n, --name <name>', 'project name (default: repo folder name)')
  .action(async (repo: string, cmd: { name?: string }) => {
    const { config: configPath, db: url } = program.opts<{ config: string; db?: string }>();
    const config = await loadConfig(configPath);
    const project = projectFrom(repo, cmd.name);
    const db = await connect(url);
    try {
      const graph = await initProjectGraph(db, project, config);
      console.log(`✔ ${graphName(project.slug)} ready for ${project.repoPath}`);
      printStats(await graphStats(graph));
    } finally {
      await db.close();
    }
  });

program
  .command('status')
  .description('show node and edge counts for a project graph')
  .argument('[repo]', 'path to the repository', '.')
  .option('-n, --name <name>', 'project name (default: repo folder name)')
  .action(async (repo: string, cmd: { name?: string }) => {
    const { db: url } = program.opts<{ db?: string }>();
    const project = projectFrom(repo, cmd.name);
    const db = await connect(url);
    try {
      const name = graphName(project.slug);
      if (!(await db.list()).includes(name)) {
        console.log(`${name} does not exist yet. Run: npm run puff -- init ${repo}`);
        process.exitCode = 1;
        return;
      }
      console.log(name);
      printStats(await graphStats(projectGraph(db, project.slug)));
    } finally {
      await db.close();
    }
  });

program
  .command('graphs')
  .description('list Puff project graphs in FalkorDB')
  .action(async () => {
    const { db: url } = program.opts<{ db?: string }>();
    const db = await connect(url);
    try {
      const graphs = (await db.list()).filter((g) => g.startsWith('puff_'));
      console.log(graphs.length ? graphs.join('\n') : '(no Puff graphs yet)');
    } finally {
      await db.close();
    }
  });

program.parseAsync().catch((err: Error) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
