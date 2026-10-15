import { now } from './clock';

export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: Record<string, unknown>;
  at: number;
}

const entries: LogEntry[] = [];

export function log(
  level: LogEntry['level'],
  message: string,
  data?: Record<string, unknown>,
): void {
  const entry: LogEntry = { level, message, data, at: now() };
  entries.push(entry);
  if (process.env.LOG_TO_CONSOLE) console.log(JSON.stringify(entry));
}

export function logEntries(): readonly LogEntry[] {
  return entries;
}

export function clearLog(): void {
  entries.length = 0;
}
