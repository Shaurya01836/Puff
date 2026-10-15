import { useCallback, useMemo, useState } from 'react';
import { MOCK_PROJECT_ID } from '@puff/shared/mocks';
import type { MascotState } from '@/components/Mascot';
import { Sidebar, type Screen } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { puff } from '@/lib/api';
import { useLoad, useTasks } from '@/lib/hooks';
import { Agents } from '@/screens/Agents';
import { Board } from '@/screens/Board';
import { MemoryGraph } from '@/screens/MemoryGraph';
import { TaskDetail } from '@/screens/TaskDetail';

// Phase P0: one demo project from mocks. "Open project" arrives with the real backend in P1.
const PROJECT_ID = MOCK_PROJECT_ID;
// The main process also serves mocks until P1, so numbers are mock data everywhere for now.
const USING_MOCKS = true;

const TITLES: Record<Screen, { title: string; subtitle: string }> = {
  graph: {
    title: 'Memory graph',
    subtitle: 'Code and what the team learned about it',
  },
  board: { title: 'Board', subtitle: 'Tasks, owners and what they wait on' },
  agents: { title: 'Agents', subtitle: 'Strengths, results and savings' },
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

  const createGoal = async (goal: string) => {
    await puff.createGoal(PROJECT_ID, goal);
    setScreen('board');
  };

  const closeTask = useCallback(() => setOpenTask(undefined), []);

  return (
    <div className="flex h-full">
      <Sidebar
        screen={screen}
        onScreen={setScreen}
        mascot={mascot}
        agents={agents}
        projectId={PROJECT_ID}
        counts={{ board: tasks.filter((t) => t.status !== 'done').length }}
        mock={USING_MOCKS}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar
          {...TITLES[screen]}
          running={running}
          onToggleRun={toggleRun}
          onGoal={createGoal}
          mock={USING_MOCKS}
        />
        <div className="min-h-0 flex-1 overflow-auto">
          {screen === 'graph' && <MemoryGraph projectId={PROJECT_ID} graph={graph} />}
          {screen === 'board' && <Board tasks={tasks} onOpen={setOpenTask} />}
          {screen === 'agents' && <Agents agents={agents} savings={savings} mock={USING_MOCKS} />}
        </div>
      </main>
      {openTask && <TaskDetail taskId={openTask} onClose={closeTask} />}
    </div>
  );
}
