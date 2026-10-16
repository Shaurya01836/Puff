import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity } from 'lucide-react';
import type { BackendInfo, GraphData, ProjectSummary, Task } from '@puff/shared';
import { MOCK_PROJECT_ID } from '@puff/shared/mocks';
import type { MascotState } from '@/components/Mascot';
import { Sidebar, type Screen } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { Notice } from '@/components/ui';
import { puff } from '@/lib/api';
import { useChat, useLoad, useTasks } from '@/lib/hooks';
import { NewTaskDialog, type SymbolOption } from '@/components/NewTaskDialog';
import { ChatPanel } from '@/components/ChatPanel';
import { ImportProjectDialog, ProjectSettingsDialog } from '@/components/ProjectDialogs';
import { Agents } from '@/screens/Agents';
import { Board } from '@/screens/Board';
import { MemoryGraph } from '@/screens/MemoryGraph';
import { Team } from '@/screens/Team';
import { TaskDetail } from '@/screens/TaskDetail';
import { Setup } from '@/screens/Setup';
import { Welcome } from '@/screens/Welcome';

const TITLES: Record<Screen, { title: string; subtitle: string }> = {
  graph: { title: 'Memory graph', subtitle: 'Code and what the team learned about it' },
  board: { title: 'Board', subtitle: 'Tasks, owners and what they wait on' },
  team: { title: 'Team', subtitle: 'Who did what, and who handed what to whom' },
  agents: { title: 'Agents', subtitle: 'Strengths, results and savings' },
};

const TICKER_MESSAGES = [
  'CODEX RESOLVED 2 CALLERS OF LOGIN()',
  'CLAUDE CODE WROTE 1 LESSON TO GRAPH',
  'OPENCODE PINNED DOCS/API/REFERENCE.MD',
  'GRAPH +1 SYMBOL · +3 EDGES',
  'CLAUDE CODE VERIFIED CONTEXTPACK',
  'CODEX OPENED WORKTREE WT_SESSION',
  'FALKORDB CHECKPOINT WRITTEN TO DISK',
];

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
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsFor, setSettingsFor] = useState<ProjectSummary>();
  /** Bumped when the active project changes (added, switched, removed, edited): everything reloads */
  const [projectTick, setProjectTick] = useState(0);
  /** Bumped when agents finish a session, so the agent pool and stats reload */
  const [agentsTick, setAgentsTick] = useState(0);

  const info = useLoad(() => puff.getBackendInfo(), [projectTick]);
  const projects = useLoad(() => puff.listProjects(), [projectTick]);
  // What the setup screen shows (database and Docker) or the welcome screen (agent tools)
  const setup = useLoad(
    () =>
      info?.needsSetup || info?.noProject ? puff.getSetupStatus() : Promise.resolve(undefined),
    [info?.needsSetup, info?.noProject, projectTick],
  );
  const projectId = info?.projectId ?? MOCK_PROJECT_ID;
  const live = info?.mode === 'live';
  const savingsMocked = !live || info.mockParts.includes('savings');

  const tasks = useTasks(projectId);
  const chat = useChat(projectId);
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

  // Ctrl+K (or Cmd+K) opens and closes the chat from anywhere
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setChatOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const reloadProjects = () => setProjectTick((t) => t + 1);
  const switchProject = async (id: string) => {
    try {
      await puff.switchProject(id);
      reloadProjects();
    } catch (err) {
      setNotice({ tone: 'bad', text: (err as Error).message });
    }
  };

  if (info?.needsSetup) {
    return (
      <Setup
        status={setup}
        onStart={async () => {
          await puff.startDatabase();
          reloadProjects();
        }}
        onRetry={async () => {
          const status = await puff.retrySetup();
          if (!status.databaseOk) throw new Error(status.databaseError ?? 'Still not reachable.');
          reloadProjects();
        }}
      />
    );
  }

  const [tickerIndex, setTickerIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setTickerIndex((i) => (i + 1) % TICKER_MESSAGES.length);
    }, 4000);
    return () => clearInterval(timer);
  }, []);

  const tickerText = notice?.text ?? TICKER_MESSAGES[tickerIndex];

  return (
    <div className="flex h-full flex-col bg-abyss text-ink">
      {/* Top window chrome matching Screenshot 3 & 4 */}
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-line bg-surface-2 px-4 select-none">
        <div className="flex gap-1.5">
          <span className="size-2 bg-slate-700" />
          <span className="size-2 bg-slate-700" />
          <span className="size-2 bg-slate-700" />
        </div>
        <span className="font-mono text-[11px] text-slate-500">
          Puff — {info?.projectName ?? 'puff_demo'}
        </span>
        <span className="ml-auto hidden items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-emerald-400 sm:flex">
          <span className="size-1.5 animate-pulse-dot rounded-full bg-emerald-400" />
          graph connected
        </span>
      </div>

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
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
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <TopBar
            {...TITLES[screen]}
            running={running}
            onToggleRun={toggleRun}
            onGoal={createGoal}
            onNewTask={() => setNewTaskOpen(true)}
            chatOpen={chatOpen}
            onToggleChat={() => setChatOpen((open) => !open)}
            badge={badgeFor(info)}
            runBlockedReason={
              info?.noProject ? 'Add a project first.' : live ? info.runBlocked : undefined
            }
          />
          <div className="min-h-0 flex-1 overflow-auto">
            {info?.noProject && <Welcome onAdd={() => setImportOpen(true)} agents={setup?.agents} />}
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

        {/* Antigravity / Cursor style slide-over Chat Panel */}
        <ChatPanel
          open={chatOpen}
          messages={chat.messages}
          info={chat.info}
          busy={chat.busy}
          error={chat.error}
          onSend={(text) => void chat.send(text)}
          onApprove={(id, approve) => void chat.approve(id, approve)}
          onReset={() => void chat.reset()}
          onClose={() => setChatOpen(false)}
        />
      </div>

      {/* Bottom status bar ticker matching Screenshot 3 & 4 */}
      <footer className="flex h-7 shrink-0 items-center justify-between gap-4 border-t border-line bg-surface-2 px-4 font-mono text-[10px] uppercase tracking-widest text-slate-500 select-none">
        <span className="inline-flex shrink-0 items-center gap-1.5 text-slate-400">
          <Activity className="size-3.5 text-emerald-400" />
          FALKORDB://{(info?.projectName ?? 'puff_demo').toUpperCase()}
        </span>
        <span className="hidden min-w-0 flex-1 items-center gap-1.5 sm:flex">
          <span className="size-1.5 shrink-0 animate-pulse-dot rounded-full bg-emerald-400" />
          <span className="truncate text-slate-300">{tickerText}</span>
          <span className="animate-caret shrink-0 text-emerald-400">▌</span>
        </span>
        <span className="shrink-0 text-slate-500">V0.1.0</span>
      </footer>
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
      {openTask && <TaskDetail taskId={openTask} onClose={closeTask} symbols={symbols} />}
      {notice && (
        <Notice tone={notice.tone} onClose={() => setNotice(undefined)}>
          {notice.text}
        </Notice>
      )}
    </div>
  );
}
