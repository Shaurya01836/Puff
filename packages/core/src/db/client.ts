import { FalkorDB, type Graph } from 'falkordb';
import { graphName } from '../ids';
import { noteQuery } from './trace';

export const DEFAULT_FALKORDB_URL = 'falkor://localhost:6379';

/** Load `.env` from the working directory if present (Node's built-in loader; real env vars win). */
export function loadDotEnv(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // no .env file: rely on the real environment
  }
}

export async function connect(
  url = process.env.FALKORDB_URL ?? DEFAULT_FALKORDB_URL,
): Promise<FalkorDB> {
  let db: FalkorDB;
  try {
    db = await FalkorDB.connect({ url, socket: { connectTimeout: 5000 } });
  } catch (err) {
    throw new Error(
      `Could not connect to FalkorDB at ${url}. Is it running? (npm run db:up)\n  ${(err as Error).message}`,
    );
  }
  // A plain Redis on the same port accepts the connection but has no GRAPH.* commands.
  try {
    await db.list();
  } catch (err) {
    await db.close().catch(() => {});
    if (/unknown command/i.test((err as Error).message)) {
      throw new Error(
        `${url} is a Redis server without the FalkorDB module (another Redis is using the port?).\n` +
          `  Run FalkorDB on a free port: set FALKORDB_PORT=6380 and FALKORDB_URL=falkor://localhost:6380 in .env, then npm run db:up`,
      );
    }
    throw err;
  }
  return db;
}

/** Which connection opened each graph, so a copy of it can be opened on the same connection */
const owners = new WeakMap<Graph, FalkorDB>();

export const projectGraph = (db: FalkorDB, projectSlug: string): Graph => {
  const graph = db.selectGraph(graphName(projectSlug));
  owners.set(graph, db);
  return graph;
};

/** Another graph (a copy) on the connection that opened `graph`. */
export function openSibling(graph: Graph, name: string): Graph {
  const db = owners.get(graph);
  if (!db)
    throw new Error(
      'This graph was not opened through projectGraph(), so its copy cannot be opened',
    );
  const sibling = db.selectGraph(name);
  owners.set(sibling, db);
  return sibling;
}

/** Run a write query and return its rows typed as T. */
export async function run<T>(
  graph: Graph,
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const started = performance.now();
  const res = await graph.query<T>(cypher, { params: params as never });
  const rows = res.data ?? [];
  noteQuery(cypher, params, performance.now() - started, rows.length);
  return rows;
}

/** Run a read-only query and return its rows typed as T. */
export async function read<T>(
  graph: Graph,
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const started = performance.now();
  const res = await graph.roQuery<T>(cypher, { params: params as never });
  const rows = res.data ?? [];
  noteQuery(cypher, params, performance.now() - started, rows.length);
  return rows;
}
