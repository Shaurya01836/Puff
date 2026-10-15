import { useMemo, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { MOCK_PROJECT_ID } from '@puff/shared/mocks';
import type { MascotState } from '@/components/Mascot';
import { Sidebar, type Screen } from '@/components/Sidebar';
import { inElectron, puff } from '@/lib/api';
import { useLoad, useTasks } from '@/lib/hooks';
import { Agents } from '@/screens/Agents';
import { Board } from '@/screens/Board';
import { MemoryGraph } from '@/screens/MemoryGraph';
import { TaskDetail } from '@/screens/TaskDetail';

// Phase P0: one demo project from mocks. "Open project" arrives with the real backend in P1.
const PROJECT_ID = MOCK_PROJECT_ID;
// The main process also serves mocks until P1, so numbers are mock data everywhere for now.
const USING_MOCKS = true;

const TITLES: Record<Screen, string> = {
  graph: 'Memory graph',
  board: 'Board',
  agents: 'Agents',
};

export function App() {
  const [screen, setScreen] = useState<Screen>('graph');
  const [openTask, setOpenTask] = useState<string>();
  const [running, setRunning] = useState(false);

  const tasks = useTasks(PROJECT_ID);
  const graph = useLoad(() => puff.getGraph(PROJECT_ID), []);
  const agents = useLoad(() => puff.listAgents(PROJECT_ID), []);
  const savings = useLoad(() => puff.getSavings(PROJECT_ID), []);

  const mascot: MascotState = useMemo(() => {
    if (tasks.some((t) => t.status === 'failed')) return 'worried';
    if (running || tasks.some((t) => t.status === 'running')) return 'working';
    if (tasks.length > 0 && tasks.every((t) => t.status === 'done')) return 'happy';
    return 'idle';
  }, [tasks, running]);

  const toggleRun = async () => {
    if (running) await puff.stop(PROJECT_ID);
    else await puff.start(PROJECT_ID);
    setRunning(!running);
  };

  return (
    <div className="flex h-full">
      <Sidebar screen={screen} onScreen={setScreen} mascot={mascot} />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="flex items-baseline gap-3">
            <h1 className="text-base font-semibold">{TITLES[screen]}</h1>
            <span className="font-mono text-xs text-muted">puff_{PROJECT_ID}</span>
          </div>
          <div className="flex items-center gap-3">
            {USING_MOCKS && (
              <span className="rounded-md bg-warn/10 px-2 py-1 text-[11px] text-warn">
                mock data{inElectron ? '' : ' · browser'}
              </span>
            )}
            <button
              onClick={toggleRun}
              className="inline-flex items-center gap-2 rounded-lg bg-puff px-3 py-1.5 text-sm font-medium text-bg hover:bg-puff/90"
            >
              {running ? <Pause className="size-4" /> : <Play className="size-4" />}
              {running ? 'Stop' : 'Start'}
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          {screen === 'graph' && <MemoryGraph projectId={PROJECT_ID} graph={graph} />}
          {screen === 'board' && <Board tasks={tasks} onOpen={setOpenTask} />}
          {screen === 'agents' && <Agents agents={agents} savings={savings} mock={USING_MOCKS} />}
        </div>
      </main>
      {openTask && <TaskDetail taskId={openTask} onClose={() => setOpenTask(undefined)} />}
    </div>
  );
}
