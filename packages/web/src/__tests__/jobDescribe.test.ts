// jobDescribe — human-readable trigger labels + two-axis action verbs
// (spec/14 ## Jobs view + design/web-lo-fi-schedules.html).

import { describe, it, expect } from 'vitest';
import type { Job } from '@patch/wire/jobs';
import {
  describeTrigger,
  describeCron,
  actionVerb,
  actionTarget,
  describeAction,
  jobTriggerLabel,
  jobChatId,
} from '../lib/jobDescribe.js';

// The list's describeCron is a thin wrapper: @patch/wire does the phrasing
// (pinned exhaustively in packages/wire/test/cron-describe.test.ts) and this
// adds the `cron · <expr>` fallback a list cell wants when wire returns ''.
describe('describeCron', () => {
  it('renders weekdays at a minute time', () => {
    expect(describeCron('57 8 * * 1-5')).toBe('weekdays at 8:57am');
  });
  it('renders on-the-hour times as Xam/Xpm', () => {
    expect(describeCron('0 9 * * 0')).toBe('Sundays at 9am');
    expect(describeCron('0 19 * * 1')).toBe('Mondays at 7pm');
  });
  it('renders every day', () => {
    expect(describeCron('0 8 * * *')).toBe('every day at 8am');
  });
  it('renders midnight and noon as 12am/12pm', () => {
    expect(describeCron('0 0 * * *')).toBe('every day at 12am');
    expect(describeCron('0 12 * * *')).toBe('every day at 12pm');
  });
  // These used to be the list's whole blind spot — 5 of the 16 distinct crons
  // in Tom's live fleet rendered as `cron · <expr>` because the local describer
  // only understood a fixed minute + hour. They are phrased now.
  it('renders the interval and windowed shapes that used to fall back', () => {
    expect(describeCron('*/5 * * * *')).toBe('every 5 minutes');
    expect(describeCron('*/15 * * * *')).toBe('every 15 minutes');
    expect(describeCron('0 */4 * * *')).toBe('every 4 hours');
    expect(describeCron('*/30 8-20 * * *')).toBe('every 30 minutes between 8am and 8pm');
    expect(describeCron('*/30 7-22 * * *')).toBe('every 30 minutes between 7am and 10pm');
    expect(describeCron('0,30 7-22 * * *')).toBe('every 30 minutes between 7am and 10pm');
    expect(describeCron('17 7,11,15,19 * * *')).toBe('at 7:17am, 11:17am, 3:17pm and 7:17pm');
  });
  it('falls back when the expression does not have exactly 5 fields', () => {
    expect(describeCron('* * * *')).toBe('cron · * * * *');
  });
  it('falls back when a sub-hour interval is crossed with a single hour', () => {
    expect(describeCron('*/5 8 * * *')).toBe('cron · */5 8 * * *');
  });
  it('falls back when minute/hour are non-numeric', () => {
    expect(describeCron('x 8 y * *')).toBe('cron · x 8 y * *');
  });
  it('falls back when minute or hour is out of range', () => {
    expect(describeCron('60 8 * * *')).toBe('cron · 60 8 * * *');
    expect(describeCron('0 24 * * *')).toBe('cron · 0 24 * * *');
  });
  it('renders weekends for both dow orderings', () => {
    expect(describeCron('0 8 * * 0,6')).toBe('weekends at 8am');
    expect(describeCron('0 8 * * 6,0')).toBe('weekends at 8am');
  });
  it('renders a comma list of named days when dom is wildcard', () => {
    expect(describeCron('0 8 * * 1,3,5')).toBe('Monday, Wednesday, Friday at 8am');
  });
  it('renders "the Nth" when a specific day-of-month is set', () => {
    expect(describeCron('0 8 1 * *')).toBe('the 1st at 8am');
    expect(describeCron('0 8 2 * *')).toBe('the 2nd at 8am');
    expect(describeCron('0 8 3 * *')).toBe('the 3rd at 8am');
    expect(describeCron('0 8 11 * *')).toBe('the 11th at 8am');
    expect(describeCron('0 8 12 * *')).toBe('the 12th at 8am');
    expect(describeCron('0 8 13 * *')).toBe('the 13th at 8am');
    expect(describeCron('0 8 21 * *')).toBe('the 21st at 8am');
    expect(describeCron('0 8 22 * *')).toBe('the 22nd at 8am');
    expect(describeCron('0 8 23 * *')).toBe('the 23rd at 8am');
  });
  it('falls back to the raw expression when the month field is not a wildcard', () => {
    expect(describeCron('0 8 * 6 *')).toBe('cron · 0 8 * 6 *');
  });
  it('falls back when no time and no day rule matches (raw dow, no clock)', () => {
    expect(describeCron('x 8 * * 2')).toBe('cron · x 8 * * 2');
  });
});

describe('describeTrigger', () => {
  it('describes a todoist trigger', () => {
    expect(describeTrigger({ type: 'todoist' })).toBe('Todoist task tagged @claude');
    expect(describeTrigger({ type: 'todoist', filter: 'labels contains @claude' })).toContain(
      'Todoist task',
    );
  });
  it('describes a webhook trigger by scheme', () => {
    expect(describeTrigger({ type: 'webhook', scheme: 'github' })).toBe('github webhook');
    expect(describeTrigger({ type: 'webhook', scheme: 'none' })).toBe('unsigned webhook');
  });
});

describe('action verb + target', () => {
  const spawnSkill: Job['action'] = {
    type: 'spawn',
    daemonId: 'd1',
    folder: '~/p',
    skill: 'bus-watch',
  };
  const messagePrompt: Job['action'] = { type: 'message', chatId: 'c1', prompt: 'do the thing' };
  it('renders spawn · skill, with the folder alongside it', () => {
    expect(actionVerb(spawnSkill)).toBe('spawn · skill');
    expect(actionTarget(spawnSkill)).toBe('bus-watch · ~/p');
  });
  it('renders message · prompt with the quoted prompt', () => {
    expect(actionVerb(messagePrompt)).toBe('message · prompt');
    expect(actionTarget(messagePrompt)).toBe('"do the thing"');
  });
  it('renders spawn · prompt with the folder alongside the quoted prompt', () => {
    const spawnPrompt: Job['action'] = {
      type: 'spawn',
      daemonId: 'd1',
      folder: '~/proj',
      prompt: 'go',
    };
    expect(actionVerb(spawnPrompt)).toBe('spawn · prompt');
    expect(actionTarget(spawnPrompt)).toBe('"go" · ~/proj');
  });
  it('clips a long prompt to 47 chars + ellipsis (message action, no folder to append)', () => {
    const longPrompt = 'x'.repeat(80);
    const action: Job['action'] = { type: 'message', chatId: 'c1', prompt: longPrompt };
    const target = actionTarget(action);
    expect(target).toBe(`"${'x'.repeat(47)}…"`);
  });
  it('trims a prompt before measuring/clipping', () => {
    const action: Job['action'] = { type: 'message', chatId: 'c1', prompt: '  hi  ' };
    expect(actionTarget(action)).toBe('"hi"');
  });
  it('falls back to the chatId for a message action with no prompt/skill', () => {
    const action = { type: 'message', chatId: 'c-42' } as Job['action'];
    expect(actionTarget(action)).toBe('c-42');
  });
  it('falls back to the folder for a spawn/ensure action with no prompt/skill', () => {
    const spawn = { type: 'spawn', daemonId: 'd1', folder: '~/p' } as Job['action'];
    expect(actionTarget(spawn)).toBe('~/p');
    const ensure = { type: 'continue', daemonId: 'd1', folder: '~/e' } as Job['action'];
    expect(actionTarget(ensure)).toBe('~/e');
  });
  it('threads the host name in alongside the folder when given one (spec/14 § Jobs view)', () => {
    expect(actionTarget(spawnSkill, 'laptop')).toBe('bus-watch · laptop · ~/p');
    const spawnPrompt: Job['action'] = {
      type: 'spawn',
      daemonId: 'd1',
      folder: '~/proj',
      prompt: 'go',
    };
    expect(actionTarget(spawnPrompt, 'laptop')).toBe('"go" · laptop · ~/proj');
    const spawn = { type: 'spawn', daemonId: 'd1', folder: '~/p' } as Job['action'];
    expect(actionTarget(spawn, 'laptop')).toBe('laptop · ~/p');
  });
  it('leaves a non-folder-addressed target alone even when a host name is given', () => {
    expect(actionTarget(messagePrompt, 'laptop')).toBe('"do the thing"');
  });
  it('describeAction combines verb + target', () => {
    expect(describeAction(spawnSkill)).toBe('spawn · skill bus-watch · ~/p');
  });
});

// spec/14 § Jobs view — the schedule label names the zone it runs in whenever
// that is not the reader's own. Tom's jobs read "9am" on the row and fired at
// 10:00 BST; a bare cron field rendering cannot say which of the two it means.
describe('describeTrigger — cron zone', () => {
  it('adds nothing when the job runs in the viewer\u2019s own zone', () => {
    expect(
      describeTrigger(
        { type: 'cron', expression: '0 9 * * 1-5', timezone: 'Europe/London' },
        'Europe/London',
      ),
    ).toBe('weekdays at 9am');
  });

  it('names the zone when the job runs somewhere else', () => {
    expect(
      describeTrigger(
        { type: 'cron', expression: '0 9 * * 1-5', timezone: 'Europe/London' },
        'America/New_York',
      ),
    ).toBe('weekdays at 9am \u00b7 Europe/London');
  });

  it('names UTC for a job carrying no zone, read from a zone that is not UTC', () => {
    expect(describeTrigger({ type: 'cron', expression: '0 9 * * *' }, 'Europe/London')).toBe(
      'every day at 9am \u00b7 UTC',
    );
  });

  it('stays quiet about UTC for a viewer already in UTC', () => {
    expect(describeTrigger({ type: 'cron', expression: '0 9 * * *' }, 'UTC')).toBe(
      'every day at 9am',
    );
  });

  it('qualifies the raw-expression fallback too', () => {
    expect(describeTrigger({ type: 'cron', expression: 'x 8 y * *' }, 'Europe/London')).toBe(
      'cron \u00b7 x 8 y * * \u00b7 UTC',
    );
  });

  it('qualifies an interval label the same way', () => {
    expect(describeTrigger({ type: 'cron', expression: '*/5 * * * *' }, 'Europe/London')).toBe(
      'every 5 minutes \u00b7 UTC',
    );
  });

  it('leaves non-cron triggers untouched whatever the viewer zone', () => {
    expect(describeTrigger({ type: 'webhook', scheme: 'github' }, 'America/New_York')).toBe(
      'github webhook',
    );
  });

  it('defaults the viewer zone to this runtime when none is passed', () => {
    // The box running this suite is UTC, so a UTC job needs no label and a
    // London one does — proving the default is read, not hardcoded.
    expect(describeTrigger({ type: 'cron', expression: '0 9 * * *' })).toBe('every day at 9am');
    expect(
      describeTrigger({ type: 'cron', expression: '0 9 * * *', timezone: 'Europe/London' }),
    ).toBe('every day at 9am \u00b7 Europe/London');
  });
});

describe('jobTriggerLabel', () => {
  it('delegates to describeTrigger for the job trigger', () => {
    const job = {
      id: 'j1',
      name: 'Test',
      enabled: true,
      trigger: { type: 'cron', expression: '0 8 * * *' },
      filter: null,
      action: { type: 'spawn', daemonId: 'd1', folder: '~/p', skill: 'x' },
      createdAt: 0,
      updatedAt: 0,
    } as Job;
    // Viewer zone passed explicitly: the label is zone-aware now, so leaving
    // it to the runtime would make this assertion depend on the box's $TZ.
    expect(jobTriggerLabel(job, 'UTC')).toBe('every day at 8am');
  });

  // Starts/Stops (spec/08 § Filter, spec/14 § Jobs view): the date range a
  // job's filter carries should be visible on the list row itself, not only
  // after opening the editor.
  describe('with a date-range filter', () => {
    function jobWith(filter: string | null): Job {
      return {
        id: 'j1',
        name: 'Test',
        enabled: true,
        trigger: { type: 'cron', expression: '0 8 * * *' },
        filter,
        action: { type: 'spawn', daemonId: 'd1', folder: '~/p', skill: 'x' },
        createdAt: 0,
        updatedAt: 0,
      } as Job;
    }

    it('null filter — no suffix, reads exactly as before this feature', () => {
      expect(jobTriggerLabel(jobWith(null), 'UTC')).toBe('every day at 8am');
    });

    // Dates are formatted via `toLocaleDateString(undefined, ...)` — the
    // house style throughout this file (SnoozeMenu, usage.ts) of respecting
    // the runtime's own locale rather than hardcoding one — so these
    // assertions build their expectation the same way instead of pinning a
    // specific locale's output.
    const fmt = (iso: string): string =>
      new Date(iso).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });

    it('a start-only filter appends "from <date>"', () => {
      const label = jobTriggerLabel(jobWith('now >= "2027-05-01T00:00:00.000Z"'), 'UTC');
      expect(label).toBe(`every day at 8am · from ${fmt('2027-05-01T00:00:00.000Z')}`);
    });

    it('a stop-only filter appends "until <date>"', () => {
      const label = jobTriggerLabel(jobWith('now <= "2027-09-01T00:00:00.000Z"'), 'UTC');
      expect(label).toBe(`every day at 8am · until ${fmt('2027-09-01T00:00:00.000Z')}`);
    });

    it('a start-and-stop filter appends the full range', () => {
      const label = jobTriggerLabel(
        jobWith('now >= "2027-05-01T00:00:00.000Z" and now <= "2027-09-01T00:00:00.000Z"'),
        'UTC',
      );
      expect(label).toBe(
        `every day at 8am · ${fmt('2027-05-01T00:00:00.000Z')} – ${fmt('2027-09-01T00:00:00.000Z')}`,
      );
    });

    it('a plain payload filter (no date range) is not shown as one', () => {
      expect(jobTriggerLabel(jobWith('payload.foo = "bar"'), 'UTC')).toBe('every day at 8am');
    });
  });
});

describe('jobChatId', () => {
  const base = {
    id: 'j1',
    name: 'Test',
    enabled: true,
    trigger: { type: 'cron', expression: '0 8 * * *' },
    filter: null,
    createdAt: 0,
    updatedAt: 0,
  };

  it('returns the canonical ensure chat id for an "continue" action', () => {
    const job = {
      ...base,
      action: { type: 'continue', daemonId: 'd1', folder: '~/p', skill: 'x' },
    } as Job;
    expect(jobChatId(job, undefined)).toBe('jobchat-j1');
  });

  it('returns the fixed chatId for a "message" action', () => {
    const job = { ...base, action: { type: 'message', chatId: 'c-fixed', prompt: 'x' } } as Job;
    expect(jobChatId(job, 'other-chat')).toBe('c-fixed');
  });

  it('returns the latest run chatId for a "spawn" action', () => {
    const job = {
      ...base,
      action: { type: 'spawn', daemonId: 'd1', folder: '~/p', skill: 'x' },
    } as Job;
    expect(jobChatId(job, 'latest-run-chat')).toBe('latest-run-chat');
  });

  it('returns null for a "spawn" action with no runs yet', () => {
    const job = {
      ...base,
      action: { type: 'spawn', daemonId: 'd1', folder: '~/p', skill: 'x' },
    } as Job;
    expect(jobChatId(job, undefined)).toBeNull();
  });
});
