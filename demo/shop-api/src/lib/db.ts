// Tiny in-memory store. Good enough for a demo; swap for a real database later.

export interface Row {
  id: string;
}

const tables = new Map<string, Map<string, Row>>();

function table<T extends Row>(name: string): Map<string, T> {
  if (!tables.has(name)) tables.set(name, new Map());
  return tables.get(name) as Map<string, T>;
}

export function insert<T extends Row>(name: string, row: T): T {
  table<T>(name).set(row.id, { ...row });
  return row;
}

export function query<T extends Row>(name: string, where: Partial<T> = {}): T[] {
  return [...table<T>(name).values()]
    .filter((row) => Object.entries(where).every(([k, v]) => row[k as keyof T] === v))
    .map((row) => ({ ...row }));
}

export function findById<T extends Row>(name: string, id: string): T | undefined {
  const row = table<T>(name).get(id);
  return row ? { ...row } : undefined;
}

export function update<T extends Row>(name: string, id: string, patch: Partial<T>): T | undefined {
  const t = table<T>(name);
  const row = t.get(id);
  if (!row) return undefined;
  const next = { ...row, ...patch, id };
  t.set(id, next);
  return { ...next };
}

export function remove(name: string, id: string): boolean {
  return table(name).delete(id);
}

export function resetDb(): void {
  tables.clear();
}
