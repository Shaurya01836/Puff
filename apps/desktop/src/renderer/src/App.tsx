import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BackendInfo, GraphData } from '@puff/shared';
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

const TITLES: Record<Screen, { title: string; subtitle: string }> = {
  graph: { title: 'Memory graph', subtitle: 'Code and what the team learned about it' },
  board: { title: 'Board', subtitle: 'Tasks, owners and what they wait on' },
  agents: { title: 'Agents', subtitle: 'Strengths, results and savings' },
};

/** What the data badge says: honest about which parts are live and which are mocked. */
function badgeFor(info?: BackendInfo): string | undefined {
  if (!info) return undefined;
  if (info.mode === 'mock') return 'Mock data';
  return info.mockParts.length ? 'Live graph · tasks mocked' : undefined;
}

export function App() {
  const [screen, setScreen] = useState<Screen>('graph');
  const [openTask, setOpenTask] = useState<string>();
  const [running, setRunning] = useState(false);
  const [graph, setGraph] = useState<GraphData>();

  const info = useLoad(() => puff.getBackendInfo(), []);
  const projectId = info?.projectId ?? MOCK_PROJECT_ID;
  const tasksMocked = info?.mode !== 'live' || info.mockParts.includes('tasks');

  const tasks = useTasks(projectId);
  const agents = useLoad(() => puff.listAgents(projectId), [projectId]);
  const savings = useLoad(() => puff.getSavings(projectId), [projectId]);

  const loadGraph = useCallback(() => puff.getGraph(projectId).then(setGraph), [projectId]);
  useEffect(() => {
    if (info) void loadGraph();
  }, [info, loadGraph]);

  const mascot: MascotState = useMemo(() => {
    if (tasks.some((t) => t.status === 'failed')) return 'worried';
    if (running || tasks.some((t) => t.status === 'running')) return 'working';
    if (tasks.length > 0 && tasks.every((t) => t.status === 'done')) return 'happy';
    return 'idle';
  }, [tasks, running]);

  const toggleRun = async () => {
    if (running) await puff.stop(projectId);
    else await puff.start(projectId);
    setRunning(!running);
  };

  const createGoal = async (goal: string) => {
    await puff.createGoal(projectId, goal);
    setScreen('board');
  };

  const reindex = async () => {
    const s = await puff.indexProject(projectId);
    await loadGraph();
    return `${s.files} files · ${s.symbols} symbols · ${s.calls} calls`;
  };

  const closeTask = useCallback(() => setOpenTask(undefined), []);

  return (
    <div className="flex h-full">
      <Sidebar
        screen={screen}
        onScreen={setScreen}
        mascot={mascot}
        agents={agents}
        info={info}
        onReindex={reindex}
        counts={{ board: tasks.filter((t) => t.status !== 'done').length }}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar
          {...TITLES[screen]}
          running={running}
          onToggleRun={toggleRun}
          onGoal={createGoal}
          badge={badgeFor(info)}
        />
        <div className="min-h-0 flex-1 overflow-auto">
          {screen === 'graph' && (
            <MemoryGraph
              projectId={projectId}
              graph={graph}
              feedIsSample={info?.mode !== 'live' || info.mockParts.includes('memory feed')}
            />
          )}
          {screen === 'board' && <Board tasks={tasks} onOpen={setOpenTask} />}
          {screen === 'agents' && <Agents agents={agents} savings={savings} mock={tasksMocked} />}
        </div>
      </main>
      {openTask && <TaskDetail taskId={openTask} onClose={closeTask} />}
    </div>
  );
}
