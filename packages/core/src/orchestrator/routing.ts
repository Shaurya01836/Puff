// Q10: which agent should take a task. Declared strengths pick the candidates; their past results on
// the same capability rank them. An agent with no history scores a neutral 0.5. A task that touches
// load-bearing code (Q20: risk from PageRank and betweenness over CALLS) goes to an agent that
// declares `reasoning` first.
import type { Graph } from 'falkordb';
import type { AgentName } from '@puff/shared';
import { graphOff, type PuffConfig } from '../config';
import { read } from '../db/client';
import { taskRisk, type TaskRisk } from '../queries/insights';
import {
  agentExpertise,
  EXPERTISE_MARGIN,
  EXPERTISE_MIN_RUNS,
  smoothedRate,
  taskModules,
} from '../queries/modules';

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

export interface Route {
  /** The order to try agents in */
  agents: AgentName[];
  /** The decision in words, for the Why view and the trace */
  reason: string;
  /** Set when the task touches code at or above the risk threshold */
  risk?: TaskRisk;
  /** The modules the task is in, and the agent whose record there changed the order (Q28) */
  modules?: string[];
  expertise?: { agent: AgentName; module: string; runs: number; wins: number };
  graphOff?: boolean;
}

const pct = (risk: number) => `top ${Math.max(1, Math.round((1 - risk) * 100))}%`;

/**
 * The order to try agents in: the best declared match first, then the escalation chain from the
 * strongest down, so a task with no declared match (or an unavailable specialist) still gets an agent.
 * Risky code puts the agents that declare `reasoning` in front. With the graph off it is simply the
 * escalation order, cheapest first.
 */
export async function routeTask(graph: Graph, config: PuffConfig, taskId: string): Promise<Route> {
  const chain = config.escalation as AgentName[];
  if (graphOff(config)) {
    return {
      agents: [...chain],
      reason: `graph off: the escalation order (${chain.join(' → ')})`,
      graphOff: true,
    };
  }
  const ranked = await rankAgents(graph, taskId);
  const strongestFirst = [...chain].reverse();
  let agents = [...new Set([...ranked.map((r) => r.agent), ...strongestFirst])];
  const best = ranked[0];
  let reason = best
    ? `${best.agent} declares ${best.matched} of the task's capabilities` +
      (best.runs ? ` and won ${best.wins} of ${best.runs} earlier runs` : ' (no earlier runs)')
    : `no agent declares the task's capabilities: strongest first (${strongestFirst[0] ?? 'none'})`;

  // Q28: an agent with a real record in this task's module can lead, even if another declares the strength
  const modules = await taskModules(graph, taskId);
  let expertise: Route['expertise'];
  if (modules.length) {
    const record = await agentExpertise(graph, modules);
    const total = (agent: string) =>
      (record.get(agent) ?? []).reduce(
        (t, e) => ({ runs: t.runs + e.runs, wins: t.wins + e.wins }),
        { runs: 0, wins: 0 },
      );
    const lead = agents[0];
    if (lead) {
      const leadRec = total(lead);
      const leadRate = smoothedRate(leadRec.wins, leadRec.runs);
      const challenger = agents
        .filter((a) => a !== lead && total(a).runs >= EXPERTISE_MIN_RUNS)
        .map((a) => ({ a, rec: total(a), rate: smoothedRate(total(a).wins, total(a).runs) }))
        .sort((x, y) => y.rate - x.rate)[0];
      if (challenger && challenger.rate - leadRate >= EXPERTISE_MARGIN) {
        const name = modules.length === 1 ? modules[0]! : modules.join(', ');
        expertise = {
          agent: challenger.a,
          module: name,
          runs: challenger.rec.runs,
          wins: challenger.rec.wins,
        };
        agents = [challenger.a, ...agents.filter((a) => a !== challenger.a)];
        reason =
          `${challenger.a} has won ${challenger.rec.wins} of ${challenger.rec.runs} runs in the ${name} module` +
          (leadRec.runs
            ? ` (${lead} ${leadRec.wins} of ${leadRec.runs})`
            : ` (${lead} has not worked there)`) +
          `, so it goes first even though ${reason}`;
      }
    }
  }

  const risk = await taskRisk(graph, taskId);
  if (risk && risk.risk >= config.graph.riskThreshold) {
    const reasoning = Object.entries(config.harnesses)
      .filter(([, h]) => h.strengths.includes('reasoning'))
      .map(([name]) => name as AgentName);
    // keep the order among the reasoning agents, then everyone else as before
    const front = agents.filter((a) => reasoning.includes(a));
    const strongest = strongestFirst[0];
    const lead = front.length ? front : strongest ? [strongest] : [];
    agents = [...new Set([...lead, ...agents])];
    reason =
      `${agents[0]} because ${risk.name}() is in the ${pct(risk.risk)} of this code by risk ` +
      `(PageRank ${risk.pagerank.toFixed(3)}, betweenness ${Math.round(risk.betweenness)}` +
      (risk.openFailures ? `, ${risk.openFailures} open failure(s)` : '') +
      `): load-bearing code goes to an agent that declares reasoning`;
    return { agents, reason, risk, modules, expertise };
  }
  return { agents, reason, modules, expertise, ...(risk ? { risk } : {}) };
}

export async function candidateAgents(
  graph: Graph,
  config: PuffConfig,
  taskId: string,
): Promise<AgentName[]> {
  return (await routeTask(graph, config, taskId)).agents;
}
