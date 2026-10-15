// Sample memory for the shop-api demo, written through the same functions the orchestrator uses.
// Everything it creates is flagged `seeded: true` so the UI can say it is sample data and not the
// result of real agent runs. It deliberately avoids the planted bug and the benchmark traps that are
// still unfixed, so the benchmark starts from a clean slate.
import type { Graph } from 'falkordb';
import type { AgentName, Role } from '@puff/shared';
import type { PuffConfig } from '../config';
import { compileContext } from '../context/compiler';
import { read, run } from '../db/client';
import {
  recordDecision,
  recordFailure,
  recordHandoff,
  recordProcedure,
  recordSolution,
} from '../memory/memory';
import { finishSession, startSession } from '../memory/sessions';
import { createTask, updateTask } from '../memory/tasks';
import { resolveSymbols } from '../queries/code';

const MEMORY_LABELS = [
  'Task',
  'Session',
  'Failure',
  'Solution',
  'Decision',
  'Procedure',
  'Handoff',
  'ContextPack',
];

export async function isSeeded(graph: Graph): Promise<boolean> {
  const rows = await read<{ n: number }>(
    graph,
    `MATCH (t:Task {seeded: true}) RETURN count(t) AS n`,
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** Development reset: removes tasks, sessions and memory (not the code graph or agent pool). */
export async function clearMemory(graph: Graph): Promise<void> {
  await run(graph, `MATCH (n) WHERE labels(n)[0] IN $labels DETACH DELETE n`, {
    labels: MEMORY_LABELS,
  });
}

export interface SeedResult {
  tasks: number;
  sessions: number;
  failures: number;
  skipped?: string;
}

export async function seedDemoMemory(
  graph: Graph,
  projectId: string,
  config: PuffConfig,
  opts: { force?: boolean } = {},
): Promise<SeedResult> {
  const existing = await read<{ n: number }>(graph, `MATCH (t:Task) RETURN count(t) AS n`);
  if (Number(existing[0]?.n ?? 0) > 0) {
    if (!opts.force)
      return {
        tasks: 0,
        sessions: 0,
        failures: 0,
        skipped: 'tasks already exist (use --force to reset)',
      };
    await clearMemory(graph);
  }

  const base = Date.now() - 55 * 60_000;
  const at = (minute: number) => base + minute * 60_000;
  const seeded = true;
  let sessions = 0;
  let failures = 0;
  const sym = (name: string) => resolveSymbols(graph, [name]).then((r) => r[0]!);

  await recordProcedure(graph, projectId, {
    text: 'Run the tests with `npm test`; all of them must pass before you finish',
    at: at(0),
    seeded,
  });
  await recordProcedure(graph, projectId, {
    text: 'Money is stored as integer cents; never use floating-point prices',
    at: at(0),
    seeded,
  });
  await recordProcedure(graph, projectId, {
    text: 'Throw the HttpError helpers from src/lib/errors.ts instead of setting status codes by hand',
    technology: 'Express',
    at: at(0),
    seeded,
  });

  /** Run one agent session: start, optionally receive context, then finish. */
  const session = async (
    taskId: string,
    agent: AgentName,
    role: Role,
    minute: number,
    finish?: Parameters<typeof finishSession>[2],
  ) => {
    const id = await startSession(graph, { agent, taskId, role, at: at(minute), seeded });
    await compileContext(graph, taskId, { role, sessionId: id, at: at(minute) });
    sessions++;
    if (finish) await finishSession(graph, id, finish);
    return id;
  };

  // 1. The planner splits the goal and hands off the design.
  const plan = await createTask(graph, projectId, config, {
    title: 'Plan: harden login and document the change',
    type: 'plan',
    complexity: 'high',
    targets: ['login'],
    at: at(1),
    seeded,
  });
  const planSession = await session(plan.id, 'claude-code', 'planner', 2, {
    outcome: 'success',
    tokensIn: 6120,
    tokensOut: 1480,
    durationMs: 162_000,
    summary:
      'Split the goal into: audit failed logins, lock accounts after 5 failures, document it.',
  });
  await recordHandoff(graph, {
    fromSessionId: planSession,
    toRole: 'coder',
    at: at(5),
    seeded,
    payload: {
      summary:
        'Audit failed logins first; lockout builds on that. Keep audit entries free of request data.',
    },
  });
  await updateTask(graph, plan.id, {
    status: 'done',
    assignedAgent: 'claude-code',
    role: 'planner',
    tokens: { in: 6120, out: 1480 },
    at: at(5),
  });

  // 2. A first attempt trips the "never log passwords" trap. The failure lands on checkUser.
  const logging = await createTask(graph, projectId, config, {
    title: 'Log failed login attempts',
    targets: ['login', 'checkUser'],
    dependsOn: [plan.id],
    at: at(6),
    seeded,
  });
  const first = await session(logging.id, 'codex', 'coder', 7, {
    outcome: 'failure',
    tokensIn: 7450,
    tokensOut: 1620,
    durationMs: 610_000,
    changedFiles: ['src/auth/login.ts'],
    summary: 'Logged failed attempts through audit(); one test fails.',
  });
  failures++;
  const trap = await recordFailure(graph, {
    sessionId: first,
    message:
      'login > never writes a password to the logs: AssertionError: expected \'[{"level":"info","message":"audit:log…\' not to contain \'wrong-password-123\'',
    symbolIds: [await sym('checkUser')],
    anchoredBy: 'diff',
    at: at(18),
    seeded,
  });

  // 3. The retry is handed the lesson; it passes and the fix is recorded.
  const retry = await session(logging.id, 'codex', 'coder', 20, {
    outcome: 'success',
    tokensIn: 5200,
    tokensOut: 980,
    durationMs: 240_000,
    changedFiles: ['src/auth/login.ts'],
    summary: 'Audit entries now carry the email only.',
  });
  void retry;
  await recordSolution(graph, {
    failureId: trap.id,
    summary: 'Log only the email; never the password or the request body',
    at: at(26),
    seeded,
  });
  await updateTask(graph, logging.id, {
    status: 'done',
    assignedAgent: 'codex',
    role: 'coder',
    tokens: { in: 12650, out: 2600 },
    testSummary: { passed: 6, total: 6 },
    at: at(26),
  });

  // 4. A token decision changes: the old one is superseded, never deleted.
  const start = await sym('Session.start');
  const oldDecision = await recordDecision(graph, {
    symbolIds: [start],
    text: 'Session tokens are stored in localStorage on the client',
    at: at(3),
    seeded,
  });
  await recordDecision(graph, {
    text: 'Session tokens live in an httpOnly cookie and are never exposed to client scripts',
    supersedes: oldDecision.id,
    at: at(27),
    seeded,
  });

  // 5. Docs chore on the cheap agent.
  const docs = await createTask(graph, projectId, config, {
    title: 'Document login behaviour in docs/API.md',
    type: 'chore',
    complexity: 'low',
    targets: ['authRouter'],
    dependsOn: [plan.id],
    at: at(8),
    seeded,
  });
  await session(docs.id, 'opencode', 'chore', 9, {
    outcome: 'success',
    tokensIn: 3210,
    tokensOut: 640,
    durationMs: 205_000,
    changedFiles: [],
    summary: 'Documented the cookie session in docs/API.md.',
  });
  await updateTask(graph, docs.id, {
    status: 'done',
    assignedAgent: 'opencode',
    role: 'chore',
    tokens: { in: 3210, out: 640 },
    at: at(14),
  });

  // 6. A refactor fails on the "tax after discount" trap, escalates, and the stronger agent passes.
  const refactor = await createTask(graph, projectId, config, {
    title: 'Refactor cartTotal to support per-line discounts',
    complexity: 'high',
    targets: ['cartTotal', 'applyDiscount'],
    at: at(10),
    seeded,
  });
  const attempt = await session(refactor.id, 'codex', 'coder', 11, {
    outcome: 'failure',
    tokensIn: 8900,
    tokensOut: 2100,
    durationMs: 420_000,
    changedFiles: ['src/cart/cart.ts'],
    summary: 'Total came out wrong with a discount code applied.',
  });
  failures++;
  const tax = await recordFailure(graph, {
    sessionId: attempt,
    message:
      'cart > applies the discount before tax: AssertionError: expected 4998 to be 5308 // Object.is equality',
    symbolIds: [await sym('cartTotal')],
    anchoredBy: 'stack',
    at: at(24),
    seeded,
  });
  await session(refactor.id, 'claude-code', 'coder', 28, {
    outcome: 'success',
    tokensIn: 11200,
    tokensOut: 3050,
    durationMs: 380_000,
    changedFiles: ['src/cart/cart.ts'],
    summary: 'Discount applied to the subtotal first, then tax on the discounted amount.',
  });
  await recordSolution(graph, {
    failureId: tax.id,
    summary: 'Apply the discount to the subtotal first, then charge tax on the discounted amount',
    at: at(36),
    seeded,
  });
  await recordDecision(graph, {
    symbolIds: [await sym('applyDiscount')],
    text: 'Discounts are applied before tax, rounded to the nearest cent',
    at: at(37),
    seeded,
  });
  await updateTask(graph, refactor.id, {
    status: 'done',
    assignedAgent: 'claude-code',
    role: 'coder',
    tokens: { in: 20100, out: 5150 },
    testSummary: { passed: 25, total: 25 },
    at: at(37),
  });

  // 7. Right now: lockout is running, and it was given everything above.
  const lockout = await createTask(graph, projectId, config, {
    title: 'Lock the account after 5 failed logins',
    complexity: 'high',
    targets: ['login'],
    dependsOn: [logging.id],
    at: at(38),
    seeded,
  });
  await session(lockout.id, 'claude-code', 'coder', 50);
  await updateTask(graph, lockout.id, {
    status: 'running',
    assignedAgent: 'claude-code',
    role: 'coder',
    at: at(50),
  });

  // 8. Waiting in the queue.
  await createTask(graph, projectId, config, {
    title: 'Add GET /cart/summary reusing the cart totals',
    targets: ['cartTotal', 'getCart'],
    dependsOn: [refactor.id],
    at: at(40),
    seeded,
  });

  return { tasks: 6, sessions, failures };
}
