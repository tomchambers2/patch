// Background-task completion notices (spec/02 § Background task completions).
//
// The samples here are REAL payloads captured from Claude Code sessions, not
// invented ones. They are the contract between the host (which lifts the
// summary out of the notification block) and the surfaces (which recover the
// structure to render it) — so they are asserted verbatim.

import { describe, it, expect } from 'vitest';
import {
  taskNotificationSummary,
  parseBackgroundTaskNotice,
  parseTaskNotificationBlock,
  hasTaskNotification,
} from '../src/background-task.js';

const COMMAND_BLOCK = `<task-notification>
<task-id>baiw888mq</task-id>
<tool-use-id>toolu_019qoZTEw4vif4xvr1padB3a</tool-use-id>
<output-file>/tmp/claude-1000/-home-claude-dev-projects-portfolio/9a1710c0/tasks/baiw888mq.output</output-file>
<status>completed</status>
<summary>Background command "Build web package to compile CSS" completed (exit code 0)</summary>
</task-notification>`;

const AGENT_BLOCK = `<task-notification>
<task-id>bkvn61the</task-id>
<tool-use-id>toolu_01CboyqDGa8R38RQuRmk8HWQ</tool-use-id>
<output-file>/tmp/claude-1000/-home-claude-dev-projects-portfolio/4685c749/tasks/bkvn61the.output</output-file>
<status>completed</status>
<summary>Agent "Diagnose 25045 test failures" completed</summary>
</task-notification>`;

describe('taskNotificationSummary', () => {
  it('lifts the summary out of a background command notification', () => {
    expect(taskNotificationSummary(COMMAND_BLOCK)).toBe(
      'Background command "Build web package to compile CSS" completed (exit code 0)',
    );
  });

  it('lifts the summary out of a background agent notification', () => {
    expect(taskNotificationSummary(AGENT_BLOCK)).toBe(
      'Agent "Diagnose 25045 test failures" completed',
    );
  });

  it('returns null for a message that is not a task notification', () => {
    expect(taskNotificationSummary('deploy the web package please')).toBeNull();
    expect(taskNotificationSummary('')).toBeNull();
  });

  it('returns null for a notification block carrying no summary', () => {
    // Malformed input is NOT repaired into an invented summary — the caller
    // needs to see that there was nothing to surface.
    expect(
      taskNotificationSummary(
        '<task-notification>\n<status>completed</status>\n</task-notification>',
      ),
    ).toBeNull();
  });
});

describe('hasTaskNotification', () => {
  it('recognises a notification block a surface has been handed raw', () => {
    // Replay (and any host on a pre-lifting host) delivers the block as a
    // user turn, so the surface has to spot it without the host's help.
    expect(hasTaskNotification(COMMAND_BLOCK)).toBe(true);
    expect(hasTaskNotification(AGENT_BLOCK)).toBe(true);
  });

  it('recognises a block carrying no summary — there is still nothing to show as a turn', () => {
    expect(
      hasTaskNotification('<task-notification>\n<status>killed</status>\n</task-notification>'),
    ).toBe(true);
  });

  it('is false for anything a person actually typed', () => {
    expect(hasTaskNotification('deploy the web package please')).toBe(false);
    expect(hasTaskNotification('')).toBe(false);
    // An unclosed tag is not a block — a message merely talking about one
    // stays an ordinary message.
    expect(hasTaskNotification('what does <task-notification> mean?')).toBe(false);
  });
});

describe('parseBackgroundTaskNotice', () => {
  it('recovers a background command, its description and its exit code', () => {
    expect(
      parseBackgroundTaskNotice(
        'Background command "Build web package to compile CSS" completed (exit code 0)',
      ),
    ).toEqual({
      kind: 'command',
      description: 'Build web package to compile CSS',
      status: 'completed',
      exitCode: 0,
    });
  });

  it('recovers a non-zero exit code', () => {
    expect(
      parseBackgroundTaskNotice('Background command "Run the suite" completed (exit code 1)'),
    ).toEqual({
      kind: 'command',
      description: 'Run the suite',
      status: 'completed',
      exitCode: 1,
    });
  });

  it('recovers a background agent, which carries no exit code', () => {
    expect(parseBackgroundTaskNotice('Agent "Diagnose 25045 test failures" completed')).toEqual({
      kind: 'agent',
      description: 'Diagnose 25045 test failures',
      status: 'completed',
      exitCode: null,
    });
  });

  it('keeps a description that itself contains quotes intact', () => {
    expect(
      parseBackgroundTaskNotice(
        'Background command "Grep for "foo" in src" completed (exit code 0)',
      ),
    ).toEqual({
      kind: 'command',
      description: 'Grep for "foo" in src',
      status: 'completed',
      exitCode: 0,
    });
  });

  it('carries a status other than completed through rather than assuming success', () => {
    expect(parseBackgroundTaskNotice('Background command "Long build" killed')).toEqual({
      kind: 'command',
      description: 'Long build',
      status: 'killed',
      exitCode: null,
    });
  });

  // 2026-09-15: both of these were emitted by a real session and BOTH were
  // rejected by the old grammar — wrong prefix (`Background agent "`) and a
  // multi-word tail. On the live path the host has already dropped the
  // block's `<status>`, so a rejected sentence left the task reading as running
  // for the rest of the chat's life. That is the bug these pin down.
  it('ends a task whose sentence uses the "Background agent" spelling', () => {
    expect(
      parseBackgroundTaskNotice(
        'Background agent "fish-sleep: steps + online log" didn\u2019t finish before the previous session ended',
      ),
    ).toEqual({
      kind: 'agent',
      description: 'fish-sleep: steps + online log',
      status: 'ended',
      exitCode: null,
    });
  });

  it('ends a task on a phrase it has no exact reading for, rather than pinning it open', () => {
    expect(
      parseBackgroundTaskNotice('Background command "Long build" ran out of disk half way through'),
    ).toEqual({
      kind: 'command',
      description: 'Long build',
      status: 'ended',
      exitCode: null,
    });
  });

  it('still reads the wordings it knows exactly, rather than flattening them to "ended"', () => {
    expect(parseBackgroundTaskNotice('Agent "x" completed')?.status).toBe('completed');
    expect(parseBackgroundTaskNotice('Background command "x" killed')?.status).toBe('killed');
    expect(parseBackgroundTaskNotice('Background command "x" was stopped by Claude')?.status).toBe(
      'stopped',
    );
    expect(parseBackgroundTaskNotice('Background command "x" failed with exit code 144')).toEqual({
      kind: 'command',
      description: 'x',
      status: 'failed',
      exitCode: 144,
    });
  });

  it('is still not fooled by a sentence that merely mentions a background task', () => {
    expect(parseBackgroundTaskNotice('Background command without a quoted description')).toBeNull();
    expect(parseBackgroundTaskNotice('Background command "no outcome given"')).toBeNull();
    expect(parseBackgroundTaskNotice('Agent smith walked in')).toBeNull();
  });

  it('returns null for ordinary system text', () => {
    expect(parseBackgroundTaskNotice('Session resumed')).toBeNull();
    expect(parseBackgroundTaskNotice('Background noise about a command')).toBeNull();
  });

  it('round-trips every summary the notification blocks carry', () => {
    const commandSummary = taskNotificationSummary(COMMAND_BLOCK);
    const agentSummary = taskNotificationSummary(AGENT_BLOCK);
    expect(commandSummary).not.toBeNull();
    expect(agentSummary).not.toBeNull();
    expect(parseBackgroundTaskNotice(commandSummary as string)).not.toBeNull();
    expect(parseBackgroundTaskNotice(agentSummary as string)).not.toBeNull();
  });
});

// The outcomes a real Claude Code session actually reports. Captured from this
// machine's own session logs: of ~2,300 notification blocks, `completed` is
// 1,806, `failed` 396, `stopped` 66 and `killed` 47 — so the three that are not
// "completed" are a fifth of every background task that has ever run here, and
// a sentence one of them cannot be read out of is a task nothing can ever close.
describe('parseBackgroundTaskNotice — the outcomes that are not "completed"', () => {
  it('reads a failed command and the exit code the sentence spells out in words', () => {
    expect(
      parseBackgroundTaskNotice('Background command "Run the suite" failed with exit code 144'),
    ).toEqual({
      kind: 'command',
      description: 'Run the suite',
      status: 'failed',
      exitCode: 144,
    });
  });

  it('reads a command the agent layer stopped', () => {
    expect(parseBackgroundTaskNotice('Background command "Long build" was stopped')).toEqual({
      kind: 'command',
      description: 'Long build',
      status: 'stopped',
      exitCode: null,
    });
  });

  it('reads an agent that finished, which is its own word for completed', () => {
    expect(parseBackgroundTaskNotice('Agent "Diagnose 25045 test failures" finished')).toEqual({
      kind: 'agent',
      description: 'Diagnose 25045 test failures',
      status: 'finished',
      exitCode: null,
    });
  });

  it('reads a stopped agent, with or without the hand that stopped it', () => {
    // Both wordings mean the same end, so both land on the same status the
    // block's own `<status>` tag carries.
    expect(parseBackgroundTaskNotice('Agent "Bath pubs: local press" was stopped')).toEqual({
      kind: 'agent',
      description: 'Bath pubs: local press',
      status: 'stopped',
      exitCode: null,
    });
    expect(
      parseBackgroundTaskNotice('Agent "Bath pubs: local press" was stopped by Claude'),
    ).toEqual({
      kind: 'agent',
      description: 'Bath pubs: local press',
      status: 'stopped',
      exitCode: null,
    });
  });

  it('keeps a quoted description intact through a failed sentence too', () => {
    expect(
      parseBackgroundTaskNotice(
        'Background command "Grep for "foo" in src" failed with exit code 1',
      ),
    ).toEqual({
      kind: 'command',
      description: 'Grep for "foo" in src',
      status: 'failed',
      exitCode: 1,
    });
  });

  it('still returns null for the session-ended notice, which names no task at all', () => {
    // There is no description and no id in the lifted sentence, so there is
    // nothing to attribute it to. Inventing one would close the wrong task.
    expect(
      parseBackgroundTaskNotice(
        "Background shell command didn't finish before the previous session ended",
      ),
    ).toBeNull();
    expect(parseBackgroundTaskNotice('Background command with no closing quote failed')).toBeNull();
  });
});

// The raw block, the way replay (and any host on a pre-lifting host) hands it
// over. It carries identity the lifted sentence cannot: `<tool-use-id>` IS the
// launching tool call's id, and `<task-id>` is the background id.
describe('parseTaskNotificationBlock', () => {
  it('recovers the launching call id, the background id and the status', () => {
    expect(parseTaskNotificationBlock(COMMAND_BLOCK)).toEqual({
      toolUseId: 'toolu_019qoZTEw4vif4xvr1padB3a',
      taskIds: ['baiw888mq'],
      status: 'completed',
    });
  });

  it('recovers an agent block, whose task id is the agent id TaskStop names', () => {
    expect(parseTaskNotificationBlock(AGENT_BLOCK)).toEqual({
      toolUseId: 'toolu_01CboyqDGa8R38RQuRmk8HWQ',
      taskIds: ['bkvn61the'],
      status: 'completed',
    });
  });

  it('recovers every task id from a block that ends several at once', () => {
    // The session-start sweep marks every task the previous session left
    // unfinished, and reports them in one block with one `<task-id>` each.
    const block = [
      '<task-notification>',
      '<task-id>b6i2olceh</task-id>',
      '<task-id>bs2zgkv4l</task-id>',
      '<task-id>bbdipobp8</task-id>',
      '<status>stopped</status>',
      '<summary>3 background shell command task(s) from the previous session have no completion record.</summary>',
      '</task-notification>',
    ].join('\n');
    expect(parseTaskNotificationBlock(block)).toEqual({
      toolUseId: null,
      taskIds: ['b6i2olceh', 'bs2zgkv4l', 'bbdipobp8'],
      status: 'stopped',
    });
  });

  it('recovers a block that carries no summary at all', () => {
    // This is the whole point of reading the block rather than the sentence:
    // there is no sentence, but the end is not in doubt.
    expect(
      parseTaskNotificationBlock(
        '<task-notification>\n<task-id>baiw888mq</task-id>\n<status>killed</status>\n</task-notification>',
      ),
    ).toEqual({ toolUseId: null, taskIds: ['baiw888mq'], status: 'killed' });
  });

  it('is null for anything that is not a notification block', () => {
    expect(parseTaskNotificationBlock('Session resumed')).toBeNull();
    expect(parseTaskNotificationBlock('')).toBeNull();
    expect(
      parseTaskNotificationBlock('Background command "Run the suite" completed (exit code 0)'),
    ).toBeNull();
  });
});
