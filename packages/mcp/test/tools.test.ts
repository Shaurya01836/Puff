// The MCP tools driven by a real MCP client over an in-memory transport, against a real FalkorDB:
// what an agent writes through a tool is what the next agent's context contains.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  connect,
  createTask,
  graphName,
  indexRepo,
  initProjectGraph,
  loadDotEnv,
  parseConfig,
  read,
  run,
  startSession,
} from '@puff/core';
import { createPuffServer } from '../src/tools';

const rel = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const DEMO = rel('../../../demo/shop-api');
const config = parseConfig(readFileSync(rel('../../../puff.config.yaml'), 'utf8'));

loadDotEnv(rel('../../../.env'));
const db = await connect().catch(() => undefined);

describe.skipIf(!db)('Puff MCP tools', () => {
  const slug = `test_mcp_${process.pid}`;
  let client: Client;
  let graph: Awaited<ReturnType<typeof initProjectGraph>>;
  let sessionId: string;
  let taskId: string;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    return { error: res.isError === true, text: res.content.map((c) => c.text).join('\n') };
  };

  beforeAll(async () => {
    graph = await initProjectGraph(db!, { slug, name: slug, repoPath: DEMO }, config);
    await indexRepo(graph, { slug, repoPath: DEMO });
    const task = await createTask(graph, slug, config, {
      title: 'Harden login',
      type: 'implement',
      complexity: 'low',
      targets: ['src/auth/login.ts::login'],
    });
    taskId = task.id;
    sessionId = await startSession(graph, { agent: 'opencode', taskId, role: 'coder' });

    const server = createPuffServer({ graph, config, sessionId });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await db!
      .selectGraph(graphName(slug))
      .delete()
      .catch(() => {});
    await db!.close();
  });

  it('offers the tools an agent needs', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'confirm_memory',
      'find_symbols',
      'get_context',
      'handoff',
      'hotspots',
      'impact_of',
      'project_status',
      'record_decision',
      'record_failure',
      'record_solution',
      'similar_failures',
      'why',
    ]);
  });

  it('looks up code and what may break', async () => {
    expect((await call('find_symbols', { term: 'login' })).text).toContain(
      'src/auth/login.ts::login',
    );
    const impact = await call('impact_of', { symbol: 'login' });
    expect(impact.text).toContain('src/routes/auth.ts');
  });

  it('writes a failure and a decision that the next context contains', async () => {
    const failure = await call('record_failure', {
      symbol: 'login',
      message: 'Password was written to the audit log in plain text',
      kind: 'review',
    });
    expect(failure.error).toBe(false);
    const failureId = /failure (\S+)\./.exec(failure.text)![1]!;

    const decision = await call('record_decision', {
      symbols: ['login'],
      text: 'Never log credentials; log the user id only',
    });
    expect(decision.error).toBe(false);
    const decisionId = /decision (\S+)\./.exec(decision.text)![1]!;

    const ctx = await call('get_context', { taskId, role: 'coder' });
    expect(ctx.text).toContain('Password was written to the audit log');
    expect(ctx.text).toContain('Never log credentials');

    // superseding keeps the old decision but stops handing it out
    const next = await call('record_decision', {
      symbols: ['login'],
      text: 'Log the user id and a request id, never credentials',
      supersedes: decisionId,
    });
    expect(next.text).toContain(`supersedes ${decisionId}`);
    const rows = await read<{ status: string }>(
      graph,
      `MATCH (d:Decision {id: $id}) RETURN d.status AS status`,
      { id: decisionId },
    );
    expect(rows[0]!.status).toBe('superseded');
    expect((await call('get_context', { taskId })).text).not.toContain('Never log credentials;');

    expect((await call('record_solution', { failureId, summary: 'Log the id only' })).error).toBe(
      false,
    );
  });

  it('clears the outdated flag when memory is confirmed', async () => {
    const f = await call('record_failure', {
      symbol: 'checkUser',
      message: 'Unknown email leaked in the error message',
    });
    const id = /failure (\S+)\./.exec(f.text)![1]!;
    await run(graph, `MATCH (f:Failure {id: $id}) SET f.stale = true`, { id });
    expect((await call('confirm_memory', { id })).error).toBe(false);
    const rows = await read<{ stale: boolean }>(
      graph,
      `MATCH (f:Failure {id: $id}) RETURN f.stale AS stale`,
      { id },
    );
    expect(rows[0]!.stale).toBe(false);
  });

  it('records a handoff from the running session and explains a task', async () => {
    expect((await call('handoff', { summary: 'Login is hardened; docs still to do' })).error).toBe(
      false,
    );
    expect((await call('why', { taskId })).text.length).toBeGreaterThan(0);
  });

  it('reports mistakes as tool errors instead of crashing', async () => {
    const unknown = await call('record_failure', { symbol: 'noSuchFunction', message: 'x' });
    expect(unknown.error).toBe(true);
    expect(unknown.text).toMatch(/No symbol named/);
    expect((await call('confirm_memory', { id: 'nope' })).error).toBe(true);
  });
});
