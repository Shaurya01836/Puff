// Referring to a task the way a person does: not by its 26-character id.
import type { Task } from '@puff/shared';

/** The last characters of an id: short, and still unique in practice (ids end in random characters). */
export const shortId = (id: string): string => id.slice(-6);

const describe = (t: Task): string => `${shortId(t.id)} ${t.title.slice(0, 60)}`;

/**
 * Find the task a reference means. In order: the exact id; the end or any part of an id (at least four
 * characters, so `T6ZY` or `4ZY7B` work); a part of the title. The first step that matches exactly one
 * task wins; a step that matches several says so instead of guessing.
 */
export function resolveTask(tasks: Task[], ref: string): Task {
  const r = ref.trim().replace(/^#/, '');
  if (!r) throw new Error('Which task? Give its id (or the end of it) or a word from its title.');
  const lower = r.toLowerCase();

  const exact = tasks.find((t) => t.id.toLowerCase() === lower);
  if (exact) return exact;

  const steps: ((t: Task) => boolean)[] = [];
  if (lower.length >= 4) {
    const bare = lower.replace(/^task_/, '');
    steps.push((t) => t.id.toLowerCase().endsWith(bare));
    steps.push((t) => t.id.toLowerCase().includes(bare));
  }
  steps.push((t) => t.title.toLowerCase().includes(lower));

  for (const matches of steps) {
    const found = tasks.filter(matches);
    if (found.length === 1) return found[0]!;
    if (found.length > 1)
      throw new Error(
        `"${ref}" matches ${found.length} tasks: ${found.slice(0, 5).map(describe).join('; ')}. Be more specific.`,
      );
  }
  throw new Error(`No task matches "${ref}".`);
}
