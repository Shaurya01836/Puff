// Index a repository into its project graph. Re-running is cheap and idempotent:
// only files whose content hash changed are rewritten, and memory linked to them is marked stale.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Graph } from 'falkordb';
import { read, run } from '../db/client';
import { langForPath, parseSource } from './parser';
import { resolveRepo, type SourceFile } from './resolve';
import { isTestFile, listSourceFiles } from './walk';

export interface IndexStats {
  files: number;
  changed: number;
  removed: number;
  symbols: number;
  calls: number;
  imports: number;
  technologies: number;
  /** Failures/Decisions marked stale because their code changed (Q2) */
  staleFlagged: number;
  durationMs: number;
}

export interface IndexOptions {
  /** Rewrite every file even if its hash is unchanged */
  force?: boolean;
}

const BATCH = 500;

async function inBatches<T>(items: T[], fn: (batch: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += BATCH) await fn(items.slice(i, i + BATCH));
}

async function readDependencies(root: string): Promise<Set<string>> {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]);
  } catch {
    return new Set();
  }
}

export async function loadSources(root: string): Promise<SourceFile[]> {
  const paths = await listSourceFiles(root);
  return Promise.all(
    paths.map(async (path) => {
      const text = await readFile(join(root, path), 'utf8');
      const lang = langForPath(path)!;
      return {
        path,
        lang,
        hash: createHash('sha256').update(text).digest('hex'),
        isTest: isTestFile(path),
        parsed: await parseSource(text, lang),
      };
    }),
  );
}

export async function indexRepo(
  graph: Graph,
  project: { slug: string; repoPath: string },
  opts: IndexOptions = {},
): Promise<IndexStats> {
  const started = Date.now();
  const sources = await loadSources(project.repoPath);
  // Parse everything (cheap) so cross-file calls resolve correctly; write only what changed.
  const resolved = resolveRepo(sources, await readDependencies(project.repoPath));

  const existing = await read<{ path: string; hash: string; removed: boolean }>(
    graph,
    `MATCH (f:File) RETURN f.path AS path, f.hash AS hash, coalesce(f.removed, false) AS removed`,
  );
  const before = new Map(existing.map((f) => [f.path, f]));
  const current = new Set(sources.map((s) => s.path));

  const changed = sources.filter((s) => {
    const old = before.get(s.path);
    return opts.force || !old || old.hash !== s.hash || old.removed;
  });
  const changedPaths = new Set(changed.map((s) => s.path));
  const removedPaths = existing
    .filter((f) => !f.removed && !current.has(f.path))
    .map((f) => f.path);

  // Files whose outgoing edges may now point somewhere else: changed files and their importers.
  const affected = new Set(changedPaths);
  for (const imp of resolved.imports) if (changedPaths.has(imp.to)) affected.add(imp.from);
  for (const path of removedPaths) affected.add(path);

  // Q2: mark memory stale for files whose content changed or disappeared (before hashes are updated).
  const staleRows = await run<{ flagged: number }>(
    graph,
    `UNWIND $files AS file
     MATCH (f:File {path: file.path})
     WHERE f.hash <> file.hash
     MATCH (f)-[:DEFINES]->(:Symbol)<-[:ABOUT|IN]-(m)
     WHERE coalesce(m.stale, false) = false
     SET m.stale = true
     RETURN count(DISTINCT m) AS flagged`,
    {
      files: [
        ...changed.filter((s) => before.has(s.path)).map((s) => ({ path: s.path, hash: s.hash })),
        ...removedPaths.map((path) => ({ path, hash: '' })),
      ],
    },
  );
  const staleFlagged = staleRows[0]?.flagged ?? 0;

  // Drop outgoing edges of affected files; they are rewritten below from the fresh parse.
  const affectedList = [...affected];
  await run(
    graph,
    `UNWIND $paths AS p
     MATCH (:File {path: p})-[:DEFINES]->(:Symbol)-[c:CALLS]->()
     DELETE c`,
    { paths: affectedList },
  );
  await run(
    graph,
    `UNWIND $paths AS p
     MATCH (:File {path: p})-[r:IMPORTS|USES]->()
     DELETE r`,
    { paths: affectedList },
  );

  // Symbols that no longer exist are flagged, not deleted: memory linked to them keeps its anchor.
  const symbolsByFile = new Map<string, string[]>();
  for (const sym of resolved.symbols) {
    if (!symbolsByFile.has(sym.file)) symbolsByFile.set(sym.file, []);
    symbolsByFile.get(sym.file)!.push(sym.id);
  }
  await run(
    graph,
    `UNWIND $files AS file
     MATCH (:File {path: file.path})-[:DEFINES]->(s:Symbol)
     WHERE NOT s.id IN file.ids
     SET s.removed = true`,
    {
      files: [
        ...changed.map((s) => ({ path: s.path, ids: symbolsByFile.get(s.path) ?? [] })),
        ...removedPaths.map((path) => ({ path, ids: [] })),
      ],
    },
  );
  await run(
    graph,
    `UNWIND $paths AS p MATCH (f:File {path: p}) SET f.removed = true, f.updatedAt = timestamp()`,
    { paths: removedPaths },
  );

  // Q1: upsert changed files and their symbols.
  const fileRows = changed.map((s) => ({
    path: s.path,
    hash: s.hash,
    lang: s.lang,
    isTest: s.isTest,
    symbols: resolved.symbols
      .filter((sym) => sym.file === s.path)
      .map(({ id, name, kind, startLine, endLine, signature }) => ({
        id,
        name,
        kind,
        startLine,
        endLine,
        signature,
      })),
  }));
  await inBatches(fileRows, (files) =>
    run(
      graph,
      `MATCH (p:Project {id: $projectId})
       UNWIND $files AS file
       MERGE (f:File {path: file.path})
       SET f.hash = file.hash, f.lang = file.lang, f.isTest = file.isTest,
           f.removed = false, f.updatedAt = timestamp()
       MERGE (p)-[:HAS_FILE]->(f)
       WITH f, file
       UNWIND file.symbols AS sym
       MERGE (s:Symbol {id: sym.id})
       SET s.name = sym.name, s.kind = sym.kind, s.file = file.path, s.startLine = sym.startLine,
           s.endLine = sym.endLine, s.signature = sym.signature, s.removed = false
       MERGE (f)-[:DEFINES]->(s)`,
      { projectId: project.slug, files },
    ),
  );

  // Edges for affected files.
  const symbolFile = new Map(resolved.symbols.map((s) => [s.id, s.file]));
  const calls = resolved.calls.filter((c) => affected.has(symbolFile.get(c.from) ?? ''));
  await inBatches(calls, (batch) =>
    run(
      graph,
      `UNWIND $calls AS c
       MATCH (a:Symbol {id: c.from}), (b:Symbol {id: c.to})
       MERGE (a)-[:CALLS]->(b)`,
      { calls: batch },
    ),
  );
  const imports = resolved.imports.filter((i) => affected.has(i.from));
  await inBatches(imports, (batch) =>
    run(
      graph,
      `UNWIND $imports AS i
       MATCH (a:File {path: i.from}), (b:File {path: i.to})
       MERGE (a)-[:IMPORTS]->(b)`,
      { imports: batch },
    ),
  );
  const uses = resolved.uses.filter((u) => affected.has(u.file));
  await inBatches(uses, (batch) =>
    run(
      graph,
      `UNWIND $uses AS u
       MATCH (f:File {path: u.file})
       MERGE (t:Technology {name: u.technology})
       MERGE (f)-[:USES]->(t)`,
      { uses: batch },
    ),
  );

  return {
    files: sources.length,
    changed: changed.length,
    removed: removedPaths.length,
    symbols: resolved.symbols.length,
    calls: resolved.calls.length,
    imports: resolved.imports.length,
    technologies: new Set(resolved.uses.map((u) => u.technology)).size,
    staleFlagged,
    durationMs: Date.now() - started,
  };
}
