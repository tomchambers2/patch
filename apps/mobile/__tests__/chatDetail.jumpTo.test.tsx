// app/chats/[chatId].tsx — opening a chat at a search hit (spec/03 § Chat
// search): the route's `seq` param names the matched message, and the
// transcript lands on the row holding it — mid-screen, following off, the
// scroll-to-bottom button up, the row tinted for a moment. Observed through
// the FlatList stub's call log (__flatListCalls), as chatDetail.scroll does;
// every test uses its own chatId because the screen's scroll memory is a
// module-level map that outlives a test.
//
// The list is INVERTED: data is newest-first, so the row index a jump asks for
// counts back from the newest message.

import React from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  renderRN,
  findHost,
  queryHost,
  byTestId,
  textOf,
  actSync,
  actAsync,
  update,
} from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __flatListCalls, __resetFlatListCalls } from './stubs/react-native';
import { __setLocalSearchParams } from './stubs/expo-router';
import { JUMP_HIGHLIGHT_MS, JUMP_MAX_RETRIES, JUMP_WAIT_MS } from '../src/lib/chatJump';

vi.mock('../src/api/rest', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
  },
}));
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() }),
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

let ChatDetailScreen: React.ComponentType;

const mounted: ReactTestRenderer[] = [];
function render(element: React.ReactElement): ReactTestRenderer {
  const r = renderRN(element);
  mounted.push(r);
  return r;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.clearAllMocks();
  __resetFlatListCalls();
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setDaemon('online');
  const mod = await import('../app/chats/[chatId]');
  ChatDetailScreen = mod.default;
});

afterEach(() => {
  actSync(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });
  vi.useRealTimers();
});

/** Let the FlatList stub's microtask-fired `onContentSizeChange` land. */
async function flushMicro(): Promise<void> {
  await actAsync(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function seedChat(chatId: string): void {
  useChatStore.getState().hydrate([
    {
      chatId,
      name: 'Chat',
      folder: '~/a',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
    },
  ]);
}

function message(chatId: string, seq: number): void {
  useChatStore.getState().applyEvent({
    type: 'chat.message',
    chatId,
    seq,
    role: 'assistant',
    content: `msg ${seq}`,
  });
}

function jumps(): Array<{ index: number; viewPosition?: number; animated?: boolean }> {
  return __flatListCalls
    .filter((c) => c.method === 'scrollToIndex')
    .map((c) => c.args[0] as { index: number; viewPosition?: number; animated?: boolean });
}

function scrolledToNewest(): boolean {
  return __flatListCalls.some(
    (c) => c.method === 'scrollToOffset' && (c.args[0] as { offset: number }).offset === 0,
  );
}

describe('jump to a search hit', () => {
  it('scrolls the row holding the seq to mid-screen, stops following, and tints it', async () => {
    seedChat('jump-1');
    for (let s = 1; s <= 5; s++) message('jump-1', s);
    __setLocalSearchParams({ chatId: 'jump-1', seq: '2' });
    const r = render(<ChatDetailScreen />);
    await flushMicro();
    // Newest-first: seq 5 is index 0, so seq 2 is index 3.
    expect(jumps()).toEqual([{ index: 3, viewPosition: 0.5, animated: false }]);
    // The open's usual pin to the newest message did not run over it.
    expect(scrolledToNewest()).toBe(false);
    expect(findHost(r.root, byTestId('scroll-to-bottom'))).toBeTruthy();
    expect(textOf(findHost(r.root, byTestId('jump-highlight')))).toContain('msg 2');

    await actAsync(async () => {
      vi.advanceTimersByTime(JUMP_HIGHLIGHT_MS);
    });
    expect(queryHost(r.root, byTestId('jump-highlight'))).toBeNull();
  });

  it('finds a seq folded into a tool run', async () => {
    seedChat('jump-group');
    message('jump-group', 1);
    useChatStore.getState().applyEvent({
      type: 'chat.tool_call',
      chatId: 'jump-group',
      seq: 2,
      callId: 't1',
      tool: 'Read',
      args: { file_path: '/a' },
    });
    useChatStore.getState().applyEvent({
      type: 'chat.tool_result',
      chatId: 'jump-group',
      seq: 3,
      callId: 't1',
      result: { ok: true },
    });
    message('jump-group', 4);
    __setLocalSearchParams({ chatId: 'jump-group', seq: '3' });
    const r = render(<ChatDetailScreen />);
    await flushMicro();
    // Rows newest-first: [msg 4, tool run (2,3), msg 1].
    expect(useChatStore.getState().timelines['jump-group']).toHaveLength(4);
    expect(jumps().map((j) => j.index)).toEqual([1]);
    expect(textOf(findHost(r.root, byTestId('jump-highlight')))).not.toContain('msg');
  });

  it('waits for a seq the transcript has not hydrated yet, then jumps once', async () => {
    seedChat('jump-late');
    message('jump-late', 1);
    message('jump-late', 2);
    __setLocalSearchParams({ chatId: 'jump-late', seq: '4' });
    render(<ChatDetailScreen />);
    await flushMicro();
    // Not there yet: the chat opens normally meanwhile.
    expect(jumps()).toEqual([]);
    expect(scrolledToNewest()).toBe(true);

    actSync(() => {
      message('jump-late', 3);
      message('jump-late', 4);
      message('jump-late', 5);
    });
    await flushMicro();
    expect(jumps()).toEqual([{ index: 1, viewPosition: 0.5, animated: false }]);

    // Later growth never re-jumps, and — following off — never re-pins either.
    __resetFlatListCalls();
    actSync(() => message('jump-late', 6));
    await flushMicro();
    expect(__flatListCalls).toEqual([]);
  });

  it('gives up after the wait and leaves the chat where it opened', async () => {
    seedChat('jump-never');
    message('jump-never', 1);
    __setLocalSearchParams({ chatId: 'jump-never', seq: '9' });
    const r = render(<ChatDetailScreen />);
    await flushMicro();
    await actAsync(async () => {
      vi.advanceTimersByTime(JUMP_WAIT_MS + 1);
    });
    actSync(() => {
      for (let s = 2; s <= 9; s++) message('jump-never', s);
    });
    await flushMicro();
    expect(jumps()).toEqual([]);
    expect(queryHost(r.root, byTestId('jump-highlight'))).toBeNull();
  });

  it('a seq arriving on an already-open chat jumps straight away', async () => {
    seedChat('jump-param');
    for (let s = 1; s <= 3; s++) message('jump-param', s);
    __setLocalSearchParams({ chatId: 'jump-param' });
    const r = render(<ChatDetailScreen />);
    await flushMicro();
    expect(jumps()).toEqual([]);
    __setLocalSearchParams({ chatId: 'jump-param', seq: '1' });
    update(r, <ChatDetailScreen />);
    expect(jumps()).toEqual([{ index: 2, viewPosition: 0.5, animated: false }]);
  });

  it('ignores a seq param that is not a number', async () => {
    seedChat('jump-bad');
    message('jump-bad', 1);
    __setLocalSearchParams({ chatId: 'jump-bad', seq: 'abc' });
    render(<ChatDetailScreen />);
    await flushMicro();
    expect(jumps()).toEqual([]);
    expect(scrolledToNewest()).toBe(true);
  });

  it('a later open without the param lands at the newest message as before', async () => {
    seedChat('jump-reopen');
    for (let s = 1; s <= 3; s++) message('jump-reopen', s);
    __setLocalSearchParams({ chatId: 'jump-reopen', seq: '1' });
    const first = render(<ChatDetailScreen />);
    await flushMicro();
    expect(jumps()).toHaveLength(1);
    actSync(() => first.unmount());
    mounted.splice(mounted.indexOf(first), 1);

    __resetFlatListCalls();
    __setLocalSearchParams({ chatId: 'jump-reopen' });
    const r = render(<ChatDetailScreen />);
    await flushMicro();
    expect(jumps()).toEqual([]);
    expect(scrolledToNewest()).toBe(true);
    expect(queryHost(r.root, byTestId('scroll-to-bottom'))).toBeNull();
  });
});

describe('scrollToIndex on a row not measured yet', () => {
  it('scrolls to the estimated offset, then asks for the index again — a bounded number of times', async () => {
    seedChat('jump-fail');
    message('jump-fail', 1);
    __setLocalSearchParams({ chatId: 'jump-fail' });
    const r = render(<ChatDetailScreen />);
    await flushMicro();
    const list = findHost(r.root, (i) => i.type === 'FlatList');
    __resetFlatListCalls();

    actSync(() =>
      list.props.onScrollToIndexFailed({
        index: 7,
        averageItemLength: 100,
        highestMeasuredFrameIndex: 2,
      }),
    );
    expect(__flatListCalls).toEqual([
      { method: 'scrollToOffset', args: [{ offset: 700, animated: false }] },
    ]);
    await actAsync(async () => {
      vi.advanceTimersByTime(50);
    });
    expect(jumps()).toEqual([{ index: 7, viewPosition: 0.5, animated: false }]);

    // Keep failing: the retries stop at the bound.
    for (let i = 0; i < JUMP_MAX_RETRIES + 3; i++) {
      actSync(() =>
        list.props.onScrollToIndexFailed({
          index: 7,
          averageItemLength: 100,
          highestMeasuredFrameIndex: 2,
        }),
      );
      await actAsync(async () => {
        vi.advanceTimersByTime(50);
      });
    }
    expect(jumps()).toHaveLength(JUMP_MAX_RETRIES);
  });
});
