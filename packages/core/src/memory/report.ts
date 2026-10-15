// Agents end their answer with <puff-report>{...}</puff-report>. This is how decisions, notes,
// handoffs and new tasks come back from every harness, including Codex, which cannot call MCP
// tools in headless mode.
import type { Graph } from 'falkordb';
import type { PuffReport, Task } from '@puff/shared';
import { z } from 'zod';
import type { PuffConfig } from '../config';
import { resolveSymbols } from '../queries/code';
import { recordDecision, recordHandoff } from './memory';
import { spawnTasks } from './plan';

// Models are loose about JSON: a bad `type` or a string where a list belongs must not throw away a
// whole plan, so optional fields fall back to "not given" instead of failing the report.
const list = z.union([z.string().transform((s) => [s]), z.array(z.string())]);

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
  tasks: z
    .array(
      z.object({
        title: z.string().min(1),
        type: z.enum(['plan', 'implement', 'verify', 'chore']).optional().catch(undefined),
        complexity: z.enum(['low', 'medium', 'high']).optional().catch(undefined),
        targets: list.optional().catch(undefined),
        dependsOn: z.array(z.coerce.number().int()).optional().catch(undefined),
      }),
    )
    .optional(),
  handoffs: z
    .array(z.object({ toRole: z.string().optional(), summary: z.string().min(1) }))
    .optional(),
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
  /** Tasks the report created (only when a context was given) */
  tasks: Task[];
  skippedTasks: { title: string; reason: string }[];
  handoffIds: string[];
}

/** Where the report came from, so tasks and handoffs can be attributed. */
export interface ApplyContext {
  projectId: string;
  config: PuffConfig;
  sessionId: string;
  /** The task the reporting session worked on */
  parent: Task;
}

/**
 * Turn a report into memory: decisions (unanchorable ones are skipped, not guessed), handoff notes
 * and, when a context is given, the tasks it asks for.
 */
export async function applyReport(
  graph: Graph,
  report: PuffReport,
  ctx?: ApplyContext,
): Promise<AppliedReport> {
  const out: AppliedReport = {
    decisionIds: [],
    skipped: [],
    notes: report.notes,
    tasks: [],
    skippedTasks: [],
    handoffIds: [],
  };
  for (const d of report.decisions ?? []) {
    try {
      const [symbolId] = await resolveSymbols(graph, [d.symbol]);
      const { id } = await recordDecision(graph, {
        symbolIds: [symbolId!],
        text: d.text,
        supersedes: d.supersedes,
      });
      out.decisionIds.push(id);
    } catch (err) {
      out.skipped.push({ symbol: d.symbol, reason: (err as Error).message });
    }
  }
  if (ctx) {
    for (const h of report.handoffs ?? []) {
      out.handoffIds.push(
        await recordHandoff(graph, {
          fromSessionId: ctx.sessionId,
          toRole: h.toRole,
          payload: { summary: h.summary },
        }),
      );
    }
    if (report.tasks?.length) {
      const spawned = await spawnTasks(graph, ctx, report.tasks);
      out.tasks = spawned.created;
      out.skippedTasks = spawned.skipped;
    }
  }
  return out;
}
