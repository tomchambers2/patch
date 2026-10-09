// lib/backgroundTasks.ts — the small bits the Background task bar needs on
// top of the raw `WatchTaskRow` list the REST call returns (spec/14 § Main
// chat panel — Background task bar): sort order, the terminal's tail command,
// and the elapsed-time clock. The underlying "which tasks are running"
// question is now just `status === 'running'` on a real record — nothing
// here derives it from a transcript any more (that fold, for the now-denied
// Bash/Task `run_in_background` mechanism, still lives at the wire layer as
// `@patch/wire`'s `background-task-tracking.ts`, tested there, and is no
// longer imported by this package at all).

import { describe, it, expect } from 'vitest';
import {
  backgroundBarTitle,
  formatElapsed,
  runningWatchTasks,
  sortWatchTasks,
  watchTailCommand,
} from '../lib/backgroundTasks.js';
import type { WatchTaskRow } from '@patch/wire';

function task(over: Partial<WatchTaskRow> = {}): WatchTaskRow {
  return {
    taskId: 't1',
    description: 'a task',
    command: 'pnpm test',
    outputFile: '/tmp/c1/watch/t1.output',
    status: 'running',
    startedAt: 1_700_000_000_000,
    ...over,
  };
}

describe('runningWatchTasks', () => {
  it('keeps only running tasks, newest first', () => {
    const rows = [
      task({ taskId: 'a', status: 'exited', startedAt: 1 }),
      task({ taskId: 'b', status: 'running', startedAt: 2 }),
      task({ taskId: 'c', status: 'running', startedAt: 3 }),
    ];
    expect(runningWatchTasks(rows).map((t) => t.taskId)).toEqual(['c', 'b']);
  });

  it('is empty when nothing is running', () => {
    expect(runningWatchTasks([task({ status: 'failed' })])).toEqual([]);
  });
});

describe('sortWatchTasks', () => {
  it('lists running tasks first (newest first), then ended ones (most recently ended first)', () => {
    const rows = [
      task({ taskId: 'old-end', status: 'exited', startedAt: 1, endedAt: 10 }),
      task({ taskId: 'running-old', status: 'running', startedAt: 2 }),
      task({ taskId: 'new-end', status: 'failed', startedAt: 3, endedAt: 30 }),
      task({ taskId: 'running-new', status: 'running', startedAt: 4 }),
    ];
    expect(sortWatchTasks(rows).map((t) => t.taskId)).toEqual([
      'running-new',
      'running-old',
      'new-end',
      'old-end',
    ]);
  });
});

describe('watchTailCommand', () => {
  it('tails the exact output file the record names', () => {
    expect(watchTailCommand('/tmp/c1/watch/t1.output')).toBe(
      "tail -n 200 -f '/tmp/c1/watch/t1.output'",
    );
  });

  it('quotes a path containing a single quote safely for the shell', () => {
    const cmd = watchTailCommand("/tmp/it's/watch/t1.output");
    expect(cmd).toBe(`tail -n 200 -f '/tmp/it'\\''s/watch/t1.output'`);
  });
});

describe('formatElapsed', () => {
  it('renders seconds under a minute', () => {
    expect(formatElapsed(0, 45_000)).toBe('45s');
  });

  it('renders minutes and seconds under an hour', () => {
    expect(formatElapsed(0, 3 * 60_000 + 4_000)).toBe('3m 04s');
  });

  it('renders hours and minutes past an hour', () => {
    expect(formatElapsed(0, 60 * 60_000 + 2 * 60_000)).toBe('1h 02m');
  });

  it('never goes negative — a clock skew reads as 0s, not a negative number', () => {
    expect(formatElapsed(10_000, 0)).toBe('0s');
  });
});

describe('backgroundBarTitle', () => {
  it('names the running count, singular and plural', () => {
    expect(backgroundBarTitle(1)).toBe('1 background task');
    expect(backgroundBarTitle(3)).toBe('3 background tasks');
  });
});
