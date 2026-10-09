// spec/06 § Manager conversation — bounded context. The pure half: given a
// chat's whole track, find the point N real messages from the end and keep
// everything from there on, so a tool call and its result never split
// across the cut.

import { describe, it, expect } from 'vitest';
import { countMessages, windowTrack } from '../src/managerContext.js';
import type { TrackEntry } from '../src/nativeReconstruct.js';

let seq = 0;
function message(role: 'user' | 'assistant' | 'system', content: string): TrackEntry {
  seq += 1;
  return {
    record: { seq, at: seq * 1000 },
    event: {
      type: 'chat.message',
      chatId: 'thread_manager',
      role,
      content,
      seq,
      createdAt: seq * 1000,
    },
  } as TrackEntry;
}
function toolCall(tool: string): TrackEntry {
  seq += 1;
  return {
    record: { seq, at: seq * 1000 },
    event: {
      type: 'chat.tool_call',
      chatId: 'thread_manager',
      tool,
      args: {},
      callId: `call-${seq}`,
      seq,
      createdAt: seq * 1000,
    },
  } as TrackEntry;
}
function toolResult(tool: string, callId: string): TrackEntry {
  seq += 1;
  return {
    record: { seq, at: seq * 1000 },
    event: {
      type: 'chat.tool_result',
      chatId: 'thread_manager',
      tool,
      callId,
      result: 'ok',
      seq,
      createdAt: seq * 1000,
    },
  } as TrackEntry;
}

describe('countMessages', () => {
  it('counts user and assistant messages, not system or tool events', () => {
    seq = 0;
    const track = [
      message('user', 'hi'),
      message('system', 'rotated'),
      message('assistant', 'hello'),
      toolCall('Bash'),
      toolResult('Bash', 'call-4'),
    ];
    expect(countMessages(track)).toBe(2);
  });

  it('is zero for an empty track', () => {
    expect(countMessages([])).toBe(0);
  });
});

describe('windowTrack', () => {
  it('keeps the trailing N real messages and everything after the Nth-from-end one', () => {
    seq = 0;
    const m1 = message('user', 'one');
    const m2 = message('assistant', 'two');
    const m3 = message('user', 'three');
    const m4 = message('assistant', 'four');
    const track = [m1, m2, m3, m4];
    expect(windowTrack(track, 2)).toEqual([m3, m4]);
    expect(windowTrack(track, 1)).toEqual([m4]);
    expect(windowTrack(track, 10)).toEqual(track); // fewer messages than the window — keep everything
  });

  it('never splits a tool call from its result across the cut', () => {
    seq = 0;
    const m1 = message('user', 'one');
    const call = toolCall('Bash');
    const result = toolResult(
      'Bash',
      call.event.type === 'chat.tool_call' ? call.event.callId : '',
    );
    const m2 = message('assistant', 'two');
    const track = [m1, call, result, m2];
    // Window of 1 keeps only the last real message (m2) — the call/result
    // pair sits entirely BEFORE it and is correctly dropped whole, not split.
    expect(windowTrack(track, 1)).toEqual([m2]);
    // Window of 2 reaches back to m1, which keeps the call/result pair too
    // (they sit between m1 and m2, inside the kept range).
    expect(windowTrack(track, 2)).toEqual(track);
  });

  it('returns the track unchanged for a nonsensical (<=0) window', () => {
    seq = 0;
    const track = [message('user', 'one'), message('assistant', 'two')];
    expect(windowTrack(track, 0)).toEqual(track);
    expect(windowTrack(track, -1)).toEqual(track);
  });

  it('keeps a system message that sits between two kept real messages', () => {
    seq = 0;
    const m1 = message('user', 'one');
    const m2 = message('assistant', 'two');
    const sys = message('system', 'boundary');
    const m3 = message('user', 'three');
    const track = [m1, m2, sys, m3];
    // m2 is the 2nd-from-end real message, so the window starts there —
    // `sys`, sitting between m2 and m3, is inside the kept range.
    expect(windowTrack(track, 2)).toEqual([m2, sys, m3]);
  });
});
