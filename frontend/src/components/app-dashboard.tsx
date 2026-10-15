'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  LayoutList,
  Network,
  Bot,
  Database,
  Settings,
  Search,
  Plus,
  Copy,
  GitBranch,
  Activity,
} from 'lucide-react';
import { AgentBadge } from './agent-badge';
import { agentLogos, agentBrandColors } from './agent-logos';
import { GraphMemoryLoop } from './graph-memory-loop';
import { PuffMark } from './puff-logo';

type ViewKey = 'tasks' | 'graph' | 'agents' | 'memory';
type AgentKey = keyof typeof agentLogos;
type Status = 'running' | 'queued' | 'verified' | 'planned';

const NAV: { key: ViewKey; label: string; icon: typeof LayoutList }[] = [
  { key: 'tasks', label: 'Tasks', icon: LayoutList },
  { key: 'graph', label: 'Graph', icon: Network },
  { key: 'agents', label: 'Agents', icon: Bot },
  { key: 'memory', label: 'Memory', icon: Database },
];

const STATUS: Record<Status, { label: string; dot: string; text: string }> = {
  running: { label: 'running', dot: 'bg-emerald-400', text: 'text-emerald-400' },
  queued: { label: 'queued', dot: 'bg-slate-600', text: 'text-slate-400' },
  verified: { label: 'verified', dot: 'bg-slate-300', text: 'text-slate-200' },
  planned: { label: 'planned', dot: 'bg-slate-700', text: 'text-slate-500' },
};

const ACTIVITY = [
  'Claude Code wrote 1 lesson to graph',
  'Codex resolved 2 callers of login()',
  'OpenCode pinned docs/api/reference.md',
  'graph +1 symbol · +3 edges',
  'Claude Code verified ContextPack',
  'Codex opened worktree wt_session',
  'FalkorDB checkpoint written to disk',
];

type Task = {
  id: string;
  title: string;
  target: string;
  status: Status;
  agent: AgentKey;
  role: string;
  progress: number;
  tokens: string;
  callers: string[];
  lesson: string;
  decision: string;
};

const TASKS: Task[] = [
  {
    id: 'rate-limit',
    title: 'Add rate limiting to login endpoint',
    target: 'src/auth/login.ts:12-48',
    status: 'running',
    agent: 'claude',
    role: 'plan + verify',
    progress: 68,
    tokens: '4.2k of 11k tokens',
    callers: ['routes/auth.ts::postLogin', 'session.ts::Session.start'],
    lesson: '"test: password appears in audit log" → redact credentials before audit()',
    decision: 'Tokens are stored in httpOnly cookies, never localStorage',
  },
  {
    id: 'product-names',
    title: 'Return all product names in one helper',
    target: 'src/products/service.ts:80-105',
    status: 'running',
    agent: 'codex',
    role: 'implementation',
    progress: 42,
    tokens: '3.1k of 12k tokens',
    callers: ['controllers/products.ts::getProducts'],
    lesson: 'None recorded for this symbol',
    decision: 'Always paginate DB queries with limit ≤ 100',
  },
  {
    id: 'docs-refresh',
    title: 'Refresh the API reference docs',
    target: 'docs/api/reference.md',
    status: 'queued',
    agent: 'opencode',
    role: 'docs · formatting',
    progress: 0,
    tokens: '1.4k of 9k tokens',
    callers: ['—'],
    lesson: 'Keep examples runnable; link the source symbol',
    decision: 'Docs edits never touch code files',
  },
  {
    id: 'session-refactor',
    title: 'Refactor session token storage',
    target: 'src/session.ts:30-96',
    status: 'verified',
    agent: 'codex',
    role: 'refactor',
    progress: 100,
    tokens: '6.8k of 16k tokens',
    callers: ['routes/auth.ts::postLogin', 'middleware/guard.ts::requireUser'],
    lesson: '"rotating refresh broke mobile" → keep a 30s grace window',
    decision: 'Refresh tokens rotate on every use',
  },
  {
    id: 'audit-redaction',
    title: 'Redact credentials in the audit log',
    target: 'src/audit/log.ts:18-52',
    status: 'planned',
    agent: 'claude',
    role: 'review',
    progress: 0,
    tokens: '2.2k of 10k tokens',
    callers: ['session.ts::Session.start', 'auth/login.ts::login'],
    lesson: '"password leaked into audit" → redact before write',
    decision: 'Audit log stores identifiers, never secrets',
  },
];

const AGENT_CARDS: { key: AgentKey; name: string; role: string; success: string; tasks: number }[] =
  [
    {
      key: 'claude',
      name: 'Claude Code',
      role: 'plan · verify · review',
      success: '94%',
      tasks: 3,
    },
    { key: 'codex', name: 'Codex', role: 'implementation · refactor', success: '91%', tasks: 4 },
    { key: 'opencode', name: 'OpenCode', role: 'docs · formatting', success: '88%', tasks: 2 },
  ];

const MEMORY_ROWS = [
  {
    kind: 'Symbol',
    node: 'src/auth/login.ts::login',
    detail: '2 callers · 1 dependency',
    updated: '12s',
  },
  { kind: 'Task', node: 'Add rate limiting', detail: 'targets login.ts:12-48', updated: '1m' },
  { kind: 'Lesson', node: 'password in audit log', detail: 'redact before audit()', updated: '3m' },
  { kind: 'Decision', node: 'httpOnly cookies', detail: 'applies to auth/*', updated: '9m' },
  { kind: 'Procedure', node: 'spin up worktree', detail: 'used by 4 tasks', updated: '26m' },
];

function StatusPill({ status }: { status: Status }) {
  const s = STATUS[status];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 border border-slate-600 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest ${s.text}`}
    >
      <span
        className={`h-1.5 w-1.5 ${s.dot} ${status === 'running' ? 'animate-live-ring' : ''}`}
      />
      {s.label}
    </span>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">{children}</p>
  );
}

export function AppDashboard() {
  const [view, setView] = useState<ViewKey>('tasks');
  const [selected, setSelected] = useState<string>(TASKS[0].id);
  const [tick, setTick] = useState(0);
  const [live, setLive] = useState(true);
  const pausedUntil = useRef(0);
  const tickRef = useRef(0);

  const task = TASKS.find((t) => t.id === selected) ?? TASKS[0];
  const AgentLogo = agentLogos[task.agent];
  const taskStatus = STATUS[task.status];

  // Framer Motion transitions, neutralised when the user prefers reduced motion.
  const layoutSpring = live
    ? { type: 'spring' as const, stiffness: 420, damping: 34, mass: 0.8 }
    : { duration: 0 };
  const fade = (duration: number) =>
    live ? { duration, ease: 'easeOut' as const } : { duration: 0 };

  // Respect reduced-motion: freeze all simulated activity.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setLive(!mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  // Heartbeat that drives the live numbers.
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1200);
    return () => window.clearInterval(id);
  }, [live]);

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  // Auto-cycle the focused task (paused briefly after a manual click).
  useEffect(() => {
    if (!live || view !== 'tasks') return;
    const id = window.setInterval(() => {
      if (tickRef.current < pausedUntil.current) return;
      setSelected((cur) => {
        const i = TASKS.findIndex((t) => t.id === cur);
        return TASKS[(i + 1) % TASKS.length].id;
      });
    }, 5200);
    return () => window.clearInterval(id);
  }, [live, view]);

  function pickTask(id: string) {
    pausedUntil.current = tickRef.current + 12;
    setSelected(id);
  }

  const stats = [
    { label: 'Agents online', value: '3' },
    { label: 'Tasks in flight', value: '2' },
    { label: 'Token reduction', value: `${84 + (tick % 4)}%` },
    { label: 'Graph nodes', value: (1284 + tick).toLocaleString('en-US') },
  ];

  const selectedProgress =
    task.status === 'running' ? Math.min(99, task.progress + tick * 2) : task.progress;

  const activity = ACTIVITY[tick % ACTIVITY.length];

  return (
    <div className="border border-slate-600 bg-[#0b0d12] shadow-2xl shadow-black/50">
      {/* window chrome */}
      <div className="flex h-10 items-center gap-3 border-b border-slate-600 bg-[#0e1116] px-4">
        <div className="flex gap-1.5">
          <span className="h-2.5 w-2.5 bg-slate-700" />
          <span className="h-2.5 w-2.5 bg-slate-700" />
          <span className="h-2.5 w-2.5 bg-slate-700" />
        </div>
        <span className="font-mono text-[11px] text-slate-500">Puff — puff_demo</span>
        <span className="ml-auto hidden items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-emerald-400 sm:flex">
          <span className="h-1.5 w-1.5 animate-pulse-dot bg-emerald-400" />
          graph connected
        </span>
      </div>

      <div className="grid md:grid-cols-[13rem_1fr]">
        {/* sidebar */}
        <aside className="hidden flex-col border-r border-slate-600 p-3 md:flex">
          <div className="flex items-center gap-2 px-2 pb-4">
            <PuffMark className="h-6 w-6 shrink-0" />
            <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
              desktop
            </span>
          </div>

          <nav className="space-y-1">
            {NAV.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setView(key)}
                aria-pressed={view === key}
                className={`relative flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors duration-150 ease-out ${
                  view === key ? 'text-white' : 'text-slate-400 hover:bg-slate-900/60 hover:text-slate-200'
                }`}
              >
                {view === key && (
                  <motion.span
                    layoutId="nav-active"
                    className="absolute inset-0 bg-slate-800/70"
                    transition={layoutSpring}
                  />
                )}
                <Icon className="relative z-10 h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                <span className="relative z-10">{label}</span>
              </button>
            ))}
          </nav>

          <div className="mt-4 border-t border-slate-600 pt-4">
            <button className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm text-slate-500 transition-colors duration-150 ease-out hover:text-slate-300">
              <Settings className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
              Settings
            </button>
          </div>

          <div className="mt-auto border border-slate-600 bg-slate-900/40 p-3">
            <Label>Workspace</Label>
            <p className="mt-1 text-sm text-slate-200">puff_demo</p>
            <p className="flex items-center gap-1.5 font-mono text-[10px] text-slate-500">
              <span className="h-1.5 w-1.5 animate-pulse-dot bg-emerald-400" />
              falkordb · connected
            </p>
          </div>
        </aside>

        {/* main */}
        <div className="min-w-0">
          {/* mobile nav */}
          <div className="no-scrollbar flex gap-1 overflow-x-auto border-b border-slate-600 p-2 md:hidden">
            {NAV.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setView(key)}
                className={`relative inline-flex shrink-0 items-center gap-1.5 px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors duration-150 ease-out ${
                  view === key ? 'text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {view === key && (
                  <motion.span
                    layoutId="nav-active-mobile"
                    className="absolute inset-0 bg-slate-800"
                    transition={layoutSpring}
                  />
                )}
                <Icon className="relative z-10 h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
                <span className="relative z-10">{label}</span>
              </button>
            ))}
          </div>

          {/* view header */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-600 px-4 py-3">
            <div className="flex items-center gap-2">
              <h3 className="font-display text-sm font-semibold text-white">
                {view === 'tasks' && 'Tasks'}
                {view === 'graph' && 'Graph memory'}
                {view === 'agents' && 'Agents'}
                {view === 'memory' && 'Memory'}
              </h3>
              <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                {view === 'tasks' && '2 running · 1 queued · 1 verified'}
                {view === 'graph' && '1,284 nodes · 3,910 edges'}
                {view === 'agents' && '3 connected'}
                {view === 'memory' && 'recent writes'}
              </span>
              {live && (
                <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-emerald-400">
                  <span className="h-1.5 w-1.5 animate-live-ring bg-emerald-400" />
                  live
                </span>
              )}
            </div>

            {view === 'tasks' && (
              <div className="flex items-center gap-2">
                <div className="hidden items-center gap-2 border border-slate-600 bg-slate-900/60 px-2.5 py-1.5 sm:flex">
                  <Search className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
                  <span className="font-mono text-xs text-slate-500">Search tasks…</span>
                </div>
                <button className="inline-flex items-center gap-1.5 bg-white px-3 py-1.5 text-xs font-semibold text-slate-950 transition-opacity duration-150 ease-out hover:opacity-90">
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  New task
                </button>
              </div>
            )}
          </div>

          <div className="no-scrollbar h-[540px] overflow-y-auto overscroll-contain">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={view}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={fade(0.22)}
              >
                {view === 'tasks' && (
                  <>
                    <div className="grid grid-cols-2 gap-px border-b border-slate-600 bg-slate-600 md:grid-cols-4">
                      {stats.map((s) => (
                        <div key={s.label} className="bg-[#0b0d12] p-4">
                          <Label>{s.label}</Label>
                          <p className="mt-1 font-display text-xl font-bold tabular-nums tracking-tight text-white">
                            {s.value}
                          </p>
                        </div>
                      ))}
                    </div>

                    <div className="grid lg:grid-cols-[1fr_20rem]">
                      {/* task list */}
                      <div className="min-w-0">
                        {TASKS.map((t) => {
                          const Logo = agentLogos[t.agent];
                          const isSelected = t.id === task.id;
                          return (
                            <button
                              key={t.id}
                              onClick={() => pickTask(t.id)}
                              aria-pressed={isSelected}
                              className={`relative flex w-full items-center gap-3 border-b border-slate-600 px-4 py-3 text-left ${
                                isSelected ? '' : 'transition-colors duration-150 ease-out hover:bg-slate-900/40'
                              }`}
                            >
                              {isSelected && (
                                <motion.span
                                  layoutId="task-active"
                                  className="absolute inset-0 bg-slate-900/70"
                                  transition={layoutSpring}
                                />
                              )}
                              <Logo
                                className="relative z-10 h-4 w-4 shrink-0"
                                color={agentBrandColors[t.agent]}
                              />
                              <div className="relative z-10 min-w-0 flex-1">
                                <p className="truncate text-sm text-slate-100">{t.title}</p>
                                <p className="truncate font-mono text-[11px] text-slate-500">
                                  {t.target}
                                </p>
                              </div>
                              <span className="relative z-10">
                                <StatusPill status={t.status} />
                              </span>
                            </button>
                          );
                        })}

                        <div className="flex items-center justify-between px-4 py-3 font-mono text-[10px] uppercase tracking-widest text-slate-500">
                          <span className="inline-flex items-center gap-1.5">
                            <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
                            one worktree per running task
                          </span>
                          <span className="hidden sm:inline">
                            no two agents edit the same symbol
                          </span>
                        </div>
                      </div>

                      {/* detail */}
                      <div className="border-t border-slate-600 lg:border-l lg:border-t-0">
                        <AnimatePresence mode="wait" initial={false}>
                          <motion.div
                            key={task.id}
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -10 }}
                            transition={fade(0.24)}
                          >
                            <div className="flex items-center justify-between border-b border-slate-600 px-4 py-3">
                              <Label>ContextPack</Label>
                              <span
                                className={`inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest ${taskStatus.text}`}
                              >
                                <span
                                  className={`h-1.5 w-1.5 ${taskStatus.dot} ${
                                    task.status === 'running' ? 'animate-live-ring' : ''
                                  }`}
                                />
                                {taskStatus.label}
                              </span>
                            </div>

                            <div className="space-y-5 p-4">
                              <div className="flex items-center justify-between gap-3">
                                <AgentBadge kind={task.agent} brand />
                                <span className="font-mono text-[11px] text-slate-400">
                                  {task.role}
                                </span>
                              </div>

                              <div>
                                <Label>Target symbol</Label>
                                <p className="mt-1 inline-flex items-center gap-2 font-mono text-xs text-slate-200">
                                  <AgentLogo
                                    className="h-3.5 w-3.5"
                                    color={agentBrandColors[task.agent]}
                                  />
                                  {task.target}
                                </p>
                              </div>

                              <div>
                                <Label>Progress</Label>
                                <div className="mt-2 flex items-center gap-3">
                                  <span className="relative block h-1.5 flex-1 overflow-hidden bg-slate-600">
                                    <motion.span
                                      className="relative block h-full overflow-hidden bg-emerald-400"
                                      initial={false}
                                      animate={{ width: `${selectedProgress}%` }}
                                      transition={
                                        live ? { duration: 1.1, ease: 'easeOut' } : { duration: 0 }
                                      }
                                    >
                                      {task.status === 'running' && (
                                        <span className="absolute inset-y-0 left-0 w-1/3 animate-sheen bg-white/30" />
                                      )}
                                    </motion.span>
                                  </span>
                                  <span className="w-9 text-right font-mono text-[11px] tabular-nums text-slate-400">
                                    {selectedProgress}%
                                  </span>
                                </div>
                              </div>

                              <div>
                                <Label>Impact graph · callers</Label>
                                <ul className="mt-1.5 space-y-1 font-mono text-xs text-slate-300">
                                  {task.callers.map((c) => (
                                    <li key={c} className="truncate">
                                      <span className="text-slate-600">↳ </span>
                                      {c}
                                    </li>
                                  ))}
                                </ul>
                              </div>

                              <div>
                                <Label>Past lesson</Label>
                                <p className="mt-1 text-xs text-slate-300 text-pretty">
                                  {task.lesson}
                                </p>
                              </div>

                              <div>
                                <Label>Active decision</Label>
                                <p className="mt-1 text-xs text-slate-300 text-pretty">
                                  {task.decision}
                                </p>
                              </div>
                            </div>

                            <div className="flex items-center justify-between border-t border-slate-600 bg-[#0e1116] px-4 py-3">
                              <span className="font-mono text-[11px] text-slate-500">
                                {task.tokens}
                              </span>
                              <button className="inline-flex items-center gap-1.5 font-mono text-[11px] text-slate-400 transition-colors duration-150 ease-out hover:text-white">
                                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                                Copy context
                              </button>
                            </div>
                          </motion.div>
                        </AnimatePresence>
                      </div>
                    </div>
                  </>
                )}

                {view === 'graph' && (
                  <div className="p-5">
                    <GraphMemoryLoop live={live} tick={tick} />
                    <div className="mt-5 grid grid-cols-2 gap-px bg-slate-600 md:grid-cols-4">
                      {[
                        { label: 'Symbols', value: '412' },
                        { label: 'Tasks', value: '68' },
                        { label: 'Lessons', value: '37' },
                        { label: 'Decisions', value: '24' },
                      ].map((s) => (
                        <div key={s.label} className="bg-[#0b0d12] p-4">
                          <Label>{s.label}</Label>
                          <p className="mt-1 font-display text-xl font-bold tabular-nums tracking-tight text-white">
                            {s.value}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {view === 'agents' && (
                  <div className="grid gap-px bg-slate-600 md:grid-cols-3">
                    {AGENT_CARDS.map((a) => {
                      const Logo = agentLogos[a.key];
                      return (
                        <div key={a.key} className="bg-[#0b0d12] p-5">
                          <div className="flex items-center gap-3">
                            <Logo className="h-5 w-5" color={agentBrandColors[a.key]} />
                            <div>
                              <p className="text-sm font-semibold text-white">{a.name}</p>
                              <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
                                {a.role}
                              </p>
                            </div>
                          </div>
                          <dl className="mt-5 space-y-2 font-mono text-xs">
                            <div className="flex items-center justify-between">
                              <dt className="text-slate-500">status</dt>
                              <dd className="inline-flex items-center gap-1.5 text-emerald-400">
                                <span className="h-1.5 w-1.5 animate-live-ring bg-emerald-400" />
                                online
                              </dd>
                            </div>
                            <div className="flex items-center justify-between">
                              <dt className="text-slate-500">success rate</dt>
                              <dd className="tabular-nums text-slate-200">{a.success}</dd>
                            </div>
                            <div className="flex items-center justify-between">
                              <dt className="text-slate-500">tasks handled</dt>
                              <dd className="tabular-nums text-slate-200">{a.tasks}</dd>
                            </div>
                          </dl>
                        </div>
                      );
                    })}
                  </div>
                )}

                {view === 'memory' && (
                  <div className="no-scrollbar overflow-x-auto">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="border-b border-slate-600 font-mono text-[10px] uppercase tracking-widest text-slate-500">
                          <th className="px-4 py-3 font-normal">Kind</th>
                          <th className="px-4 py-3 font-normal">Node</th>
                          <th className="px-4 py-3 font-normal">Detail</th>
                          <th className="px-4 py-3 font-normal text-right">Updated</th>
                        </tr>
                      </thead>
                      <tbody>
                        {MEMORY_ROWS.map((r, i) => (
                          <tr key={r.node} className="border-b border-slate-600 last:border-b-0">
                            <td className="px-4 py-3 font-mono text-[11px] uppercase tracking-widest text-slate-400">
                              {r.kind}
                            </td>
                            <td className="px-4 py-3 font-mono text-xs text-slate-100">{r.node}</td>
                            <td className="px-4 py-3 text-xs text-slate-400">{r.detail}</td>
                            <td className="px-4 py-3 text-right font-mono text-[11px] tabular-nums text-slate-500">
                              <span className="inline-flex items-center gap-1.5">
                                {i === 0 && live && (
                                  <span className="h-1.5 w-1.5 animate-live-ring bg-emerald-400" />
                                )}
                                {i === 0 ? `${12 + (tick % 48)}s` : r.updated}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* status bar */}
          <div className="flex items-center justify-between gap-4 border-t border-slate-600 bg-[#0e1116] px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-slate-500">
            <span className="inline-flex shrink-0 items-center gap-1.5">
              <Activity className="h-3.5 w-3.5" aria-hidden="true" />
              falkordb://puff_demo
            </span>
            <span className="hidden min-w-0 flex-1 items-center gap-1.5 sm:flex">
              <span className="h-1.5 w-1.5 shrink-0 animate-live-ring bg-emerald-400" />
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={tick}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={fade(0.25)}
                  className="truncate text-slate-400"
                >
                  {activity}
                </motion.span>
              </AnimatePresence>
              <span className="animate-caret shrink-0 text-emerald-400">▌</span>
            </span>
            <span className="shrink-0">v0.1.0</span>
          </div>
        </div>
      </div>
    </div>
  );
}
