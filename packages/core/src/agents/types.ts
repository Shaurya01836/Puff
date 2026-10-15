import type { AgentName, PuffReport, Role } from '@puff/shared';

export type AgentErrorKind =
  /** Not signed in, expired session, bad API key: nothing wrong with the code */
  | 'auth'
  /** The program is not installed or could not be started */
  | 'unavailable'
  | 'timeout'
  | 'aborted'
  /** The provider refused or failed: rate limit, quota, outage, unsupported model */
  | 'api'
  /** The process died or printed nothing we can read */
  | 'crash';

/**
 * Errors are about the harness or the provider, never about the code. Puff records them as a
 * session outcome of `error` and does NOT write failure memory for them, or a login problem would
 * teach the next agent a "lesson" about the wrong function.
 */
export interface AgentError {
  kind: AgentErrorKind;
  message: string;
}

export interface HarnessResult {
  exitCode: number | null;
  /** The agent's final text (all assistant messages joined) */
  output: string;
  report?: PuffReport;
  /** A <puff-report> block was present but unusable */
  reportError?: string;
  /** Total input tokens, including cached ones (normalised across vendors) */
  tokensIn?: number;
  /** The cached part of tokensIn */
  cachedIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs: number;
  error?: AgentError;
  /** Raw stdout, trimmed, for debugging */
  raw: string;
}

export interface RunOptions {
  prompt: string;
  /** The task's worktree */
  cwd: string;
  role: Role;
  timeoutMs: number;
  /** Provider model override; omit to use the CLI's own configuration */
  model?: string;
  signal?: AbortSignal;
}

export interface HarnessAdapter {
  readonly name: AgentName;
  /** Is the CLI installed and runnable? Does not call the model. */
  available(): Promise<{ ok: boolean; detail: string }>;
  run(opts: RunOptions): Promise<HarnessResult>;
}

/** Roles that may change files. Planners and verifiers only read. */
export const WRITES_FILES: Record<Role, boolean> = {
  planner: false,
  coder: true,
  verifier: false,
  chore: true,
};
