// The Jobs tab's trigger/action renderers (spec/15 § Jobs screen), the
// loosely-typed mobile counterpart of packages/web/src/lib/jobDescribe.ts.

import { describe, it, expect } from 'vitest';
import {
  actionTarget,
  actionVerb,
  jobChatId,
  queuedLabel,
  triggerLabel,
} from '../src/lib/jobDescribe';

describe('triggerLabel', () => {
  it('phrases a cron trigger, naming the zone only when it differs from the viewer', () => {
    expect(triggerLabel({ type: 'cron', expression: '0 9 * * *' }, 'UTC')).toBe('every day at 9am');
    expect(
      triggerLabel({ type: 'cron', expression: '0 9 * * 5', timezone: 'Europe/London' }, 'UTC'),
    ).toBe('Fridays at 9am · Europe/London');
  });

  it('phrases a recurrence trigger', () => {
    expect(
      triggerLabel(
        { type: 'recurrence', rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0', timezone: 'UTC' },
        'UTC',
      ),
    ).toMatch(/monday/i);
  });

  it('phrases a webhook trigger, unsigned when the scheme is none/absent', () => {
    expect(triggerLabel({ type: 'webhook', scheme: 'none' })).toBe('unsigned webhook');
    expect(triggerLabel({ type: 'webhook', scheme: 'github' })).toBe('github webhook');
    expect(triggerLabel({ type: 'webhook' })).toBe('unsigned webhook');
  });

  it('phrases a todoist trigger, with or without a filter', () => {
    expect(triggerLabel({ type: 'todoist' })).toBe('Todoist task tagged @claude');
    expect(triggerLabel({ type: 'todoist', filter: "labels contains 'agent'" })).toBe(
      "Todoist task labels contains 'agent'",
    );
  });

  it('falls back to the raw type, or the literal "trigger", for anything else', () => {
    expect(triggerLabel({ type: 'manual' })).toBe('manual');
    expect(triggerLabel(undefined)).toBe('trigger');
  });
});

describe('actionVerb', () => {
  it('reads as "<type> · skill" or "<type> · prompt"', () => {
    expect(actionVerb({ type: 'spawn', skill: 'life-coach' })).toBe('spawn · skill');
    expect(actionVerb({ type: 'message', prompt: 'hi' })).toBe('message · prompt');
  });

  it('a script action reads as "script · command"', () => {
    expect(actionVerb({ type: 'script', command: 'echo hi' })).toBe('script · command');
  });
});

describe('actionTarget', () => {
  it('a folder-addressed skill target carries the host + folder', () => {
    expect(actionTarget({ type: 'spawn', skill: 'life-coach', folder: '/p' }, 'Mac mini')).toBe(
      'life-coach · Mac mini · /p',
    );
  });

  it('a message skill target has no folder to carry', () => {
    expect(actionTarget({ type: 'message', skill: 'life-coach' })).toBe('life-coach');
  });

  it('clips a long prompt and quotes it', () => {
    const long = 'x'.repeat(60);
    const t = actionTarget({ type: 'message', prompt: long });
    expect(t.startsWith('"')).toBe(true);
    expect(t).toContain('…');
  });

  it('a script target names its first non-comment line and line count', () => {
    expect(
      actionTarget({ type: 'script', command: '#!/usr/bin/env bash\necho hi\necho bye' }),
    ).toBe('"echo hi" · 3 lines');
  });

  it('a message action with neither skill nor prompt reads as its chatId', () => {
    expect(actionTarget({ type: 'message', chatId: 'chat-1' })).toBe('chat-1');
  });
});

describe('jobChatId', () => {
  it('an unkeyed ensure links to its own stable chat', () => {
    expect(jobChatId({ id: 'job1', actionType: 'continue' }, undefined)).toBe('jobchat-job1');
  });

  it('a keyed ensure has no single chat, so it falls back to the latest run', () => {
    expect(jobChatId({ id: 'job1', actionType: 'continue', ensureKey: '{{x}}' }, 'chat-9')).toBe(
      'chat-9',
    );
  });

  it('message links to its fixed target chat', () => {
    expect(
      jobChatId({ id: 'job1', actionType: 'message', messageChatId: 'chat-1' }, undefined),
    ).toBe('chat-1');
  });

  it('spawn falls back to the latest run, or null if it never fired', () => {
    expect(jobChatId({ id: 'job1', actionType: 'spawn' }, 'chat-5')).toBe('chat-5');
    expect(jobChatId({ id: 'job1', actionType: 'spawn' }, undefined)).toBeNull();
  });
});

describe('queuedLabel', () => {
  it('is null with nothing queued, and names the count otherwise', () => {
    expect(queuedLabel(undefined)).toBeNull();
    expect(queuedLabel(0)).toBeNull();
    expect(queuedLabel(3)).toBe('3 queued');
  });
});
