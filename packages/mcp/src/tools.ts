// The tools Puff offers over MCP. Every one is a thin wrapper over @puff/core, so an agent that calls
// a tool and the Puff run loop write the same facts to the same graph. Kept apart from the stdio
// entry point so tests can drive the server in memory.
import type { Graph } from 'falkordb';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  compileContext,
  confirmMemory,
  findSymbols,
  getWhy,
  graphStats,
  hotspots,
  impactOf,
  recordDecision,
  recordFailure,
  recordHandoff,
  recordSolution,
  resolveSymbols,
  similarFailures,
  type PuffConfig,
} from '@puff/core';

export interface PuffServerOptions {
  graph: Graph;
  config: PuffConfig;
  /** The session this agent is running in; Puff sets PUFF_SESSION when it launches one */
  sessionId?: string;
}

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: (err as Error).message }],
});

/** Wrap a handler so a thrown error reaches the agent as a readable tool error, not a crash. */
const safely =
  <A>(fn: (args: A) => Promise<ReturnType<typeof ok>>) =>
  async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return fail(err);
    }
  };

export function createPuffServer({ graph, config, sessionId }: PuffServerOptions): McpServer {
  const server = new McpServer({ name: 'puff', version: '0.2.0' });
  const session = (given?: string) => {
    const id = given ?? sessionId;
    if (!id) throw new Error('This needs a session id: pass sessionId, or run inside a Puff task.');
    return id;
  };
  /** Accept "login", "src/auth/login.ts::login" or a list; fail clearly when nothing matches. */
  const symbols = async (refs: string[]) => {
    const ids = await resolveSymbols(graph, refs);
    if (ids.length === 0)
      throw new Error(
        `No symbol matches ${refs.join(', ')}. Use find_symbols to look up the exact name.`,
      );
    return ids;
  };

  server.registerTool(
    'project_status',
    {
      title: 'Project memory status',
      description:
        'Counts of code and memory nodes (files, symbols, tasks, failures, decisions…) in the shared Puff graph.',
    },
    safely(async () => ok(JSON.stringify(await graphStats(graph), null, 2))),
  );

  server.registerTool(
    'find_symbols',
    {
      title: 'Find functions and classes',
      description: 'Look up symbols by name. Use it to get exact ids for the other tools.',
      inputSchema: { term: z.string().min(1) },
    },
    safely(async ({ term }: { term: string }) => {
      const rows = await findSymbols(graph, term);
      return ok(
        rows.length
          ? rows.map((r) => `${r.id}  ${r.kind} ${r.signature}`).join('\n')
          : `No symbol matches "${term}".`,
      );
    }),
  );

  server.registerTool(
    'get_context',
    {
      title: 'Context for a task',
      description:
        'What Puff would hand a fresh agent for this task: relevant failures and their fixes, decisions, procedures and handoffs, each with the reason it is included. Nothing is recorded.',
      inputSchema: {
        taskId: z.string(),
        role: z.enum(['planner', 'coder', 'verifier', 'chore']).default('coder'),
      },
    },
    safely(
      async ({
        taskId,
        role,
      }: {
        taskId: string;
        role: 'planner' | 'coder' | 'verifier' | 'chore';
      }) => {
        const pack = await compileContext(graph, taskId, {
          role,
          preview: true,
          budgetTokens: config.limits.contextTokenBudget,
        });
        return ok(pack.prompt);
      },
    ),
  );

  server.registerTool(
    'impact_of',
    {
      title: 'What may break',
      description: 'Files whose code calls this function, up to 3 hops away.',
      inputSchema: { symbol: z.string() },
    },
    safely(async ({ symbol }: { symbol: string }) => {
      const [id] = await symbols([symbol]);
      const rows = await impactOf(graph, id!);
      return ok(
        rows.length
          ? `Callers of ${id}:\n` + rows.map((r) => `${r.file}: ${r.callers.join(', ')}`).join('\n')
          : `Nothing calls ${id}.`,
      );
    }),
  );

  server.registerTool(
    'record_decision',
    {
      title: 'Record a decision',
      description:
        'Remember why something was done a certain way, tied to the functions it is about. Pass supersedes (a decision id) to replace an earlier decision; the old one is kept but marked superseded.',
      inputSchema: {
        symbols: z.array(z.string()).min(1),
        text: z.string().min(1),
        supersedes: z.string().optional(),
      },
    },
    safely(
      async ({
        symbols: refs,
        text,
        supersedes,
      }: {
        symbols: string[];
        text: string;
        supersedes?: string;
      }) => {
        const { id } = await recordDecision(graph, {
          symbolIds: await symbols(refs),
          text,
          supersedes,
        });
        return ok(`Recorded decision ${id}${supersedes ? ` (supersedes ${supersedes})` : ''}.`);
      },
    ),
  );

  server.registerTool(
    'record_failure',
    {
      title: 'Record a failure',
      description:
        'Remember something that went wrong, tied to the function it happened in, so the next agent does not repeat it.',
      inputSchema: {
        symbol: z.string(),
        message: z.string().min(1),
        kind: z.enum(['test', 'type', 'lint', 'runtime', 'review']).default('runtime'),
        sessionId: z.string().optional(),
      },
    },
    safely(
      async ({
        symbol,
        message,
        kind,
        sessionId: given,
      }: {
        symbol: string;
        message: string;
        kind: 'test' | 'type' | 'lint' | 'runtime' | 'review';
        sessionId?: string;
      }) => {
        const r = await recordFailure(graph, {
          sessionId: session(given),
          message,
          kind,
          symbolIds: await symbols([symbol]),
          anchoredBy: 'manual',
        });
        return ok(`${r.repeated ? 'Seen before: ' : 'Recorded '}failure ${r.id}.`);
      },
    ),
  );

  server.registerTool(
    'record_solution',
    {
      title: 'Record a fix',
      description: 'Say what fixed a recorded failure. Clears its "possibly outdated" flag.',
      inputSchema: { failureId: z.string(), summary: z.string().min(1) },
    },
    safely(async ({ failureId, summary }: { failureId: string; summary: string }) =>
      ok(`Recorded solution ${await recordSolution(graph, { failureId, summary })}.`),
    ),
  );

  server.registerTool(
    'confirm_memory',
    {
      title: 'Confirm memory still holds',
      description:
        'A failure or decision marked "possibly outdated" because its code changed: after checking it still applies, clear the flag.',
      inputSchema: { id: z.string() },
    },
    safely(async ({ id }: { id: string }) => {
      await confirmMemory(graph, id);
      return ok(`${id} confirmed.`);
    }),
  );

  server.registerTool(
    'handoff',
    {
      title: 'Leave a note for the next agent',
      description:
        'Pass state to whoever works next on this task or on a task that depends on it: what is done, what is left, what to watch for.',
      inputSchema: {
        summary: z.string().min(1),
        toRole: z.enum(['planner', 'coder', 'verifier', 'chore']).optional(),
        sessionId: z.string().optional(),
      },
    },
    safely(
      async ({
        summary,
        toRole,
        sessionId: given,
      }: {
        summary: string;
        toRole?: string;
        sessionId?: string;
      }) => {
        const id = await recordHandoff(graph, {
          fromSessionId: session(given),
          payload: { summary },
          toRole,
        });
        return ok(`Handoff ${id} recorded.`);
      },
    ),
  );

  server.registerTool(
    'why',
    {
      title: 'Why this task went to this agent',
      description:
        'The path from the task to the agent that got it and to every memory item that was put in its context.',
      inputSchema: { taskId: z.string() },
    },
    safely(async ({ taskId }: { taskId: string }) => ok((await getWhy(graph, taskId)).summary)),
  );

  server.registerTool(
    'similar_failures',
    {
      title: 'Past failures worded like this',
      description:
        'Past failures in this project whose message is worded like the text (a task, an error), wherever they happened, with the function each one is anchored to.',
      inputSchema: { text: z.string() },
    },
    safely(async ({ text }: { text: string }) => {
      const rows = await similarFailures(graph, text);
      return ok(
        rows.length
          ? rows
              .map((r) => `${r.symbol}${r.stale ? ' (possibly outdated)' : ''}: ${r.message}`)
              .join('\n')
          : 'No past failure is worded like that.',
      );
    }),
  );

  server.registerTool(
    'hotspots',
    {
      title: 'Most load-bearing code',
      description:
        'The functions other code depends on most (PageRank over calls), with the failures and decisions recorded on each. Check these before changing core code.',
      inputSchema: { limit: z.number().int().min(1).max(50).default(10) },
    },
    safely(async ({ limit }: { limit: number }) => {
      const rows = await hotspots(graph, limit);
      return ok(
        rows.length
          ? rows
              .map(
                (r) =>
                  `${r.id}  (${r.failures} failure(s), ${r.staleFailures} possibly outdated, ${r.decisions} decision(s))`,
              )
              .join('\n')
          : 'No calls indexed yet.',
      );
    }),
  );

  return server;
}
