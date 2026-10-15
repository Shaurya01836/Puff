// Turn a plan (from the planner) or a follow-up request (from any agent) into tasks on the board.
//
// Agents can create work, so this is where it is kept under control:
//   - a cap on tasks per plan, and a limit on how deep agent-created work can nest, so agents
//     cannot spawn work forever
//   - dependencies may only point at EARLIER tasks in the same list, so a plan can never contain a cycle
//   - a task already on the board with the same title is not created twice
//   - names that are not in the graph (new code the plan has in mind) are kept as hints, not guessed
import type { Graph } from 'falkordb';
import type { Complexity, PlannedTask, Task, TaskType } from '@puff/shared';
import type { PuffConfig } from '../config';
import { resolveSymbols } from '../queries/code';
import { createTask, listTasks } from './tasks';

export interface SpawnContext {
  projectId: string;
  config: PuffConfig;
  /** The session whose report asked for these tasks */
  sessionId: string;
  /** The task that session was working on */
  parent: Task;
}

export interface SpawnResult {
  created: Task[];
  skipped: { title: string; reason: string }[];
}

const TYPES: readonly TaskType[] = ['plan', 'implement', 'verify', 'chore'];
const LEVELS: readonly Complexity[] = ['low', 'medium', 'high'];
const MAX_TARGETS = 6;
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export async function spawnTasks(
  graph: Graph,
  ctx: SpawnContext,
  planned: PlannedTask[],
): Promise<SpawnResult> {
  const { limits } = ctx.config;
  const depth = (ctx.parent.depth ?? 0) + 1;
  const result: SpawnResult = { created: [], skipped: [] };

  if (depth > limits.maxSpawnDepth) {
    for (const p of planned) {
      result.skipped.push({
        title: p.title,
        reason: `agents may only spawn work ${limits.maxSpawnDepth} level(s) deep`,
      });
    }
    return result;
  }

  const open = new Set(
    (await listTasks(graph)).filter((t) => t.status !== 'failed').map((t) => norm(t.title)),
  );
  /** position in the plan → id of the task created for it */
  const ids: (string | undefined)[] = [];

  for (const [i, p] of planned.entries()) {
    const title = p.title.trim().slice(0, 200);
    ids[i] = undefined;
    if (i >= limits.maxTasksPerPlan) {
      result.skipped.push({
        title,
        reason: `a plan may create at most ${limits.maxTasksPerPlan} tasks`,
      });
      continue;
    }
    if (!title) {
      result.skipped.push({ title: '(empty)', reason: 'a task needs a title' });
      continue;
    }
    if (open.has(norm(title))) {
      result.skipped.push({ title, reason: 'a task with this title is already on the board' });
      continue;
    }

    const targets: string[] = [];
    const hints: string[] = [];
    for (const name of (p.targets ?? []).slice(0, MAX_TARGETS)) {
      try {
        targets.push(...(await resolveSymbols(graph, [name])));
      } catch {
        hints.push(name); // not in the graph (yet): new code, or an ambiguous name
      }
    }

    const dependsOn = [
      ...new Set(
        (p.dependsOn ?? [])
          .filter((j) => Number.isInteger(j) && j >= 0 && j < i)
          .flatMap((j) => (ids[j] ? [ids[j]!] : [])),
      ),
    ];

    const task = await createTask(graph, ctx.projectId, ctx.config, {
      title,
      type: p.type && TYPES.includes(p.type) ? p.type : 'implement',
      complexity: p.complexity && LEVELS.includes(p.complexity) ? p.complexity : 'medium',
      targets: [...new Set(targets)],
      dependsOn,
      hints,
      depth,
      spawnedBy: ctx.sessionId,
    });
    ids[i] = task.id;
    open.add(norm(title));
    result.created.push(task);
  }
  return result;
}
