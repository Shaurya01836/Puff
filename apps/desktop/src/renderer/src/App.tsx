import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BackendInfo, GraphData, ProjectSummary, Task } from '@puff/shared';
import { MOCK_PROJECT_ID } from '@puff/shared/mocks';
import type { MascotState } from '@/components/Mascot';
import { Sidebar, type Screen } from '@/components/Sidebar';
import { TopBar } from '@/components/TopBar';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Notice } from '@/components/ui';
import { cn } from '@/lib/cn';
import { puff } from '@/lib/api';
import { useChat, useLoad, useTasks } from '@/lib/hooks';
import { NewTaskDialog, type SymbolOption } from '@/components/NewTaskDialog';
import { ChatPanel } from '@/components/ChatPanel';
import { ImportProjectDialog, ProjectSettingsDialog } from '@/components/ProjectDialogs';
import { Agents } from '@/screens/Agents';
import { Board, type BoardAction } from '@/screens/Board';
import { Memory } from '@/screens/Memory';
import { Setup } from '@/screens/Setup';
import { Welcome } from '@/screens/Welcome';
import pkg from '../../../package.json';

const TITLES: Record<Screen, { title: string; subtitle: string }> = {
  memory: { title: 'Memory', subtitle: 'What the team learned, and whether it still holds' },
  board: { title: 'Tasks', subtitle: 'What each agent is doing, and why the graph chose it' },
  agents: { title: 'Agents', subtitle: 'Strengths, records and who did what' },
};

/** The app's own version, shown in the status bar */
const VERSION = pkg.version;

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
  const [screen, setScreen] = useState<Screen>('board');
  /** The task shown next to the task list */
  const [selectedTask, setSelectedTask] = useState<string>();
  /** A task the person took over: its panel opens on the terminal */
  const [terminalFor, setTerminalFor] = useState<string>();
  /** "Pause after the current tasks" was pressed: nothing new starts, the running ones finish */
  const [pausing, setPausing] = useState(false);
  const [running, setRunning] = useState(false);
  const [graph, setGraph] = useState<GraphData>();
  const [notice, setNotice] = useState<NoticeState>();
  /** The last thing that really happened (an agent step, a memory written, a run ending), for the status bar */
  const [lastEvent, setLastEvent] = useState<string>();
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  /** Bumped when a sign-in finished, so the agent list is read again */
  const [setupTick, setSetupTick] = useState(0);
  const [setupOpen, setSetupOpen] = useState(false);
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
      info?.needsSetup || info?.noProject || setupOpen ? puff.getSetupStatus() : Promise.resolve(undefined),
    [info?.needsSetup, info?.noProject, setupOpen, projectTick, setupTick],
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
      if (e.type === 'activity') setLastEvent(`${e.step.taskId} · ${e.step.text}`);
      if (e.type === 'memory') setLastEvent(e.event.text);
      if (e.type === 'run' && e.message) setLastEvent(e.message);
      if (e.type === 'session:update' || (e.type === 'task:update' && e.task.depth)) {
        setAgentsTick((t) => t + 1);
      }
      if (e.type === 'memory') {
        clearTimeout(graphTimer.current);
        graphTimer.current = setTimeout(() => void loadGraph(), 1200);
      }
      if (e.type === 'project') {
        // A different project (or different settings): forget what belonged to the old one.
        setSelectedTask(undefined);
        setTerminalFor(undefined);
        setRunning(false);
        setGraph(undefined);
        setNotice(undefined);
        setProjectTick((t) => t + 1);
      }
      if (e.type === 'run') {
        setRunning(e.running);
        if (!e.running) setPausing(false);
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
    const active = tasks.filter((t) => !t.archived);
    if (active.some((t) => t.status === 'failed')) return 'worried';
    if (running || active.some((t) => t.status === 'running')) return 'working';
    if (active.length > 0 && active.every((t) => t.status === 'done')) return 'happy';
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

  /** Show a task on the Tasks screen (from the chat, the team timeline or a board action) */
  const openTask = useCallback((id: string) => {
    setSelectedTask(id);
    setScreen('board');
  }, []);

  /** Something the person asked of a task from the board */
  const boardAction = async (a: BoardAction) => {
    const say = (tone: 'good' | 'warn' | 'bad', text: string) => setNotice({ tone, text });
    try {
      switch (a.kind) {
        case 'stop':
          await puff.stopTask(a.id);
          return say(
            'good',
            'Stopped. The task is under Needs attention: retry it, switch agent or take it over.',
          );
        case 'retry':
          await puff.retryTask(a.id);
          return say('good', 'Back in the queue. Press Run team to start it.');
        case 'done':
          if (!window.confirm('Mark this task as done? Use this when you finished it yourself.'))
            return;
          await puff.markTaskDone(a.id);
          return say('good', 'Marked done. Whatever was waiting for it can start.');
        case 'takeover':
          setTerminalFor(a.id);
          openTask(a.id);
          return;
        case 'switch':
          await puff.reassignTask(a.id, a.agent);
          // If the team is running, carry on straight away; otherwise it waits for Run team
          if (running) await puff.start(projectId);
          return say(
            'good',
            running
              ? `Moved to ${a.agent}; it starts now.`
              : `Moved to ${a.agent}. Press Run team to start it.`,
          );
        case 'archive':
          await puff.archiveTask(a.id, true);
          return say('good', 'Archived. Kept in graph memory.');
        case 'restore':
          await puff.archiveTask(a.id, false);
          return say('good', 'Restored to the active board.');
        case 'clearFinished': {
          const cleared = await puff.clearFinishedTasks(projectId);
          return say(
            'good',
            `Archived ${cleared.length} finished task${cleared.length === 1 ? '' : 's'}. Kept in graph memory.`,
          );
        }
      }
    } catch (err) {
      say('bad', (err as Error).message);
    }
  };

  const pauseTeam = async () => {
    try {
      if (await puff.pauseTeam()) setPausing(true);
    } catch (err) {
      setNotice({ tone: 'bad', text: (err as Error).message });
    }
  };

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

  if (info?.needsSetup || setupOpen) {
    return (
      <Setup
        status={setup}
        canClose={!info?.needsSetup}
        onClose={() => setSetupOpen(false)}
        onRefresh={() => setSetupTick((t) => t + 1)}
        onStart={async () => {
          await puff.startDatabase();
          reloadProjects();
          setSetupOpen(false);
        }}
        onRetry={async () => {
          const status = await puff.retrySetup();
          if (!status.databaseOk) throw new Error(status.databaseError ?? 'Still not reachable.');
          reloadProjects();
          setSetupOpen(false);
        }}
      />
    );
  }

  const working = running || tasks.some((t) => t.status === 'running' || t.status === 'verifying');
  const statusText =
    notice?.text ??
    lastEvent ??
    (working ? 'The team is working' : info?.noProject ? 'No project yet' : 'Idle');

  return (
    <div className="flex h-full flex-col bg-abyss text-ink">
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
          onConfigureDatabase={() => setSetupOpen(true)}
          counts={{ board: tasks.filter((t) => !t.archived && t.status !== 'done').length }}
        />
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <TopBar
            {...TITLES[screen]}
            running={running}
            onToggleRun={toggleRun}
            onPause={pauseTeam}
            pausing={pausing}
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
            <ErrorBoundary resetKey={screen} label="This screen">
              {info?.noProject && (
                <Welcome
                  onAdd={() => setImportOpen(true)}
                  agents={setup?.agents}
                  onRefresh={() => setSetupTick((t) => t + 1)}
                />
              )}
              {!info?.noProject && screen === 'memory' && (
                <Memory
                  projectId={projectId}
                  graph={graph}
                  feedIsSample={!live || info.seeded === true}
                />
              )}
              {!info?.noProject && screen === 'board' && (
                <Board
                  tasks={tasks}
                  selectedId={selectedTask}
                  onSelect={(id) => {
                    setSelectedTask(id);
                    if (id !== terminalFor) setTerminalFor(undefined);
                  }}
                  terminalFor={terminalFor}
                  symbols={symbols}
                  onAction={boardAction}
                  onHint={(text) => setNotice({ tone: 'warn', text })}
                />
              )}
              {!info?.noProject && screen === 'agents' && (
                <Agents
                  agents={agents}
                  savings={savings}
                  mock={savingsMocked}
                  timeline={timeline}
                  onOpenTask={openTask}
                />
              )}
            </ErrorBoundary>
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
          onSetAgent={(agent) => void chat.setAgent(agent)}
          onClose={() => setChatOpen(false)}
        />
      </div>

      {/* Status bar: what the app is connected to and the last thing that really happened */}
      <footer className="flex h-7 shrink-0 items-center justify-between gap-4 border-t border-line bg-surface-2 px-4 text-[11px] text-ink-3 select-none">
        <button
          type="button"
          onClick={() => setSetupOpen(true)}
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded px-2 py-0.5 hover:bg-surface-3 transition-colors cursor-pointer',
            live ? 'text-ink-2' : 'text-warn',
          )}
          title={
            live
              ? `Connected to FalkorDB (${info?.graphName ?? info?.projectName}). Click to configure connection.`
              : 'Not connected to FalkorDB. Click to configure connection.'
          }
        >
          <span className={cn('size-1.5 rounded-full', live ? 'bg-emerald-400' : 'bg-amber-400')} />
          {live
            ? `FalkorDB · ${info?.graphName ?? info?.projectName}`
            : 'Not connected · sample data'}
          <span className="text-[10px] text-ink-3 underline ml-1">Configure</span>
        </button>
        <span className="hidden min-w-0 flex-1 items-center sm:flex">
          <span className="truncate text-ink">{statusText}</span>
        </span>
        <span className="shrink-0 font-mono text-ink-3">v{VERSION}</span>
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
            setScreen('board');
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
      {notice && (
        <Notice tone={notice.tone} onClose={() => setNotice(undefined)}>
          {notice.text}
        </Notice>
      )}
    </div>
  );
}
