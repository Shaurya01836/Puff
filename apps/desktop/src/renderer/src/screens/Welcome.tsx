import { ArrowRight, FileCode2, FolderGit2, FolderPlus, Terminal } from 'lucide-react';
import type { AgentCliStatus } from '@puff/shared';
import { Mascot } from '@/components/Mascot';
import { SectionTitle } from '@/components/ui';
import { AgentChecklist } from '@/screens/Setup';

/** What Puff needs from the folder you point it at, in the order that matters. */
const NEEDS = [
  {
    icon: FolderGit2,
    title: 'A git repository',
    body: 'Agents work in separate git worktrees. If your folder is not one yet, Puff can set it up when you agree.',
  },
  {
    icon: FileCode2,
    title: 'TypeScript or JavaScript',
    body: 'Those are the languages Puff reads into the code graph for now.',
  },
  {
    icon: Terminal,
    title: 'An agent CLI',
    body: 'OpenCode, Codex or Claude Code, signed in. You can explore the graph without one.',
  },
] as const;

/** Shown when no project has been added yet: the one thing to do, and what Puff needs. */
export function Welcome({
  onAdd,
  agents,
  onRefresh,
}: {
  onAdd: () => void;
  agents?: AgentCliStatus[];
  onRefresh?: () => void;
}) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-center gap-10 px-8 py-14">
      <header className="flex flex-col items-center text-center">
        <Mascot state="idle" size={84} />
        <h1 className="mt-5 font-display text-2xl font-semibold tracking-tight text-ink">
          Add your first project
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-2">
          Puff reads your code into a graph, gives a team of coding agents one shared memory of it,
          and remembers what they get wrong so the next agent does not repeat it.
        </p>
        <button
          onClick={onAdd}
          className="group mt-7 inline-flex items-center gap-2 rounded bg-brand px-5 py-2.5 text-sm font-semibold text-abyss transition-colors hover:bg-brand-soft"
        >
          <FolderPlus className="size-4" />
          Add a project…
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        </button>
      </header>

      <section>
        <SectionTitle>What Puff needs</SectionTitle>
        <ul className="grid gap-3 sm:grid-cols-3">
          {NEEDS.map(({ icon: Icon, title, body }) => (
            <li key={title} className="panel flex flex-col gap-3 p-4">
              <span className="flex size-8 items-center justify-center rounded bg-surface-3 text-brand-soft">
                <Icon className="size-4" />
              </span>
              <div className="flex flex-col gap-1">
                <div className="text-sm font-medium text-ink">{title}</div>
                <p className="text-[0.8125rem] leading-snug text-ink-3">{body}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {agents && (
        <section className="panel p-5">
          <SectionTitle>Agent tools</SectionTitle>
          <AgentChecklist agents={agents} onChanged={onRefresh} />
          <p className="mt-3 text-[0.75rem] leading-snug text-ink-3">
            Puff drives these command-line agents. You need at least one, signed in. You can explore
            the graph without any.
          </p>
        </section>
      )}
    </div>
  );
}
