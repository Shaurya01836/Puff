// What the chat's orchestrator agent can do: look at the board, add and change tasks, add goals for the
// planner, and ask for a run. Every tool is a thin wrapper over the same ProjectController the app's
// buttons use. The limits are part of the design:
//   - there is no tool that deletes anything, and none that edits code or files
//   - running the team spends tokens, so the agent can only ASK; a person approves (or the chat was
//     explicitly set to auto-approve)
//   - a cap on tool calls per message, so a confused agent cannot loop
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { shortId, type ProjectController } from '@puff/core';
import { AGENT_NAMES } from '@puff/shared';

/** One thing the orchestrator did, shown to the person as a card in the chat. */
export interface ChatAction {
  tool: string;
  ok: boolean;
  /** One line: "Added task 3QZ9AB: …" */
  text: string;
}

export interface ControlOptions {
  controller: ProjectController;
  /** Counts the tool calls of the message being answered */
  turn: { calls: number; limit: number };
  /** Called after each tool that changes something (and after a failed one) */
  onAction?: (action: ChatAction) => void;
  /** The agent asks to run the team; resolves with what happened, in words the agent can repeat */
  onRunRequest: (reason?: string) => Promise<string>;
}

const TYPES = ['plan', 'implement', 'verify', 'chore'] as const;
const LEVELS = ['low', 'medium', 'high'] as const;
const STATES = [
  'planned',
  'ready',
  'running',
  'verifying',
  'retrying',
  'escalated',
  'failed',
  'done',
] as const;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const problem = (t: string) => ({ isError: true, content: [{ type: 'text' as const, text: t }] });

export function registerControlTools(server: McpServer, opts: ControlOptions): void {
  const { controller, turn } = opts;

  /**
   * Register one tool. `card` says what to show the person after it worked; tools that only look
   * leave it out, so the chat is not full of cards for every glance at the board.
   */
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>) => Promise<{ reply: string; card?: string }>,
  ): void {
    server.registerTool(
      name,
      { description, inputSchema: shape },
      // The SDK's callback type is built from the schema; ours is already checked by `run`'s own type.
      (async (args: z.infer<z.ZodObject<S>>) => {
        if (++turn.calls > turn.limit)
          return problem(
            `You have used all ${turn.limit} tool calls allowed for one message. Stop and tell the person what you did and what is left.`,
          );
        try {
          const { reply, card } = await run(args);
          if (card) opts.onAction?.({ tool: name, ok: true, text: card });
          return text(reply);
        } catch (err) {
          const message = (err as Error).message;
          opts.onAction?.({ tool: name, ok: false, text: `${name}: ${message}` });
          return problem(message);
        }
      }) as never,
    );
  }

  const line = (t: {
    id: string;
    status: string;
    type: string;
    title: string;
    targets: string[];
    preferredAgent?: string;
  }) =>
    `${shortId(t.id)}  ${t.status.padEnd(9)} ${t.type.padEnd(9)} ${t.title}` +
    (t.targets.length ? `  [${t.targets.map((x) => x.split('::').pop()).join(', ')}]` : '') +
    (t.preferredAgent ? `  (agent: ${t.preferredAgent})` : '');

  tool(
    'team_status',
    'How the project stands: tasks by state, whether the team is running, whether agents can run here at all, and which tasks wait on others. Call this first when asked how things are going.',
    {},
    async () => {
      const s = await controller.status();
      const counts = Object.entries(s.counts)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${n} ${k}`)
        .join(', ');
      return {
        reply: [
          `Project ${s.project}: ${s.total} task(s)${counts ? ` (${counts})` : ''}.`,
          s.running ? 'The team is running.' : 'The team is not running.',
          s.runBlocked ? `Agents cannot run here: ${s.runBlocked}` : 'Agents can run here.',
          ...s.waiting.map(
            (w) =>
              `Waiting: ${shortId(w.id)} ${w.title} (overlaps ${w.on.map(shortId).join(', ')})`,
          ),
        ].join('\n'),
      };
    },
  );

  tool(
    'list_tasks',
    'List the tasks on the board, newest last, optionally only those in one state. Ids are shown as short ids; use those in the other tools.',
    { status: z.enum(STATES).optional() },
    async ({ status }) => {
      const tasks = (await controller.tasks()).filter((t) => !status || t.status === status);
      return { reply: tasks.length ? tasks.map(line).join('\n') : 'No tasks.' };
    },
  );

  tool(
    'task_details',
    'Everything about one task: its state, targets, dependencies, and what each agent attempt did and how it ended. `task` is a short id or a word from the title.',
    { task: z.string() },
    async ({ task }) => {
      const { task: t, sessions } = await controller.taskReport(task);
      return {
        reply: [
          line(t),
          `complexity ${t.complexity}; depends on: ${t.dependsOn.map(shortId).join(', ') || 'nothing'}`,
          t.blockedBy?.length ? `waiting for: ${t.blockedBy.map(shortId).join(', ')}` : '',
          ...sessions
            .slice(0, 5)
            .map(
              (s) =>
                `attempt: ${s.agent} as ${s.role}: ${s.outcome}${s.output ? ` - ${s.output.slice(0, 200)}` : ''}`,
            ),
        ]
          .filter(Boolean)
          .join('\n'),
      };
    },
  );

  tool(
    'create_goal',
    'Add a goal in plain words. A planner agent splits it into tasks when the team runs. Use this when the request spans several steps or you are not sure how to divide it. It does not run anything.',
    { goal: z.string().describe('What the person wants, in their words') },
    async ({ goal }) => {
      const t = await controller.createGoal(goal);
      return {
        reply: `Added goal ${shortId(t.id)}. The planner will split it into tasks when the team runs.`,
        card: `Added goal ${shortId(t.id)}: ${goal}`,
      };
    },
  );

  tool(
    'create_task',
    'Add one task. Use find_symbols to get exact function names for `targets` (tasks that touch the same functions never run at the same time). `agent` forces an agent; leave it out to let Puff route by strengths. It does not run anything.',
    {
      title: z.string().describe('What to change and how to tell it worked'),
      type: z
        .enum(TYPES)
        .optional()
        .describe('implement (default), chore (docs, formatting), verify, plan'),
      complexity: z.enum(LEVELS).optional(),
      targets: z.array(z.string()).optional().describe('Function names or path::name ids'),
      agent: z.enum(AGENT_NAMES as unknown as [string, ...string[]]).optional(),
      dependsOn: z
        .array(z.string())
        .optional()
        .describe('Tasks (short ids or title words) that must finish first'),
    },
    async ({ title, type, complexity, targets, agent, dependsOn }) => {
      const deps = dependsOn
        ? await Promise.all(dependsOn.map((d) => controller.find(d)))
        : undefined;
      const t = await controller.createTask({
        title,
        type,
        complexity,
        targets,
        preferredAgent: agent as never,
        dependsOn: deps?.map((d) => d.id),
      });
      return {
        reply: `Created ${shortId(t.id)} (${t.status}): ${t.title}`,
        card: `Added task ${shortId(t.id)}: ${t.title}`,
      };
    },
  );

  tool(
    'edit_task',
    'Change a task that is planned, ready or failed: its title, complexity, agent ("auto" goes back to routing), model, or targets. A task being worked on or finished cannot be edited.',
    {
      task: z.string(),
      title: z.string().optional(),
      complexity: z.enum(LEVELS).optional(),
      agent: z.enum([...AGENT_NAMES, 'auto'] as unknown as [string, ...string[]]).optional(),
      model: z.string().optional(),
      targets: z.array(z.string()).optional(),
    },
    async ({ task, title, complexity, agent, model, targets }) => {
      const t = await controller.editTask(task, {
        title,
        complexity,
        preferredAgent:
          agent === undefined ? undefined : agent === 'auto' ? null : (agent as never),
        model,
        targets,
      });
      return {
        reply: `Updated ${shortId(t.id)}.`,
        card: `Edited task ${shortId(t.id)}: ${t.title}`,
      };
    },
  );

  tool(
    'retry_task',
    'Put a failed task back in the queue. It does not run until the team runs.',
    { task: z.string() },
    async ({ task }) => {
      const t = await controller.retryTask(task);
      return {
        reply: `${shortId(t.id)} is back in the queue as ${t.status}.`,
        card: `Retry queued for ${shortId(t.id)}: ${t.title}`,
      };
    },
  );

  tool(
    'request_run',
    'Ask to run the team on the ready tasks. This spends real agent tokens, so a person must approve it: this only asks. Never say the team started unless the answer says it did.',
    { reason: z.string().optional().describe('One line on what will run and why') },
    async ({ reason }) => ({ reply: await opts.onRunRequest(reason) }),
  );

  tool(
    'stop_team',
    'Stop the team if it is running. Running tasks go back to the queue.',
    {},
    async () => {
      await controller.stop();
      return { reply: 'Stopped the team.', card: 'Stopped the team' };
    },
  );
}
