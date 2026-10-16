import { FolderPlus, GitBranch, Network, Users } from 'lucide-react';
import type { AgentCliStatus } from '@puff/shared';
import { Mascot } from '@/components/Mascot';
import { AgentChecklist } from '@/screens/Setup';

/** Shown when no project has been added yet: the one thing to do, and what Puff needs. */
export function Welcome({ onAdd, agents }: { onAdd: () => void; agents?: AgentCliStatus[] }) {
  return (
    <div className="grid h-full place-items-center p-10">
      <div className="flex max-w-lg flex-col items-center text-center">
        <Mascot state="idle" size={84} />
        <h2 className="mt-5 font-display text-2xl font-semibold">Add your first project</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">
          Puff reads your code into a graph, gives a team of coding agents one shared memory of it,
          and remembers what they get wrong so the next agent does not repeat it.
        </p>
        <button
          onClick={onAdd}
          className="mt-6 inline-flex items-center gap-2 rounded bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-emerald-400"
        >
          <FolderPlus className="size-4" />
          Add a project…
        </button>
        <ul className="mt-8 flex flex-col gap-3 text-left text-[13px] leading-snug text-ink-3">
          <li className="flex gap-3">
            <GitBranch className="mt-0.5 size-4 shrink-0 text-ink-2" />
            <span>
              <b className="font-medium text-ink-2">A git repository.</b> Agents work in separate
              git worktrees. If your folder is not one yet, Puff can set it up when you agree.
            </span>
          </li>
          <li className="flex gap-3">
            <Network className="mt-0.5 size-4 shrink-0 text-ink-2" />
            <span>
              <b className="font-medium text-ink-2">TypeScript or JavaScript.</b> Those are the
              languages Puff reads into the code graph for now.
            </span>
          </li>
          <li className="flex gap-3">
            <Users className="mt-0.5 size-4 shrink-0 text-ink-2" />
            <span>
              <b className="font-medium text-ink-2">An agent CLI.</b> OpenCode, Codex or Claude
              Code, signed in. You can explore the graph without one.
            </span>
          </li>
          {agents && (
            <li className="rounded-xl border border-line bg-surface p-4">
              <AgentChecklist agents={agents} />
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
