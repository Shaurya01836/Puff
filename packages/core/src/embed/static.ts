// Text embeddings without a model server or native code: a static (model2vec) model is a word-piece
// tokenizer and one vector per token. A text's vector is the mean of its tokens' vectors, normalised to
// length 1, so cosine similarity is a dot product. Used for the vector index on lessons (Q32).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The default model: minishlab/potion-base-8M (MIT), 256 dimensions, 30 MB */
export const DEFAULT_EMBED_MODEL = 'minishlab/potion-base-8M';
const FILES = ['vocab.txt', 'model.safetensors'] as const;

export interface Embedder {
  model: string;
  dimension: number;
  embed(text: string): Float32Array;
}

/** Where models are kept: PUFF_MODELS_DIR, else ~/.puff/models */
export function modelsDir(): string {
  return process.env.PUFF_MODELS_DIR || join(homedir(), '.puff', 'models');
}

const folderFor = (model: string) => join(modelsDir(), model.replace(/[\\/]/g, '__'));

/** Download the model's files once (atomically: a half-written file is never used). */
export async function ensureModel(model = DEFAULT_EMBED_MODEL): Promise<string> {
  const dir = folderFor(model);
  mkdirSync(dir, { recursive: true });
  for (const f of FILES) {
    const path = join(dir, f);
    if (existsSync(path)) continue;
    const res = await fetch(`https://huggingface.co/${model}/resolve/main/${f}`);
    if (!res.ok) throw new Error(`Could not download ${model}/${f}: HTTP ${res.status}`);
    writeFileSync(`${path}.part`, Buffer.from(await res.arrayBuffer()));
    renameSync(`${path}.part`, path);
  }
  return dir;
}

/** Load a model that is on disk. Undefined when it has not been downloaded. */
export function loadEmbedder(model = DEFAULT_EMBED_MODEL): Embedder | undefined {
  const dir = folderFor(model);
  if (!FILES.every((f) => existsSync(join(dir, f)))) return undefined;
  const vocab = new Map<string, number>();
  readFileSync(join(dir, 'vocab.txt'), 'utf8')
    .split(/\r?\n/)
    .forEach((token, id) => token && vocab.set(token, id));
  const { table, rows, dimension } = readTable(readFileSync(join(dir, 'model.safetensors')));
  if (rows !== vocab.size) throw new Error(`${model}: ${rows} vectors for ${vocab.size} tokens`);
  const unk = vocab.get('[UNK]');
  return {
    model,
    dimension,
    embed(text: string): Float32Array {
      const out = new Float32Array(dimension);
      let n = 0;
      for (const word of basicTokens(text)) {
        for (const id of wordPiece(word, vocab, unk)) {
          if (id === unk) continue;
          const at = id * dimension;
          for (let i = 0; i < dimension; i++) out[i]! += table[at + i]!;
          n++;
        }
      }
      if (n === 0) return out;
      let norm = 0;
      for (let i = 0; i < dimension; i++) norm += out[i]! * out[i]!;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < dimension; i++) out[i]! /= norm;
      return out;
    },
  };
}

/** The one F32 tensor of a model2vec safetensors file */
function readTable(buf: Buffer): { table: Float32Array; rows: number; dimension: number } {
  const headerLen = Number(buf.readBigUInt64LE(0));
  const header = JSON.parse(buf.subarray(8, 8 + headerLen).toString('utf8')) as Record<
    string,
    { dtype: string; shape: number[]; data_offsets: [number, number] }
  >;
  const entry = Object.entries(header).find(([k]) => k !== '__metadata__')?.[1];
  if (!entry || entry.dtype !== 'F32' || entry.shape.length !== 2)
    throw new Error('Expected one F32 matrix in model.safetensors');
  const [start, end] = entry.data_offsets;
  const bytes = buf.subarray(8 + headerLen + start, 8 + headerLen + end);
  // copy into an aligned buffer: the data may start at any byte
  const table = new Float32Array(new Uint8Array(bytes).buffer);
  return { table, rows: entry.shape[0]!, dimension: entry.shape[1]! };
}

const isPunct = (ch: string) => /[\p{P}\p{S}]/u.test(ch);
const isCjk = (cp: number) =>
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x20000 && cp <= 0x2a6df) ||
  (cp >= 0xf900 && cp <= 0xfaff);

/** BERT's basic tokenizer: clean, lowercase, strip accents, split on spaces and around punctuation */
export function basicTokens(text: string): string[] {
  let s = '';
  for (const ch of text.normalize('NFD').toLowerCase()) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0 || cp === 0xfffd || /\p{Cc}/u.test(ch)) {
      if (/\s/.test(ch)) s += ' ';
      continue;
    }
    if (/\p{Mn}/u.test(ch)) continue; // accents
    s += isPunct(ch) || isCjk(cp) ? ` ${ch} ` : ch;
  }
  return s.split(/\s+/).filter(Boolean);
}

/** Greedy longest-match word pieces; a word that cannot be split is one unknown token */
export function wordPiece(word: string, vocab: Map<string, number>, unk?: number): number[] {
  if (word.length > 100) return unk === undefined ? [] : [unk];
  const ids: number[] = [];
  let start = 0;
  while (start < word.length) {
    let end = word.length;
    let found: number | undefined;
    while (start < end) {
      const piece = (start > 0 ? '##' : '') + word.slice(start, end);
      found = vocab.get(piece);
      if (found !== undefined) break;
      end--;
    }
    if (found === undefined) return unk === undefined ? [] : [unk];
    ids.push(found);
    start = end;
  }
  return ids;
}

/** Cosine similarity of two normalised vectors */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}
