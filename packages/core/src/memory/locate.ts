// Tie a failure to the code it is about. This is the link the whole memory idea rests on, so it is
// deliberately conservative and explainable: every answer says which strategy produced it.
//
// Strategies, best first:
//   stack           a non-test source frame in the stack trace (runtime errors)
//   diff            symbols whose lines the agent's diff touched (assertion failures: the stack only
//                   shows the test, not the code that caused it)
//   changed-target  task targets that live in files the agent changed
//   target          the task's own targets
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { symbolId } from '../ids';
import { langForPath, parseSource } from '../indexer/parser';
import { isTestFile } from '../indexer/walk';
import { sanitizeMessage } from './memory';

const ANSI = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, '');

export interface StackFrame {
  /** Repo-relative POSIX path when the frame is inside `root`, otherwise as printed */
  file: string;
  line: number;
  col: number;
  fn?: string;
}

/** Normalise a path from test output: file:// URLs, backslashes, and absolute paths under `root`. */
export function normalizePath(file: string, root?: string): string {
  let p = file.trim();
  if (/^file:\/\/\/[A-Za-z]:/.test(p)) p = p.slice('file:///'.length);
  else if (p.startsWith('file://')) p = p.slice('file://'.length);
  p = p.replace(/\\/g, '/');
  if (root) {
    const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (p.toLowerCase().startsWith(`${r.toLowerCase()}/`)) p = p.slice(r.length + 1);
  }
  return p.replace(/^\.\//, '');
}

// Vitest: `❯ taxFor src/cart/tax.ts:5:30` or `❯ test/cart.spec.ts:32:12`
const VITEST_FRAME = /^\s*[❯>]\s+(?:(\S+)\s+)?(\S+):(\d+):(\d+)\s*$/;
// Node/Jest: `at taxFor (/abs/src/cart/tax.ts:5:30)` or `at /abs/src/x.ts:1:2`
const NODE_FRAME = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

export function parseStackFrames(text: string, root?: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    const m = VITEST_FRAME.exec(raw) ?? NODE_FRAME.exec(raw);
    if (!m) continue;
    const line = Number(m[3]);
    if (!line) continue;
    frames.push({ fn: m[1], file: normalizePath(m[2]!, root), line, col: Number(m[4]) });
  }
  return frames;
}

/** Frames that say nothing about project source: dependencies, Node internals, absolute outside-root paths, tests. */
export function isNoiseFrame(f: StackFrame): boolean {
  return (
    /(^|\/)node_modules\//.test(f.file) ||
    f.file.startsWith('node:') ||
    f.file.startsWith('/') ||
    /^[A-Za-z]:\//.test(f.file) ||
    isTestFile(f.file)
  );
}

export interface TestFailure {
  test: string;
  file?: string;
  /** Headline only (first line), safe to store */
  message: string;
  frames: StackFrame[];
}

/** Parse failing tests from Vitest or Jest text output. Returns [] if none are recognisable. */
export function parseTestFailures(output: string, root?: string): TestFailure[] {
  const lines = stripAnsi(output).replace(/\r\n/g, '\n').split('\n');
  const headers: { idx: number; file?: string; test: string }[] = [];
  lines.forEach((l, idx) => {
    let m = /^\s*FAIL\s+(\S+)\s+>\s+(.+?)\s*$/.exec(l); // Vitest
    if (m) return void headers.push({ idx, file: normalizePath(m[1]!, root), test: m[2]! });
    m = /^\s*●\s+(.+?)\s*$/.exec(l); // Jest
    if (m && !/^Console\b/.test(m[1]!)) {
      headers.push({ idx, test: m[1]!.replace(/\s+›\s+/g, ' > ') });
    }
  });

  const seen = new Set<string>();
  const out: TestFailure[] = [];
  headers.forEach((h, i) => {
    const key = `${h.file ?? ''}|${h.test}`;
    if (seen.has(key)) return;
    seen.add(key);
    const end = headers[i + 1]?.idx ?? lines.length;
    const block: string[] = [];
    for (const l of lines.slice(h.idx + 1, end)) {
      if (/^\s*(Test Files|Tests)\s+\d+/.test(l)) break;
      block.push(l);
    }
    const message = sanitizeMessage(
      block.find(
        (l) => l.trim() && !/^\s*⎯+/.test(l) && !VITEST_FRAME.test(l) && !NODE_FRAME.test(l),
      ) ?? h.test,
    );
    out.push({
      test: h.test,
      file: h.file,
      message,
      frames: parseStackFrames(block.join('\n'), root),
    });
  });
  return out;
}

/** file → changed line numbers in the new version (added lines, plus the spot where lines were removed). */
export function parseUnifiedDiff(diff: string): Map<string, number[]> {
  const changed = new Map<string, number[]>();
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  let file: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const plus = /^\+\+\+ (?:b\/)?(.+?)\s*$/.exec(line);
    if (plus) {
      file = plus[1] === '/dev/null' ? undefined : plus[1];
      continue;
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk || !file) continue;
    let oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
    let newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
    let newLine = Number(hunk[2]);
    const list = changed.get(file) ?? [];
    // Consume exactly the lines the hunk header promises, so '--- ' content lines are not mistaken for headers.
    while ((oldLeft > 0 || newLeft > 0) && ++i < lines.length) {
      const l = lines[i]!;
      if (l.startsWith('+')) {
        list.push(newLine++);
        newLeft--;
      } else if (l.startsWith('-')) {
        list.push(Math.max(newLine, 1));
        oldLeft--;
      } else if (l.startsWith('\\')) {
        continue;
      } else {
        newLine++;
        oldLeft--;
        newLeft--;
      }
    }
    changed.set(file, list);
  }
  return changed;
}

export interface FileSymbol {
  id: string;
  startLine: number;
  endLine: number;
}
export type FileSymbols = (path: string) => Promise<FileSymbol[]>;

/**
 * Symbols as they are in a working tree right now. Failures come from the worktree an agent edited,
 * so line numbers must be resolved against those files, not against the graph's last-indexed state.
 */
export function worktreeSymbols(root: string): FileSymbols {
  const cache = new Map<string, Promise<FileSymbol[]>>();
  return (path) => {
    let hit = cache.get(path);
    if (!hit) {
      hit = (async () => {
        const lang = langForPath(path);
        if (!lang) return [];
        try {
          const text = await readFile(join(root, path), 'utf8');
          const parsed = await parseSource(text, lang);
          return parsed.defs.map((d) => ({
            id: symbolId(path, d.name),
            startLine: d.startLine,
            endLine: d.endLine,
          }));
        } catch {
          return []; // file deleted or unreadable
        }
      })();
      cache.set(path, hit);
    }
    return hit;
  };
}

/** The smallest symbol whose lines contain `line` (a method beats its class). */
export function innermost(symbols: FileSymbol[], line: number): FileSymbol | undefined {
  let best: FileSymbol | undefined;
  for (const s of symbols) {
    if (s.startLine <= line && line <= s.endLine) {
      if (!best || s.endLine - s.startLine < best.endLine - best.startLine) best = s;
    }
  }
  return best;
}

export type LocateVia = 'stack' | 'diff' | 'changed-target' | 'target';

export interface Location {
  symbolIds: string[];
  via: LocateVia;
}

export interface LocateInput {
  frames: StackFrame[];
  /** Symbols in a file of the working tree (see worktreeSymbols) */
  symbols: FileSymbols;
  /** Which symbol ids exist in the graph, so a failure never anchors to nothing */
  exists: (ids: string[]) => Promise<Set<string>>;
  /** Symbol ids the task targets */
  targets: string[];
  changedFiles?: string[];
  /** Unified diff of what the agent changed */
  diff?: string;
}

const MAX_SYMBOLS = 3;
const fileOf = (id: string): string => id.split('::')[0] ?? id;

export async function locateFailure(input: LocateInput): Promise<Location | undefined> {
  const targets = [...new Set(input.targets)];
  const inTargets = new Set(targets);

  // 1. Source frames in the stack.
  const fromStack: string[] = [];
  for (const f of input.frames.filter((fr) => !isNoiseFrame(fr))) {
    const sym = innermost(await input.symbols(f.file), f.line);
    if (sym && !fromStack.includes(sym.id)) fromStack.push(sym.id);
  }
  if (fromStack.length) {
    const alive = await input.exists(fromStack);
    const known = fromStack.filter((id) => alive.has(id));
    if (known.length) {
      // The innermost frame is the primary anchor; add the first frame that is a task target.
      const ids = [known[0]!];
      const target = known.find((id) => inTargets.has(id));
      if (target && !ids.includes(target)) ids.push(target);
      return { symbolIds: ids, via: 'stack' };
    }
  }

  // 2. Symbols the agent's diff touched.
  if (input.diff) {
    const touched: string[] = [];
    for (const [file, lines] of parseUnifiedDiff(input.diff)) {
      if (isTestFile(file)) continue;
      const symbols = await input.symbols(file);
      for (const line of lines) {
        const sym = innermost(symbols, line);
        if (sym && !touched.includes(sym.id)) touched.push(sym.id);
      }
    }
    const alive = await input.exists(touched);
    const known = touched.filter((id) => alive.has(id));
    const targeted = known.filter((id) => inTargets.has(id));
    const pick = (targeted.length ? targeted : known).slice(0, MAX_SYMBOLS);
    if (pick.length) return { symbolIds: pick, via: 'diff' };
  }

  // 3. Task targets in files the agent changed.
  const changed = new Set((input.changedFiles ?? []).map((f) => normalizePath(f)));
  const changedTargets = targets.filter((id) => changed.has(fileOf(id)));
  if (changedTargets.length) {
    const alive = await input.exists(changedTargets);
    const known = changedTargets.filter((id) => alive.has(id)).slice(0, MAX_SYMBOLS);
    if (known.length) return { symbolIds: known, via: 'changed-target' };
  }

  // 4. The task's own targets.
  if (targets.length) {
    const alive = await input.exists(targets);
    const known = targets.filter((id) => alive.has(id)).slice(0, MAX_SYMBOLS);
    if (known.length) return { symbolIds: known, via: 'target' };
  }
  return undefined;
}
