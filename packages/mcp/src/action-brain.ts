// A conversation partner for agents that cannot be handed Puff's tools the way Claude Code can (Codex and
// OpenCode, so a teammate who has only those two still has a working Ask Puff).
//
// The agent answers in plain text and, when it wants to look something up or do something, ends its answer
// with ONE block of requested calls:
//     <puff-calls>[{"tool":"list_tasks","args":{}}]</puff-calls>
// Puff runs those calls through its own tool server, the very same one Claude Code talks to, so every limit
// holds (no deleting, running only asks, at most N calls per message) and every call shows up as a card in
// the chat. The results go back to the agent, which then answers. The agent itself runs read-only: it has no
// way to touch files or run commands while it is being the orchestrator.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { BrainInput, BrainReply, ChatBrain } from './chat';

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/** What one run of the agent gives back (its answer as plain text) */
export interface RunResult {
  text: string;
  tokens?: { in: number; out: number };
  error?: { kind: string; message: string };
}

/** Runs the agent once, read-only, with this prompt. */
export type AgentRun = (
  prompt: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; model?: string },
) => Promise<RunResult>;

const MAX_CALLS_PER_ROUND = 5;
const MAX_ROUNDS = 3;
const HISTORY_TURNS = 6;

/** An answer without the machine-readable report block and the reasoning tags some models print. */
function clean(text: string): string {
  return text
    .replace(/<puff-report>[\s\S]*?(?:<\/puff-report>|$)/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, '')
    .replace(/<\/?(?:function|parameter|tool_call)[^>]*>/gi, '')
    .trim();
}

/**
 * Pull the requested calls out of an answer. Anything unusable is reported back as a problem (the agent is
 * told in the next round), never run and never thrown.
 */
export function parseCalls(
  text: string,
  known: ReadonlySet<string>,
): { visible: string; calls: ToolCall[]; problems: string[] } {
  // Some models mangle the tag into their own tool-call syntax; the JSON list inside is still usable
  const block =
    /<puff-calls>([\s\S]*?)(?:<\/puff-calls>|$)/i.exec(text) ??
    /<tool_call>[^[{]*([[{][\s\S]*[\]}])[^\]}]*?(?:<\/tool_call>|$)/i.exec(text);
  if (!block) return { visible: clean(text), calls: [], problems: [] };
  const visible = clean(text.replace(block[0], ''));
  const problems: string[] = [];
  const json = block[1]!
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      visible,
      calls: [],
      problems: [`The <puff-calls> block is not valid JSON (${(err as Error).message}).`],
    };
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const calls: ToolCall[] = [];
  for (const item of list) {
    const c = item as { tool?: unknown; args?: unknown };
    if (typeof c?.tool !== 'string' || !known.has(c.tool)) {
      problems.push(`"${String(c?.tool)}" is not one of the tools.`);
      continue;
    }
    const args =
      c.args && typeof c.args === 'object' && !Array.isArray(c.args)
        ? (c.args as Record<string, unknown>)
        : {};
    calls.push({ tool: c.tool, args });
  }
  if (calls.length > MAX_CALLS_PER_ROUND) {
    problems.push(`At most ${MAX_CALLS_PER_ROUND} calls at a time; the rest were not run.`);
    calls.length = MAX_CALLS_PER_ROUND;
  }
  return { visible, calls, problems };
}

const PROTOCOL = [
  'HOW YOU USE THE TOOLS',
  'You cannot call tools directly. To look something up or to do something, END your answer with ONE block of calls, with valid JSON and double quotes:',
  '<puff-calls>[{"tool":"list_tasks","args":{}}]</puff-calls>',
  'Puff runs the calls and sends you the results, and then you answer the person. If you add no block, your text goes straight to the person. Never invent a result: only say what the results say. Do not put more than a few calls in a block.',
  'Adding goals and tasks needs no permission: when the person asks for one and it is clear, make the call now instead of announcing it. Only running the team asks the person first, and Puff does that itself.',
  'When the request is vague (no clear outcome, no idea which code, or very large), do NOT create anything yet: ask the person one to three short, specific questions in plain text, with options where you can. Make no calls until they answer.',
].join('\n');

/** The tool list, short enough to read: name(arguments): what it does. */
function describeTools(
  tools: { name: string; description?: string; inputSchema?: unknown }[],
): string {
  return tools
    .map((t) => {
      const schema = (t.inputSchema ?? {}) as {
        properties?: Record<string, { type?: string }>;
        required?: string[];
      };
      const args = Object.entries(schema.properties ?? {})
        .map(([k, v]) => `${k}${schema.required?.includes(k) ? '' : '?'}: ${v.type ?? 'any'}`)
        .join(', ');
      return `- ${t.name}(${args}): ${(t.description ?? '').split('\n')[0]!.slice(0, 170)}`;
    })
    .join('\n');
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export class ActionBrain implements ChatBrain {
  /** What each conversation has said so far (the agent has no memory of its own between runs) */
  private readonly histories = new Map<string, { user: string; assistant: string }[]>();
  private counter = 0;

  constructor(
    readonly name: string,
    private readonly run: AgentRun,
    private readonly check: () => Promise<{ ok: boolean; note?: string }>,
  ) {}

  available() {
    return this.check();
  }

  async send(input: BrainInput): Promise<BrainReply> {
    // The conversation id is ours: no id means a new conversation (the person pressed "new conversation")
    const key =
      input.sessionId && this.histories.has(input.sessionId)
        ? input.sessionId
        : `ab_${++this.counter}`;
    const history = this.histories.get(key) ?? [];
    this.histories.set(key, history);

    const client = new Client({ name: 'puff-action-brain', version: '0.0.0' });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(input.mcp.url), {
          requestInit: { headers: { Authorization: `Bearer ${input.mcp.token}` } },
        }),
      );
      const tools = (await client.listTools()).tools;
      const known = new Set(tools.map((t) => t.name));
      const callTool = async (c: ToolCall): Promise<string> => {
        try {
          const r = (await client.callTool({ name: c.tool, arguments: c.args })) as {
            isError?: boolean;
            content?: { text?: string }[];
          };
          const text = (r.content ?? [])
            .map((p) => p.text ?? '')
            .join('\n')
            .trim();
          return r.isError ? `ERROR: ${text}` : text;
        } catch (err) {
          return `ERROR: ${(err as Error).message}`;
        }
      };

      // What is on the board right now, so the first answer needs no round trip
      const state = [
        known.has('team_status') ? await callTool({ tool: 'team_status', args: {} }) : '',
        known.has('list_tasks') ? await callTool({ tool: 'list_tasks', args: {} }) : '',
      ]
        .filter(Boolean)
        .join('\n');

      const tokens = { in: 0, out: 0 };
      let results = '';
      let final = '';
      for (let round = 1; round <= MAX_ROUNDS; round++) {
        const prompt = [
          input.systemPrompt,
          '',
          PROTOCOL,
          '',
          'TOOLS',
          describeTools(tools),
          '',
          'THE BOARD RIGHT NOW',
          state || '(nothing yet)',
          '',
          history.length ? 'THE CONVERSATION SO FAR' : '',
          ...history
            .slice(-HISTORY_TURNS)
            .flatMap((t) => [`PERSON: ${clip(t.user, 1200)}`, `YOU: ${clip(t.assistant, 1200)}`]),
          '',
          `PERSON: ${input.message}`,
          results
            ? `\nRESULTS OF YOUR CALLS (these are real; answer the person using them, briefly):\n${results}`
            : '',
          '',
          'YOU:',
        ]
          .filter((line, i, all) => !(line === '' && all[i - 1] === ''))
          .join('\n');

        const reply = await this.run(prompt, {
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
          signal: input.signal,
          model: input.model,
        });
        tokens.in += reply.tokens?.in ?? 0;
        tokens.out += reply.tokens?.out ?? 0;
        if (reply.error) return { text: '', sessionId: key, tokens, error: reply.error };

        const { visible, calls, problems } = parseCalls(reply.text, known);
        final = visible;
        if (calls.length === 0 && problems.length === 0) break;
        if (round === MAX_ROUNDS) {
          final = `${visible}${visible ? '\n\n' : ''}(I stopped looking things up after ${MAX_ROUNDS} rounds.)`;
          break;
        }
        const lines: string[] = [...problems];
        for (const c of calls) {
          lines.push(
            `${c.tool}(${clip(JSON.stringify(c.args), 200)}) -> ${clip(await callTool(c), 1500)}`,
          );
        }
        results = `${results ? `${results}\n` : ''}${lines.join('\n')}`;
      }

      final = final.trim() || '(No answer.)';
      history.push({ user: input.message, assistant: final });
      return { text: final, sessionId: key, tokens };
    } catch (err) {
      return {
        text: '',
        sessionId: key,
        error: { kind: 'crash', message: (err as Error).message },
      };
    } finally {
      await client.close().catch(() => {});
    }
  }
}
