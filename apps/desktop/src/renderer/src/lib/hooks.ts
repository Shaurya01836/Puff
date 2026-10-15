import { useEffect, useState } from 'react';
import type {
  ActivityStep,
  ChatInfo,
  ChatMessage,
  MemoryEvent,
  SessionInfo,
  Task,
} from '@puff/shared';
import { puff } from './api';

/** The steps of one attempt: the session it belongs to (once it is known) and what happened, oldest first */
export interface ActivityGroup {
  id: string;
  session?: SessionInfo;
  steps: ActivityStep[];
}

/**
 * What the agents did on a task, one group per attempt. Finished attempts bring their steps with the
 * session; the running one arrives step by step as `activity` events. The two are merged by step id, so
 * a step that shows up both ways is shown once.
 */
export function useActivity(taskId: string, sessions: SessionInfo[] | undefined): ActivityGroup[] {
  const [live, setLive] = useState<ActivityStep[]>([]);
  useEffect(() => {
    setLive([]);
    return puff.onEvent((e) => {
      if (e.type !== 'activity' || e.step.taskId !== taskId) return;
      setLive((prev) => (prev.some((s) => s.id === e.step.id) ? prev : [...prev, e.step]));
    });
  }, [taskId]);

  const groups = new Map<string, ActivityGroup>();
  for (const s of sessions ?? [])
    groups.set(s.id, { id: s.id, session: s, steps: [...(s.activity ?? [])] });
  for (const step of live) {
    const g = groups.get(step.sessionId) ?? { id: step.sessionId, steps: [] };
    if (!g.steps.some((x) => x.id === step.id)) g.steps.push(step);
    groups.set(g.id, g);
  }
  for (const g of groups.values()) g.steps.sort((a, b) => a.at - b.at);
  return [...groups.values()];
}

/** Load once; re-runs when deps change. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []): T | undefined {
  const [value, setValue] = useState<T>();
  useEffect(() => {
    let alive = true;
    load().then((v) => alive && setValue(v));
    return () => {
      alive = false;
    };
  }, deps);
  return value;
}

/** Tasks for a project, kept live from task:update events. */
export function useTasks(projectId: string): Task[] {
  const [tasks, setTasks] = useState<Task[]>([]);
  useEffect(() => {
    let alive = true;
    puff.listTasks(projectId).then((t) => alive && setTasks(t));
    const off = puff.onEvent((e) => {
      if (e.type === 'task:removed') {
        setTasks((prev) => prev.filter((t) => t.id !== e.taskId));
        return;
      }
      if (e.type !== 'task:update') return;
      setTasks((prev) => {
        const i = prev.findIndex((t) => t.id === e.task.id);
        if (i === -1) return [...prev, e.task];
        const next = prev.slice();
        next[i] = e.task;
        return next;
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, [projectId]);
  return tasks;
}

/**
 * The conversation with the orchestrator. Messages arrive as `chat` events (and an answered approval
 * arrives again with its new state), so they are merged by id. `projectKey` makes it start over when
 * the open project changes.
 */
export function useChat(projectKey: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [info, setInfo] = useState<ChatInfo>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let alive = true;
    setMessages([]);
    setError(undefined);
    puff.chatHistory().then((h) => alive && setMessages(h));
    puff.chatInfo().then((i) => alive && setInfo(i));
    const off = puff.onEvent((e) => {
      // A sign-in ending changes whether the agent can answer
      if (e.type === 'signin') puff.chatInfo().then((i) => alive && setInfo(i));
      if (e.type !== 'chat') return;
      setMessages((prev) => {
        const i = prev.findIndex((m) => m.id === e.message.id);
        if (i === -1) return [...prev, e.message];
        const next = prev.slice();
        next[i] = e.message;
        return next;
      });
    });
    return () => {
      alive = false;
      off();
    };
  }, [projectKey]);

  const run = async (action: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return {
    messages,
    info,
    busy,
    error,
    send: async (text: string) => {
      setBusy(true);
      await run(() => puff.chatSend(text));
      setBusy(false);
      // An answer can change what the panel should say (Claude Code turned out not to be signed in)
      puff.chatInfo().then(setInfo);
    },
    approve: (id: string, approve: boolean) => run(() => puff.chatApprove(id, approve)),
    reset: async () => {
      await run(() => puff.chatReset());
      setMessages([]);
    },
  };
}

/** Memory feed for a project, newest first, kept live from memory events. */
export function useMemoryFeed(projectId: string, limit = 50): MemoryEvent[] {
  const [feed, setFeed] = useState<MemoryEvent[]>([]);
  useEffect(() => {
    let alive = true;
    puff.getMemoryFeed(projectId, limit).then((f) => alive && setFeed(f));
    const off = puff.onEvent((e) => {
      if (e.type === 'memory') setFeed((prev) => [e.event, ...prev].slice(0, limit));
    });
    return () => {
      alive = false;
      off();
    };
  }, [projectId, limit]);
  return feed;
}
