// Parse one source file into definitions, calls and imports with tree-sitter (WASM, no native build).
import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';

const resolveModulePath = createRequire(import.meta.url).resolve;

export type Lang = 'typescript' | 'tsx' | 'javascript';
export type SymbolKind = 'function' | 'class' | 'method';

export interface ParsedDef {
  /** `name` for functions/classes, `Class.method` for methods */
  name: string;
  kind: SymbolKind;
  /** 1-based, inclusive */
  startLine: number;
  endLine: number;
  signature: string;
  startIndex: number;
  endIndex: number;
}

export interface ParsedCall {
  /** Called name: `foo` in `foo()`, `bar` in `x.bar()`, `X` in `new X()` */
  name: string;
  /** Receiver for member calls: `x` in `x.bar()`, `this` for `this.bar()` */
  object?: string;
  /** Enclosing definition name; undefined for top-level calls */
  from?: string;
}

export interface ParsedImport {
  /** Module specifier as written: `./login`, `express`, `node:crypto` */
  source: string;
  /** Local binding → name exported by the module (`default` / `*` for default and namespace imports) */
  bindings: Record<string, string>;
}

export interface ParsedFile {
  defs: ParsedDef[];
  calls: ParsedCall[];
  imports: ParsedImport[];
}

const QUERY = `
(function_declaration name: (identifier) @def.function)
(variable_declarator name: (identifier) @def.function value: [(arrow_function) (function_expression)])
(method_definition name: (property_identifier) @def.method)
(class_declaration name: (type_identifier) @def.class)
(call_expression function: (identifier) @call)
(call_expression function: (member_expression property: (property_identifier) @call.member))
(new_expression constructor: (identifier) @call)
(import_statement) @import
`;

const QUERY_JS = QUERY.replace(
  '(class_declaration name: (type_identifier) @def.class)',
  '(class_declaration name: (identifier) @def.class)',
);

const WASM: Record<Lang, string> = {
  typescript: 'tree-sitter-wasms/out/tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-wasms/out/tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-wasms/out/tree-sitter-javascript.wasm',
};

interface Loaded {
  parser: Parser;
  query: Parser.Query;
}

let ready: Promise<void> | undefined;
const loaded = new Map<Lang, Promise<Loaded>>();

async function load(lang: Lang): Promise<Loaded> {
  ready ??= Parser.init();
  await ready;
  let entry = loaded.get(lang);
  if (!entry) {
    entry = (async () => {
      const language = await Parser.Language.load(resolveModulePath(WASM[lang]));
      const parser = new Parser();
      parser.setLanguage(language);
      return { parser, query: language.query(lang === 'javascript' ? QUERY_JS : QUERY) };
    })();
    loaded.set(lang, entry);
  }
  return entry;
}

export function langForPath(path: string): Lang | undefined {
  if (/\.tsx$/.test(path)) return 'tsx';
  if (/\.(ts|mts|cts)$/.test(path)) return 'typescript';
  if (/\.(js|jsx|mjs|cjs)$/.test(path)) return 'javascript';
  return undefined;
}

const DEF_NODE_TYPES = new Set([
  'function_declaration',
  'variable_declarator',
  'method_definition',
  'class_declaration',
]);

/** The statement a definition spans, widened over `const` and `export` wrappers. */
function definitionNode(name: Parser.SyntaxNode): Parser.SyntaxNode {
  let node = name.parent!;
  while (node && !DEF_NODE_TYPES.has(node.type)) node = node.parent!;
  if (node.parent?.type === 'lexical_declaration') node = node.parent;
  if (node.parent?.type === 'export_statement') node = node.parent;
  return node;
}

function signatureOf(node: Parser.SyntaxNode): string {
  const firstLine = node.text.split('\n')[0] ?? '';
  return firstLine
    .replace(/\s*\{\s*$/, '')
    .trim()
    .slice(0, 160);
}

function enclosingClass(node: Parser.SyntaxNode): string | undefined {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === 'class_declaration' || p.type === 'class')
      return p.childForFieldName('name')?.text;
  }
  return undefined;
}

function parseImport(node: Parser.SyntaxNode): ParsedImport | undefined {
  const source = node.childForFieldName('source')?.text.slice(1, -1);
  if (!source) return undefined;
  const bindings: Record<string, string> = {};
  for (const spec of node.descendantsOfType('import_specifier')) {
    const imported = spec.childForFieldName('name')?.text;
    const local = spec.childForFieldName('alias')?.text ?? imported;
    if (imported && local) bindings[local] = imported;
  }
  const clause = node.children.find((c) => c.type === 'import_clause');
  for (const child of clause?.namedChildren ?? []) {
    if (child.type === 'identifier') bindings[child.text] = 'default';
    if (child.type === 'namespace_import') {
      const local = child.namedChildren.find((c) => c.type === 'identifier')?.text;
      if (local) bindings[local] = '*';
    }
  }
  return { source, bindings };
}

export async function parseSource(source: string, lang: Lang): Promise<ParsedFile> {
  const { parser, query } = await load(lang);
  const tree = parser.parse(source);
  const defs: ParsedDef[] = [];
  const rawCalls: { name: string; object?: string; index: number }[] = [];
  const imports: ParsedImport[] = [];

  for (const { name, node } of query.captures(tree.rootNode)) {
    if (name.startsWith('def.')) {
      const kind = name.slice(4) as SymbolKind;
      const def = definitionNode(node);
      const cls = kind === 'method' ? enclosingClass(node) : undefined;
      if (kind === 'method' && !cls) continue; // object-literal methods are not symbols
      defs.push({
        name: cls ? `${cls}.${node.text}` : node.text,
        kind,
        startLine: def.startPosition.row + 1,
        endLine: def.endPosition.row + 1,
        signature: signatureOf(def),
        startIndex: def.startIndex,
        endIndex: def.endIndex,
      });
    } else if (name === 'call') {
      rawCalls.push({ name: node.text, index: node.startIndex });
    } else if (name === 'call.member') {
      const object = node.parent?.childForFieldName('object');
      rawCalls.push({
        name: node.text,
        object: object?.type === 'this' ? 'this' : object?.text,
        index: node.startIndex,
      });
    } else if (name === 'import') {
      const imp = parseImport(node);
      if (imp) imports.push(imp);
    }
  }

  // Attribute each call to the innermost definition that contains it.
  const calls = rawCalls.map(({ name, object, index }) => {
    let from: ParsedDef | undefined;
    for (const d of defs) {
      if (d.startIndex <= index && index < d.endIndex) {
        if (!from || d.endIndex - d.startIndex < from.endIndex - from.startIndex) from = d;
      }
    }
    return { name, object, from: from?.name };
  });

  tree.delete();
  return { defs, calls, imports };
}
