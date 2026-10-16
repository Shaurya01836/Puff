// Memory writes. Every Failure and Decision is anchored to a Symbol (design rule 1), memory is
// never deleted, only superseded or marked stale (rule 4), and Puff writes facts itself (rule 9).
import type { Graph } from 'falkordb';
import type { FailureKind } from '@puff/shared';
import { read, run } from '../db/client';
import { newId } from '../ids';
import { existingSymbols } from '../queries/code';

const ANSI = /\x1b\[[0-9;]*m/g;

const SECRET_VALUE =
  /(\b(?:password|passwd|pwd|secret|token|api[_-]?key|authorization|cookie)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/gi;

/** Blank out values of obviously sensitive keys (`password: x`, `"token":"x"`) and bearer tokens. */
export function redactSecrets(text: string): string {
  return text
    .replace(SECRET_VALUE, '$1[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [redacted]');
}

/**
 * First line only, ANSI stripped, secrets redacted, whitespace collapsed, capped. Test output often
 * prints the received value in later lines, which can hold secrets, so only the headline is stored.
 */
export function sanitizeMessage(raw: string, max = 300): string {
  const first =
    raw
      .replace(ANSI, '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  const text = redactSecrets(first).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface Stamp {
  /** Override the creation time (seeding and tests) */
  at?: number;
  /** Marks sample data written by `puff seed` */
  seeded?: boolean;
}

export interface FailureInput extends Stamp {
  sessionId: string;
  message: string;
  kind?: FailureKind;
  /** Symbols the failure happened in. At least one must exist in the graph. */
  symbolIds: string[];
  /** How the failure was tied to code: stack | diff | changed-target | target | manual */
  anchoredBy?: string;
}

export interface FailureResult {
  id: string;
  /** True when the same failure was already known on the same symbol and was re-observed */
  repeated: boolean;
  symbolIds: string[];
}

/** Q12: record a failure anchored to code. A repeat of a known failure is counted, not duplicated. */
export async function recordFailure(graph: Graph, input: FailureInput): Promise<FailureResult> {
  const message = sanitizeMessage(input.message);
  if (!message) throw new Error('A failure needs a message');
  const symbolIds = [...(await existingSymbols(graph, input.symbolIds))];
  if (symbolIds.length === 0) {
    throw new Error('A failure must be anchored to at least one existing symbol');
  }
  // Keep the caller's order (primary symbol first); Set order is insertion order of the query result.
  const ordered = input.symbolIds.filter((id) => symbolIds.includes(id));
  const primary = ordered[0]!;

  const known = await read<{ id: string }>(
    graph,
    `MATCH (f:Failure {message: $message})-[:IN]->(s:Symbol {id: $primary})
     RETURN f.id AS id ORDER BY f.createdAt DESC LIMIT 1`,
    { message, primary },
  );
  if (known[0]) {
    // The same failure again: link this session to it and revive it if it had gone stale.
    const id = known[0].id;
    await run(
      graph,
      `MATCH (se:Session {id: $sessionId}), (f:Failure {id: $id})
       MERGE (se)-[:HIT]->(f)
       SET f.count = coalesce(f.count, 1) + 1, f.stale = false, f.lastSeenAt = coalesce($at, timestamp())`,
      { sessionId: input.sessionId, id, at: input.at ?? null },
    );
    return { id, repeated: true, symbolIds: ordered };
  }

  const id = newId('Failure');
  const rows = await run<{ id: string }>(
    graph,
    `MATCH (se:Session {id: $sessionId})
     CREATE (se)-[:HIT]->(f:Failure {id: $id, message: $message, kind: $kind, stale: false, count: 1,
                                     anchoredBy: $anchoredBy, createdAt: coalesce($at, timestamp()),
                                     seeded: $seeded})
     CREATE (f)-[:LEARNED_IN]->(se)
     RETURN f.id AS id`,
    {
      sessionId: input.sessionId,
      id,
      message,
      kind: input.kind ?? 'test',
      anchoredBy: input.anchoredBy ?? 'manual',
      at: input.at ?? null,
      seeded: input.seeded ?? false,
    },
  );
  if (!rows.length) throw new Error(`Unknown session ${input.sessionId}`);
  await run(
    graph,
    `MATCH (f:Failure {id: $id}) UNWIND $symbols AS sid MATCH (s:Symbol {id: sid}) MERGE (f)-[:IN]->(s)`,
    { id, symbols: ordered },
  );
  return { id, repeated: false, symbolIds: ordered };
}

export interface SolutionInput extends Stamp {
  failureId: string;
  summary: string;
  commit?: string;
  /** The session whose work fixed it */
  sessionId?: string;
}

/** Q13: record what fixed a failure. */
export async function recordSolution(graph: Graph, input: SolutionInput): Promise<string> {
  const summary = input.summary.trim().slice(0, 500);
  if (!summary) throw new Error('A solution needs a summary');
  const id = newId('Solution');
  const rows = await run<{ id: string }>(
    graph,
    `MATCH (f:Failure {id: $failureId})
     CREATE (f)-[:FIXED_BY]->(s:Solution {id: $id, summary: $summary, commit: $commit,
                                          createdAt: coalesce($at, timestamp()), seeded: $seeded})
     SET f.stale = false
     RETURN s.id AS id`,
    {
      failureId: input.failureId,
      id,
      summary,
      commit: input.commit ?? null,
      at: input.at ?? null,
      seeded: input.seeded ?? false,
    },
  );
  if (!rows.length) throw new Error(`Unknown failure ${input.failureId}`);
  // Provenance (P16): the commit the fix is in, and the session that made it
  if (input.commit) {
    await run(
      graph,
      `MATCH (s:Solution {id: $id})
       MERGE (c:Commit {sha: $sha}) ON CREATE SET c.at = timestamp()
       MERGE (s)-[:IN_COMMIT]->(c)`,
      { id, sha: input.commit },
    );
  }
  if (input.sessionId) {
    await run(
      graph,
      `MATCH (s:Solution {id: $id}), (se:Session {id: $sid}) MERGE (s)-[:LEARNED_IN]->(se)`,
      { id, sid: input.sessionId },
    );
  }
  return id;
}

export interface DecisionInput extends Stamp {
  /** Symbols the decision is about. When superseding, defaults to the old decision's symbols. */
  symbolIds?: string[];
  text: string;
  /** Id of an active decision this one replaces */
  supersedes?: string;
  /** The session that wrote it */
  sessionId?: string;
  /** Failures or solutions it was written after (DERIVED_FROM) */
  derivedFrom?: string[];
}

/** Q14: record a decision, or supersede an earlier one. The old decision is kept, never deleted. */
export async function recordDecision(graph: Graph, input: DecisionInput): Promise<{ id: string }> {
  const text = input.text.trim().slice(0, 500);
  if (!text) throw new Error('A decision needs text');

  let symbolIds = input.symbolIds ?? [];
  if (input.supersedes) {
    const old = await read<{ status: string; symbols: string[] }>(
      graph,
      `MATCH (d:Decision {id: $id})
       OPTIONAL MATCH (d)-[:ABOUT]->(s:Symbol)
       RETURN d.status AS status, collect(s.id) AS symbols`,
      { id: input.supersedes },
    );
    if (!old[0]) throw new Error(`Unknown decision ${input.supersedes}`);
    if (old[0].status !== 'active')
      throw new Error(`Decision ${input.supersedes} is already superseded`);
    if (symbolIds.length === 0) symbolIds = old[0].symbols;
  }
  const existing = [...(await existingSymbols(graph, symbolIds))];
  if (existing.length === 0)
    throw new Error('A decision must be about at least one existing symbol');

  const id = newId('Decision');
  await run(
    graph,
    `CREATE (:Decision {id: $id, text: $text, status: 'active', stale: false,
                        createdAt: coalesce($at, timestamp()), seeded: $seeded})`,
    { id, text, at: input.at ?? null, seeded: input.seeded ?? false },
  );
  await run(
    graph,
    `MATCH (d:Decision {id: $id}) UNWIND $symbols AS sid MATCH (s:Symbol {id: sid}) MERGE (d)-[:ABOUT]->(s)`,
    { id, symbols: existing },
  );
  if (input.sessionId) {
    await run(
      graph,
      `MATCH (d:Decision {id: $id}), (se:Session {id: $sid}) MERGE (d)-[:LEARNED_IN]->(se)`,
      { id, sid: input.sessionId },
    );
  }
  if (input.derivedFrom?.length) {
    await run(
      graph,
      `MATCH (d:Decision {id: $id})
       MATCH (x) WHERE x.id IN $from AND labels(x)[0] IN ['Failure', 'Solution']
       MERGE (d)-[:DERIVED_FROM]->(x)`,
      { id, from: input.derivedFrom },
    );
  }
  if (input.supersedes) {
    await run(
      graph,
      `MATCH (n:Decision {id: $id}), (o:Decision {id: $old})
       SET o.status = 'superseded', o.supersededAt = coalesce($at, timestamp())
       MERGE (n)-[:SUPERSEDES]->(o)`,
      { id, old: input.supersedes, at: input.at ?? null },
    );
  }
  return { id };
}

/**
 * A person or agent checked that a failure or decision flagged "possibly outdated" still holds after
 * the code changed. Clears the flag; superseded decisions stay superseded.
 */
export async function confirmMemory(graph: Graph, id: string): Promise<void> {
  const rows = await run<{ id: string }>(
    graph,
    `MATCH (m) WHERE m.id = $id AND labels(m)[0] IN ['Failure', 'Decision']
     SET m.stale = false, m.confirmedAt = timestamp(), m.confirmations = coalesce(m.confirmations, 0) + 1
     RETURN m.id AS id`,
    { id },
  );
  if (!rows.length) throw new Error(`No failure or decision with id ${id}`);
}

export interface ProcedureInput extends Stamp {
  text: string;
  /** Technology it applies to (e.g. Express). Omit for a project-wide procedure. */
  technology?: string;
}

/** Procedural memory: how things are done in this project. Idempotent on the text. */
export async function recordProcedure(
  graph: Graph,
  projectId: string,
  input: ProcedureInput,
): Promise<string> {
  const text = input.text.trim().slice(0, 500);
  if (!text) throw new Error('A procedure needs text');
  const found = await read<{ id: string }>(
    graph,
    `MATCH (p:Procedure {text: $text}) RETURN p.id AS id`,
    { text },
  );
  const id = found[0]?.id ?? newId('Procedure');
  if (!found[0]) {
    await run(
      graph,
      `CREATE (:Procedure {id: $id, text: $text, createdAt: coalesce($at, timestamp()), seeded: $seeded})`,
      { id, text, at: input.at ?? null, seeded: input.seeded ?? false },
    );
  }
  if (input.technology) {
    await run(
      graph,
      `MATCH (p:Procedure {id: $id}) MERGE (t:Technology {name: $tech}) MERGE (p)-[:APPLIES_TO]->(t)`,
      { id, tech: input.technology },
    );
  } else {
    await run(
      graph,
      `MATCH (p:Procedure {id: $id}), (pr:Project {id: $projectId}) MERGE (p)-[:APPLIES_TO]->(pr)`,
      { id, projectId },
    );
  }
  return id;
}

export interface HandoffInput extends Stamp {
  fromSessionId: string;
  /** Structured state for the next agent */
  payload: Record<string, unknown>;
  toRole?: string;
}

/** Q15: structured state passed from one session to whoever works next. */
export async function recordHandoff(graph: Graph, input: HandoffInput): Promise<string> {
  const id = newId('Handoff');
  const rows = await run<{ id: string }>(
    graph,
    `MATCH (se:Session {id: $from})
     CREATE (se)-[:HANDED_OFF]->(h:Handoff {id: $id, payload: $payload, toRole: $toRole,
                                            createdAt: coalesce($at, timestamp()), seeded: $seeded})
     RETURN h.id AS id`,
    {
      from: input.fromSessionId,
      id,
      payload: JSON.stringify(input.payload).slice(0, 4000),
      toRole: input.toRole ?? null,
      at: input.at ?? null,
      seeded: input.seeded ?? false,
    },
  );
  if (!rows.length) throw new Error(`Unknown session ${input.fromSessionId}`);
  return id;
}

export interface PendingHandoff {
  id: string;
  payload: Record<string, unknown>;
  toRole?: string;
  fromAgent: string;
  fromRole: string;
}

/**
 * Handoffs waiting for this task: from earlier sessions on the same task (a retry) and from sessions
 * on tasks it depends on. A handoff stops being pending once a context pack delivers it (`TO` edge).
 */
export async function pendingHandoffs(graph: Graph, taskId: string): Promise<PendingHandoff[]> {
  type Row = { id: string; payload: string; toRole: string | null; agent: string; role: string };
  const cols = `h.id AS id, h.payload AS payload, h.toRole AS toRole, a.name AS agent, se.role AS role`;
  const same = await read<Row>(
    graph,
    `MATCH (:Task {id: $taskId})<-[:WORKED_ON]-(se:Session)-[:HANDED_OFF]->(h:Handoff)
     WHERE NOT (h)-[:TO]->()
     MATCH (a:Agent)-[:RAN]->(se)
     RETURN ${cols} ORDER BY h.createdAt`,
    { taskId },
  );
  const deps = await read<Row>(
    graph,
    `MATCH (:Task {id: $taskId})-[:DEPENDS_ON]->(:Task)<-[:WORKED_ON]-(se:Session)-[:HANDED_OFF]->(h:Handoff)
     WHERE NOT (h)-[:TO]->()
     MATCH (a:Agent)-[:RAN]->(se)
     RETURN ${cols} ORDER BY h.createdAt`,
    { taskId },
  );
  // Notes left by the session that asked for this task (a follow-up request or a plan).
  const spawner = await read<Row>(
    graph,
    `MATCH (se:Session)-[:SPAWNED]->(:Task {id: $taskId})
     MATCH (se)-[:HANDED_OFF]->(h:Handoff)
     WHERE NOT (h)-[:TO]->()
     MATCH (a:Agent)-[:RAN]->(se)
     RETURN ${cols} ORDER BY h.createdAt`,
    { taskId },
  );
  const seen = new Set<string>();
  return [...same, ...deps, ...spawner]
    .filter((r) => !seen.has(r.id) && seen.add(r.id))
    .map((r) => ({
      id: r.id,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
      toRole: r.toRole ?? undefined,
      fromAgent: r.agent,
      fromRole: r.role,
    }));
}
