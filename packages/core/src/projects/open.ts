// Turn a registered project into something Puff can use: its settings applied to the user's
// configuration, its graph created, and its code indexed the first time.
import type { FalkorDB, Graph } from 'falkordb';
import type { PuffConfig } from '../config';
import { projectGraph, read } from '../db/client';
import { initProjectGraph, type ProjectInfo } from '../db/init';
import { indexRepo, type IndexStats } from '../indexer/index';
import { detectSetup } from './detect';
import type { ProjectEntry } from './registry';

/** The user's configuration with this project's own settings on top. */
export function applyProject(config: PuffConfig, entry?: ProjectEntry): PuffConfig {
  if (!entry) return config;
  return {
    ...config,
    verify: { ...config.verify, testCommand: entry.testCommand ?? config.verify.testCommand },
    worktrees: { ...config.worktrees, linkDirs: entry.linkDirs ?? config.worktrees.linkDirs },
  };
}

/**
 * The project with what Puff found out about its folder filled in for anything the person has not set:
 * an app in a subfolder gets its check command and its dependency folder without anyone typing them.
 * What the person set always wins; nothing is written to the registry.
 */
export async function withDetectedSettings(entry: ProjectEntry): Promise<ProjectEntry> {
  if (entry.testCommand !== undefined && entry.linkDirs !== undefined) return entry;
  const found = await detectSetup(entry.repoPath).catch(() => undefined);
  if (!found) return entry;
  return {
    ...entry,
    testCommand: entry.testCommand ?? found.testCommand,
    linkDirs: entry.linkDirs ?? found.linkDirs,
  };
}

export const toProjectInfo = (entry: ProjectEntry): ProjectInfo => ({
  slug: entry.slug,
  name: entry.name,
  repoPath: entry.repoPath,
});

export interface OpenedProject {
  graph: Graph;
  config: PuffConfig;
  project: ProjectInfo;
  /** Set when this call had to index the code (a project's first open) */
  indexed?: IndexStats;
}

export async function openProject(
  db: FalkorDB,
  entry: ProjectEntry,
  userConfig: PuffConfig,
): Promise<OpenedProject> {
  const config = applyProject(userConfig, await withDetectedSettings(entry));
  const project = toProjectInfo(entry);
  const graph = await initProjectGraph(db, project, config);
  const rows = await read<{ files: number }>(graph, 'MATCH (f:File) RETURN count(f) AS files');
  const indexed = (rows[0]?.files ?? 0) === 0 ? await indexRepo(graph, project) : undefined;
  return { graph, config, project, indexed };
}

/** Delete a project's graph: all its memory. Only ever called when the person asked for it. */
export async function deleteProjectMemory(db: FalkorDB, slug: string): Promise<void> {
  await projectGraph(db, slug)
    .delete()
    .catch(() => {});
}

/** Counts shown in the project list; undefined when the graph does not exist or cannot be read. */
export async function projectCounts(
  db: FalkorDB,
  slug: string,
): Promise<{ files: number; symbols: number; tasks: number } | undefined> {
  try {
    const graph = projectGraph(db, slug);
    const rows = await read<{ files: number; symbols: number; tasks: number }>(
      graph,
      `OPTIONAL MATCH (f:File) WITH count(f) AS files
       OPTIONAL MATCH (s:Symbol) WITH files, count(s) AS symbols
       OPTIONAL MATCH (t:Task) RETURN files, symbols, count(t) AS tasks`,
    );
    return rows[0];
  } catch {
    return undefined;
  }
}
