// A tool call is identified by its callId: the same call arriving twice (a
// re-delivered chat.replay, or the same call at a second seq) is one row.

import { describe, it, expect, beforeEach } from 'vitest';
import { useChatStore } from '../src/stores/chatStore';

beforeEach(() => {
  useChatStore.getState()._reset();
});

const call = (seq: number, callId: string) =>
  ({
    type: 'chat.tool_call',
    chatId: 'c1',
    seq,
    tool: 'Bash',
    args: { command: 'ls' },
    callId,
  }) as const;
const result = (seq: number, callId: string) =>
  ({ type: 'chat.tool_result', chatId: 'c1', seq, tool: 'Bash', result: 'ok', callId }) as const;

describe('mobile chatStore tool call dedupe', () => {
  it('a replayed tool_call/tool_result at the same seq renders once', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    for (let i = 0; i < 2; i++) {
      s.applyEvent(call(1, 'a'));
      s.applyEvent(result(2, 'a'));
    }
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.map((e) => e.kind)).toEqual(['tool_call', 'tool_result']);
  });

  it('the same callId at a different seq renders once', () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    s.applyEvent(call(1, 'a'));
    s.applyEvent(call(2, 'a'));
    const tl = useChatStore.getState().timelines['c1'] ?? [];
    expect(tl.filter((e) => e.kind === 'tool_call')).toHaveLength(1);
  });
});
