// The slash commands of the chat and the command bar. They run at once and cost no tokens. Anything
// that is not a slash command goes to the orchestrator agent. The list lives here so the UI can offer
// completions without depending on the backend.

export interface SlashCommand {
  name: string;
  /** How it is typed */
  usage: string;
  summary: string;
  /** Costs real agent tokens when it runs */
  spends?: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'help', usage: '/help', summary: 'What you can type here' },
  { name: 'status', usage: '/status', summary: 'Tasks by state, and whether the team is running' },
  { name: 'tasks', usage: '/tasks [state]', summary: 'List tasks, optionally only one state' },
  {
    name: 'goal',
    usage: '/goal <what you want>',
    summary: 'Add a goal; the planner splits it when the team runs',
  },
  { name: 'task', usage: '/task <title>', summary: 'Add one task to the board' },
  { name: 'run', usage: '/run', summary: 'Run the ready tasks', spends: true },
  { name: 'stop', usage: '/stop', summary: 'Stop the team; running tasks go back to the queue' },
  { name: 'retry', usage: '/retry <task>', summary: 'Put a failed task back in the queue' },
  {
    name: 'why',
    usage: '/why <task>',
    summary: 'Why a task went to its agent and what it was told',
  },
  { name: 'diff', usage: '/diff <task>', summary: 'What a task changed' },
  { name: 'index', usage: '/index', summary: 'Re-read the code into the graph' },
  { name: 'projects', usage: '/projects', summary: 'List projects' },
  { name: 'project', usage: '/project <name>', summary: 'Switch to another project' },
];

/** Commands whose name starts with what was typed after the slash (empty: all of them). */
export function matchCommands(typed: string): SlashCommand[] {
  const word = typed.replace(/^\//, '').split(/\s/)[0]!.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(word));
}

/** `/run now` becomes `{ name: 'run', args: 'now' }`; text that is not a command gives undefined. */
export function parseSlashCommand(text: string): { name: string; args: string } | undefined {
  const m = /^\s*\/([a-z]+)\b\s*(.*)$/is.exec(text);
  return m ? { name: m[1]!.toLowerCase(), args: m[2]!.trim() } : undefined;
}
