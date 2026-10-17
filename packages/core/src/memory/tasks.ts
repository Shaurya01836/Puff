// Tasks: the unit of work. A task TARGETS symbols, REQUIRES capabilities and may DEPEND_ON other tasks.
import type { Graph } from 'falkordb';
import type {
  AgentName,
  Complexity,
  Role,
  Task,
  TaskStatus,
  TaskType,
  TaskWhy,
  TrailEntry,
} from '@puff/shared';
import type { PuffConfig } from '../config';
import { read, run } from '../db/client';
import { newId } from '../ids';
import { resolveSymbols } from '../queries/code';

export interface NewTask {
  title: string;
  type?: TaskType;
  complexity?: Complexity;
  /** Symbol ids or unique names */
  targets?: string[];
  /** Existing task ids this task waits for */
  dependsOn?: string[];
  /** Names that did not resolve to symbols (new code the planner has in mind), kept as a hint */
  hints?: string[];
  /** 0 for tasks a person creates; each agent-created step adds one */
  depth?: number;
  /** The session whose report created this task (who asked for it) */
  spawnedBy?: string;
  /** Run this task with this agent instead of routing */
  preferredAgent?: AgentName;
  /** Provider model override for this task */
  model?: string;
  /** Override the creation time (seeding and tests) */
  at?: number;
  /** Marks data created by `puff seed`, so the UI can say it is sample data */
  seeded?: boolean;
}

interface TaskRow {
  p: Record<string, unknown>;
  targets: string[];
  dependsOn: string[];
  risk?: number | null;
  /** [kind, reason, graphOff] of the task's route and schedule traces, newest first */
  decisions?: [string | null, string | null, boolean | null][];
}

const TASK_QUERY = `
  MATCH (t:Task)
  WHERE $id IS NULL OR t.id = $id
  OPTIONAL MATCH (t)-[:TARGETS]->(s:Symbol)
  WITH t, collect(DISTINCT s.id) AS targets, max(s.risk) AS risk
  OPTIONAL MATCH (t)-[:DEPENDS_ON]->(d:Task)
  WITH t, targets, risk, collect(DISTINCT d.id) AS dependsOn
  OPTIONAL MATCH (tr:Trace)-[:FOR]->(t) WHERE tr.kind IN ['route', 'schedule']
  WITH t, targets, risk, dependsOn, tr ORDER BY tr.at DESC
  WITH t, targets, risk, dependsOn, collect([tr.kind, tr.reason, tr.graphOff]) AS decisions
  RETURN properties(t) AS p, targets, dependsOn, risk, decisions, t.createdAt AS createdAt
  ORDER BY createdAt`;

/** The newest route and schedule reasons from a task's traces (Q13): what the card says about the graph's choice */
function toWhy(decisions: TaskRow['decisions']): TaskWhy | undefined {
  const newest = (kind: string) => (decisions ?? []).find((d) => d[0] === kind);
  const route = newest('route');
  const schedule = newest('schedule');
  if (!route && !schedule) return undefined;
  return {
    route: route?.[1] ?? undefined,
    schedule: schedule?.[1] ?? undefined,
    graphOff: route?.[2] === true || schedule?.[2] === true ? true : undefined,
  };
}

/** The stored trail; a missing or unreadable value is an empty trail, never an error. */
function parseTrail(raw: unknown): TrailEntry[] | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const trail = JSON.parse(raw);
    return Array.isArray(trail) && trail.length ? (trail as TrailEntry[]) : undefined;
  } catch {
    return undefined;
  }
}

function toTask({ p, targets, dependsOn, risk, decisions }: TaskRow): Task {
  const num = (v: unknown) => (v === undefined || v === null ? undefined : Number(v));
  const tokensIn = num(p.tokensIn);
  const testsTotal = num(p.testsTotal);
  return {
    id: String(p.id),
    title: String(p.title),
    type: p.type as TaskType,
    complexity: p.complexity as Complexity,
    status: p.status as TaskStatus,
    assignedAgent: (p.assignedAgent as AgentName | undefined) ?? undefined,
    role: (p.role as Role | undefined) ?? undefined,
    targets: [...targets].sort(),
    dependsOn: [...dependsOn].sort(),
    depth: num(p.depth) ?? 0,
    preferredAgent: (p.preferredAgent as AgentName | undefined) ?? undefined,
    model: (p.model as string | undefined) ?? undefined,
    hints: Array.isArray(p.hints) && p.hints.length ? (p.hints as string[]) : undefined,
    blockedBy:
      Array.isArray(p.blockedBy) && p.blockedBy.length ? (p.blockedBy as string[]) : undefined,
    worktree: (p.worktree as string | undefined) ?? undefined,
    trail: parseTrail(p.trail),
    stalledAt: num(p.stalledAt),
    note: (p.note as string | undefined) ?? undefined,
    doneByHand: p.doneByHand === true ? true : undefined,
    archived: p.archived === true ? true : undefined,
    risk: risk === undefined || risk === null ? undefined : Number(risk),
    why: toWhy(decisions),
    tokens: tokensIn === undefined ? undefined : { in: tokensIn, out: num(p.tokensOut) ?? 0 },
    testSummary:
      testsTotal === undefined ? undefined : { passed: num(p.testsPassed) ?? 0, total: testsTotal },
    createdAt: Number(p.createdAt),
    updatedAt: Number(p.updatedAt ?? p.createdAt),
  };
}

export async function listTasks(graph: Graph): Promise<Task[]> {
  return (await read<TaskRow>(graph, TASK_QUERY, { id: null })).map(toTask);
}

export async function getTask(graph: Graph, id: string): Promise<Task | undefined> {
  const rows = await read<TaskRow>(graph, TASK_QUERY, { id });
  return rows[0] ? toTask(rows[0]) : undefined;
}

export async function createTask(
  graph: Graph,
  projectId: string,
  config: PuffConfig,
  input: NewTask,
): Promise<Task> {
  const title = input.title.trim();
  if (!title) throw new Error('A task needs a title');
  const type = input.type ?? 'implement';
  const targets = input.targets?.length ? await resolveSymbols(graph, input.targets) : [];

  const dependsOn = [...new Set(input.dependsOn ?? [])];
  if (dependsOn.length) {
    const found = await read<{ id: string }>(
      graph,
      `MATCH (t:Task) WHERE t.id IN $ids RETURN t.id AS id`,
      { ids: dependsOn },
    );
    const missing = dependsOn.filter((id) => !found.some((f) => f.id === id));
    if (missing.length) throw new Error(`Unknown task(s) in dependsOn: ${missing.join(', ')}`);
  }

  const id = newId('Task');
  await run(
    graph,
    `MATCH (p:Project {id: $projectId})
     CREATE (t:Task {id: $id, title: $title, type: $type, complexity: $complexity, status: 'planned',
                     createdAt: coalesce($at, timestamp()), updatedAt: coalesce($at, timestamp()),
                     depth: $depth, hints: $hints, preferredAgent: $preferredAgent, model: $model,
                     seeded: $seeded})
     CREATE (p)-[:HAS_TASK]->(t)`,
    {
      projectId,
      id,
      title,
      type,
      complexity: input.complexity ?? 'medium',
      at: input.at ?? null,
      depth: input.depth ?? 0,
      hints: input.hints ?? [],
      preferredAgent: input.preferredAgent ?? null,
      model: input.model ?? null,
      seeded: input.seeded ?? false,
    },
  );
  if (input.spawnedBy) {
    await run(
      graph,
      `MATCH (se:Session {id: $sid}), (t:Task {id: $id}) MERGE (se)-[:SPAWNED]->(t)`,
      { sid: input.spawnedBy, id },
    );
  }
  if (targets.length) {
    await run(
      graph,
      `MATCH (t:Task {id: $id}) UNWIND $targets AS sid MATCH (s:Symbol {id: sid}) MERGE (t)-[:TARGETS]->(s)`,
      { id, targets },
    );
  }
  if (dependsOn.length) {
    await run(
      graph,
      `MATCH (t:Task {id: $id}) UNWIND $deps AS did MATCH (d:Task {id: did}) MERGE (t)-[:DEPENDS_ON]->(d)`,
      { id, deps: dependsOn },
    );
  }
  const caps = config.routing[type] ?? [];
  if (caps.length) {
    await run(
      graph,
      `MATCH (t:Task {id: $id}) UNWIND $caps AS c MATCH (cap:Capability {name: c}) MERGE (t)-[:REQUIRES]->(cap)`,
      { id, caps },
    );
  }
  return (await getTask(graph, id))!;
}

export interface TaskPatch {
  status?: TaskStatus;
  assignedAgent?: AgentName;
  role?: Role;
  worktree?: string;
  tokens?: { in: number; out: number };
  testSummary?: { passed: number; total: number };
  trail?: TrailEntry[];
  /** When the agent went quiet; `null` clears it */
  stalledAt?: number | null;
  /** A note for the next attempt; `null` clears it */
  note?: string | null;
  doneByHand?: boolean;
  archived?: boolean;
  /** Running tasks whose code overlaps this one (set while it waits); `null` clears it */
  blockedBy?: string[] | null;
  /** Override the update time (seeding and tests) */
  at?: number;
}

/** Update task fields. Only keys present in the patch are written. */
export async function updateTask(graph: Graph, id: string, patch: TaskPatch): Promise<Task> {
  const sets: string[] = ['t.updatedAt = coalesce($at, timestamp())'];
  const params: Record<string, unknown> = { id, at: patch.at ?? null };
  const set = (key: string, value: unknown) => {
    sets.push(`t.${key} = $${key}`);
    params[key] = value;
  };
  if (patch.status !== undefined) set('status', patch.status);
  if (patch.assignedAgent !== undefined) set('assignedAgent', patch.assignedAgent);
  if (patch.role !== undefined) set('role', patch.role);
  if (patch.worktree !== undefined) set('worktree', patch.worktree);
  if (patch.tokens) {
    set('tokensIn', patch.tokens.in);
    set('tokensOut', patch.tokens.out);
  }
  if (patch.testSummary) {
    set('testsPassed', patch.testSummary.passed);
    set('testsTotal', patch.testSummary.total);
  }
  if (patch.blockedBy !== undefined)
    set('blockedBy', patch.blockedBy?.length ? patch.blockedBy : null);
  if (patch.trail) set('trail', JSON.stringify(patch.trail.slice(-30)));
  if (patch.stalledAt !== undefined) set('stalledAt', patch.stalledAt);
  if (patch.note !== undefined) set('note', patch.note?.trim().slice(0, 2000) || null);
  if (patch.doneByHand !== undefined) set('doneByHand', patch.doneByHand);
  if (patch.archived !== undefined) set('archived', patch.archived);
  const rows = await run<{ id: string }>(
    graph,
    `MATCH (t:Task {id: $id}) SET ${sets.join(', ')} RETURN t.id AS id`,
    params,
  );
  if (!rows.length) throw new Error(`Unknown task ${id}`);
  return (await getTask(graph, id))!;
}

/** Q7: a planned task becomes ready once every task it depends on is done. Returns the promoted tasks. */
export async function promoteReady(graph: Graph): Promise<Task[]> {
  const tasks = await listTasks(graph);
  const done = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  const promoted: Task[] = [];
  for (const t of tasks) {
    if (t.status === 'planned' && !t.archived && t.dependsOn.every((d) => done.has(d))) {
      promoted.push(await updateTask(graph, t.id, { status: 'ready' }));
    }
  }
  return promoted;
}

/**
 * After a crash or a force-quit, tasks can be stuck mid-run with a session that will never finish.
 * Put them back in the queue and close their sessions as errors. Returns how many tasks were reset.
 */
export async function recoverInterrupted(
  graph: Graph,
  opts: { olderThanMs?: number } = {},
): Promise<number> {
  const now = Date.now();
  const stuck = (await listTasks(graph)).filter(
    (t) =>
      ['running', 'verifying', 'retrying'].includes(t.status) &&
      // With a limit, only tasks that have been silent that long: one that another process is working on
      // right now keeps updating, so it is left alone
      (opts.olderThanMs === undefined || now - t.updatedAt > opts.olderThanMs),
  );
  for (const t of stuck) await updateTask(graph, t.id, { status: 'planned' });
  await run(
    graph,
    `MATCH (se:Session {outcome: 'running'})-[:WORKED_ON]->(t:Task)
     WHERE $all OR t.id IN $ids
     SET se.outcome = 'error', se.summary = 'Interrupted before it finished', se.endedAt = timestamp()`,
    { all: opts.olderThanMs === undefined, ids: stuck.map((t) => t.id) },
  );
  return stuck.length;
}

/**
 * Q9: atomically move a task from ready to running. FalkorDB runs each query atomically, so when two
 * schedulers race for the same task exactly one gets a row back. Returns false when someone else won.
 */
export async function claimTask(graph: Graph, id: string, owner: string): Promise<boolean> {
  const rows = await run<{ id: string }>(
    graph,
    `MATCH (t:Task {id: $id, status: 'ready'})
     SET t.status = 'running', t.claimedBy = $owner, t.updatedAt = timestamp(), t.blockedBy = null
     RETURN t.id AS id`,
    { id, owner },
  );
  return rows.length > 0;
}

/** Statuses in which a task is not being worked on and its definition can still change. */
export const EDITABLE_STATUSES: TaskStatus[] = ['planned', 'ready', 'failed'];

export interface TaskEdit {
  title?: string;
  complexity?: Complexity;
  /** `null` goes back to routing the task by strengths and past results */
  preferredAgent?: AgentName | null;
  /** `null` uses the CLI's own model */
  model?: string | null;
  /** Symbol ids or unique names; replaces the task's current targets */
  targets?: string[];
}

/**
 * Change what a task asks for. Only planned, ready or failed tasks: a task an agent is working on, or
 * one that is done, keeps its definition so the history still describes what was done.
 */
export async function editTask(graph: Graph, id: string, edit: TaskEdit): Promise<Task> {
  const task = await getTask(graph, id);
  if (!task) throw new Error(`Unknown task ${id}`);
  if (!EDITABLE_STATUSES.includes(task.status))
    throw new Error(
      `Task ${id} is ${task.status}. Only planned, ready or failed tasks can be edited.`,
    );

  // Resolve targets first so a bad name changes nothing.
  const targets = edit.targets ? await resolveSymbols(graph, edit.targets) : undefined;

  const sets: string[] = ['t.updatedAt = timestamp()'];
  const params: Record<string, unknown> = { id };
  const set = (key: string, value: unknown) => {
    sets.push(`t.${key} = $${key}`);
    params[key] = value;
  };
  if (edit.title !== undefined) {
    if (!edit.title.trim()) throw new Error('A task needs a title');
    set('title', edit.title.trim());
  }
  if (edit.complexity !== undefined) set('complexity', edit.complexity);
  if (edit.preferredAgent !== undefined) set('preferredAgent', edit.preferredAgent);
  if (edit.model !== undefined) set('model', edit.model?.trim() || null);
  await run(graph, `MATCH (t:Task {id: $id}) SET ${sets.join(', ')}`, params);

  if (targets) {
    await run(graph, `MATCH (:Task {id: $id})-[r:TARGETS]->() DELETE r`, { id });
    if (targets.length)
      await run(
        graph,
        `MATCH (t:Task {id: $id}) UNWIND $targets AS sid MATCH (s:Symbol {id: sid}) MERGE (t)-[:TARGETS]->(s)`,
        { id, targets },
      );
  }
  return (await getTask(graph, id))!;
}

/**
 * Delete a task that never ran. A task with history (sessions), or that other tasks wait on, stays:
 * what happened is worth keeping, and removing a dependency would silently change other tasks.
 */
export async function removeTask(graph: Graph, id: string): Promise<void> {
  const task = await getTask(graph, id);
  if (!task) throw new Error(`Unknown task ${id}`);
  if (!['planned', 'ready'].includes(task.status))
    throw new Error(`Task ${id} is ${task.status}. Only a task that has not run can be removed.`);
  const [facts] = await read<{ sessions: number; dependents: number }>(
    graph,
    `MATCH (t:Task {id: $id})
     OPTIONAL MATCH (t)<-[:WORKED_ON]-(se:Session)
     WITH t, count(se) AS sessions
     OPTIONAL MATCH (t)<-[:DEPENDS_ON]-(d:Task)
     RETURN sessions, count(d) AS dependents`,
    { id },
  );
  if (facts && facts.sessions > 0)
    throw new Error(`Task ${id} has been worked on, so its history is kept.`);
  if (facts && facts.dependents > 0)
    throw new Error(`Other tasks wait for task ${id}. Remove or change those first.`);
  await run(graph, `MATCH (t:Task {id: $id}) DETACH DELETE t`, { id });
}

/**
 * Archive or restore a task. Archiving hides it from the active board while keeping its
 * sessions and lessons in memory.
 */
export async function archiveTask(graph: Graph, id: string, archived = true): Promise<Task> {
  const task = await getTask(graph, id);
  if (!task) throw new Error(`Unknown task ${id}`);
  if (archived && ['running', 'verifying'].includes(task.status)) {
    throw new Error(`Task ${id} is currently running and cannot be archived.`);
  }
  return updateTask(graph, id, { archived });
}

