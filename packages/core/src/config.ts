import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { userConfigPath } from './paths';

const harnessSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** How the prompt reaches the CLI: on stdin (preferred, no length limit) or as the `{prompt}` arg */
  promptVia: z.enum(['stdin', 'arg']).default('stdin'),
  instances: z.number().int().positive().default(1),
  strengths: z.array(z.string()).default([]),
  /** Provider model override; omit to use the CLI's own configuration */
  model: z.string().optional(),
});

export const configSchema = z.object({
  harnesses: z.record(z.string(), harnessSchema),
  routing: z.partialRecord(z.enum(['plan', 'implement', 'verify', 'chore']), z.array(z.string())),
  limits: z
    .object({
      maxParallel: z.number().int().positive().default(3),
      timeoutMs: z.number().int().positive().default(600_000),
      retriesBeforeEscalate: z.number().int().nonnegative().default(1),
      maxAttempts: z.number().int().positive().default(3),
      /** How many tasks one plan may create */
      maxTasksPerPlan: z.number().int().positive().default(8),
      /** Tasks created by tasks created by tasks… stop here, so agents cannot spawn work forever */
      maxSpawnDepth: z.number().int().nonnegative().default(2),
      contextTokenBudget: z.number().int().positive().default(2000),
      /** An agent silent this long is marked stalled on the board (it keeps running; the person can stop it or switch agent) */
      stallWarnMs: z.number().int().positive().default(180_000),
      /** An agent silent this long is stopped and the task moves on to the next agent. 0 = never, only the normal timeout applies. */
      stallKillMs: z.number().int().nonnegative().default(0),
    })
    .prefault({}),
  escalation: z.array(z.string()).default([]),
  verify: z
    .object({
      testCommand: z.string().default('npm test --silent'),
      verifierAgent: z.string().optional(),
      /**
       * After a task's tests pass and it is merged, run the tests again on the combined result. If they
       * fail (twice, to rule out a flaky test), the merge is undone with a revert commit and the failure
       * is recorded as a lesson. Set to false to skip the second run.
       */
      retestAfterMerge: z.boolean().default(true),
    })
    .prefault({}),
  worktrees: z.object({ linkDirs: z.array(z.string()).default(['node_modules']) }).prefault({}),
  graph: z
    .object({
      /**
       * false runs Puff without its graph decisions (the ablation): routing takes the escalation order,
       * context is the task and its target files only, overlap is by file path, nothing is marked stale.
       * PUFF_GRAPH=off does the same without editing the file.
       */
      enabled: z.boolean().default(true),
      /** Risk (0 to 1, a percentile) at or above which a task counts as touching load-bearing code */
      riskThreshold: z.number().min(0).max(1).default(0.9),
    })
    .prefault({}),
});

export type PuffConfig = z.infer<typeof configSchema>;

/** True when the graph's decisions are switched off: PUFF_GRAPH=off (or 0/false), else `graph.enabled: false`. */
export function graphOff(config?: Pick<PuffConfig, 'graph'>): boolean {
  const env = process.env.PUFF_GRAPH?.trim().toLowerCase();
  if (env === 'off' || env === '0' || env === 'false') return true;
  if (env === 'on' || env === '1' || env === 'true') return false;
  return config?.graph?.enabled === false;
}
export type HarnessConfig = z.infer<typeof harnessSchema>;

/** Parse and validate config text; agent names used in escalation/verify must exist in harnesses. */
export function parseConfig(text: string): PuffConfig {
  const config = configSchema.parse(parse(text));
  const known = new Set(Object.keys(config.harnesses));
  const unknown = [...config.escalation, config.verify.verifierAgent ?? ''].filter(
    (name) => name && !known.has(name),
  );
  if (unknown.length) {
    throw new Error(`Config refers to unknown harness(es): ${unknown.join(', ')}`);
  }
  return config;
}

/**
 * Which configuration file to use: $PUFF_CONFIG, else the user's own (~/.puff/config.yaml), else the
 * nearest puff.config.yaml above any of `startDirs` (how a checkout of Puff finds its own).
 */
export function findConfigFile(startDirs: string[] = [process.cwd()]): string | undefined {
  if (process.env.PUFF_CONFIG) return resolve(process.env.PUFF_CONFIG);
  if (existsSync(userConfigPath())) return userConfigPath();
  for (const start of startDirs) {
    for (let dir = resolve(start); ; dir = dirname(dir)) {
      const candidate = join(dir, 'puff.config.yaml');
      if (existsSync(candidate)) return candidate;
      if (dirname(dir) === dir) break;
    }
  }
  return undefined;
}

export async function loadConfig(
  path = process.env.PUFF_CONFIG ?? 'puff.config.yaml',
): Promise<PuffConfig> {
  const full = resolve(path);
  try {
    return parseConfig(await readFile(full, 'utf8'));
  } catch (err) {
    throw new Error(`Could not load Puff config from ${full}: ${(err as Error).message}`);
  }
}

/** Every capability named anywhere in the config (agent strengths + routing requirements). */
export function allCapabilities(config: PuffConfig): string[] {
  const caps = new Set<string>();
  for (const h of Object.values(config.harnesses)) h.strengths.forEach((c) => caps.add(c));
  for (const list of Object.values(config.routing)) list.forEach((c) => caps.add(c));
  return [...caps].sort();
}
