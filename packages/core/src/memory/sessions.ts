// Sessions: one agent run on one task (episodic memory). Created when the run starts so the
// context pack can hang off it, then finished with the outcome Puff observed.
import type { Graph } from 'falkordb';
import type { AgentName, Role, SessionInfo, SessionOutcome } from '@puff/shared';
import { read, run } from '../db/client';
import { newId } from '../ids';

export async function startSession(
  graph: Graph,
  input: { agent: AgentName; taskId: string; role: Role; at?: number; seeded?: boolean },
): Promise<string> {
  const id = newId('Session');
  const rows = await run<{ id: string }>(
    graph,
    `MATCH (a:Agent {name: $agent}), (t:Task {id: $taskId})
     CREATE (a)-[:RAN]->(se:Session {id: $id, role: $role, outcome: 'running',
                                     startedAt: coalesce($at, timestamp()), seeded: $seeded})-[:WORKED_ON]->(t)
     RETURN se.id AS id`,
    {
      id,
      agent: input.agent,
      taskId: input.taskId,
      role: input.role,
      at: input.at ?? null,
      seeded: input.seeded ?? false,
    },
  );
  if (!rows.length)
    throw new Error(
      `Cannot start a session: unknown agent "${input.agent}" or task "${input.taskId}"`,
    );
  return id;
}

export interface SessionResult {
  outcome: Exclude<SessionOutcome, 'running'>;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
  filesRead?: number;
  /** Short human summary of what the agent reported (not the full transcript) */
  summary?: string;
  /** Repo-relative paths the agent changed (`git diff --name-only`) */
  changedFiles?: string[];
}

/** Q11: record what Puff observed. Facts only: outcome, tokens, duration, files. */
export async function finishSession(
  graph: Graph,
  sessionId: string,
  result: SessionResult,
): Promise<void> {
  const rows = await run<{ id: string }>(
    graph,
    `MATCH (se:Session {id: $id})
     SET se.outcome = $outcome, se.tokensIn = $tokensIn, se.tokensOut = $tokensOut,
         se.durationMs = $durationMs, se.filesRead = $filesRead, se.summary = $summary,
         se.endedAt = timestamp()
     RETURN se.id AS id`,
    {
      id: sessionId,
      outcome: result.outcome,
      tokensIn: result.tokensIn ?? null,
      tokensOut: result.tokensOut ?? null,
      durationMs: result.durationMs ?? null,
      filesRead: result.filesRead ?? null,
      summary: result.summary?.slice(0, 2000) ?? null,
    },
  );
  if (!rows.length) throw new Error(`Unknown session ${sessionId}`);
  if (result.changedFiles?.length) {
    await run(
      graph,
      `MATCH (se:Session {id: $id}) UNWIND $files AS p MATCH (f:File {path: p}) MERGE (se)-[:CHANGED]->(f)`,
      { id: sessionId, files: result.changedFiles },
    );
  }
}

interface SessionRow {
  p: Record<string, unknown>;
  agent: AgentName;
  taskId: string;
  changed: string[];
}

export async function listSessions(graph: Graph, taskId?: string): Promise<SessionInfo[]> {
  const rows = await read<SessionRow>(
    graph,
    `MATCH (a:Agent)-[:RAN]->(se:Session)-[:WORKED_ON]->(t:Task)
     WHERE $taskId IS NULL OR t.id = $taskId
     OPTIONAL MATCH (se)-[:CHANGED]->(f:File)
     RETURN properties(se) AS p, a.name AS agent, t.id AS taskId, collect(DISTINCT f.path) AS changed,
            se.startedAt AS startedAt
     ORDER BY startedAt`,
    { taskId: taskId ?? null },
  );
  const num = (v: unknown) => (v === undefined || v === null ? undefined : Number(v));
  return rows.map(({ p, agent, taskId: tid, changed }) => ({
    id: String(p.id),
    taskId: tid,
    agent,
    role: p.role as Role,
    outcome: p.outcome as SessionOutcome,
    tokensIn: num(p.tokensIn),
    tokensOut: num(p.tokensOut),
    durationMs: num(p.durationMs),
    changedFiles: changed.sort(),
    output: (p.summary as string | undefined) ?? undefined,
    startedAt: Number(p.startedAt),
  }));
}
