// Background-task tracking (spec/02 § Background task completions, spec/14
// § Status badges) — the fold that answers "how many of this chat's background
// commands and sub-agents are still running".
//
// The whole-transcript walk is exercised by the web surface's own suite
// (`packages/web/src/__tests__/backgroundTasks.test.ts`, which imports this
// module). What is locked HERE is the single-entry step the host uses, since
// it is the half no surface exercises: the host never re-walks a transcript,
// it folds each event once as it emits it, and the running count it puts on
// `chat.state` is the only thing the sidebar has to go on.

import { describe, it, expect } from 'vitest';
import {
  applyBackgroundTaskEntry,
  countRunningBackgroundTasks,
  deriveBackgroundTasks,
  type BackgroundTaskEntry,
  type BackgroundTaskRow,
} from '../src/background-task-tracking.js';

const COMMAND_BLOCK = `<task-notification>
<task-id>baiw888mq</task-id>
<tool-use-id>toolu_019qoZTEw4vif4xvr1padB3a</tool-use-id>
<output-file>/tmp/claude-1000/proj/9a1710c0/tasks/baiw888mq.output</output-file>
<status>completed</status>
<summary>Background command "Build web package to compile CSS" completed (exit code 0)</summary>
</task-notification>`;

let seq = 0;
function entry(e: Omit<BackgroundTaskEntry, 'seq'>): BackgroundTaskEntry {
  seq += 1;
  return { ...e, seq };
}

function launch(callId: string, description: string): BackgroundTaskEntry {
  return entry({
    kind: 'tool_call',
    tool: 'Bash',
    callId,
    toolArgs: { command: 'pnpm build', description, run_in_background: true },
  });
}

/** Fold a list of entries the way the host does — one at a time, in order. */
function fold(entries: BackgroundTaskEntry[]): { rows: BackgroundTaskRow[]; changes: number } {
  const rows: BackgroundTaskRow[] = [];
  let changes = 0;
  for (const e of entries) {
    const before = countRunningBackgroundTasks(rows);
    applyBackgroundTaskEntry(rows, e);
    if (countRunningBackgroundTasks(rows) !== before) changes += 1;
  }
  return { rows, changes };
}

describe('applyBackgroundTaskEntry — folded one entry at a time', () => {
  it('counts a backgrounded command from its launch until its completion notice', () => {
    const rows: BackgroundTaskRow[] = [];
    applyBackgroundTaskEntry(rows, launch('toolu_1', 'Build web package to compile CSS'));
    expect(countRunningBackgroundTasks(rows)).toBe(1);

    applyBackgroundTaskEntry(
      rows,
      entry({
        kind: 'message',
        content: 'Background command "Build web package to compile CSS" completed (exit code 0)',
      }),
    );
    expect(countRunningBackgroundTasks(rows)).toBe(0);
  });

  it('does not count a foreground call — `run_in_background` is the whole signal', () => {
    const rows: BackgroundTaskRow[] = [];
    applyBackgroundTaskEntry(
      rows,
      entry({
        kind: 'tool_call',
        tool: 'Bash',
        callId: 'toolu_fg',
        toolArgs: { command: 'pnpm build', description: 'Build it' },
      }),
    );
    expect(countRunningBackgroundTasks(rows)).toBe(0);
  });

  it('reaches the same count as the whole-transcript walk, entry by entry', () => {
    const entries = [
      launch('toolu_1', 'Build web package to compile CSS'),
      launch('toolu_2', 'Run the server suite'),
      entry({
        kind: 'message',
        content: 'Background command "Run the server suite" failed with exit code 144',
      }),
    ];
    const { rows } = fold(entries);
    expect(countRunningBackgroundTasks(rows)).toBe(1);
    expect(countRunningBackgroundTasks(deriveBackgroundTasks(entries))).toBe(1);
  });

  it('reports a change exactly on the launch and on the end, and on nothing else', () => {
    const { changes } = fold([
      launch('toolu_1', 'Build web package to compile CSS'),
      entry({
        kind: 'tool_result',
        callId: 'toolu_1',
        toolResult: 'Command running in background with ID: baiw888mq.',
      }),
      entry({ kind: 'message', content: 'still going' }),
      entry({
        kind: 'message',
        content: 'Background command "Build web package to compile CSS" completed (exit code 0)',
      }),
    ]);
    expect(changes).toBe(2);
  });

  it('closes by the raw block ids where it still has them', () => {
    const rows: BackgroundTaskRow[] = [];
    applyBackgroundTaskEntry(rows, launch('toolu_019qoZTEw4vif4xvr1padB3a', 'something else'));
    applyBackgroundTaskEntry(rows, entry({ kind: 'message', content: COMMAND_BLOCK }));
    // The sentence names a task this chat never launched; the `<tool-use-id>`
    // names one it did, and the id wins.
    expect(countRunningBackgroundTasks(rows)).toBe(0);
  });

  it('closes the OLDEST of two live tasks sharing a description, so N−M are left', () => {
    const rows: BackgroundTaskRow[] = [];
    applyBackgroundTaskEntry(rows, launch('toolu_1', 'Run the suite'));
    applyBackgroundTaskEntry(rows, launch('toolu_2', 'Run the suite'));
    applyBackgroundTaskEntry(
      rows,
      entry({ kind: 'message', content: 'Background command "Run the suite" completed' }),
    );
    expect(countRunningBackgroundTasks(rows)).toBe(1);
    expect(rows.find((r) => r.ended !== null)?.callId).toBe('toolu_1');
  });

  it('NO FALLBACK: a notice naming nothing this chat launched ends nothing', () => {
    const rows: BackgroundTaskRow[] = [];
    applyBackgroundTaskEntry(rows, launch('toolu_1', 'Build web package to compile CSS'));
    applyBackgroundTaskEntry(
      rows,
      entry({ kind: 'message', content: 'Background command "A different job" completed' }),
    );
    expect(countRunningBackgroundTasks(rows)).toBe(1);
  });

  it('NO FALLBACK: a notification block that reports no end ends nothing', () => {
    const rows: BackgroundTaskRow[] = [];
    applyBackgroundTaskEntry(rows, launch('toolu_019qoZTEw4vif4xvr1padB3a', 'Watch the log'));
    // A `Monitor` event block: a task id and a summary, but no `<status>`.
    applyBackgroundTaskEntry(
      rows,
      entry({
        kind: 'message',
        content:
          '<task-notification>\n<task-id>baiw888mq</task-id>\n' +
          '<tool-use-id>toolu_019qoZTEw4vif4xvr1padB3a</tool-use-id>\n' +
          '<summary>matched: build failed</summary>\n</task-notification>',
      }),
    );
    expect(countRunningBackgroundTasks(rows)).toBe(1);
  });

  it('a kill closes the task whose background id the launch reported', () => {
    const rows: BackgroundTaskRow[] = [];
    applyBackgroundTaskEntry(rows, launch('toolu_1', 'Long build'));
    applyBackgroundTaskEntry(
      rows,
      entry({
        kind: 'tool_result',
        callId: 'toolu_1',
        toolResult: 'Command running in background with ID: bkill01xy.',
      }),
    );
    applyBackgroundTaskEntry(
      rows,
      entry({
        kind: 'tool_call',
        tool: 'KillShell',
        callId: 'toolu_k',
        toolArgs: { shell_id: 'bkill01xy' },
      }),
    );
    expect(countRunningBackgroundTasks(rows)).toBe(0);
  });
});
