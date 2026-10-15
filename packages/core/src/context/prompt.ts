// Pure prompt rendering: no database, so budgeting and layout are easy to test.
import type { Role } from '@puff/shared';

export interface PromptTarget {
  id: string;
  name: string;
  file: string;
  startLine: number;
  endLine: number;
}

export interface PromptInput {
  role: Role;
  title: string;
  targets: PromptTarget[];
  /** Symbol ids that call the targets and may break */
  callers: string[];
  failures: { message: string; fix?: string; stale?: boolean }[];
  decisions: { text: string; stale?: boolean }[];
  procedures: string[];
  handoffs: string[];
  technologies: string[];
  diff?: string;
  testCommand?: string;
}

/** Rough token estimate: about four characters per token. Good enough for budgeting. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const REPORT_FOOTER =
  'WHEN DONE: state the files you changed, the tests you ran, and any decision you made and why, in a final block:\n' +
  '<puff-report>{"decisions":[{"symbol":"<function name or path::name>","text":"..."}],"notes":"..."}</puff-report>';

const OUTDATED = ' (possibly outdated: the code changed since this was recorded)';
const MAX_DIFF_CHARS = 6000;

function targetLines(targets: PromptTarget[]): string[] {
  return targets.map((t) => `- ${t.file}:${t.startLine}-${t.endLine}  ${t.name}`);
}

function memoryBlock(i: PromptInput): string[] {
  const out: string[] = [];
  if (i.failures.length) {
    out.push('Past failures on or near this code, and their fixes:');
    for (const f of i.failures) {
      const fix = f.fix ? `fixed by: ${f.fix}` : 'no fix recorded yet, avoid repeating it';
      out.push(`- ${f.message} → ${fix}${f.stale ? OUTDATED : ''}`);
    }
  }
  if (i.decisions.length) {
    out.push('Active decisions you must respect:');
    for (const d of i.decisions) out.push(`- ${d.text}${d.stale ? OUTDATED : ''}`);
  }
  if (i.procedures.length) {
    out.push('Procedures:');
    for (const p of i.procedures) out.push(`- ${p}`);
  }
  if (i.handoffs.length) {
    out.push('Handoff notes from earlier work:');
    for (const h of i.handoffs) out.push(`- ${h}`);
  }
  return out.length ? ['PROJECT MEMORY', ...out, ''] : [];
}

export function renderPrompt(i: PromptInput): string {
  const lines: string[] = [
    `You are the ${i.role} on a team of coding agents working in this repository.`,
    '',
  ];

  switch (i.role) {
    case 'planner':
      lines.push(`GOAL: ${i.title}`);
      if (i.technologies.length) lines.push(`PROJECT TECHNOLOGIES: ${i.technologies.join(', ')}`);
      if (i.targets.length) lines.push('CODE THE GOAL LIKELY TOUCHES:', ...targetLines(i.targets));
      lines.push(
        '',
        'PLAN: split the goal into small tasks. For each task give a title, its type (plan, implement, verify or chore),',
        'and the functions it should target. Tasks that touch the same code must not run at the same time.',
        '',
      );
      break;
    case 'verifier':
      lines.push(`TASK UNDER REVIEW: ${i.title}`);
      if (i.targets.length) lines.push('CODE THAT CHANGED:', ...targetLines(i.targets));
      if (i.testCommand) lines.push(`TESTS TO RUN: ${i.testCommand}`);
      if (i.diff) {
        const diff =
          i.diff.length > MAX_DIFF_CHARS
            ? `${i.diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)`
            : i.diff;
        lines.push('DIFF:', '```diff', diff, '```');
      }
      lines.push(
        'Check the change against the decisions and past failures below, then report pass or fail with reasons.',
        '',
      );
      break;
    case 'chore':
      lines.push(`TASK: ${i.title}`);
      if (i.targets.length) lines.push('FILES AND FUNCTIONS TO TOUCH:', ...targetLines(i.targets));
      lines.push('');
      break;
    default:
      lines.push(`TASK: ${i.title}`);
      if (i.targets.length) {
        lines.push(
          'TARGET CODE (read these first, do not scan the whole repo):',
          ...targetLines(i.targets),
        );
      }
      if (i.callers.length) lines.push(`CALLERS THAT MAY BREAK: ${i.callers.join(', ')}`);
      lines.push('');
  }

  lines.push(...memoryBlock(i), REPORT_FOOTER);
  return lines.join('\n');
}
