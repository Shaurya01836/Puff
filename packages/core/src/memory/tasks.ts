// Tasks: the unit of work. A task TARGETS symbols, REQUIRES capabilities and may DEPEND_ON other tasks.
import type { Graph } from 'falkordb';
import type { AgentName, Complexity, Role, Task, TaskStatus, TaskType } from '@puff/shared';
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
  /** Override the creation time (seeding and tests) */
  at?: number;
  /** Marks data created by `puff seed`, so the UI can say it is sample data */
  seeded?: boolean;
}

interface TaskRow {
  p: Record<string, unknown>;
  targets: string[];
  dependsOn: string[];
}

const TASK_QUERY = `
  MATCH (t:Task)
  WHERE $id IS NULL OR t.id = $id
  OPTIONAL MATCH (t)-[:TARGETS]->(s:Symbol)
  WITH t, collect(DISTINCT s.id) AS targets
  OPTIONAL MATCH (t)-[:DEPENDS_ON]->(d:Task)
  RETURN properties(t) AS p, targets, collect(DISTINCT d.id) AS dependsOn, t.createdAt AS createdAt
  ORDER BY createdAt`;

function toTask({ p, targets, dependsOn }: TaskRow): Task {
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
    worktree: (p.worktree as string | undefined) ?? undefined,
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
                     seeded: $seeded})
     CREATE (p)-[:HAS_TASK]->(t)`,
    {
      projectId,
      id,
      title,
      type,
      complexity: input.complexity ?? 'medium',
      at: input.at ?? null,
      seeded: input.seeded ?? false,
    },
  );
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
    if (t.status === 'planned' && t.dependsOn.every((d) => done.has(d))) {
      promoted.push(await updateTask(graph, t.id, { status: 'ready' }));
    }
  }
  return promoted;
}

/**
 * After a crash or a force-quit, tasks can be stuck mid-run with a session that will never finish.
 * Put them back in the queue and close their sessions as errors. Returns how many tasks were reset.
 */
export async function recoverInterrupted(graph: Graph): Promise<number> {
  const stuck = (await listTasks(graph)).filter((t) =>
    ['running', 'verifying', 'retrying'].includes(t.status),
  );
  for (const t of stuck) await updateTask(graph, t.id, { status: 'planned' });
  await run(
    graph,
    `MATCH (se:Session {outcome: 'running'})
     SET se.outcome = 'error', se.summary = 'Interrupted before it finished', se.endedAt = timestamp()`,
  );
  return stuck.length;
}
