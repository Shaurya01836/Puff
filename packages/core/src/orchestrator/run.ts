// Run one task end to end: context → agent in its own worktree → verify with the project's tests →
// on success merge and re-index, on failure record the lesson, then retry or escalate.
//
// What Puff records is what Puff observed (exit codes, test output, diffs, tokens), never what an
// agent claims. Harness problems (not signed in, timeout) are recorded as `error` sessions and do
// not create failure memory, because they say nothing about the code.
import type { Graph } from 'falkordb';
import type { AgentName, PuffEvent, Task } from '@puff/shared';
import { ROLE_FOR_TYPE, type Adapters } from '../agents/adapters';
import { WRITES_FILES, type HarnessResult } from '../agents/types';
import type { PuffConfig } from '../config';
import { compileContext } from '../context/compiler';
import { GitRepo, type Worktree } from '../git/repo';
import { indexRepo } from '../indexer/index';
import { recordTestFailures } from '../memory/failures';
import { getMemoryFeed } from '../queries/explain';
import { recordSolution } from '../memory/memory';
import { applyReport } from '../memory/report';
import { finishSession, listSessions, startSession } from '../memory/sessions';
import { getTask, updateTask } from '../memory/tasks';
import { candidateAgents } from './routing';
import type { SlotPool } from './schedule';
import { runVerification } from './verify';

export interface RunDeps {
  graph: Graph;
  project: { slug: string; repoPath: string };
  config: PuffConfig;
  repo: GitRepo;
  adapters: Adapters;
  emit?: (e: PuffEvent) => void;
  log?: (line: string) => void;
  signal?: AbortSignal;
  /** Limits how many runs each agent has at once; without it there is no limit */
  slots?: SlotPool;
  /** Agents that proved unusable during this run (not signed in, not installed), with the reason */
  unavailable?: Map<AgentName, string>;
}

export interface AttemptSummary {
  n: number;
  agent: AgentName;
  sessionId: string;
  outcome: 'success' | 'failure' | 'error';
  detail: string;
  /** Failures recorded in memory by this attempt */
  failures: number;
}

export interface TaskRunResult {
  taskId: string;
  status: 'done' | 'failed' | 'aborted';
  attempts: AttemptSummary[];
  reason?: string;
}

export interface TaskRunOptions {
  /** Force this agent first instead of routing */
  agent?: AgentName;
}

/** Agent text without the machine-readable block, shortened for the session summary. */
export function summarize(output: string, max = 600): string {
  const text = output
    .replace(/<puff-report>[\s\S]*?<\/puff-report>/g, '')
    // some models print their reasoning in <think> tags, sometimes unbalanced
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const seenMemory = new WeakMap<object, Set<string>>();

/**
 * Push memory events the UI has not seen yet. With `prime`, everything that exists now is marked as
 * seen without being emitted, so only what happens from here on reaches the UI.
 */
export async function flushMemoryEvents(
  deps: Pick<RunDeps, 'graph' | 'emit'>,
  prime = false,
): Promise<void> {
  const seen = seenMemory.get(deps.graph) ?? new Set<string>();
  seenMemory.set(deps.graph, seen);
  for (const event of (await getMemoryFeed(deps.graph, 15)).reverse()) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (!prime) deps.emit?.({ type: 'memory', event });
  }
}

/** Make sure existing memory is not replayed as "new" the first time a run flushes events. */
async function primeMemoryEvents(deps: Pick<RunDeps, 'graph' | 'emit'>): Promise<void> {
  if (!seenMemory.has(deps.graph)) await flushMemoryEvents(deps, true);
}

async function emitTask(deps: RunDeps, task: Task): Promise<Task> {
  deps.emit?.({ type: 'task:update', task });
  return task;
}

async function emitSession(deps: RunDeps, taskId: string, sessionId: string): Promise<void> {
  const session = (await listSessions(deps.graph, taskId)).find((s) => s.id === sessionId);
  if (session) deps.emit?.({ type: 'session:update', session });
}

/**
 * Which agents to try, in order: the person's choice (or the best routed agent), then up the
 * escalation chain, then any other agent that is installed, so one agent that is not signed in does
 * not leave a task stuck.
 */
async function plan(deps: RunDeps, task: Task, forced?: AgentName): Promise<AgentName[]> {
  const usable = (a: AgentName) => deps.adapters[a] !== undefined && !deps.unavailable?.has(a);
  const candidates = await candidateAgents(deps.graph, deps.config, task.id);
  const first = forced ?? task.preferredAgent ?? candidates.find(usable);
  if (!first) return [];
  const chain = deps.config.escalation as AgentName[];
  const after = chain.includes(first)
    ? chain.slice(chain.indexOf(first) + 1)
    : [...chain].reverse();
  return [...new Set([first, ...after, ...candidates])].filter((a) => a === first || usable(a));
}

export async function runTask(
  deps: RunDeps,
  taskId: string,
  opts: TaskRunOptions = {},
): Promise<TaskRunResult> {
  const { graph, config } = deps;
  const log = deps.log ?? (() => {});
  const task0 = await getTask(graph, taskId);
  if (!task0) throw new Error(`Unknown task ${taskId}`);
  await primeMemoryEvents(deps);
  const role = ROLE_FOR_TYPE[task0.type];
  const { limits } = config;
  const retriesPerAgent = limits.retriesBeforeEscalate;

  const agents = await plan(deps, task0, opts.agent);
  if (agents.length === 0) {
    const reason = 'No agent is available for this task (none installed or signed in)';
    await emitTask(deps, await updateTask(graph, taskId, { status: 'failed' }));
    return { taskId, status: 'failed', attempts: [], reason };
  }

  const attempts: AttemptSummary[] = [];
  let tokens = { in: 0, out: 0 };
  let agentIdx = 0;
  let failuresOnAgent = 0;
  /** Failures recorded by earlier attempts of this task: whatever finally passes is their fix */
  const learned = new Set<string>();

  while (attempts.length < limits.maxAttempts && agentIdx < agents.length) {
    const agent = agents[agentIdx]!;
    if (deps.unavailable?.has(agent)) {
      agentIdx++;
      failuresOnAgent = 0;
      continue;
    }
    const n = attempts.length + 1;
    log(`attempt ${n}: ${agent} as ${role}`);
    const attempt = await runAttempt(deps, task0, agent, role, n);
    attempts.push(attempt.summary);
    tokens = { in: tokens.in + attempt.tokens.in, out: tokens.out + attempt.tokens.out };
    for (const id of attempt.failureIds ?? []) learned.add(id);

    if (attempt.summary.outcome === 'success') {
      // Close the learning loop: what passed after those failures is how they were fixed.
      if (learned.size > 0) {
        const text = attempt.fix?.text || 'Fixed on a later attempt (see the merged commit)';
        for (const failureId of learned) {
          await recordSolution(graph, { failureId, summary: text, commit: attempt.fix?.commit });
        }
        log(`recorded the fix for ${learned.size} earlier failure(s)`);
      }
      await emitTask(
        deps,
        await updateTask(graph, taskId, { status: 'done', tokens, testSummary: attempt.tests }),
      );
      await flushMemoryEvents(deps);
      log(`✔ ${taskId} done by ${agent}`);
      return { taskId, status: 'done', attempts };
    }

    if (attempt.aborted) {
      await emitTask(deps, await updateTask(graph, taskId, { status: 'planned', tokens }));
      return { taskId, status: 'aborted', attempts, reason: 'Stopped by the user' };
    }
    if (attempt.stop) {
      await emitTask(deps, await updateTask(graph, taskId, { status: 'failed', tokens }));
      await flushMemoryEvents(deps);
      return { taskId, status: 'failed', attempts, reason: attempt.summary.detail };
    }

    // Decide what happens next: another go with the same agent, or move up the chain.
    if (attempt.summary.outcome === 'error' || attempt.skipRetry) {
      agentIdx++;
      failuresOnAgent = 0;
    } else if (++failuresOnAgent > retriesPerAgent) {
      agentIdx++;
      failuresOnAgent = 0;
    }
    const more =
      attempts.length < limits.maxAttempts &&
      agents.slice(agentIdx).some((a) => !deps.unavailable?.has(a));
    const next = !more ? 'failed' : agentIdx > agents.indexOf(agent) ? 'escalated' : 'retrying';
    await emitTask(
      deps,
      await updateTask(graph, taskId, { status: next, testSummary: attempt.tests, tokens }),
    );
    await flushMemoryEvents(deps);
    if (next === 'escalated') log(`↑ escalating ${taskId} to ${agents[agentIdx]}`);
    if (next === 'retrying') log(`↻ retrying ${taskId} with what was learned`);
  }

  const last = attempts.at(-1);
  await emitTask(deps, await updateTask(graph, taskId, { status: 'failed', tokens }));
  await flushMemoryEvents(deps);
  return {
    taskId,
    status: 'failed',
    attempts,
    reason: last ? last.detail : 'No attempts were made',
  };
}

interface AttemptOutcome {
  summary: AttemptSummary;
  tokens: { in: number; out: number };
  tests?: { passed: number; total: number };
  /** Failures this attempt wrote to memory */
  failureIds?: string[];
  /** What the agent said about its change, and the merge commit, for the Solution if it fixed earlier failures */
  fix?: { text: string; commit?: string };
  /** Do not try this agent again (it changed nothing, so a retry would be identical) */
  skipRetry?: boolean;
  /** Give up on the whole task (e.g. a merge conflict) */
  stop?: boolean;
  aborted?: boolean;
}

async function runAttempt(
  deps: RunDeps,
  task: Task,
  agent: AgentName,
  role: ReturnType<typeof roleOf>,
  n: number,
): Promise<AttemptOutcome> {
  const { graph, config, repo } = deps;
  const log = deps.log ?? (() => {});
  const adapter = deps.adapters[agent]!;
  const writes = WRITES_FILES[role];
  const none = { in: 0, out: 0 };

  const wt = await repo.createWorktree(`${task.id}-a${n}`, config.worktrees.linkDirs);
  const sessionId = await startSession(graph, { agent, taskId: task.id, role });
  await emitTask(
    deps,
    await updateTask(graph, task.id, {
      status: 'running',
      assignedAgent: agent,
      role,
      worktree: `.puff/worktrees/${wt.name}`,
    }),
  );

  const summary = (
    outcome: AttemptSummary['outcome'],
    detail: string,
    failures = 0,
  ): AttemptSummary => ({
    n,
    agent,
    sessionId,
    outcome,
    detail,
    failures,
  });
  const cleanup = (deleteBranch: boolean) =>
    repo.remove(wt, { deleteBranch }).catch((e) => log(`cleanup: ${(e as Error).message}`));

  // A planner also gets the code map, so it is allowed a bigger prompt.
  const pack = await compileContext(graph, task.id, {
    role,
    sessionId,
    budgetTokens: config.limits.contextTokenBudget * (role === 'planner' ? 2 : 1),
    testCommand: config.verify.testCommand,
    maxTasks: config.limits.maxTasksPerPlan,
  });
  await emitSession(deps, task.id, sessionId);

  // Wait for one of this agent's slots (its configured instances), then run. Waiting can be aborted.
  let release: (() => void) | undefined;
  try {
    release = await deps.slots?.acquire(agent, deps.signal);
  } catch {
    await finishSession(graph, sessionId, {
      outcome: 'error',
      summary: 'Stopped while waiting for a free agent slot',
    });
    await emitSession(deps, task.id, sessionId);
    await cleanup(true);
    return { summary: summary('error', 'Stopped by the user'), tokens: none, aborted: true };
  }
  const res: HarnessResult = await adapter
    .run({
      prompt: pack.prompt,
      cwd: wt.path,
      role,
      timeoutMs: config.limits.timeoutMs,
      model: task.model ?? config.harnesses[agent]?.model,
      signal: deps.signal,
    })
    .finally(() => release?.());
  const tokens = { in: res.tokensIn ?? 0, out: res.tokensOut ?? 0 };
  const facts = { tokensIn: res.tokensIn, tokensOut: res.tokensOut, durationMs: res.durationMs };

  // 1. The agent itself failed to run: not a code failure, so no failure memory.
  if (res.error) {
    if (res.error.kind === 'auth' || res.error.kind === 'unavailable') {
      deps.unavailable ??= new Map();
      deps.unavailable.set(agent, res.error.message);
    }
    await finishSession(graph, sessionId, {
      outcome: 'error',
      ...facts,
      summary: `${res.error.kind}: ${res.error.message}`,
    });
    await emitSession(deps, task.id, sessionId);
    await cleanup(true);
    log(`✖ ${agent} could not run (${res.error.kind}): ${res.error.message}`);
    return {
      summary: summary('error', `${agent}: ${res.error.message}`),
      tokens,
      aborted: res.error.kind === 'aborted',
    };
  }

  // 2. Read-only roles produce text, not code: nothing to verify or merge.
  if (!writes) {
    const applied = res.report
      ? await applyReport(graph, res.report, {
          projectId: deps.project.slug,
          config,
          sessionId,
          parent: task,
        })
      : undefined;
    for (const t of applied?.skippedTasks ?? []) log(`task skipped (${t.title}): ${t.reason}`);
    // A plan that creates no tasks achieved nothing, even if the agent answered politely.
    if (role === 'planner' && !applied?.tasks.length) {
      const why =
        res.reportError ??
        applied?.skippedTasks[0]?.reason ??
        'the answer had no tasks in a <puff-report> block';
      await finishSession(graph, sessionId, {
        outcome: 'failure',
        ...facts,
        summary: `Planned nothing: ${why}`,
      });
      await emitSession(deps, task.id, sessionId);
      await cleanup(true);
      log(`✖ ${agent} produced no plan: ${why}`);
      return { summary: summary('failure', `no plan: ${why}`), tokens, skipRetry: true };
    }
    await finishSession(graph, sessionId, {
      outcome: 'success',
      ...facts,
      summary: summarize(res.output),
    });
    if (applied?.tasks.length) log(`plan created ${applied.tasks.length} task(s)`);
    await emitSession(deps, task.id, sessionId);
    for (const t of applied?.tasks ?? []) await emitTask(deps, t);
    await cleanup(true);
    return { summary: summary('success', summarize(res.output, 160)), tokens };
  }

  const { files, diff } = await repo.changes(wt);

  // 3. A writer that changed nothing would "pass" the existing tests. That is not a success.
  if (files.length === 0) {
    await finishSession(graph, sessionId, {
      outcome: 'failure',
      ...facts,
      summary: `Changed nothing. ${summarize(res.output, 300)}`,
    });
    await emitSession(deps, task.id, sessionId);
    await cleanup(true);
    log(`✖ ${agent} changed no files`);
    return { summary: summary('failure', `${agent} changed no files`), tokens, skipRetry: true };
  }

  // 4. Verify with the project's own tests.
  await emitTask(deps, await updateTask(graph, task.id, { status: 'verifying' }));
  const verdict = await runVerification(
    wt.path,
    config.verify.testCommand,
    config.limits.timeoutMs,
    deps.signal,
  );
  const tests = verdict.summary
    ? { passed: verdict.summary.passed, total: verdict.summary.total }
    : undefined;

  if (verdict.ok) {
    await repo.commit(wt, `puff: ${task.title}`);
    // Merge and re-index together under the repository lock, so parallel tasks never read the main
    // checkout halfway through each other's merge. The re-index flags memory about changed code as stale.
    const merge = await repo.serial(async () => {
      const m = await repo.mergeNow(wt, `Merge puff task ${task.id}: ${task.title}`);
      if (m.merged) await indexRepo(graph, deps.project);
      return m;
    });
    if (!merge.merged) {
      await finishSession(graph, sessionId, {
        outcome: 'error',
        ...facts,
        changedFiles: files,
        summary: `Tests passed but the merge failed: ${merge.reason}`,
      });
      await emitSession(deps, task.id, sessionId);
      await cleanup(false);
      log(`✖ merge failed for ${task.id}: ${merge.reason}`);
      return {
        summary: summary('error', `Merge failed: ${merge.reason}`),
        tokens,
        tests,
        stop: true,
      };
    }
    await finishSession(graph, sessionId, {
      outcome: 'success',
      ...facts,
      changedFiles: files,
      summary: summarize(res.output),
    });
    if (res.report) {
      // Decisions, handoff notes, and any follow-up tasks the agent asked for.
      const applied = await applyReport(graph, res.report, {
        projectId: deps.project.slug,
        config,
        sessionId,
        parent: task,
      });
      for (const s of applied.skipped) log(`decision skipped (${s.symbol}): ${s.reason}`);
      for (const t of applied.skippedTasks) log(`task skipped (${t.title}): ${t.reason}`);
      if (applied.tasks.length) log(`${agent} asked for ${applied.tasks.length} follow-up task(s)`);
      for (const t of applied.tasks) await emitTask(deps, t);
    }
    await emitSession(deps, task.id, sessionId);
    await cleanup(true);
    return {
      summary: summary('success', summarize(res.output, 160)),
      tokens,
      tests,
      fix: { text: res.report?.notes?.trim() || summarize(res.output, 300), commit: merge.sha },
    };
  }

  if (verdict.kind === 'error') {
    // The tests could not run (timeout, crash of the runner): a harness problem, not a lesson.
    await finishSession(graph, sessionId, {
      outcome: 'error',
      ...facts,
      changedFiles: files,
      summary: verdict.message,
    });
    await emitSession(deps, task.id, sessionId);
    await cleanup(true);
    log(`✖ verification error: ${verdict.message}`);
    return { summary: summary('error', verdict.message ?? 'verification error'), tokens, tests };
  }

  // 5. The tests failed: remember exactly where, before the worktree disappears.
  const recorded = await recordTestFailures(graph, {
    sessionId,
    taskId: task.id,
    output: verdict.output,
    root: wt.path,
    diff,
    changedFiles: files,
    fallbackMessage: 'Tests failed',
  });
  await finishSession(graph, sessionId, {
    outcome: 'failure',
    ...facts,
    changedFiles: files,
    summary: summarize(res.output) || recorded[0]?.message,
  });
  await emitSession(deps, task.id, sessionId);
  await repo.commit(wt, `puff: failed attempt ${n} of ${task.title}`);
  await cleanup(false); // keep the branch so the failed attempt can be inspected
  for (const r of recorded)
    log(
      `✖ ${r.repeated ? 'again' : 'new'}: ${r.message}  → ${r.symbolIds.join(', ')} (by ${r.via})`,
    );
  return {
    summary: summary('failure', recorded[0]?.message ?? 'Tests failed', recorded.length),
    tokens,
    tests,
    failureIds: recorded.map((r) => r.id),
  };
}

const roleOf = (type: Task['type']) => ROLE_FOR_TYPE[type];

export type { Worktree };
