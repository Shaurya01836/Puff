// Agents end their answer with <puff-report>{...}</puff-report>. This is how decisions and notes
// come back from every harness, including Codex, which cannot call MCP tools in headless mode.
import type { Graph } from 'falkordb';
import type { PuffReport } from '@puff/shared';
import { z } from 'zod';
import { resolveSymbols } from '../queries/code';
import { recordDecision } from './memory';

const reportSchema = z.object({
  decisions: z
    .array(
      z.object({
        symbol: z.string().min(1),
        text: z.string().min(1),
        supersedes: z.string().optional(),
      }),
    )
    .optional(),
  notes: z.string().optional(),
});

export interface ParsedReport {
  report?: PuffReport;
  /** Why the block was ignored, when one was present but unusable */
  error?: string;
}

/** Find the last <puff-report> block in an agent's output and validate it. */
export function parsePuffReport(output: string): ParsedReport {
  const matches = [...output.matchAll(/<puff-report>([\s\S]*?)<\/puff-report>/g)];
  const last = matches.at(-1);
  if (!last) return {};
  try {
    const parsed = reportSchema.safeParse(JSON.parse(last[1]!.trim()));
    if (!parsed.success)
      return { error: `Invalid <puff-report>: ${parsed.error.issues[0]?.message ?? 'bad shape'}` };
    return { report: parsed.data };
  } catch {
    return { error: 'Invalid <puff-report>: not valid JSON' };
  }
}

export interface AppliedReport {
  decisionIds: string[];
  /** Decisions that could not be anchored to a known symbol, with the reason */
  skipped: { symbol: string; reason: string }[];
  notes?: string;
}

/** Turn a report's decisions into Decision memory. Unanchorable decisions are skipped, not guessed. */
export async function applyReport(graph: Graph, report: PuffReport): Promise<AppliedReport> {
  const decisionIds: string[] = [];
  const skipped: AppliedReport['skipped'] = [];
  for (const d of report.decisions ?? []) {
    try {
      const [symbolId] = await resolveSymbols(graph, [d.symbol]);
      const { id } = await recordDecision(graph, {
        symbolIds: [symbolId!],
        text: d.text,
        supersedes: d.supersedes,
      });
      decisionIds.push(id);
    } catch (err) {
      skipped.push({ symbol: d.symbol, reason: (err as Error).message });
    }
  }
  return { decisionIds, skipped, notes: report.notes };
}
