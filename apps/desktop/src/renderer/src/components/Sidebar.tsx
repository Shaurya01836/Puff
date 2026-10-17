import type { AgentProfile, BackendInfo, ProjectSummary } from '@puff/shared';
import { PuffMark } from '@/components/landing/puff-logo';
import { cn } from '@/lib/cn';
import { AGENT_META } from '@/lib/theme';
import { Mascot, MASCOT_LINES, type MascotState } from './Mascot';
import { ProjectSwitcher } from './ProjectSwitcher';
import { AgentAvatar } from './ui';

export type Screen = 'board' | 'memory' | 'agents';

const NAV: { id: Screen; label: string; hint: string }[] = [
  { id: 'board', label: 'Tasks', hint: 'What each agent is doing' },
  { id: 'memory', label: 'Memory', hint: 'What the team learned, and whether it holds' },
  { id: 'agents', label: 'Agents', hint: 'Pool, records, who did what' },
];

export function Sidebar({
  screen,
  onScreen,
  mascot,
  agents,
  info,
  projects,
  onReindex,
  onSwitchProject,
  onAddProject,
  onProjectSettings,
  counts,
}: {
  screen: Screen;
  onScreen: (s: Screen) => void;
  mascot: MascotState;
  agents?: AgentProfile[];
  info?: BackendInfo;
  projects?: ProjectSummary[];
  onReindex: () => Promise<string>;
  onSwitchProject: (id: string) => void;
  onAddProject: () => void;
  onProjectSettings: (project: ProjectSummary) => void;
  counts: Partial<Record<Screen, number>>;
}) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-abyss">
      {/* Header matching Screenshot 3 & 4 */}
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <PuffMark className="size-6 shrink-0" />
        <span className="font-display text-base font-bold tracking-tight text-ink">Puff</span>
      </div>

      <nav className="flex flex-col gap-1 px-3 pt-2">
        {NAV.map(({ id, label, hint }) => {
          const active = screen === id;
          return (
            <button
              key={id}
              onClick={() => onScreen(id)}
              title={hint}
              className={cn(
                'group relative flex items-center gap-3 px-3 py-2 text-left text-sm transition-colors',
                active
                  ? 'bg-surface-3 text-ink font-medium'
                  : 'text-ink-2 hover:bg-surface/50 hover:text-ink',
              )}
            >
              {active && <span className="absolute top-1 bottom-1 left-0 w-0.5 bg-brand" />}
              <span className="min-w-0 flex-1">{label}</span>
              {counts[id] !== undefined && counts[id]! > 0 && (
                <span className="border border-line bg-surface px-1.5 font-mono text-[10px] text-ink-2 tabular-nums">
                  {counts[id]}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Agent Pool section */}
      <div className="mt-5 border-t border-line px-4 pt-4">
        <div className="mb-2.5 font-mono text-[10px] uppercase tracking-wide text-ink-3">
          Agent pool
        </div>
        <ul className="flex flex-col gap-2">
          {agents?.map((a) => (
            <li key={a.name} className="flex items-center gap-2.5 py-0.5">
              <AgentAvatar agent={a.name} size={20} />
              <span className="flex-1 truncate font-mono text-xs text-ink">
                {AGENT_META[a.name].label}
              </span>
              <span
                title={`${a.busy} of ${a.instances} busy`}
                className={cn(
                  'font-mono text-[10px] tabular-nums',
                  a.busy > 0 ? 'text-brand' : 'text-ink-3',
                )}
              >
                {a.busy}/{a.instances}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* Mascot status tip */}
      <div className="mt-auto px-3 pb-2 pt-3">
        <div className="flex items-start gap-2.5 border border-line bg-surface p-2.5">
          <Mascot state={mascot} size={26} />
          <p className="text-[11px] leading-snug text-ink-2">{MASCOT_LINES[mascot]}</p>
        </div>
      </div>

      {/* Project Switcher / Workspace matching Screenshot 3 & 4 */}
      <div className="border-t border-line p-3">
        <ProjectSwitcher
          info={info}
          projects={projects}
          onReindex={onReindex}
          onSwitch={onSwitchProject}
          onAdd={onAddProject}
          onSettings={onProjectSettings}
        />
      </div>
    </aside>
  );
}
