// Mock team timeline for the demo repo: derived from the mock sessions, plus the handoff, spawn and
// escalation moments that make the story readable.
import type { TeamEvent } from '../types';
import { mockSessions, mockTasks } from './fixtures';

const titleOf = (taskId: string): string => mockTasks.find((t) => t.id === taskId)?.title ?? taskId;
const session = (id: string) => mockSessions.find((s) => s.id === id)!;

const sessionEvents: TeamEvent[] = mockSessions.map((s) => ({
  id: `session:${s.id}`,
  at: s.startedAt,
  kind: 'session',
  agent: s.agent,
  role: s.role,
  taskId: s.taskId,
  taskTitle: titleOf(s.taskId),
  outcome: s.outcome,
  text: s.output ?? (s.outcome === 'running' ? 'Working on it…' : ''),
}));

const planner = session('ses_01');
const spawned: TeamEvent[] = ['task_02', 'task_05', 'task_06'].map((id, i) => ({
  id: `spawned:${id}`,
  at: planner.startedAt + 150_000 + i * 1000,
  kind: 'spawned',
  agent: planner.agent,
  role: planner.role,
  taskId: planner.taskId,
  taskTitle: titleOf(planner.taskId),
  toTaskId: id,
  toTaskTitle: titleOf(id),
  text: titleOf(id),
}));

const extras: TeamEvent[] = [
  {
    id: 'handoff:hand_01',
    at: planner.startedAt + 160_000,
    kind: 'handoff',
    agent: planner.agent,
    role: planner.role,
    taskId: planner.taskId,
    taskTitle: titleOf(planner.taskId),
    toRole: 'coder',
    toAgent: 'codex',
    text: 'Limiter: 5 attempts per IP per 60 s, reset after the window. Wire it before the login handler.',
  },
  {
    id: 'escalated:ses_08',
    at: session('ses_08').startedAt - 1,
    kind: 'escalated',
    agent: 'opencode',
    toAgent: 'claude-code',
    role: 'coder',
    taskId: 'task_09',
    taskTitle: titleOf('task_09'),
    text: 'opencode could not finish it (failure), so it moved to claude-code',
  },
];

export const mockTeamTimeline: TeamEvent[] = [...sessionEvents, ...spawned, ...extras].sort(
  (a, b) => b.at - a.at,
);
