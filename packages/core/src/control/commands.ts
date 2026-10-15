// Running a slash command: the same actions the app's buttons perform, answered in plain words.
import { SLASH_COMMANDS, parseSlashCommand, type TaskStatus } from '@puff/shared';
import type { ProjectController } from './controller';
import { shortId } from './resolve';

export interface CommandResult {
  ok: boolean;
  text: string;
}

/** What only the application knows: the list of projects and how to switch. Absent in a plain CLI chat. */
export interface ProjectHooks {
  list(): Promise<{ id: string; name: string; active: boolean; repoPath: string }[]>;
  /** Switch to the project the person named; returns its name */
  switchTo(ref: string): Promise<string>;
}

const STATES: TaskStatus[] = [
  'planned',
  'ready',
  'running',
  'verifying',
  'retrying',
  'escalated',
  'failed',
  'done',
];

const ok = (text: string): CommandResult => ({ ok: true, text });
const no = (text: string): CommandResult => ({ ok: false, text });

export function helpText(): string {
  return [
    'Type a slash command, or just say what you want and the orchestrator agent will do it.',
    '',
    ...SLASH_COMMANDS.map(
      (c) => `${c.usage.padEnd(24)} ${c.summary}${c.spends ? ' (spends tokens)' : ''}`,
    ),
  ].join('\n');
}

/** Run a slash command. Never throws: a failure is a result the person can read. */
export async function runSlashCommand(
  controller: ProjectController,
  text: string,
  projects?: ProjectHooks,
): Promise<CommandResult> {
  const cmd = parseSlashCommand(text);
  if (!cmd) return no('That is not a slash command. Type /help to see them.');
  try {
    switch (cmd.name) {
      case 'help':
        return ok(helpText());

      case 'status': {
        const s = await controller.status();
        const parts = STATES.filter((st) => s.counts[st] > 0).map((st) => `${s.counts[st]} ${st}`);
        const lines = [
          `${s.project}: ${s.total === 0 ? 'no tasks yet' : `${s.total} task(s), ${parts.join(', ')}`}.`,
          s.running ? 'The team is running.' : 'The team is idle.',
        ];
        if (s.runBlocked) lines.push(`Agents cannot run here: ${s.runBlocked}`);
        for (const w of s.waiting)
          lines.push(
            `Waiting: ${shortId(w.id)} ${w.title} (overlaps ${w.on.map(shortId).join(', ')})`,
          );
        return ok(lines.join('\n'));
      }

      case 'tasks': {
        let tasks = await controller.tasks();
        if (cmd.args) {
          const state = cmd.args.toLowerCase() as TaskStatus;
          if (!STATES.includes(state))
            return no(`Unknown state "${cmd.args}". Use one of: ${STATES.join(', ')}.`);
          tasks = tasks.filter((t) => t.status === state);
        }
        if (tasks.length === 0) return ok('No tasks.');
        return ok(
          tasks.map((t) => `${shortId(t.id)}  ${t.status.padEnd(9)} ${t.title}`).join('\n'),
        );
      }

      case 'goal': {
        if (!cmd.args)
          return no('Say what you want: /goal add a health check endpoint and document it');
        const t = await controller.createGoal(cmd.args);
        return ok(
          `Added the goal as ${shortId(t.id)}. The planner splits it into tasks when the team runs (/run).`,
        );
      }

      case 'task': {
        if (!cmd.args) return no('Give the task a title: /task add a /health route');
        const t = await controller.createTask({ title: cmd.args });
        return ok(`Added ${shortId(t.id)}: ${t.title}`);
      }

      case 'run': {
        const started = await controller.start();
        return started
          ? ok('The team is running. Progress shows on the board; I will tell you how it ended.')
          : ok('The team is already running.');
      }

      case 'stop':
        await controller.stop();
        return ok(controller.running ? 'Stopping…' : 'The team is stopped.');

      case 'retry': {
        const t = await controller.retryTask(cmd.args);
        return ok(`${shortId(t.id)} is back in the queue as ${t.status}. /run to start it.`);
      }

      case 'why': {
        const { task, summary } = await controller.why(cmd.args);
        return ok(`${shortId(task.id)} ${task.title}\n${summary}`);
      }

      case 'diff': {
        const { task, diff } = await controller.diff(cmd.args);
        if (!diff) return ok(`${shortId(task.id)} has no changes to show yet.`);
        return ok(
          `${shortId(task.id)}: ${diff.label} (${diff.files.join(', ')})\n\n${diff.diff.slice(0, 4000)}`,
        );
      }

      case 'index': {
        const s = await controller.index();
        return ok(`Indexed ${s.files} files, ${s.symbols} symbols (${s.changed} changed).`);
      }

      case 'projects': {
        if (!projects) return no('Projects are managed in the app or with `puff project`.');
        const list = await projects.list();
        if (list.length === 0) return ok('No projects yet.');
        return ok(list.map((p) => `${p.active ? '*' : ' '} ${p.name}  ${p.repoPath}`).join('\n'));
      }

      case 'project': {
        if (!projects)
          return no('Switching projects is done in the app or with `puff project use`.');
        if (!cmd.args) return no('Which project? /project <name>');
        return ok(`Switched to ${await projects.switchTo(cmd.args)}.`);
      }

      default: {
        const close = SLASH_COMMANDS.filter((c) => c.name[0] === cmd.name[0]).map(
          (c) => `/${c.name}`,
        );
        return no(
          `Unknown command /${cmd.name}.${close.length ? ` Did you mean ${close.join(', ')}?` : ''} Type /help.`,
        );
      }
    }
  } catch (err) {
    return no((err as Error).message);
  }
}
