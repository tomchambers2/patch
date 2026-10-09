import { describe, expect, it } from 'vitest';
import { EVENT_SCHEMAS, formatMeetingClock, meetingElapsedMs, MeetingState } from '../src/index.js';

const state = {
  status: 'live',
  startedAt: 1,
  elapsedBaseMs: 1000,
  resumedAt: 5000,
  now: null,
  summary: null,
  topics: [],
  actions: [],
  transcript: [],
  error: null,
};

describe('meeting wire', () => {
  it('accepts every meeting event shape', () => {
    const ok = [
      { type: 'meeting.control_request', chatId: 'c', action: 'start' },
      { type: 'meeting.get_request', chatId: 'c' },
      { type: 'meeting.audio', chatId: 'c', source: 'mic', audioBase64: 'AA==' },
      { type: 'meeting.action_request', chatId: 'c', actionId: 'a', decision: 'do' },
      { type: 'meeting.state', chatId: 'c', meeting: state },
      { type: 'meeting.state', chatId: 'c', meeting: null },
    ];
    for (const e of ok)
      expect(EVENT_SCHEMAS[e.type as keyof typeof EVENT_SCHEMAS].safeParse(e).success).toBe(true);
  });

  it('rejects a bad action and unknown fields', () => {
    expect(
      EVENT_SCHEMAS['meeting.control_request'].safeParse({
        type: 'meeting.control_request',
        chatId: 'c',
        action: 'x',
      }).success,
    ).toBe(false);
    expect(MeetingState.safeParse({ ...state, extra: 1 }).success).toBe(false);
  });

  it('computes elapsed time and the clock', () => {
    expect(meetingElapsedMs(MeetingState.parse(state), 8000)).toBe(4000);
    expect(
      meetingElapsedMs(
        MeetingState.parse({ ...state, status: 'paused', resumedAt: undefined }),
        99999,
      ),
    ).toBe(1000);
    expect(formatMeetingClock(65_000)).toBe('01:05');
    expect(formatMeetingClock(3_725_000)).toBe('1:02:05');
  });
});
