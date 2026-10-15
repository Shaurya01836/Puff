import { cpSync, appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, loadDotEnv, read, run } from '../src/db/client';
import { graphName } from '../src/ids';
import { indexRepo, loadSources } from '../src/indexer/index';
import { parseSource } from '../src/indexer/parser';
import { packageName, resolveModule, resolveRepo } from '../src/indexer/resolve';
import { isTestFile } from '../src/indexer/walk';
import { impactOf } from '../src/queries/code';
import { exportGraph } from '../src/queries/graph';
import { parseConfig } from '../src/config';
import { initProjectGraph } from '../src/db/init';
import { readFileSync } from 'node:fs';

const DEMO = fileURLToPath(new URL('../../../demo/shop-api', import.meta.url));

describe('parser', () => {
  it('extracts functions, arrow functions, classes, methods, calls and imports', async () => {
    const parsed = await parseSource(
      [
        `import { hash as h } from './crypto';`,
        `import express from 'express';`,
        `export function login(u: string) { checkUser(u); return h(u); }`,
        `function checkUser(u: string) { audit(u); }`,
        `export const audit = (x: string) => log(x);`,
        `class Session { start() { login('a'); this.end(); } end() {} }`,
        `const obj = { method() { return 1; } };`,
      ].join('\n'),
      'typescript',
    );
    expect(parsed.defs.map((d) => `${d.kind}:${d.name}@${d.startLine}`)).toEqual([
      'function:login@3',
      'function:checkUser@4',
      'function:audit@5',
      'class:Session@6',
      'method:Session.start@6',
      'method:Session.end@6',
    ]);
    expect(parsed.calls).toContainEqual({ name: 'h', object: undefined, from: 'login' });
    expect(parsed.calls).toContainEqual({ name: 'end', object: 'this', from: 'Session.start' });
    expect(parsed.imports).toEqual([
      { source: './crypto', bindings: { h: 'hash' } },
      { source: 'express', bindings: { express: 'default' } },
    ]);
  });
});

describe('resolve', () => {
  const files = new Set(['src/a.ts', 'src/lib/index.ts', 'src/b.tsx']);

  it('resolves relative modules with extensions and index files', () => {
    expect(resolveModule('src/x.ts', './a', files)).toBe('src/a.ts');
    expect(resolveModule('src/x.ts', './a.js', files)).toBe('src/a.ts');
    expect(resolveModule('src/x.ts', './lib', files)).toBe('src/lib/index.ts');
    expect(resolveModule('src/x.ts', './b', files)).toBe('src/b.tsx');
    expect(resolveModule('src/x.ts', 'express', files)).toBeUndefined();
  });

  it('reads package names from bare specifiers', () => {
    expect(packageName('express')).toBe('express');
    expect(packageName('@scope/pkg/sub')).toBe('@scope/pkg');
    expect(packageName('node:crypto')).toBe('node');
    expect(packageName('./x')).toBeUndefined();
  });

  it('spots test files', () => {
    expect(isTestFile('test/auth.spec.ts')).toBe(true);
    expect(isTestFile('src/a.test.tsx')).toBe(true);
    expect(isTestFile('src/auth/login.ts')).toBe(false);
  });

  it('builds the demo repo call graph across files', async () => {
    const sources = await loadSources(DEMO);
    const repo = resolveRepo(sources, new Set(['express', 'vitest', 'supertest']));
    const calls = new Set(repo.calls.map((c) => `${c.from} -> ${c.to}`));

    expect(sources.some((s) => s.path.includes('node_modules'))).toBe(false);
    expect(calls).toContain('src/auth/login.ts::login -> src/auth/login.ts::checkUser');
    expect(calls).toContain('src/auth/login.ts::login -> src/auth/session.ts::Session.start');
    expect(calls).toContain('src/routes/auth.ts::authRouter -> src/auth/login.ts::login');
    expect(calls).toContain('src/cart/cart.ts::cartTotal -> src/cart/tax.ts::taxFor');
    // library calls are dropped, not guessed
    expect([...calls].some((c) => c.includes('console') || c.includes('::json'))).toBe(false);
    expect(repo.imports).toContainEqual({ from: 'src/routes/auth.ts', to: 'src/auth/login.ts' });
    expect(repo.uses).toContainEqual({ file: 'src/app.ts', technology: 'Express' });
  });
});

// Integration: needs a running FalkorDB (npm run db:up). Skipped when unreachable.
loadDotEnv(fileURLToPath(new URL('../../../.env', import.meta.url)));
const db = await connect().catch(() => undefined);

describe.skipIf(!db)('indexRepo against FalkorDB', () => {
  const slug = `test_indexer_${process.pid}`;
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'puff-index-'));
    cpSync(join(DEMO, 'src'), join(repo, 'src'), { recursive: true });
    cpSync(join(DEMO, 'package.json'), join(repo, 'package.json'));
  });

  afterAll(async () => {
    await db!
      .selectGraph(graphName(slug))
      .delete()
      .catch(() => {});
    await db!.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('indexes, answers impact queries, re-indexes incrementally and flags stale memory', async () => {
    const config = parseConfig(
      readFileSync(fileURLToPath(new URL('../../../puff.config.yaml', import.meta.url)), 'utf8'),
    );
    const project = { slug, name: slug, repoPath: repo };
    const graph = await initProjectGraph(db!, project, config);

    const first = await indexRepo(graph, project);
    expect(first.changed).toBe(first.files);
    expect(first.symbols).toBeGreaterThan(50);

    const impact = await impactOf(graph, 'src/auth/login.ts::login');
    expect(impact.map((r) => r.file)).toEqual(['src/app.ts', 'src/routes/auth.ts']);

    const again = await indexRepo(graph, project);
    expect(again.changed).toBe(0);

    await run(
      graph,
      `MATCH (s:Symbol {id: 'src/auth/login.ts::login'}), (c:Symbol {id: 'src/auth/login.ts::checkUser'})
       CREATE (:Failure {id: 'fail_test', message: 'pw logged', stale: false})-[:IN]->(s),
              (:Failure {id: 'fail_check', message: 'wrong user', stale: false})-[:IN]->(c)`,
    );
    const stale = async () =>
      (
        await read<{ id: string }>(
          graph,
          `MATCH (f:Failure) WHERE f.stale = true RETURN f.id AS id ORDER BY id`,
        )
      ).map((r) => r.id);

    // A comment after every function changes the file but not what any of them does.
    appendFileSync(join(repo, 'src/auth/login.ts'), '\n// edited\n');
    const commented = await indexRepo(graph, project);
    expect(commented.changed).toBe(1);
    expect(commented.staleFlagged).toBe(0);
    expect(await stale()).toEqual([]);

    // Editing one function flags what we learned about it, and only it.
    const file = join(repo, 'src/auth/login.ts');
    writeFileSync(file, readFileSync(file, 'utf8').replace("'login.failed'", "'login.rejected'"));
    const edited = await indexRepo(graph, project);
    expect(edited.changed).toBe(1);
    expect(edited.staleFlagged).toBe(1);
    expect(await stale()).toEqual(['fail_check']);

    const exported = await exportGraph(graph);
    expect(exported.nodes.find((n) => n.id === 'src/auth/login.ts::login')?.kind).toBe('Symbol');
    expect(exported.nodes.find((n) => n.id === 'agent:codex')?.kind).toBe('Agent');
    expect(exported.edges).toContainEqual({
      source: 'fail_test',
      target: 'src/auth/login.ts::login',
      type: 'IN',
    });

    // Deleting a function flags its memory too.
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace(/export function login[\s\S]*?\n}\n/, ''),
    );
    const removed = await indexRepo(graph, project);
    expect(removed.staleFlagged).toBe(1);
    expect(await stale()).toEqual(['fail_check', 'fail_test']);
  });
});
