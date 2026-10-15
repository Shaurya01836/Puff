// From raw test output to anchored Failure memory. This is what the orchestrator calls after a
// verification run fails (P3); it also backs `puff failure add` for manual use.
import type { Graph } from 'falkordb';
import { existingSymbols } from '../queries/code';
import { recordFailure, sanitizeMessage, type FailureResult } from './memory';
import {
  locateFailure,
  parseStackFrames,
  parseTestFailures,
  worktreeSymbols,
  type LocateVia,
  type TestFailure,
} from './locate';
import { getTask } from './tasks';

export interface RecordTestFailuresInput {
  sessionId: string;
  taskId: string;
  /** Text output of the failing test command */
  output: string;
  /** Working tree the tests ran in (the task's worktree). Frames are resolved against it. */
  root: string;
  /** Unified diff of what the agent changed (`git diff`) */
  diff?: string;
  changedFiles?: string[];
  /** Used when the output has no recognisable failing test (e.g. the command crashed) */
  fallbackMessage?: string;
  /** Stop after this many distinct failures so a broken build does not flood memory */
  max?: number;
}

export interface RecordedFailure extends FailureResult {
  message: string;
  test?: string;
  via: LocateVia;
}

export async function recordTestFailures(
  graph: Graph,
  input: RecordTestFailuresInput,
): Promise<RecordedFailure[]> {
  const task = await getTask(graph, input.taskId);
  if (!task) throw new Error(`Unknown task ${input.taskId}`);

  let failures: TestFailure[] = parseTestFailures(input.output, input.root);
  if (failures.length === 0) {
    const message = sanitizeMessage(input.fallbackMessage ?? 'Tests failed');
    failures = [{ test: message, message, frames: parseStackFrames(input.output, input.root) }];
  }

  const symbols = worktreeSymbols(input.root);
  const exists = (ids: string[]) => existingSymbols(graph, ids);
  const recorded: RecordedFailure[] = [];
  for (const failure of failures.slice(0, input.max ?? 10)) {
    const where = await locateFailure({
      frames: failure.frames,
      symbols,
      exists,
      targets: task.targets,
      changedFiles: input.changedFiles,
      diff: input.diff,
    });
    if (!where) continue; // nothing to anchor to: better no memory than a floating one
    // The test name is written by a human and says what the code must do ("never writes a password
    // to the logs"), which is far more useful to the next agent than a bare assertion.
    const headline =
      failure.test && failure.test !== failure.message
        ? `${failure.test}: ${failure.message}`
        : failure.message;
    const result = await recordFailure(graph, {
      sessionId: input.sessionId,
      message: headline,
      kind: 'test',
      symbolIds: where.symbolIds,
      anchoredBy: where.via,
    });
    recorded.push({ ...result, message: headline, test: failure.test, via: where.via });
  }
  return recorded;
}
