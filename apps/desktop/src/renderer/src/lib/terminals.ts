// The terminals the person has open, kept outside any screen: a terminal keeps running in the app when the
// task panel is closed, and reopening the panel should still show it.
import { useEffect, useState } from 'react';
import type { TerminalCli, TerminalInfo } from '@puff/shared';
import { puff } from './api';

interface Entry {
  info: TerminalInfo;
  /** The program ended (the terminal still shows what it printed) */
  ended: boolean;
}

const store = new Map<string, Entry>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

// A terminal whose program ends is marked, wherever it is shown
puff.onEvent((e) => {
  if (e.type !== 'terminal:exit') return;
  const entry = store.get(e.id);
  if (entry && !entry.ended) {
    entry.ended = true;
    changed();
  }
});

/** Take the task over in a real terminal running `cli` in its working folder. */
export async function openTerminal(
  taskId: string,
  cli: TerminalCli,
  start = false,
): Promise<TerminalInfo> {
  const info = await puff.openTerminal({ taskId, cli, start });
  store.set(info.id, { info, ended: false });
  changed();
  return info;
}

export async function closeTerminal(id: string): Promise<void> {
  await puff.closeTerminal(id).catch(() => {});
  store.delete(id);
  changed();
}

/** The open terminals of one task, oldest first. */
export function useTerminals(taskId: string): { info: TerminalInfo; ended: boolean }[] {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((t) => t + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return [...store.values()].filter((e) => e.info.taskId === taskId);
}
