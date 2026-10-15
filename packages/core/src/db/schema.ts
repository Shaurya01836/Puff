// Indexes created for every project graph at startup (see docs/GRAPH_SCHEMA.md#indexes).

export const RANGE_INDEXES: readonly [label: string, property: string][] = [
  ['Project', 'id'],
  ['File', 'path'],
  ['Symbol', 'id'],
  ['Symbol', 'name'],
  ['Symbol', 'file'],
  ['Task', 'id'],
  ['Task', 'status'],
  ['Session', 'id'],
  ['Agent', 'name'],
  ['Capability', 'name'],
  ['Technology', 'name'],
  ['Failure', 'id'],
  ['Solution', 'id'],
  ['Decision', 'id'],
  ['Procedure', 'id'],
  ['ContextPack', 'id'],
  ['Handoff', 'id'],
];

export const FULLTEXT_INDEXES: readonly [label: string, property: string][] = [
  ['Failure', 'message'],
];

export const rangeIndexCypher = (label: string, property: string): string =>
  `CREATE INDEX FOR (n:${label}) ON (n.${property})`;

/** FalkorDB rejects re-creating an existing index; treat that as success so init stays idempotent. */
export const isAlreadyIndexedError = (err: unknown): boolean =>
  /already indexed|already exists/i.test((err as Error)?.message ?? '');
