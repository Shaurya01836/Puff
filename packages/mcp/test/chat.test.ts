// The orchestrator chat, end to end except for the language model: a scripted "agent" connects to the
// real local HTTP endpoint as a real MCP client and uses the real tools, against a real FalkorDB and a
// real git repository. What is tested is everything Puff owns: the tools, the limits, the approval, the
// endpoint's security and the messages the person sees.
import { request } from 'node:http';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  GitRepo,
  ProjectController,
  connect,
  graphName,
  indexRepo,
  initProjectGraph,
  initRepo,
  loadDotEnv,
  parseConfig,
  removeLink,
  type PuffConfig,
} from '@puff/core';
import type { ChatMessage, PuffEvent } from '@puff/shared';
import {
  ChatSession,
  ClaudeCodeBrain,
  claudeArgs,
  describeBrainError,
  hostMcp,
  orchestratorPrompt,
  type BrainInput,
  type BrainReply,
  type ChatBrain,
} from '../src/lib';

const rel = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const DEMO = rel('../../../demo/shop-api');
const config: PuffConfig = parseConfig(readFileSync(rel('../../../puff.config.yaml'), 'utf8'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Call = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<{ text: string; isError: boolean }>;

/** An agent that follows a script: it calls tools exactly as Claude Code would, over HTTP. */
class ScriptedBrain implements ChatBrain {
  readonly name = 'Scripted';
  readonly inputs: BrainInput[] = [];
  constructor(
    private readonly script: (ctx: {
      call: Call;
      client: Client;
      input: BrainInput;
    }) => Promise<BrainReply | string>,
  ) {}
  async available() {
    return { ok: true };
  }
  async send(input: BrainInput): Promise<BrainReply> {
    this.inputs.push(input);
    const client = new Client({ name: 'scripted-agent', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(input.mcp.url), {
        requestInit: { headers: { Authorization: `Bearer ${input.mcp.token}` } },
      }),
    );
    const call: Call = async (name, args = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      return { text: r.content.map((c) => c.text).join('\n'), isError: r.isError === true };
    };
    try {
      const out = await this.script({ call, client, input });
      return typeof out === 'string'
        ? { text: out, sessionId: `sess_${this.inputs.length}`, tokens: { in: 100, out: 10 } }
        : out;
    } finally {
      await client.close();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// No database needed
// ---------------------------------------------------------------------------------------------

describe('Claude Code command line', () => {
  const base: BrainInput = {
    message: 'hi',
    mcp: { url: 'http://127.0.0.1:1/mcp', token: 't' },
    systemPrompt: 'be brief',
    cwd: '.',
    timeoutMs: 1000,
  };

  it('gives the agent only Puff: no built-in tools, no other MCP servers', () => {
    const args = claudeArgs(base, 'cfg.json');
    expect(args.slice(0, 3)).toEqual(['-p', '--output-format', 'json']);
    expect(args).toContain('--strict-mcp-config');
    expect(args.slice(args.indexOf('--mcp-config'), args.indexOf('--mcp-config') + 2)).toEqual([
      '--mcp-config',
      'cfg.json',
    ]);
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual([
      '--tools',
      '',
    ]);
    expect(args.slice(args.indexOf('--allowedTools'), args.indexOf('--allowedTools') + 2)).toEqual([
      '--allowedTools',
      'mcp__puff__*',
    ]);
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--model');
  });

  it('continues the same conversation, and honours a model', () => {
    const args = claudeArgs({ ...base, sessionId: 'abc-123', model: 'sonnet' }, 'cfg.json');
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual([
      '--resume',
      'abc-123',
    ]);
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual([
      '--model',
      'sonnet',
    ]);
  });

  it('says plainly when Claude Code is missing, without throwing', async () => {
    const brain = new ClaudeCodeBrain('puff-no-such-command-xyz');
    expect((await brain.available()).ok).toBe(false);
    const reply = await brain.send({ ...base, cwd: tmpdir() });
    expect(reply.error?.kind).toBe('unavailable');
  });

  it('tells the person how to fix an agent that is not signed in', () => {
    expect(
      describeBrainError('Claude Code', { kind: 'auth', message: 'OAuth session expired' }),
    ).toMatch(/not signed in.*\/login.*Slash commands work/s);
    expect(
      describeBrainError('Claude Code', {
        kind: 'timeout',
        message: 'No answer within 5 seconds.',
      }),
    ).toBe('No answer within 5 seconds.');
  });

  it('tells the orchestrator what it is and what it must not do', () => {
    const p = orchestratorPrompt('shop-api');
    expect(p).toContain('"shop-api"');
    expect(p).toMatch(/do not write or edit code/i);
    expect(p).toMatch(/request_run/);
    expect(p).toMatch(/cannot delete/i);
  });
});

describe('the local HTTP endpoint', () => {
  const rawRequest = (
    url: string,
    opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
  ) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(url);
      const req = request(
        {
          host: u.hostname,
          port: u.port,
          path: opts.path ?? '/mcp',
          method: opts.method ?? 'POST',
          headers: opts.headers,
        },
        (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end(opts.body);
    });

  it('listens on this computer only, and refuses anyone without the token', async () => {
    const host = await hostMcp(() => new McpServer({ name: 'x', version: '0' }));
    try {
      expect(host.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      const json = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      };
      const init = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      });

      // no token, wrong token, same length but wrong
      expect((await rawRequest(host.url, { headers: json, body: init })).status).toBe(401);
      expect(
        (
          await rawRequest(host.url, {
            headers: { ...json, authorization: 'Bearer nope' },
            body: init,
          })
        ).status,
      ).toBe(401);
      const wrong = 'x'.repeat(host.token.length);
      expect(
        (
          await rawRequest(host.url, {
            headers: { ...json, authorization: `Bearer ${wrong}` },
            body: init,
          })
        ).status,
      ).toBe(401);

      const good = { ...json, authorization: `Bearer ${host.token}` };
      expect((await rawRequest(host.url, { headers: good, body: init })).status).toBe(200);
      // only POST, only /mcp, only for its own host name
      expect((await rawRequest(host.url, { method: 'GET', headers: good })).status).toBe(405);
      expect(
        (await rawRequest(host.url, { path: '/other', headers: good, body: init })).status,
      ).toBe(404);
      expect(
        (await rawRequest(host.url, { headers: { ...good, host: 'evil.example.com' }, body: init }))
          .status,
      ).toBe(403);
      expect((await rawRequest(host.url, { headers: good, body: 'not json' })).status).toBe(400);
    } finally {
      await host.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// With FalkorDB and git
// ---------------------------------------------------------------------------------------------

loadDotEnv(rel('../../../.env'));
const db = await connect().catch(() => undefined);

describe.skipIf(!db)('the chat session (real tools, scripted agent)', () => {
  const cleanups: (() => Promise<void>)[] = [];
  let counter = 0;
  afterAll(async () => {
    for (const c of cleanups) await c();
    await db?.close();
  });

  async function fixture(opts: { git?: boolean } = {}) {
    const slug = `test_chat_${process.pid}_${++counter}`;
    const repoPath = mkdtempSync(join(tmpdir(), 'puff-chat-'));
    cpSync(join(DEMO, 'src'), join(repoPath, 'src'), { recursive: true });
    cpSync(join(DEMO, 'package.json'), join(repoPath, 'package.json'));
    if (opts.git !== false) await initRepo(repoPath);
    const project = { slug, name: 'shop', repoPath };
    const graph = await initProjectGraph(db!, project, config);
    await indexRepo(graph, project);
    const events: PuffEvent[] = [];
    const emit = (e: PuffEvent) => events.push(e);
    const controller = await ProjectController.create({
      graph,
      project,
      config,
      emit,
      ...(opts.git === false
        ? {}
        : {
            runDeps: {
              graph,
              project,
              config,
              repo: await GitRepo.open(repoPath, config.worktrees.linkDirs),
              adapters: {},
              emit,
            },
          }),
    });
    const sessions: ChatSession[] = [];
    const chat = (
      brain: ChatBrain,
      extra: Partial<ConstructorParameters<typeof ChatSession>[0]> = {},
    ) => {
      const s = new ChatSession({ controller, brain, emit, ...extra });
      sessions.push(s);
      return s;
    };
    cleanups.push(async () => {
      for (const s of sessions) await s.close();
      await db!
        .selectGraph(graphName(slug))
        .delete()
        .catch(() => {});
      await removeLink(join(repoPath, 'node_modules')).catch(() => {});
      rmSync(repoPath, { recursive: true, force: true });
    });
    const chatMessages = () =>
      events
        .filter((e): e is Extract<PuffEvent, { type: 'chat' }> => e.type === 'chat')
        .map((e) => e.message);
    return { controller, chat, events, chatMessages };
  }

  it('gives the agent the control tools and the read-only memory tools, and nothing that deletes or writes memory', async () => {
    const { chat } = await fixture();
    let names: string[] = [];
    const session = chat(
      new ScriptedBrain(async ({ client }) => {
        names = (await client.listTools()).tools.map((t) => t.name);
        return 'ok';
      }),
    );
    await session.send('what can you do?');
    expect(names).toEqual(
      expect.arrayContaining([
        'team_status',
        'list_tasks',
        'task_details',
        'create_goal',
        'create_task',
        'edit_task',
        'retry_task',
        'request_run',
        'stop_team',
        'find_symbols',
        'get_context',
        'impact_of',
        'why',
      ]),
    );
    for (const forbidden of [
      'record_decision',
      'record_failure',
      'record_solution',
      'confirm_memory',
      'handoff',
    ])
      expect(names).not.toContain(forbidden);
    expect(names.filter((n) => /delete|remove|drop|reset/.test(n))).toEqual([]);
  }, 60_000);

  it('answers a plain sentence by using the tools, and shows what it did as cards before the answer', async () => {
    const { chat, controller, chatMessages } = await fixture();
    const brain = new ScriptedBrain(async ({ call }) => {
      const goal = await call('create_goal', { goal: 'add a health check endpoint' });
      const symbols = await call('find_symbols', { term: 'login' });
      const task = await call('create_task', {
        title: 'Document the health check',
        type: 'chore',
        targets: ['login'],
        agent: 'opencode',
      });
      const list = await call('list_tasks');
      return `Done. ${goal.text} ${task.text} ${symbols.isError ? '' : 'Looked up login.'}\n${list.text}`;
    });
    const session = chat(brain);
    await session.send('plan a health check endpoint and document it');

    const tasks = await controller.tasks();
    expect(tasks.map((t) => t.title)).toEqual([
      'Plan: add a health check endpoint',
      'Document the health check',
    ]);
    expect(tasks[1]).toMatchObject({ type: 'chore', preferredAgent: 'opencode' });
    expect(tasks[1]!.targets).toEqual(['src/auth/login.ts::login']);

    // the conversation reads in order: the person, the two things done, then the answer
    expect(chatMessages().map((m) => `${m.role}:${m.tool ?? ''}`)).toEqual([
      'user:',
      'action:create_goal',
      'action:create_task',
      'assistant:',
    ]);
    const answer = chatMessages().at(-1)!;
    expect(answer.text).toContain('Document the health check');
    expect(answer.tokens).toEqual({ in: 100, out: 10 });
    expect(chatMessages()[1]!.text).toMatch(/^Added goal \w{6}: add a health check endpoint$/);
    // the agent was told who it is and given the project's own name
    expect(brain.inputs[0]!.systemPrompt).toContain('"shop"');
  }, 60_000);

  it('continues the same conversation with the agent, and a reset starts a new one', async () => {
    const { chat } = await fixture();
    const brain = new ScriptedBrain(async () => 'hello');
    const session = chat(brain);
    await session.send('one');
    await session.send('two');
    expect(brain.inputs.map((i) => i.sessionId)).toEqual([undefined, 'sess_1']);
    session.reset();
    expect(session.history).toEqual([]);
    await session.send('three');
    expect(brain.inputs[2]!.sessionId).toBeUndefined();
  }, 60_000);

  it('answers slash commands itself: the agent is never asked', async () => {
    const { chat } = await fixture();
    const brain = new ScriptedBrain(async () => 'should not be used');
    const session = chat(brain);
    await session.send('/status');
    await session.send('/task Write the docs');
    expect(brain.inputs).toEqual([]);
    const history = session.history;
    expect(history.map((m) => m.role)).toEqual(['user', 'system', 'user', 'system']);
    expect(history[1]!.text).toMatch(/^shop: no tasks yet\./);
    expect(history[3]).toMatchObject({ ok: true });
  }, 60_000);

  it('asks before spending tokens: a run waits for the person, and only starts when approved', async () => {
    const { chat, controller, events, chatMessages } = await fixture();
    const brain = new ScriptedBrain(async ({ call }) => {
      const r = await call('request_run', { reason: 'Run the planner on the new goal' });
      expect(r.text).toMatch(/NOT started/);
      const again = await call('request_run');
      expect(again.text).toMatch(/already waiting/);
      return 'I asked you to approve a run.';
    });
    const session = chat(brain);
    await session.send('run it');

    const approval = chatMessages().find((m) => m.role === 'approval')!;
    expect(approval.approval).toMatchObject({
      state: 'pending',
      summary: 'Run the planner on the new goal',
    });
    expect(controller.running).toBe(false);
    expect(events.some((e) => e.type === 'run')).toBe(false);

    await session.approve(approval.approval!.id, true);
    expect(events.find((e) => e.type === 'run')).toMatchObject({ running: true });
    const latest = chatMessages()
      .filter((m) => m.id === approval.id)
      .at(-1)!;
    expect(latest.approval?.state).toBe('approved');
    await expect(session.approve(approval.approval!.id, true)).rejects.toThrow(/no longer waiting/);
    for (let i = 0; i < 50 && controller.running; i++) await sleep(50);
  }, 60_000);

  it('does nothing when the person declines, and starts straight away only if told to auto-approve', async () => {
    const { chat, controller, events, chatMessages } = await fixture();
    const ask = new ScriptedBrain(async ({ call }) => (await call('request_run')).text);
    const declined = chat(ask);
    await declined.send('run');
    const approval = chatMessages().find((m) => m.role === 'approval')!;
    await declined.approve(approval.approval!.id, false);
    expect(
      chatMessages()
        .filter((m) => m.id === approval.id)
        .at(-1)!.approval?.state,
    ).toBe('declined');
    expect(controller.running).toBe(false);
    expect(events.some((e) => e.type === 'run')).toBe(false);

    const auto = chat(new ScriptedBrain(async ({ call }) => (await call('request_run')).text), {
      autoApprove: true,
    });
    await auto.send('run');
    expect(events.find((e) => e.type === 'run')).toMatchObject({ running: true });
    expect((await auto.info()).autoApprove).toBe(true);
    for (let i = 0; i < 50 && controller.running; i++) await sleep(50);
  }, 60_000);

  it('says why a run cannot start instead of asking for approval it cannot use', async () => {
    const { chat, chatMessages } = await fixture({ git: false });
    let said = '';
    const session = chat(
      new ScriptedBrain(async ({ call }) => {
        said = (await call('request_run')).text;
        return 'ok';
      }),
    );
    await session.send('run');
    expect(said).toMatch(/cannot run here: .*not a git repository/i);
    expect(chatMessages().some((m) => m.role === 'approval')).toBe(false);
  }, 60_000);

  it('stops an agent that makes too many tool calls for one message, and counts again next message', async () => {
    const { chat } = await fixture();
    const results: boolean[] = [];
    const session = chat(
      new ScriptedBrain(async ({ call }) => {
        for (let i = 0; i < 5; i++) results.push((await call('list_tasks')).isError);
        return 'done';
      }),
      { toolCallLimit: 3 },
    );
    await session.send('look around');
    expect(results).toEqual([false, false, false, true, true]);
    results.length = 0;
    await session.send('again');
    expect(results).toEqual([false, false, false, true, true]); // a new message gets a new allowance
  }, 60_000);

  it('turns a tool failure into a card and a readable error for the agent', async () => {
    const { chat, chatMessages } = await fixture();
    let reply = { text: '', isError: false };
    const session = chat(
      new ScriptedBrain(async ({ call }) => {
        reply = await call('create_task', { title: 'Broken', targets: ['noSuchFunction'] });
        await call('retry_task', { task: 'zzzzzz' });
        return 'could not';
      }),
    );
    await session.send('add a task for noSuchFunction');
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/No symbol named/);
    const cards = chatMessages().filter((m) => m.role === 'action');
    expect(cards.map((c) => c.ok)).toEqual([false, false]);
    expect(cards[0]!.text).toMatch(/^create_task: No symbol named/);
  }, 60_000);

  it('explains an agent that is not signed in, and keeps slash commands working', async () => {
    const { chat } = await fixture();
    const session = chat(
      new ScriptedBrain(async () => ({
        text: '',
        error: { kind: 'auth', message: 'OAuth session expired' },
      })),
    );
    await session.send('hello');
    const last = session.history.at(-1) as ChatMessage;
    expect(last).toMatchObject({ role: 'system', ok: false });
    expect(last.text).toMatch(/not signed in.*\/login/s);
    await session.send('/status');
    expect(session.history.at(-1)!.ok).toBe(true);
  }, 60_000);

  it('refuses a second message while one is being answered', async () => {
    const { chat } = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const session = chat(new ScriptedBrain(async () => (await gate, 'late')));
    const first = session.send('slow one');
    await sleep(100);
    await expect(session.send('impatient')).rejects.toThrow(/Still working/);
    release();
    await first;
    expect(session.history.at(-1)!.text).toBe('late');
  }, 60_000);

  it('reports whether the agent can be asked', async () => {
    const { chat } = await fixture();
    const session = chat(new ScriptedBrain(async () => 'x'));
    expect(await session.info()).toEqual({
      brain: 'Scripted',
      ready: true,
      note: undefined,
      autoApprove: false,
    });
    const missing = chat(new ClaudeCodeBrain('puff-no-such-command-xyz'));
    expect(await missing.info()).toMatchObject({ brain: 'Claude Code', ready: false });
    expect(existsSync(DEMO)).toBe(true);
  }, 60_000);
});
