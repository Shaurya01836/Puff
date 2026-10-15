import { ulid } from 'ulid';

/** Id prefixes by graph label, so ids are readable and never collide across labels. */
export const ID_PREFIX = {
  Task: 'task',
  Session: 'ses',
  Failure: 'fail',
  Solution: 'sol',
  Decision: 'dec',
  Procedure: 'proc',
  ContextPack: 'pack',
  Handoff: 'hand',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

export const newId = (kind: IdKind): string => `${ID_PREFIX[kind]}_${ulid()}`;

/** Symbol ids are stable and derived from code: `path::name` or `path::Class.method`. */
export const symbolId = (path: string, name: string): string => `${path}::${name}`;

/** Project slug used in the graph name: lowercase, `[a-z0-9_]`, no leading/trailing underscores. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!slug) throw new Error(`Cannot derive a project slug from "${name}"`);
  return slug;
}

export const graphName = (projectSlug: string): string => `puff_${projectSlug}`;
