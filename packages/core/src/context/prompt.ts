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
  /** Planner only: files and the functions in them that a task can target */
  codeMap?: { file: string; symbols: string[] }[];
  /** Planner only: titles of tasks already on the board, so the plan does not repeat them */
  boardTitles?: string[];
  /** Planner only: how many tasks a plan may contain */
  maxTasks?: number;
  /** Names the plan gave that are not in the graph yet (new code) */
  hints?: string[];
  diff?: string;
  testCommand?: string;
}

/** Rough token estimate: about four characters per token. Good enough for budgeting. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const PLANNER_FOOTER =
  'Do not change any files. Answer with the plan block described above, after a short explanation of the order you chose.';

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
      if (i.boardTitles?.length) {
        lines.push(
          'TASKS ALREADY ON THE BOARD (do not repeat them):',
          ...i.boardTitles.map((t) => `- ${t}`),
        );
      }
      if (i.codeMap?.length) {
        lines.push(
          'CODE MAP (file: functions and classes a task can target):',
          ...i.codeMap.map((f) => `- ${f.file}: ${f.symbols.join(', ')}`),
        );
      }
      lines.push(
        '',
        'PLAN: split the goal into small tasks that one agent can finish and the project\x27s tests can verify.',
        'Use your read-only tools to look at the code if the map is not enough. Finish with ONE block of JSON (no comments):',
        '<puff-report>{"tasks":[{"title":"...","type":"implement","complexity":"low","targets":["login"],"dependsOn":[]}],"notes":"..."}</puff-report>',
        'Rules:',
        `- At most ${i.maxTasks ?? 8} tasks. A title says what to change and how to tell it worked.`,
        '- "type": implement (change code and add or update its tests), chore (docs, formatting), verify (review only).',
        '- Write tests together with the code they cover; do not make tests a separate task.',
        '- "targets": function names from the CODE MAP (or "path::name"). For new code that does not exist yet, name the closest existing function it will sit next to or call.',
        '- "dependsOn": 0-based positions of EARLIER tasks in your list. Tasks that change the same function MUST depend on each other, so they never run at the same time. Independent tasks should not depend on each other, so they can run in parallel.',
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
      if (i.hints?.length)
        lines.push(`NEW OR UNRESOLVED CODE THIS TASK MENTIONS: ${i.hints.join(', ')}`);
      lines.push('');
  }

  lines.push(...memoryBlock(i), i.role === 'planner' ? PLANNER_FOOTER : REPORT_FOOTER);
  return lines.join('\n');
}
