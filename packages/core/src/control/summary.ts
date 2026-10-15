// One line describing how a run ended, and whether it went well.
import type { TaskRunResult } from '../orchestrator/run';

export function summarizeRun(results: TaskRunResult[]): {
  message: string;
  tone: 'good' | 'warn' | 'bad';
} {
  if (results.length === 0) return { message: 'Nothing to run: no ready tasks.', tone: 'warn' };
  const done = results.filter((r) => r.status === 'done').length;
  const failed = results.filter((r) => r.status === 'failed');
  const attempts = results.reduce((n, r) => n + r.attempts.length, 0);
  const base = `${done}/${results.length} task(s) done in ${attempts} agent run(s)`;
  if (failed.length === 0) return { message: base, tone: 'good' };
  return {
    message: `${base}. Failed: ${failed[0]!.reason ?? 'see the board'}`,
    tone: done ? 'warn' : 'bad',
  };
}
