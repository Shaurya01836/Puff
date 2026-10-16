// Q32, the vector index on failures: a static embedding model in plain TypeScript, vectors stored on the
// Failure nodes, and FalkorDB's vector index finding failures that mean the same as a task when they share
// no words with it. Without the model, full-text search (Q22) still works.
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';
import { compileContext } from '../src/context/compiler';
import { connect, loadDotEnv, read } from '../src/db/client';
import { initProjectGraph } from '../src/db/init';
import { embedFailures, getEmbedder, vectorSimilarFailures } from '../src/embed/lessons';
import { basicTokens, cosine, ensureModel, wordPiece } from '../src/embed/static';
import { graphName } from '../src/ids';
import { indexRepo } from '../src/indexer/index';
import { recordFailure } from '../src/memory/memory';
import { startSession } from '../src/memory/sessions';
import { createTask } from '../src/memory/tasks';
import { fullTextFailures, similarFailures } from '../src/queries/insights';

const rel = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const DEMO = rel('../../../demo/shop-api');
const config = parseConfig(readFileSync(rel('../../../puff.config.yaml'), 'utf8'));

loadDotEnv(rel('../../../.env'));
const db = await connect().catch(() => undefined);
// the model is downloaded once (30 MB) into ~/.puff/models; without a network the vector tests skip
const model = await ensureModel()
  .then(() => getEmbedder())
  .catch(() => undefined);

const LOGIN = 'src/auth/login.ts::login';
const CART_TOTAL = 'src/cart/cart.ts::cartTotal';

describe('the tokenizer', () => {
  it('splits like BERT: lowercase, no accents, punctuation on its own', () => {
    expect(basicTokens('Login.spec: Café  failed!')).toEqual([
      'login',
      '.',
      'spec',
      ':',
      'cafe',
      'failed',
      '!',
    ]);
  });

  it('splits words into the longest pieces the vocabulary has', () => {
    const vocab = new Map(['[UNK]', 'token', '##s', '##iz', '##er', 'un'].map((t, i) => [t, i]));
    expect(wordPiece('tokens', vocab, 0)).toEqual([1, 2]);
    expect(wordPiece('tokenizer', vocab, 0)).toEqual([1, 3, 4]);
    expect(wordPiece('xyz', vocab, 0)).toEqual([0]);
  });
});

describe.skipIf(!model)('the embedding model', () => {
  it('puts texts that mean the same close together, even with no shared words', () => {
    const e = model!;
    const leak = e.embed('login.spec: password appears in audit log');
    const tax = e.embed('cart.spec: discount applied before tax');
    const ask = e.embed('Stop leaking user credentials when recording events');
    expect(e.dimension).toBe(256);
    expect(cosine(leak, leak)).toBeCloseTo(1, 5);
    expect(cosine(ask, leak)).toBeGreaterThan(0.35);
    expect(cosine(ask, tax)).toBeLessThan(0.2);
  });
});

describe.skipIf(!db || !model)('the vector index on failures (real FalkorDB)', () => {
  const slug = `test_vectors_${process.pid}`;
  const project = { slug, name: slug, repoPath: '' };
  let graph: Awaited<ReturnType<typeof initProjectGraph>>;

  beforeAll(async () => {
    const repo = mkdtempSync(join(tmpdir(), 'puff-vectors-'));
    cpSync(join(DEMO, 'src'), join(repo, 'src'), { recursive: true });
    cpSync(join(DEMO, 'package.json'), join(repo, 'package.json'));
    project.repoPath = repo;
    graph = await initProjectGraph(db!, project, config);
    await indexRepo(graph, project);
  });

  afterAll(async () => {
    delete process.env.PUFF_EMBED;
    await db!
      .selectGraph(graphName(slug))
      .delete()
      .catch(() => {});
    rmSync(project.repoPath, { recursive: true, force: true });
    await db!.close();
  });

  it('Q32: finds the failure that means the same as a task, where full-text finds nothing', async () => {
    const task = await createTask(graph, slug, config, {
      title: 'Seed failures',
      targets: [LOGIN],
    });
    const s = await startSession(graph, { agent: 'codex', taskId: task.id, role: 'coder' });
    const leak = await recordFailure(graph, {
      sessionId: s,
      message: 'login.spec: password appears in audit log',
      symbolIds: [LOGIN],
    });
    const tax = await recordFailure(graph, {
      sessionId: s,
      message: 'cart.spec: discount applied before tax',
      symbolIds: [CART_TOTAL],
    });

    const ask = 'Stop leaking user credentials when recording events';
    expect(await fullTextFailures(graph, ask)).toEqual([]);
    const hits = (await vectorSimilarFailures(graph, ask))!;
    expect(hits[0]).toMatchObject({ id: leak.id, symbol: LOGIN, via: 'vector' });
    expect(hits[0]!.score).toBeGreaterThan(0.35);
    expect(hits.map((h) => h.id)).not.toContain(tax.id);
    // the vectors are on the nodes, from this model, and none is left to embed
    const [stored] = await read<{ n: number; model: string }>(
      graph,
      `MATCH (f:Failure) WHERE f.embedding IS NOT NULL RETURN count(f) AS n, head(collect(f.embedModel)) AS model`,
    );
    expect(Number(stored!.n)).toBe(2);
    expect(stored!.model).toBe(model!.model);
    expect(await embedFailures(graph, model!)).toBe(0);

    const coupon = await similarFailures(graph, 'Coupon reduces the price too early');
    expect(coupon[0]).toMatchObject({ id: tax.id, via: 'vector' });
  });

  it('Q32 in the context: a task gets the failure that means the same, and says how it was found', async () => {
    const task = await createTask(graph, slug, config, {
      title: 'Stop leaking user credentials when recording events',
      type: 'implement',
      targets: ['src/products/products.ts::listProducts'],
    });
    const s = await startSession(graph, { agent: 'codex', taskId: task.id, role: 'coder' });
    const pack = await compileContext(graph, task.id, { role: 'coder', sessionId: s });
    const item = pack.items.find((i) => i.text === 'login.spec: password appears in audit log');
    expect(item?.reason).toMatch(
      /means the same as this task \(vector search, similarity 0\.\d\d\)/,
    );
  });

  it('with vectors off, similar failures fall back to full-text search', async () => {
    process.env.PUFF_EMBED = 'off';
    expect(await vectorSimilarFailures(graph, 'anything')).toBeUndefined();
    const words = await similarFailures(graph, 'password audit');
    expect(words[0]).toMatchObject({ via: 'fulltext' });
    delete process.env.PUFF_EMBED;
  });
});
