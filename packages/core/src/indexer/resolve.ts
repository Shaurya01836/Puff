// Turn per-file parse results into graph facts: symbols, resolved calls, file imports, technologies.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { symbolId } from '../ids';
import type { ParsedFile, SymbolKind } from './parser';

export interface SourceFile {
  /** Repo-relative POSIX path */
  path: string;
  lang: string;
  hash: string;
  isTest: boolean;
  parsed: ParsedFile;
  /** Source text, used to hash each symbol's body */
  text?: string;
}

export interface SymbolFact {
  id: string;
  name: string;
  kind: SymbolKind;
  file: string;
  startLine: number;
  endLine: number;
  signature: string;
  /** Hash of the symbol's own lines: memory goes stale when this changes, not when the file does */
  bodyHash: string;
}

const bodyHashOf = (lines: string[] | undefined, start: number, end: number): string =>
  lines
    ? createHash('sha256')
        .update(lines.slice(start - 1, end).join('\n'))
        .digest('hex')
        .slice(0, 16)
    : '';

export interface CallFact {
  from: string;
  to: string;
}

export interface ImportFact {
  from: string;
  to: string;
}

export interface UsesFact {
  file: string;
  technology: string;
}

export interface ResolvedRepo {
  symbols: SymbolFact[];
  calls: CallFact[];
  imports: ImportFact[];
  uses: UsesFact[];
}

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'];

/** Resolve a relative module specifier to a repo file, trying extensions and index files. */
export function resolveModule(
  fromFile: string,
  source: string,
  files: Set<string>,
): string | undefined {
  if (!source.startsWith('.')) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(fromFile), source));
  const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
  const candidates = [
    base,
    ...EXTENSIONS.map((ext) => stem + ext),
    ...EXTENSIONS.map((ext) => `${stem}/index${ext}`),
  ];
  return candidates.find((c) => files.has(c));
}

/** npm package name from a bare specifier: `express`, `@scope/pkg/sub` → `@scope/pkg`. */
export function packageName(source: string): string | undefined {
  if (source.startsWith('.') || source.startsWith('/')) return undefined;
  if (source.startsWith('node:')) return 'node';
  const parts = source.split('/');
  return source.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const KNOWN_TECH: Record<string, string> = {
  express: 'Express',
  react: 'React',
  'react-dom': 'React',
  next: 'Next.js',
  vue: 'Vue',
  vitest: 'Vitest',
  jest: 'Jest',
  '@jest/globals': 'Jest',
  supertest: 'Supertest',
  pg: 'Postgres',
  mongoose: 'MongoDB',
  mongodb: 'MongoDB',
  '@prisma/client': 'Prisma',
  redis: 'Redis',
  zod: 'Zod',
  node: 'Node.js',
};

const LANG_TECH: Record<string, string> = {
  typescript: 'TypeScript',
  tsx: 'TypeScript',
  javascript: 'JavaScript',
};

/**
 * Resolve calls by name: imported binding first, then the same file, then methods on known classes.
 * Unresolved calls (library calls like `console.log`, `res.json`) are dropped on purpose.
 */
export function resolveRepo(sources: SourceFile[], dependencies: Set<string>): ResolvedRepo {
  const files = new Set(sources.map((s) => s.path));
  const symbols: SymbolFact[] = [];
  /** file → def name → symbol id */
  const defsByFile = new Map<string, Map<string, string>>();
  /** file → class names defined there */
  const classesByFile = new Map<string, Set<string>>();

  for (const s of sources) {
    const defs = new Map<string, string>();
    const classes = new Set<string>();
    const lines = s.text?.split(/\r?\n/);
    for (const d of s.parsed.defs) {
      const id = symbolId(s.path, d.name);
      if (defs.has(d.name)) continue; // overloads / redeclarations: first wins
      defs.set(d.name, id);
      if (d.kind === 'class') classes.add(d.name);
      symbols.push({
        id,
        name: d.name,
        kind: d.kind,
        file: s.path,
        startLine: d.startLine,
        endLine: d.endLine,
        signature: d.signature,
        bodyHash: bodyHashOf(lines, d.startLine, d.endLine),
      });
    }
    defsByFile.set(s.path, defs);
    classesByFile.set(s.path, classes);
  }

  const calls = new Map<string, CallFact>();
  const imports = new Map<string, ImportFact>();
  const uses = new Map<string, UsesFact>();
  const addUse = (file: string, technology: string) =>
    uses.set(`${file}|${technology}`, { file, technology });

  for (const s of sources) {
    const tech = LANG_TECH[s.lang];
    if (tech) addUse(s.path, tech);
    const ownDefs = defsByFile.get(s.path)!;

    /** local binding → [file, exported name] for relative imports */
    const bindings = new Map<string, [string, string]>();
    for (const imp of s.parsed.imports) {
      const target = resolveModule(s.path, imp.source, files);
      if (target) {
        imports.set(`${s.path}|${target}`, { from: s.path, to: target });
        for (const [local, exported] of Object.entries(imp.bindings))
          bindings.set(local, [target, exported]);
        continue;
      }
      const pkg = packageName(imp.source);
      if (pkg && (pkg === 'node' || dependencies.has(pkg) || KNOWN_TECH[pkg])) {
        addUse(s.path, KNOWN_TECH[pkg] ?? pkg);
      }
    }

    const lookup = (file: string, name: string) => defsByFile.get(file)?.get(name);

    for (const call of s.parsed.calls) {
      if (!call.from) continue;
      const from = ownDefs.get(call.from);
      if (!from) continue;
      let to: string | undefined;

      if (!call.object) {
        const bound = bindings.get(call.name);
        to = bound
          ? lookup(bound[0], bound[1] === 'default' ? call.name : bound[1])
          : ownDefs.get(call.name);
      } else if (call.object === 'this') {
        const cls = call.from.includes('.') ? call.from.split('.')[0] : undefined;
        to = cls ? ownDefs.get(`${cls}.${call.name}`) : undefined;
      } else {
        // `Session.start()` on an imported or local class
        const bound = bindings.get(call.object);
        if (bound && bound[1] !== '*') to = lookup(bound[0], `${bound[1]}.${call.name}`);
        else if (bound && bound[1] === '*') to = lookup(bound[0], call.name);
        else if (classesByFile.get(s.path)?.has(call.object))
          to = ownDefs.get(`${call.object}.${call.name}`);
      }

      if (to && to !== from) calls.set(`${from}|${to}`, { from, to });
    }
  }

  return {
    symbols,
    calls: [...calls.values()],
    imports: [...imports.values()],
    uses: [...uses.values()],
  };
}
