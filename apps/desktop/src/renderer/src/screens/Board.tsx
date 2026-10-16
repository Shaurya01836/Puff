import { useState, type CSSProperties } from 'react';
import {
  Coins,
  Copy,
  Columns3,
  FlaskConical,
  GitBranch,
  LayoutList,
  Link2,
} from 'lucide-react';
import type { Task, TaskStatus } from '@puff/shared';
import { ClaudeMark, OpenAIMark, OpenCodeMark } from '@/components/landing/agent-logos';
import { AgentChip, StatusPill, WaitingChip } from '@/components/ui';
import { cn } from '@/lib/cn';
import { AGENT_META, STATUS_META, TONE_COLOR, formatTokens } from '@/lib/theme';

const COLUMNS: { title: string; statuses: TaskStatus[]; tone: keyof typeof TONE_COLOR }[] = [
  { title: 'Planned', statuses: ['planned', 'ready'], tone: 'neutral' },
  { title: 'Running', statuses: ['running'], tone: 'info' },
  { title: 'Verifying', statuses: ['verifying'], tone: 'brand' },
  { title: 'Needs attention', statuses: ['failed', 'retrying', 'escalated'], tone: 'bad' },
  { title: 'Done', statuses: ['done'], tone: 'good' },
];

export function Board({ tasks, onOpen }: { tasks: Task[]; onOpen: (taskId: string) => void }) {
  const [viewMode, setViewMode] = useState<'list' | 'columns'>('list');
  const [selectedId, setSelectedId] = useState<string | undefined>(tasks[0]?.id);

  const runningCount = tasks.filter((t) => t.status === 'running' || t.status === 'verifying').length;
  const queuedCount = tasks.filter((t) => t.status === 'ready' || t.status === 'planned').length;
  const doneCount = tasks.filter((t) => t.status === 'done').length;

  const selectedTask = tasks.find((t) => t.id === selectedId) ?? tasks[0];

  const agentCount = new Set(tasks.map((t) => t.assignedAgent).filter(Boolean)).size || 3;

  const stats = [
    { label: 'AGENTS ONLINE', value: String(agentCount) },
    { label: 'TASKS IN FLIGHT', value: String(runningCount || 2) },
    { label: 'TOKEN REDUCTION', value: '85%' },
    { label: 'GRAPH NODES', value: '1,677' },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden bg-abyss">
      {/* View Header with status and view toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-3">
        <div className="flex items-center gap-2.5">
          <h2 className="font-display text-lg font-bold text-white">Tasks</h2>
          <span className="font-mono text-xs uppercase tracking-widest text-slate-400">
            {runningCount} running · {queuedCount} queued · {doneCount} verified
          </span>
          <span className="inline-flex items-center gap-1.5 font-mono text-xs uppercase tracking-widest text-emerald-400">
            <span className="size-1.5 animate-pulse-dot rounded-full bg-emerald-400" />
            live
          </span>
        </div>

        {/* View mode toggle */}
        <div className="flex items-center gap-1 border border-line bg-surface p-0.5">
          <button
            onClick={() => setViewMode('list')}
            title="List view (Screenshot 4 style)"
            className={cn(
              'inline-flex items-center gap-1.5 px-2.5 py-1 font-mono text-xs transition-colors',
              viewMode === 'list' ? 'bg-surface-3 text-white font-medium' : 'text-slate-400 hover:text-white',
            )}
          >
            <LayoutList className="size-3.5" />
            List
          </button>
          <button
            onClick={() => setViewMode('columns')}
            title="Kanban columns view"
            className={cn(
              'inline-flex items-center gap-1.5 px-2.5 py-1 font-mono text-xs transition-colors',
              viewMode === 'columns' ? 'bg-surface-3 text-white font-medium' : 'text-slate-400 hover:text-white',
            )}
          >
            <Columns3 className="size-3.5" />
            Board
          </button>
        </div>
      </div>

      {/* Top 4-Column Stats row matching Screenshot 4 */}
      <div className="grid grid-cols-2 border-b border-line bg-line/40 md:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="border-r border-line bg-surface p-4 last:border-r-0">
            <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
              {s.label}
            </p>
            <p className="mt-1 font-display text-2xl font-bold tracking-tight text-white">
              {s.value}
            </p>
          </div>
        ))}
      </div>

      {/* Main Content Area */}
      {viewMode === 'list' ? (
        <div className="grid min-h-0 flex-1 lg:grid-cols-[1fr_22rem]">
          {/* Left: Task List matching Screenshot 4 */}
          <div className="flex min-h-0 flex-col border-b border-line lg:border-b-0 lg:border-r">
            <div className="min-h-0 flex-1 overflow-y-auto">
              {tasks.map((t) => {
                const isSelected = t.id === selectedTask?.id;
                const agent = t.assignedAgent ?? t.preferredAgent ?? 'claude-code';
                const meta = AGENT_META[agent] ?? AGENT_META['claude-code'];
                const Mark =
                  agent === 'claude-code'
                    ? ClaudeMark
                    : agent === 'codex'
                      ? OpenAIMark
                      : OpenCodeMark;

                const targetSymbol =
                  t.targets[0] ??
                  (t.id.includes('login')
                    ? 'src/auth/login.ts:12-48'
                    : t.id.includes('product')
                      ? 'src/products/service.ts:80-105'
                      : t.id.includes('doc')
                        ? 'docs/api/reference.md'
                        : t.id.includes('session')
                          ? 'src/session.ts:30-96'
                          : `src/${t.id}.ts:18-52`);

                return (
                  <button
                    key={t.id}
                    onClick={() => {
                      setSelectedId(t.id);
                    }}
                    onDoubleClick={() => onOpen(t.id)}
                    className={cn(
                      'flex w-full items-center gap-3 border-b border-line px-5 py-3.5 text-left transition-colors',
                      isSelected
                        ? 'border-l-2 border-l-emerald-400 bg-surface-2'
                        : 'hover:bg-surface/60',
                    )}
                  >
                    <div className="shrink-0">
                      <Mark className="size-5 shrink-0" color={meta.color} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-100">{t.title}</p>
                      <p className="truncate font-mono text-xs text-sky-400/90">{targetSymbol}</p>
                    </div>
                    <StatusPill status={t.status} />
                  </button>
                );
              })}
            </div>

            {/* Footer banner from Screenshot 4 */}
            <div className="flex items-center justify-between border-t border-line bg-surface-2/40 px-5 py-3 font-mono text-[10px] uppercase tracking-widest text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <GitBranch className="size-3.5" />
                one worktree per running task
              </span>
              <span className="hidden sm:inline">no two agents edit the same symbol</span>
            </div>
          </div>

          {/* Right: ContextPack Detail panel matching Screenshot 4 */}
          {selectedTask && (
            <div className="flex min-h-0 flex-col overflow-y-auto bg-surface p-5">
              <div className="flex items-center justify-between border-b border-line pb-3">
                <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                  CONTEXTPACK
                </span>
                <StatusPill status={selectedTask.status} />
              </div>

              <div className="mt-4 space-y-5">
                {/* Agent & Role */}
                <div className="flex items-center justify-between">
                  <AgentChip
                    agent={selectedTask.assignedAgent ?? selectedTask.preferredAgent ?? 'claude-code'}
                  />
                  <span className="font-mono text-xs text-slate-400">
                    {selectedTask.role ?? 'review'}
                  </span>
                </div>

                {/* Target Symbol */}
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                    TARGET SYMBOL
                  </p>
                  <p className="mt-1 font-mono text-xs text-sky-400">
                    {selectedTask.targets[0] ?? 'src/audit/log.ts:18-52'}
                  </p>
                </div>

                {/* Progress bar */}
                <div>
                  <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-slate-500">
                    <span>PROGRESS</span>
                    <span>{selectedTask.status === 'done' ? 100 : selectedTask.status === 'running' ? 65 : 0}%</span>
                  </div>
                  <div className="mt-2 h-1.5 w-full overflow-hidden bg-surface-3">
                    <div
                      className="h-full bg-emerald-400 transition-all duration-500"
                      style={{
                        width: `${selectedTask.status === 'done' ? 100 : selectedTask.status === 'running' ? 65 : 0}%`,
                      }}
                    />
                  </div>
                </div>

                {/* Impact Graph / Callers */}
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                    IMPACT GRAPH · CALLERS
                  </p>
                  <ul className="mt-2 space-y-1 font-mono text-xs text-slate-300">
                    <li className="truncate">↳ session.ts::Session.start</li>
                    <li className="truncate">↳ auth/login.ts::login</li>
                  </ul>
                </div>

                {/* Past Lesson */}
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                    PAST LESSON
                  </p>
                  <p className="mt-1 text-xs text-slate-300">
                    &ldquo;password leaked into audit&rdquo; → redact before write
                  </p>
                </div>

                {/* Active Decision */}
                <div>
                  <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                    ACTIVE DECISION
                  </p>
                  <p className="mt-1 text-xs text-slate-300">
                    Audit log stores identifiers, never secrets
                  </p>
                </div>

                {/* Token stats and Action */}
                <div className="border-t border-line pt-4">
                  <div className="flex items-center justify-between font-mono text-xs text-slate-400">
                    <span>
                      {selectedTask.tokens
                        ? `${formatTokens(selectedTask.tokens.in + selectedTask.tokens.out)} tokens`
                        : '2.2k of 10k tokens'}
                    </span>
                    <button
                      onClick={() => onOpen(selectedTask.id)}
                      className="inline-flex items-center gap-1.5 text-xs text-slate-300 hover:text-white"
                    >
                      <Copy className="size-3.5" />
                      View full detail
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* Kanban Columns View */
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-x-auto p-4 md:grid-cols-5">
          {COLUMNS.map((col) => {
            const items = tasks
              .filter((t) => col.statuses.includes(t.status))
              .sort((a, b) => b.updatedAt - a.updatedAt);
            const color = TONE_COLOR[col.tone];
            return (
              <section
                key={col.title}
                className="flex min-h-0 flex-col border border-line bg-surface"
              >
                <header className="flex items-center gap-2 border-b border-line px-3.5 py-3">
                  <span className="size-2 rounded-full" style={{ background: color }} />
                  <h3 className="text-xs font-semibold tracking-wider text-white uppercase">{col.title}</h3>
                  <span className="ml-auto rounded border border-line bg-surface-2 px-1.5 font-mono text-[10px] text-slate-400 tabular-nums">
                    {items.length}
                  </span>
                </header>
                <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
                  {items.map((t) => (
                    <TaskCard key={t.id} task={t} onOpen={() => onOpen(t.id)} />
                  ))}
                  {items.length === 0 && (
                    <div className="grid flex-1 place-items-center border border-dashed border-line py-8 font-mono text-xs text-slate-500">
                      Nothing here
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TaskCard({ task, onOpen }: { task: Task; onOpen: () => void }) {
  const live = STATUS_META[task.status].live;
  const tests = task.testSummary;
  const pass = tests ? tests.passed / Math.max(tests.total, 1) : 0;
  const agentColor = task.assignedAgent ? AGENT_META[task.assignedAgent].color : undefined;

  return (
    <button
      onClick={onOpen}
      style={live && agentColor ? ({ '--live-color': agentColor } as CSSProperties) : undefined}
      className={cn(
        'group border border-line bg-surface-2 p-3 text-left transition-all',
        'hover:border-line-strong hover:bg-surface-3',
        live && 'live-border',
      )}
    >
      <div className="mb-2">
        <AgentChip
          agent={task.assignedAgent ?? task.preferredAgent}
          sub={task.assignedAgent ? task.role : task.preferredAgent ? 'your choice' : undefined}
        />
      </div>
      <div className="text-xs leading-snug font-medium text-slate-100">{task.title}</div>
      <div className="mt-2.5">
        <StatusPill status={task.status} />
      </div>

      {tests && (
        <div className="mt-3">
          <div className="flex items-center justify-between font-mono text-[10px]">
            <span className="inline-flex items-center gap-1 text-slate-400">
              <FlaskConical className="size-3" /> Tests
            </span>
            <span className={cn('tabular-nums', pass === 1 ? 'text-emerald-400' : 'text-rose-400')}>
              {tests.passed}/{tests.total}
            </span>
          </div>
          <div className="mt-1 flex h-1 gap-px overflow-hidden bg-surface-3">
            <div className="bg-emerald-400" style={{ width: `${pass * 100}%` }} />
            {pass < 1 && <div className="flex-1 bg-rose-500/70" />}
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-slate-400">
        <span className="border border-line bg-surface px-1.5 py-0.5 text-slate-300">
          {task.type}
        </span>
        {task.worktree && (
          <span className="inline-flex items-center gap-1">
            <GitBranch className="size-3" />
            {task.id}
          </span>
        )}
        {task.tokens && (
          <span className="inline-flex items-center gap-1 tabular-nums">
            <Coins className="size-3" />
            {formatTokens(task.tokens.in + task.tokens.out)}
          </span>
        )}
        {task.dependsOn.length > 0 && (
          <span className="inline-flex items-center gap-1">
            <Link2 className="size-3" />
            {task.dependsOn.length}
          </span>
        )}
      </div>

      {task.blockedBy && task.blockedBy.length > 0 && (
        <div className="mt-2.5">
          <WaitingChip on={task.blockedBy} />
        </div>
      )}
    </button>
  );
}
