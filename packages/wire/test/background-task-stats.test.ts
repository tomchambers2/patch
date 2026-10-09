import { describe, expect, it } from 'vitest';

import { decode, encode } from '../src/codec.js';
import {
  PatchBackgroundTaskStatsRequestEvent,
  PatchBackgroundTaskStatsResponseEvent,
} from '../src/events.js';
import { WireDecodeError } from '../src/errors.js';

// spec/03 § Background task stats — what a chat's running background tasks are
// costing their host, for the background task bar (spec/14 § Main chat panel —
// Background task bar).
//
// The load-bearing property of the pair is the ABSENCE of a stat: the response
// carries one entry per MEASURED task and never one per requested id, so these
// assert that a partial answer is a legal frame and that a zero is never
// required to stand in for a task nobody could measure.

describe('patch.background_task_stats.request', () => {
  it('round-trips through the codec', () => {
    const ev: PatchBackgroundTaskStatsRequestEvent = {
      type: 'patch.background_task_stats.request',
      requestId: 'r1',
      chatId: 'c1',
      taskIds: ['baiw888mq', 'bkvn61the'],
    };
    expect(decode(encode(ev))).toEqual(ev);
  });

  it('requires at least one task id — a request naming none asks nothing', () => {
    expect(
      PatchBackgroundTaskStatsRequestEvent.safeParse({
        type: 'patch.background_task_stats.request',
        requestId: 'r1',
        chatId: 'c1',
        taskIds: [],
      }).success,
    ).toBe(false);
  });

  it('caps the batch — this runs on a poll, not on demand', () => {
    const ids = Array.from({ length: 51 }, (_v, i) => `task${i}`);
    expect(
      PatchBackgroundTaskStatsRequestEvent.safeParse({
        type: 'patch.background_task_stats.request',
        requestId: 'r1',
        chatId: 'c1',
        taskIds: ids,
      }).success,
    ).toBe(false);
    expect(
      PatchBackgroundTaskStatsRequestEvent.safeParse({
        type: 'patch.background_task_stats.request',
        requestId: 'r1',
        chatId: 'c1',
        taskIds: ids.slice(0, 50),
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown field rather than dropping it', () => {
    expect(() =>
      decode(
        JSON.stringify({
          type: 'patch.background_task_stats.request',
          requestId: 'r1',
          chatId: 'c1',
          taskIds: ['baiw888mq'],
          intervalMs: 3000,
        }),
      ),
    ).toThrow(WireDecodeError);
  });
});

describe('patch.background_task_stats.response', () => {
  it('round-trips a measured task', () => {
    const ev: PatchBackgroundTaskStatsResponseEvent = {
      type: 'patch.background_task_stats.response',
      requestId: 'r1',
      ok: true,
      stats: [{ taskId: 'baiw888mq', cpuPercent: 98.4, rssBytes: 432013312, processes: 3 }],
    };
    expect(decode(encode(ev))).toEqual(ev);
  });

  it('accepts a successful answer that measured NOTHING it was asked about', () => {
    // Two ids in, no stats out: every task was unmeasurable. This is an
    // ordinary answer, not an error, and it must not need a zero per id.
    expect(
      PatchBackgroundTaskStatsResponseEvent.safeParse({
        type: 'patch.background_task_stats.response',
        requestId: 'r1',
        ok: true,
        stats: [],
      }).success,
    ).toBe(true);
  });

  it('measures at least one process per stat — a stat over nothing is not a measurement', () => {
    expect(
      PatchBackgroundTaskStatsResponseEvent.safeParse({
        type: 'patch.background_task_stats.response',
        requestId: 'r1',
        ok: true,
        stats: [{ taskId: 'baiw888mq', cpuPercent: 0, rssBytes: 0, processes: 0 }],
      }).success,
    ).toBe(false);
  });

  it('rejects a negative reading', () => {
    expect(
      PatchBackgroundTaskStatsResponseEvent.safeParse({
        type: 'patch.background_task_stats.response',
        requestId: 'r1',
        ok: true,
        stats: [{ taskId: 'baiw888mq', cpuPercent: -1, rssBytes: 10, processes: 1 }],
      }).success,
    ).toBe(false);
    expect(
      PatchBackgroundTaskStatsResponseEvent.safeParse({
        type: 'patch.background_task_stats.response',
        requestId: 'r1',
        ok: true,
        stats: [{ taskId: 'baiw888mq', cpuPercent: 1, rssBytes: -10, processes: 1 }],
      }).success,
    ).toBe(false);
  });

  it('carries the three typed failures, and nothing else', () => {
    for (const code of ['chat_not_found', 'no_process_table', 'internal']) {
      const ev = {
        type: 'patch.background_task_stats.response',
        requestId: 'r1',
        ok: false,
        error: { code, message: 'nope' },
      };
      expect(PatchBackgroundTaskStatsResponseEvent.safeParse(ev).success, code).toBe(true);
      expect(decode(encode(ev as PatchBackgroundTaskStatsResponseEvent))).toEqual(ev);
    }
    expect(
      PatchBackgroundTaskStatsResponseEvent.safeParse({
        type: 'patch.background_task_stats.response',
        requestId: 'r1',
        ok: false,
        error: { code: 'busy', message: 'nope' },
      }).success,
    ).toBe(false);
  });
});
