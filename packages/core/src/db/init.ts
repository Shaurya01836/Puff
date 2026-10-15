import type { FalkorDB, Graph } from 'falkordb';
import { allCapabilities, type PuffConfig } from '../config';
import { projectGraph, read, run } from './client';
import { FULLTEXT_INDEXES, RANGE_INDEXES, isAlreadyIndexedError, rangeIndexCypher } from './schema';

export interface ProjectInfo {
  slug: string;
  name: string;
  repoPath: string;
}

async function ignoreExisting(op: () => Promise<unknown>): Promise<void> {
  try {
    await op();
  } catch (err) {
    if (!isAlreadyIndexedError(err)) throw err;
  }
}

/**
 * Create (or refresh) a project's graph: Project root node, indexes, and the agent pool from config.
 * Must run before any read: a read-only query on a graph that doesn't exist yet fails in FalkorDB.
 * Idempotent: safe to call on every app start.
 */
export async function initProjectGraph(
  db: FalkorDB,
  project: ProjectInfo,
  config: PuffConfig,
): Promise<Graph> {
  const graph = projectGraph(db, project.slug);

  await run(
    graph,
    `MERGE (p:Project {id: $id})
     SET p.name = $name, p.repoPath = $repoPath, p.updatedAt = timestamp()`,
    { id: project.slug, name: project.name, repoPath: project.repoPath },
  );

  for (const [label, property] of RANGE_INDEXES) {
    await ignoreExisting(() => graph.query(rangeIndexCypher(label, property)));
  }
  for (const [label, property] of FULLTEXT_INDEXES) {
    await ignoreExisting(() => graph.createNodeFulltextIndex(label, property));
  }

  await syncAgentPool(graph, config);
  return graph;
}

/** Write Agent, Capability and declared HAS_STRENGTH edges from config, so routing is a pure graph query. */
export async function syncAgentPool(graph: Graph, config: PuffConfig): Promise<void> {
  await run(graph, `UNWIND $caps AS name MERGE (:Capability {name: name})`, {
    caps: allCapabilities(config),
  });

  const agents = Object.entries(config.harnesses).map(([name, h]) => ({
    name,
    instances: h.instances,
    strengths: h.strengths,
  }));

  await run(
    graph,
    `UNWIND $agents AS ag
     MERGE (a:Agent {name: ag.name})
     SET a.instances = ag.instances`,
    { agents },
  );
  // Drop declared strengths that are no longer in config, then (re)declare the current ones.
  await run(
    graph,
    `UNWIND $agents AS ag
     MATCH (a:Agent {name: ag.name})-[h:HAS_STRENGTH {declared: true}]->(c:Capability)
     WHERE NOT c.name IN ag.strengths
     DELETE h`,
    { agents },
  );
  await run(
    graph,
    `UNWIND $agents AS ag
     MATCH (a:Agent {name: ag.name})
     UNWIND ag.strengths AS cap
     MATCH (c:Capability {name: cap})
     MERGE (a)-[h:HAS_STRENGTH]->(c)
     SET h.declared = true`,
    { agents },
  );
}

export interface GraphStats {
  labels: Record<string, number>;
  relationships: Record<string, number>;
}

export async function graphStats(graph: Graph): Promise<GraphStats> {
  const labels = await read<{ label: string; n: number }>(
    graph,
    `MATCH (n) RETURN labels(n)[0] AS label, count(n) AS n ORDER BY label`,
  );
  const rels = await read<{ type: string; n: number }>(
    graph,
    `MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS n ORDER BY type`,
  );
  return {
    labels: Object.fromEntries(labels.map((r) => [r.label, r.n])),
    relationships: Object.fromEntries(rels.map((r) => [r.type, r.n])),
  };
}
