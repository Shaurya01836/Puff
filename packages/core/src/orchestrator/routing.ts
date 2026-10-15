// Q10: which agent should take a task. Declared strengths pick the candidates; their past results on
// the same capability rank them. An agent with no history scores a neutral 0.5.
import type { Graph } from 'falkordb';
import type { AgentName } from '@puff/shared';
import type { PuffConfig } from '../config';
import { read } from '../db/client';

export interface AgentRank {
  agent: AgentName;
  /** How many of the task's required capabilities this agent declares */
  matched: number;
  runs: number;
  wins: number;
  successRate: number;
}

export async function rankAgents(graph: Graph, taskId: string): Promise<AgentRank[]> {
  const rows = await read<{ agent: string; runs: number; wins: number }>(
    graph,
    `MATCH (:Task {id: $id})-[:REQUIRES]->(c:Capability)<-[:HAS_STRENGTH]-(a:Agent)
     OPTIONAL MATCH (a)-[:RAN]->(s:Session)-[:WORKED_ON]->(:Task)-[:REQUIRES]->(c)
     WHERE s.outcome IN ['success', 'failure']
     WITH a, c, collect(DISTINCT s) AS ss
     RETURN a.name AS agent, size(ss) AS runs, size([x IN ss WHERE x.outcome = 'success']) AS wins`,
    { id: taskId },
  );
  const byAgent = new Map<string, AgentRank>();
  for (const r of rows) {
    const cur = byAgent.get(r.agent) ?? {
      agent: r.agent as AgentName,
      matched: 0,
      runs: 0,
      wins: 0,
      successRate: 0.5,
    };
    cur.matched += 1;
    cur.runs += Number(r.runs);
    cur.wins += Number(r.wins);
    byAgent.set(r.agent, cur);
  }
  return [...byAgent.values()]
    .map((a) => ({ ...a, successRate: a.runs ? a.wins / a.runs : 0.5 }))
    .sort(
      (a, b) =>
        b.matched - a.matched ||
        b.successRate - a.successRate ||
        b.runs - a.runs ||
        a.agent.localeCompare(b.agent),
    );
}

/**
 * The order to try agents in: the best declared match first, then the escalation chain from the
 * strongest down, so a task with no declared match (or an unavailable specialist) still gets an agent.
 */
export async function candidateAgents(
  graph: Graph,
  config: PuffConfig,
  taskId: string,
): Promise<AgentName[]> {
  const ranked = (await rankAgents(graph, taskId)).map((r) => r.agent);
  const strongestFirst = [...config.escalation].reverse() as AgentName[];
  return [...new Set([...ranked, ...strongestFirst])];
}
