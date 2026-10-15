import { useEffect, useState } from 'react';
import type { MemoryEvent, Task } from '@puff/shared';
import { puff } from './api';

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
