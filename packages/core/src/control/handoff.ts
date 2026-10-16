// The first message handed to an agent's real CLI when a person takes a task over: what the task is, what
// was already tried, and what to leave for the person to check. Plain text, short, no database.
import type { SessionInfo, Task } from '@puff/shared';

const MAX_BRIEF = 1800;

const oneLine = (text: string, max: number): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * @param sessions the task's sessions, oldest first
 * @param testCommand how the project is checked, so the agent can run it before handing back
 */
export function buildHandoffBrief(
  task: Task,
  sessions: SessionInfo[],
  testCommand?: string,
): string {
  const lines: string[] = [
    `You are continuing a task that a person has taken over in this folder: "${task.title}".`,
  ];
  if (task.targets.length) lines.push(`Code it is about: ${task.targets.join(', ')}.`);
  if (task.note) lines.push(`The person's note: ${oneLine(task.note, 400)}`);

  const earlier = sessions.filter((s) => s.role !== 'planner' && s.outcome !== 'running').slice(-3);
  if (earlier.length) {
    lines.push('Earlier attempts on it:');
    for (const s of earlier) {
      const label = s.agent === 'you' ? 'you' : s.agent;
      lines.push(`- ${label}: ${s.outcome}${s.output ? `. ${oneLine(s.output, 220)}` : ''}`);
    }
  }
  lines.push(
    'The folder already holds the last attempt’s changes if there were any. Look at them (git status, git diff) before changing anything.',
  );
  if (testCommand) lines.push(`Check your work with: ${testCommand}`);
  lines.push(
    'When you are done, say what you changed. Do not merge or push: the person will check and merge it in Puff.',
  );
  const text = lines.join('\n');
  return text.length > MAX_BRIEF ? `${text.slice(0, MAX_BRIEF - 1)}…` : text;
}
