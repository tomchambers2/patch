// Background tasks — the chat's `patch_watch` tasks, for the mobile
// Background task bar (spec/14 § Main chat panel — Background task bar;
// background-task reliability overhaul part 3 — mirrors
// packages/web/src/lib/backgroundTasks.ts, minus `watchTailCommand`: mobile
// has no interactive terminal to tail output into.

import type { WatchTaskRow } from '@patch/wire';

export type { WatchTaskRow };

/** This chat's tasks that are still running, newest first. */
export function runningWatchTasks(tasks: readonly WatchTaskRow[]): WatchTaskRow[] {
  return tasks.filter((t) => t.status === 'running').sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Every task, running first (newest first), then ended ones (most recently
 * ended first) — the "Show all" order.
 */
export function sortWatchTasks(tasks: readonly WatchTaskRow[]): WatchTaskRow[] {
  const running = tasks
    .filter((t) => t.status === 'running')
    .sort((a, b) => b.startedAt - a.startedAt);
  const ended = tasks
    .filter((t) => t.status !== 'running')
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  return [...running, ...ended];
}

/**
 * A running task's elapsed time as a short clock string — `12s`, `3m 04s`,
 * `1h 02m`. Ticks locally off `startedAt`; no poll needed for this alone.
 */
export function formatElapsed(startedAt: number, now: number): string {
  const totalSeconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

/** The stack's title: what is running — `2 background tasks`. */
export function backgroundBarTitle(tasks: number): string {
  return tasks > 0 ? `${tasks} ${tasks === 1 ? 'background task' : 'background tasks'}` : '';
}

/** Single-quote a path for a POSIX shell, escaping any single quote it contains. */
function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** The shell command that live-tails a watch task's own output file. */
export function watchTailCommand(outputFile: string): string {
  return `tail -n 200 -f ${shellQuote(outputFile)}`;
}
