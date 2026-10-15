import { Bot, Columns3, Network } from 'lucide-react';
import type { ComponentType } from 'react';
import { cn } from '@/lib/cn';
import { Mascot, type MascotState } from './Mascot';

export type Screen = 'graph' | 'board' | 'agents';

const NAV: { id: Screen; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { id: 'graph', label: 'Memory graph', icon: Network },
  { id: 'board', label: 'Board', icon: Columns3 },
  { id: 'agents', label: 'Agents', icon: Bot },
];

export function Sidebar({
  screen,
  onScreen,
  mascot,
}: {
  screen: Screen;
  onScreen: (s: Screen) => void;
  mascot: MascotState;
}) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center gap-3 px-4 py-5">
        <Mascot state={mascot} size={40} />
        <div>
          <div className="text-lg leading-none font-bold tracking-tight">Puff</div>
          <div className="mt-1 text-[11px] text-muted">one brain · many agents</div>
        </div>
      </div>
      <nav className="flex flex-col gap-1 px-2">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onScreen(id)}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
              screen === id
                ? 'bg-panel-2 text-text'
                : 'text-muted hover:bg-panel-2/60 hover:text-text',
            )}
          >
            <Icon className="size-4" />
            {label}
          </button>
        ))}
      </nav>
    </aside>
  );
}
