// Trustworthy memory (P16): where every lesson came from, what happens to it when the code it relied on
// is reverted, and how much to trust it.
//
//   (Failure|Decision|Solution)-[:LEARNED_IN]->(Session)     the session that learned it
//   (Session)-[:MERGED]->(Commit {sha})                       the merge that session landed
//   (Solution)-[:IN_COMMIT]->(Commit)                         the commit the fix is in
//   (Decision)-[:DERIVED_FROM]->(Failure|Solution)            a decision written after a failure, about its fix
//   (Commit)-[:REVERTED_BY]->(Commit)                         a merge that was undone, and the revert
//
// A revert of a Puff merge, made by Puff's re-test or by a person in git, marks the fixes in it as
// reverted and lowers the trust of everything derived from them (Q23). Trust (Q24) is read from the
// graph each time context is built, so it always reflects the latest outcomes.
import type { Graph } from 'falkordb';
import { read, run } from '../db/client';
import type { GitRepo } from '../git/repo';
import { git } from '../git/repo';

/** Record the commit a session merged, so a later revert of it can be traced to what it taught. */
export async function recordMerge(graph: Graph, sessionId: string, sha: string): Promise<void> {
  await run(
    graph,
    `MATCH (se:Session {id: $sid})
     MERGE (c:Commit {sha: $sha}) ON CREATE SET c.at = timestamp()
     MERGE (se)-[:MERGED]->(c)`,
    { sid: sessionId, sha },
  );
}

/** Decisions written after failures (and about their fix) are derived from them. */
export async function linkDerived(graph: Graph, from: string[], to: string[]): Promise<void> {
  if (!from.length || !to.length) return;
  await run(
    graph,
    `MATCH (d:Decision) WHERE d.id IN $from
     MATCH (x) WHERE x.id IN $to AND labels(x)[0] IN ['Failure', 'Solution']
     MERGE (d)-[:DERIVED_FROM]->(x)`,
    { from, to },
  );
}

/** The session a decision or solution came from. */
export async function linkLearnedIn(graph: Graph, ids: string[], sessionId: string): Promise<void> {
  if (!ids.length) return;
  await run(
    graph,
    `MATCH (se:Session {id: $sid})
     MATCH (m) WHERE m.id IN $ids AND labels(m)[0] IN ['Failure', 'Decision', 'Solution']
     MERGE (m)-[:LEARNED_IN]->(se)`,
    { sid: sessionId, ids },
  );
}

export interface RevertResult {
  /** The merge commit that was undone */
  merged: string;
  /** Fixes in that commit, now marked reverted */
  solutions: string[];
  /** Decisions the merging session wrote */
  decisions: string[];
  /** Everything derived from those, up to three steps away, now downgraded */
  downgraded: string[];
  /** False when this revert was already recorded */
  isNew: boolean;
}

/**
 * Q23: merge `merged` was undone by `revert`. Its fixes are marked reverted, the decisions its session
 * wrote are flagged, and everything DERIVED_FROM them (up to 3 steps) is downgraded. Idempotent.
 */
export async function recordRevert(
  graph: Graph,
  merged: string,
  revert: string,
  at?: number,
): Promise<RevertResult> {
  const known = await read<{ n: number }>(
    graph,
    `MATCH (:Commit {sha: $m})-[r:REVERTED_BY]->() RETURN count(r) AS n`,
    { m: merged },
  );
  const isNew = Number(known[0]?.n ?? 0) === 0;
  await run(
    graph,
    `MERGE (x:Commit {sha: $m})
     MERGE (y:Commit {sha: $r}) ON CREATE SET y.at = coalesce($at, timestamp())
     MERGE (x)-[e:REVERTED_BY]->(y) ON CREATE SET e.at = coalesce($at, timestamp())`,
    { m: merged, r: revert, at: at ?? null },
  );
  const solutions = (
    await run<{ id: string }>(
      graph,
      `MATCH (s:Solution)-[:IN_COMMIT]->(:Commit {sha: $m})
       SET s.status = 'reverted', s.revertedIn = $m, s.revertedAt = coalesce(s.revertedAt, timestamp())
       RETURN s.id AS id`,
      { m: merged },
    )
  ).map((r) => r.id);
  const decisions = (
    await run<{ id: string }>(
      graph,
      `MATCH (d:Decision)-[:LEARNED_IN]->(:Session)-[:MERGED]->(:Commit {sha: $m})
       SET d.revertedIn = $m, d.revertedAt = coalesce(d.revertedAt, timestamp())
       RETURN DISTINCT d.id AS id`,
      { m: merged },
    )
  ).map((r) => r.id);
  const roots = [...solutions, ...decisions];
  const downgraded = roots.length
    ? (
        await run<{ id: string }>(
          graph,
          `MATCH (m)-[:DERIVED_FROM*1..3]->(root) WHERE root.id IN $roots AND NOT m.id IN $roots
           SET m.downgradedBy = coalesce(m.downgradedBy, $m), m.downgradedAt = coalesce(m.downgradedAt, timestamp())
           RETURN DISTINCT m.id AS id`,
          { roots, m: merged },
        )
      ).map((r) => r.id)
    : [];
  return { merged, solutions, decisions, downgraded, isNew };
}

/**
 * Find reverts of Puff merges in the branch's history and record the ones not seen yet. Catches
 * Puff's own revert after a failed re-test and a person's `git revert` alike.
 */
export async function syncReverts(
  graph: Graph,
  repo: Pick<GitRepo, 'root'>,
): Promise<RevertResult[]> {
  const log = await git(
    ['log', 'HEAD', '--grep=This reverts commit', '--format=%H%x1f%ct%x1f%B%x1e'],
    repo.root,
  );
  if (log.code !== 0) return [];
  const pairs = log.out
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const [revert, time, body] = entry.split('\x1f');
      const merged = /This reverts commit ([0-9a-f]{7,40})/.exec(body ?? '')?.[1];
      return revert && merged ? [{ revert, merged, at: Number(time) * 1000 }] : [];
    });
  if (!pairs.length) return [];
  // only merges Puff knows about, and only reverts not recorded yet
  const open = await read<{ sha: string }>(
    graph,
    `UNWIND $shas AS sha
     MATCH (c:Commit) WHERE c.sha STARTS WITH sha AND NOT (c)-[:REVERTED_BY]->()
     RETURN c.sha AS sha`,
    { shas: pairs.map((p) => p.merged) },
  );
  const results: RevertResult[] = [];
  for (const p of pairs) {
    const full = open.find((o) => o.sha.startsWith(p.merged))?.sha;
    if (full) results.push(await recordRevert(graph, full, p.revert, p.at));
  }
  return results;
}

/** Fill in provenance for memory recorded before P16. Safe to run again. */
export async function backfillProvenance(graph: Graph): Promise<void> {
  await run(
    graph,
    `MATCH (se:Session)-[:HIT]->(f:Failure) WHERE NOT (f)-[:LEARNED_IN]->()
     WITH f, se ORDER BY se.startedAt
     WITH f, head(collect(se.id)) AS sid
     MATCH (first:Session {id: sid})
     MERGE (f)-[:LEARNED_IN]->(first)`,
  );
  await run(
    graph,
    `MATCH (s:Solution) WHERE s.commit IS NOT NULL AND NOT (s)-[:IN_COMMIT]->()
     MERGE (c:Commit {sha: s.commit})
     MERGE (s)-[:IN_COMMIT]->(c)`,
  );
}

// ---------------------------------------------------------------------------------------------
// Q24: trust
// ---------------------------------------------------------------------------------------------

export interface TrustFactors {
  id: string;
  /** The agent whose session learned it */
  agent?: string;
  agentRuns: number;
  agentWins: number;
  confirmations: number;
  /** Sessions that had it in their context and succeeded */
  helped: number;
  /** Sessions that had it in their context and hit the same failure anyway */
  repeated: number;
  stale: boolean;
  /** The merge it was learned in was reverted */
  revertedIn?: string;
  /** It is derived from something that was reverted */
  downgradedBy?: string;
}

export interface Trust {
  /** 0 to 1 */
  trust: number;
  /** What moved it, in words */
  why: string[];
}

/** Below this a lesson is left out of the context (confirming it brings it back). */
export const TRUST_FLOOR = 0.35;
/** Below this a lesson that is included is marked as low confidence in the prompt. */
export const TRUST_LOW = 0.5;

const sha7 = (sha: string) => sha.slice(0, 7);

/** The score from its factors: start at 0.6, then add and subtract for what happened since. */
export function trustScore(f: TrustFactors): Trust {
  let t = 0.6;
  const why: string[] = [];
  if (f.confirmations) {
    t += 0.1 * Math.min(f.confirmations, 2);
    why.push(`confirmed ${f.confirmations}×`);
  }
  if (f.helped) {
    t += 0.08 * Math.min(f.helped, 3);
    why.push(`in the context of ${f.helped} session(s) that succeeded`);
  }
  if (f.repeated) {
    // A repeat proves the lesson is real, so it never lowers trust; it says the wording did not land
    why.push(`hit again ${f.repeated}× even when it was shown`);
  }
  if (f.stale) {
    t -= 0.2;
    why.push('the code it is about changed since');
  }
  if (f.revertedIn) {
    t -= 0.4;
    why.push(`learned in ${sha7(f.revertedIn)}, which was reverted`);
  } else if (f.downgradedBy) {
    t -= 0.3;
    why.push(`builds on ${sha7(f.downgradedBy)}, which was reverted`);
  }
  if (f.agent && f.agentRuns >= 3) {
    const rate = f.agentWins / f.agentRuns;
    t += 0.2 * (rate - 0.5);
    why.push(`learned by ${f.agent}, which succeeds ${Math.round(rate * 100)}% of the time`);
  }
  return { trust: Math.round(Math.min(1, Math.max(0, t)) * 100) / 100, why };
}

const LABELS = ['Failure', 'Decision'] as const;

/** Q24: the factors for failures and decisions, read from the graph, then scored. */
export async function memoryTrust(
  graph: Graph,
  ids: { Failure?: string[]; Decision?: string[] },
): Promise<Map<string, Trust & { factors: TrustFactors }>> {
  const out = new Map<string, Trust & { factors: TrustFactors }>();
  const records = new Map(
    (
      await read<{ agent: string; runs: number; wins: number }>(
        graph,
        `MATCH (a:Agent)-[:RAN]->(s:Session) WHERE s.outcome IN ['success', 'failure']
         RETURN a.name AS agent, count(s) AS runs,
                sum(CASE WHEN s.outcome = 'success' THEN 1 ELSE 0 END) AS wins`,
      )
    ).map((r) => [r.agent, { runs: Number(r.runs), wins: Number(r.wins) }]),
  );
  for (const label of LABELS) {
    const list = ids[label] ?? [];
    if (!list.length) continue;
    // The label comes from a closed set, never from input.
    const base = await read<{
      id: string;
      agent: string | null;
      confirmations: number;
      stale: boolean;
      revertedIn: string | null;
      downgradedBy: string | null;
    }>(
      graph,
      `UNWIND $ids AS mid
       MATCH (m:${label} {id: mid})
       OPTIONAL MATCH (m)-[:LEARNED_IN]->(:Session)<-[:RAN]-(a:Agent)
       RETURN m.id AS id, head(collect(a.name)) AS agent, coalesce(m.confirmations, 0) AS confirmations,
              coalesce(m.stale, false) AS stale, m.revertedIn AS revertedIn, m.downgradedBy AS downgradedBy`,
      { ids: list },
    );
    const told = await read<{ id: string; helped: number }>(
      graph,
      `UNWIND $ids AS mid
       MATCH (m:${label} {id: mid})<-[:INCLUDED]-(:ContextPack)<-[:RECEIVED]-(se:Session)
       RETURN m.id AS id, count(DISTINCT CASE WHEN se.outcome = 'success' THEN se END) AS helped`,
      { ids: list },
    );
    const again =
      label === 'Failure'
        ? await read<{ id: string; repeated: number }>(
            graph,
            `UNWIND $ids AS mid
             MATCH (f:Failure {id: mid})<-[:INCLUDED]-(:ContextPack)<-[:RECEIVED]-(se:Session)-[:HIT]->(f)
             RETURN f.id AS id, count(DISTINCT se) AS repeated`,
            { ids: list },
          )
        : [];
    for (const b of base) {
      const rec = b.agent ? records.get(b.agent) : undefined;
      const factors: TrustFactors = {
        id: b.id,
        agent: b.agent ?? undefined,
        agentRuns: rec?.runs ?? 0,
        agentWins: rec?.wins ?? 0,
        confirmations: Number(b.confirmations),
        helped: Number(told.find((t) => t.id === b.id)?.helped ?? 0),
        repeated: Number(again.find((t) => t.id === b.id)?.repeated ?? 0),
        stale: Boolean(b.stale),
        revertedIn: b.revertedIn ?? undefined,
        downgradedBy: b.downgradedBy ?? undefined,
      };
      out.set(b.id, { ...trustScore(factors), factors });
    }
  }
  return out;
}
