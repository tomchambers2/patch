// spec/15 § Chat detail — Delegate tool row: a `patch_delegate` call carries
// a live status pill and an "Open transcript" row that pushes a read-only
// screen, rather than collapsing like an ordinary tool call.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  renderRN,
  actSync,
  actAsync,
  flush,
  findHost,
  findAllHost,
  byTestId,
  hasText,
} from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __setLocalSearchParams, routerMock, __resetRouterMock } from './stubs/expo-router';

const getDelegateHistory = vi.fn(async () => ({
  events: [
    { seq: 0, role: 'user', content: 'go do the thing' },
    { seq: 1, role: 'assistant', content: 'done, here is the result' },
  ],
}));

vi.mock('../src/api/rest', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
    uploadAttachment: vi.fn(),
    getDelegateHistory: (...args: unknown[]) =>
      (getDelegateHistory as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
  },
}));
vi.mock('../src/api/ws', () => ({
  getWs: () => ({ send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() }),
}));
vi.mock('../src/lib/voiceCall', () => ({ startVoiceCall: vi.fn() }));

let ChatDetailScreen: React.ComponentType;

beforeEach(async () => {
  vi.clearAllMocks();
  getDelegateHistory.mockClear();
  __resetRouterMock();
  useChatStore.getState()._reset();
  usePresenceStore.getState().setConnection('connected');
  usePresenceStore.getState().setDaemon('online');
  const mod = await import('../app/chats/[chatId]');
  ChatDetailScreen = mod.default;
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      name: 'My Chat',
      folder: '~/project',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
    },
  ]);
  __setLocalSearchParams({ chatId: 'c1' });
});

function emitDelegateCall(tool: string, result: unknown): void {
  useChatStore.getState().applyEvent({
    type: 'chat.tool_call',
    chatId: 'c1',
    seq: 1,
    tool,
    args: { prompt: 'go do the thing' },
    callId: 'call-1',
  });
  useChatStore.getState().applyEvent({
    type: 'chat.tool_result',
    chatId: 'c1',
    seq: 2,
    callId: 'call-1',
    result,
  } as never);
}

describe('patch_delegate tool row', () => {
  it('shows a Running pill and Open transcript row once the ack lands', () => {
    emitDelegateCall('patch_delegate', { id: 'sub-1', label: 'draft the email' });
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(findHost(r.root, byTestId('delegate-status-pill')), 'Running')).toBe(true);
    expect(findHost(r.root, byTestId('delegate-open-transcript'))).toBeDefined();
  });

  it('falls back to the ordinary collapsed row before the ack has landed', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'patch_delegate',
      args: { prompt: 'go do the thing' },
      callId: 'call-1',
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('delegate-status-pill'))).toHaveLength(0);
    expect(findAllHost(r.root, byTestId('delegate-tool-call'))).toHaveLength(0);
  });

  it('updates the pill in place from chat.delegate_update, by the subagent id the ack returned', () => {
    emitDelegateCall('patch_delegate', { id: 'sub-1', label: 'draft the email' });
    const r = renderRN(<ChatDetailScreen />);
    expect(hasText(findHost(r.root, byTestId('delegate-status-pill')), 'Running')).toBe(true);

    actSync(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.delegate_update',
        chatId: 'c1',
        delegateId: 'sub-1',
        label: 'draft the email',
        status: 'failed',
        seq: 3,
      });
    });
    expect(hasText(findHost(r.root, byTestId('delegate-status-pill')), 'Failed')).toBe(true);
  });

  it('a delegate_update for a DIFFERENT subagent id leaves this row alone', () => {
    emitDelegateCall('patch_delegate', { id: 'sub-1', label: 'draft the email' });
    const r = renderRN(<ChatDetailScreen />);
    actSync(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.delegate_update',
        chatId: 'c1',
        delegateId: 'sub-2',
        label: 'something else',
        status: 'done',
        seq: 3,
      });
    });
    expect(hasText(findHost(r.root, byTestId('delegate-status-pill')), 'Running')).toBe(true);
  });

  it('is a collapsible row: collapsed by default, expands inline to the transcript, collapses again', async () => {
    emitDelegateCall('mcp__patch__patch_delegate', { id: 'sub-1', label: 'draft the email' });
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('delegate-transcript-stream'))).toHaveLength(0);
    expect(getDelegateHistory).not.toHaveBeenCalled();

    await actAsync(async () => {
      findHost(r.root, byTestId('delegate-open-transcript')).props.onPress();
      await flush();
    });
    expect(getDelegateHistory).toHaveBeenCalledWith('c1', 'sub-1');
    expect(findAllHost(r.root, byTestId('delegate-transcript-msg'))).toHaveLength(2);
    expect(hasText(r.root, 'done, here is the result')).toBe(true);
    // Inline in the parent: no navigation to a screen of its own.
    expect(routerMock.push).not.toHaveBeenCalled();

    await actAsync(async () => {
      findHost(r.root, byTestId('delegate-open-transcript')).props.onPress();
      await flush();
    });
    expect(findAllHost(r.root, byTestId('delegate-transcript-stream'))).toHaveLength(0);
  });

  it('reads the ack out of an MCP text block, not just a direct object', () => {
    emitDelegateCall('patch_delegate', {
      content: [{ type: 'text', text: JSON.stringify({ id: 'sub-1', label: 'draft the email' }) }],
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(findHost(r.root, byTestId('delegate-status-pill'))).toBeDefined();
  });

  it('leaves patch_delegate_list / patch_delegate_stop on the ordinary collapsed row', () => {
    useChatStore.getState().applyEvent({
      type: 'chat.tool_call',
      chatId: 'c1',
      seq: 1,
      tool: 'mcp__patch__patch_delegate_list',
      args: {},
      callId: 'call-1',
    });
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('delegate-status-pill'))).toHaveLength(0);
  });
});

describe('running delegates strip', () => {
  function update(id: string, label: string, status: 'running' | 'done', seq: number): void {
    actSync(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.delegate_update',
        chatId: 'c1',
        delegateId: id,
        label,
        status,
        seq,
      });
    });
  }

  it('lists running subagents with label and running time, and drops them when done', () => {
    const r = renderRN(<ChatDetailScreen />);
    expect(findAllHost(r.root, byTestId('delegate-strip'))).toHaveLength(0);
    update('sub-1', 'draft the email', 'running', 1);
    update('sub-2', 'build the design', 'running', 2);
    expect(findAllHost(r.root, byTestId('delegate-strip-item'))).toHaveLength(2);
    expect(
      hasText(findAllHost(r.root, byTestId('delegate-strip-item'))[0]!, 'draft the email'),
    ).toBe(true);
    expect(findAllHost(r.root, byTestId('delegate-strip-time'))[0]).toBeDefined();
    update('sub-1', 'draft the email', 'done', 3);
    expect(findAllHost(r.root, byTestId('delegate-strip-item'))).toHaveLength(1);
    update('sub-2', 'build the design', 'done', 4);
    expect(findAllHost(r.root, byTestId('delegate-strip'))).toHaveLength(0);
  });

  it('opens the read-only transcript from the strip', async () => {
    const r = renderRN(<ChatDetailScreen />);
    update('sub-1', 'draft the email', 'running', 1);
    await actAsync(async () => {
      findHost(r.root, byTestId('delegate-strip-open')).props.onPress();
      await flush();
    });
    expect(getDelegateHistory).toHaveBeenCalledWith('c1', 'sub-1');
  });
});
