import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BackendInfo, GraphData, ProjectSummary, Task } from '@puff/shared';
import { MOCK_PROJECT_ID } from '@puff/shared/mocks';
import type { MascotState } from '@/components/Mascot';
import { Sidebar, type Screen } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { Notice } from '@/components/ui';
import { puff } from '@/lib/api';
import { useLoad, useTasks } from '@/lib/hooks';
import { NewTaskDialog, type SymbolOption } from '@/components/NewTaskDialog';
import { ImportProjectDialog, ProjectSettingsDialog } from '@/components/ProjectDialogs';
import { Agents } from '@/screens/Agents';
import { Board } from '@/screens/Board';
import { MemoryGraph } from '@/screens/MemoryGraph';
import { Team } from '@/screens/Team';
import { TaskDetail } from '@/screens/TaskDetail';
import { Welcome } from '@/screens/Welcome';

const TITLES: Record<Screen, { title: string; subtitle: string }> = {
  graph: { title: 'Memory graph', subtitle: 'Code and what the team learned about it' },
  board: { title: 'Board', subtitle: 'Tasks, owners and what they wait on' },
  team: { title: 'Team', subtitle: 'Who did what, and who handed what to whom' },
  agents: { title: 'Agents', subtitle: 'Strengths, results and savings' },
};

/** What the data badge says: honest about which parts are live and which are mocked. */
function badgeFor(info?: BackendInfo): string | undefined {
  if (!info) return undefined;
  if (info.mode === 'mock') return 'Mock data';
  return info.seeded ? 'Live graph · sample memory' : undefined;
}

interface NoticeState {
  tone: 'good' | 'warn' | 'bad';
  text: string;
}

export function App() {
  const [screen, setScreen] = useState<Screen>('graph');
  const [openTask, setOpenTask] = useState<string>();
  const [running, setRunning] = useState(false);
  const [graph, setGraph] = useState<GraphData>();
  const [notice, setNotice] = useState<NoticeState>();
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [settingsFor, setSettingsFor] = useState<ProjectSummary>();
  /** Bumped when the active project changes (added, switched, removed, edited): everything reloads */
  const [projectTick, setProjectTick] = useState(0);
  /** Bumped when agents finish a session, so the agent pool and stats reload */
  const [agentsTick, setAgentsTick] = useState(0);

  const info = useLoad(() => puff.getBackendInfo(), [projectTick]);
  const projects = useLoad(() => puff.listProjects(), [projectTick]);
  const projectId = info?.projectId ?? MOCK_PROJECT_ID;
  const live = info?.mode === 'live';
  const savingsMocked = !live || info.mockParts.includes('savings');

  const tasks = useTasks(projectId);
  const agents = useLoad(() => puff.listAgents(projectId), [projectId, agentsTick]);
  const savings = useLoad(() => puff.getSavings(projectId), [projectId]);
  const timeline = useLoad(() => puff.getTeamTimeline(projectId), [projectId, agentsTick]);
  const symbols: SymbolOption[] = useMemo(
    () =>
      (graph?.nodes ?? [])
        .filter((n) => n.kind === 'Symbol')
        .map((n) => ({
          id: n.id,
          name: n.label,
          file: String(n.props?.file ?? n.id.split('::')[0]),
        })),
    [graph],
  );

  const loadGraph = useCallback(() => puff.getGraph(projectId).then(setGraph), [projectId]);
  useEffect(() => {
    if (info) void loadGraph();
  }, [info, loadGraph]);

  // Live updates while agents work: pool and stats on session changes, the graph (new failures,
  // fixes, merged code) shortly after memory changes, and run start/stop from the backend.
  const graphTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const off = puff.onEvent((e) => {
      if (e.type === 'session:update' || (e.type === 'task:update' && e.task.depth)) {
        setAgentsTick((t) => t + 1);
      }
      if (e.type === 'memory') {
        clearTimeout(graphTimer.current);
        graphTimer.current = setTimeout(() => void loadGraph(), 1200);
      }
      if (e.type === 'project') {
        // A different project (or different settings): forget what belonged to the old one.
        setOpenTask(undefined);
        setRunning(false);
        setGraph(undefined);
        setNotice(undefined);
        setProjectTick((t) => t + 1);
      }
      if (e.type === 'run') {
        setRunning(e.running);
        if (!e.running) {
          setAgentsTick((t) => t + 1);
          void loadGraph();
          if (e.message) setNotice({ tone: e.tone ?? 'good', text: e.message });
        }
      }
    });
    return () => {
      off();
      clearTimeout(graphTimer.current);
    };
  }, [loadGraph]);

  const mascot: MascotState = useMemo(() => {
    if (tasks.some((t) => t.status === 'failed')) return 'worried';
    if (running || tasks.some((t) => t.status === 'running')) return 'working';
    if (tasks.length > 0 && tasks.every((t) => t.status === 'done')) return 'happy';
    return 'idle';
  }, [tasks, running]);

  const toggleRun = async () => {
    try {
      if (running) {
        await puff.stop(projectId);
        return;
      }
      setNotice(undefined);
      await puff.start(projectId);
      // The live backend reports start and finish through `run` events; the mock does not.
      if (!live) setRunning(true);
    } catch (err) {
      setNotice({ tone: 'bad', text: (err as Error).message });
    }
  };

  const createGoal = async (goal: string) => {
    await puff.createGoal(projectId, goal);
    setScreen('board');
  };

  const createTask = async (task: Partial<Task>, run: boolean) => {
    await puff.createTask(projectId, task);
    setScreen('board');
    if (run && !running) await toggleRun();
  };

  const reindex = async () => {
    const s = await puff.indexProject(projectId);
    await loadGraph();
    return `${s.files} files · ${s.symbols} symbols · ${s.calls} calls`;
  };

  const closeTask = useCallback(() => setOpenTask(undefined), []);

  const reloadProjects = () => setProjectTick((t) => t + 1);
  const switchProject = async (id: string) => {
    try {
      await puff.switchProject(id);
      reloadProjects();
    } catch (err) {
      setNotice({ tone: 'bad', text: (err as Error).message });
    }
  };

  return (
    <div className="flex h-full">
      <Sidebar
        screen={screen}
        onScreen={setScreen}
        mascot={mascot}
        agents={agents}
        info={info}
        projects={projects}
        onReindex={reindex}
        onSwitchProject={switchProject}
        onAddProject={() => setImportOpen(true)}
        onProjectSettings={setSettingsFor}
        counts={{ board: tasks.filter((t) => t.status !== 'done').length }}
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <TopBar
          {...TITLES[screen]}
          running={running}
          onToggleRun={toggleRun}
          onGoal={createGoal}
          onNewTask={() => setNewTaskOpen(true)}
          badge={badgeFor(info)}
          runBlockedReason={
            info?.noProject ? 'Add a project first.' : live ? info.runBlocked : undefined
          }
        />
        <div className="min-h-0 flex-1 overflow-auto">
          {info?.noProject && <Welcome onAdd={() => setImportOpen(true)} />}
          {!info?.noProject && screen === 'graph' && (
            <MemoryGraph
              projectId={projectId}
              graph={graph}
              feedIsSample={!live || info.seeded === true}
            />
          )}
          {!info?.noProject && screen === 'board' && <Board tasks={tasks} onOpen={setOpenTask} />}
          {!info?.noProject && screen === 'team' && (
            <Team events={timeline} onOpenTask={setOpenTask} />
          )}
          {!info?.noProject && screen === 'agents' && (
            <Agents agents={agents} savings={savings} mock={savingsMocked} />
          )}
        </div>
      </main>
      {newTaskOpen && (
        <NewTaskDialog
          symbols={symbols}
          onClose={() => setNewTaskOpen(false)}
          onCreate={createTask}
        />
      )}
      {importOpen && (
        <ImportProjectDialog
          onClose={() => setImportOpen(false)}
          onPick={() => puff.pickDirectory()}
          onInspect={(path) => puff.inspectProject(path)}
          onAdd={async (input) => {
            const added = await puff.addProject(input);
            reloadProjects();
            setScreen('graph');
            setNotice({ tone: 'good', text: `${added.name} added and indexed.` });
          }}
        />
      )}
      {settingsFor && (
        <ProjectSettingsDialog
          project={settingsFor}
          onClose={() => setSettingsFor(undefined)}
          onSave={async (patch) => {
            await puff.updateProject(settingsFor.id, patch);
            reloadProjects();
          }}
          onRemove={async (deleteMemory) => {
            await puff.removeProject(settingsFor.id, { deleteMemory });
            reloadProjects();
          }}
        />
      )}
      {openTask && <TaskDetail taskId={openTask} onClose={closeTask} />}
      {notice && (
        <Notice tone={notice.tone} onClose={() => setNotice(undefined)}>
          {notice.text}
        </Notice>
      )}
    </div>
  );
}
