// Pure parsers for what each CLI prints. Tested against output captured from the real CLIs.
import type { AgentError } from './types';

export interface Parsed {
  output: string;
  /** Distinct files the agent opened with its read tool. Only reported where the CLI prints tool calls. */
  filesRead?: number;
  tokensIn?: number;
  cachedIn?: number;
  tokensOut?: number;
  costUsd?: number;
  error?: AgentError;
}

const AUTH =
  /authenticat|oauth|log ?in|sign ?in|credential|unauthori[sz]ed|\b401\b|api key|session expired|token (?:has )?expired/i;

const LIMIT =
  /session limit|usage limit|rate limit|quota|too many requests|\b429\b|credit balance|resets? (?:at|in)\b/i;

/**
 * The provider said "no more for now" (a usage or session limit, a rate limit). Trying the same agent again
 * on the next task only wastes time until the limit lifts, so Puff skips it for the rest of the run.
 */
export function isLimitError(error: AgentError): boolean {
  return error.kind === 'api' && LIMIT.test(error.message);
}

/** Sort an error message into auth problems and everything else the provider can say. */
export function classifyError(message: string): AgentError {
  return { kind: AUTH.test(message) ? 'auth' : 'api', message: message.trim().slice(0, 500) };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function jsonLines(stdout: string): Record<string, any>[] {
  const events: Record<string, any>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      // a partial or non-JSON line: ignore
    }
  }
  return events;
}

/**
 * Claude Code: `claude -p --output-format json` prints one result object.
 * `usage.input_tokens` excludes cache reads and writes, which are separate fields.
 */
export function parseClaude(stdout: string): Parsed {
  let j: Record<string, any>;
  try {
    j = JSON.parse(stdout.trim());
  } catch {
    // `--output-format stream-json` prints one event per line; the last `result` event is the same
    // object `--output-format json` prints on its own.
    const result = jsonLines(stdout)
      .reverse()
      .find((e) => e.type === 'result');
    if (!result) {
      return {
        output: '',
        error: {
          kind: 'crash',
          message: `Claude Code printed no JSON result: ${stdout.trim().slice(0, 200) || '(empty)'}`,
        },
      };
    }
    j = result;
  }
  // Some versions wrap events in an array; the result is the last element with type "result".
  if (Array.isArray(j)) j = [...j].reverse().find((e) => e?.type === 'result') ?? {};
  const u = j.usage ?? {};
  const cached = num(u.cache_read_input_tokens);
  const parsed: Parsed = {
    output: typeof j.result === 'string' ? j.result : '',
    tokensIn: num(u.input_tokens) + num(u.cache_creation_input_tokens) + cached,
    cachedIn: cached,
    tokensOut: num(u.output_tokens),
    costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : undefined,
  };
  if (j.is_error === true || (j.subtype && j.subtype !== 'success')) {
    parsed.error = classifyError(
      parsed.output || String(j.subtype ?? 'Claude Code reported an error'),
    );
  }
  return parsed;
}

/**
 * Codex: `codex exec --json` prints one event per line. `input_tokens` already includes the
 * cached part (`cached_input_tokens`), and `output_tokens` is the whole output.
 */
export function parseCodex(stdout: string): Parsed {
  const messages: string[] = [];
  let tokensIn = 0;
  let cachedIn = 0;
  let tokensOut = 0;
  let sawUsage = false;
  let error: AgentError | undefined;

  for (const ev of jsonLines(stdout)) {
    if (
      ev.type === 'item.completed' &&
      ev.item?.type === 'agent_message' &&
      typeof ev.item.text === 'string'
    ) {
      messages.push(ev.item.text);
    } else if (ev.type === 'turn.completed' && ev.usage) {
      sawUsage = true;
      tokensIn += num(ev.usage.input_tokens);
      cachedIn += num(ev.usage.cached_input_tokens);
      tokensOut += num(ev.usage.output_tokens);
    } else if (
      ev.type === 'error' ||
      ev.type === 'turn.failed' ||
      (ev.type === 'item.completed' && ev.item?.type === 'error')
    ) {
      const message =
        ev.message ?? ev.error?.message ?? ev.item?.message ?? 'Codex reported an error';
      error ??= classifyError(String(message));
    }
  }
  return {
    output: messages.join('\n\n'),
    tokensIn: sawUsage ? tokensIn : undefined,
    cachedIn: sawUsage ? cachedIn : undefined,
    tokensOut: sawUsage ? tokensOut : undefined,
    error,
  };
}

/**
 * OpenCode: `opencode run --format json` prints events; `step_finish` carries tokens per step.
 * `input` excludes cache reads/writes, and reasoning tokens are counted separately.
 */
export function parseOpenCode(stdout: string): Parsed {
  const texts: string[] = [];
  let tokensIn = 0;
  let cachedIn = 0;
  let tokensOut = 0;
  let cost = 0;
  let sawTokens = false;
  let error: AgentError | undefined;
  const read = new Set<string>();

  for (const ev of jsonLines(stdout)) {
    if (ev.type === 'text' && typeof ev.part?.text === 'string') {
      texts.push(ev.part.text);
    } else if (ev.type === 'tool_use' && ev.part?.tool === 'read') {
      const file = ev.part.state?.input?.filePath;
      if (typeof file === 'string') read.add(file.replaceAll('\\', '/'));
    } else if (ev.type === 'step_finish' && ev.part?.tokens) {
      sawTokens = true;
      const t = ev.part.tokens;
      const cacheRead = num(t.cache?.read);
      tokensIn += num(t.input) + cacheRead + num(t.cache?.write);
      cachedIn += cacheRead;
      tokensOut += num(t.output) + num(t.reasoning);
      cost += num(ev.part.cost);
    } else if (ev.type === 'error') {
      const message =
        ev.error?.data?.message ?? ev.error?.message ?? ev.message ?? 'OpenCode reported an error';
      error ??= classifyError(String(message));
    }
  }
  return {
    output: texts.join('\n\n'),
    filesRead: sawTokens ? read.size : undefined,
    tokensIn: sawTokens ? tokensIn : undefined,
    cachedIn: sawTokens ? cachedIn : undefined,
    tokensOut: sawTokens ? tokensOut : undefined,
    costUsd: sawTokens ? cost : undefined,
    error,
  };
}
