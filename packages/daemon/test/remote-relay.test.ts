// The calling machine's half of a cross-host patch_peek/patch_history/
// patch_send_to relay — shared by all three, so exercised generically here.
// See remote-spawn.test.ts for the spawn-specific sibling.

import { describe, it, expect, vi } from 'vitest';
import type { WireEvent } from '@patch/wire';
import {
  createRemoteRelayCoordinator,
  RemoteRelayError,
  REMOTE_RELAY_TIMEOUT_MS,
} from '../src/remote-relay.js';

function harness(timeoutMs?: number) {
  const emitted: WireEvent[] = [];
  const unknown: string[] = [];
  let n = 0;
  const coord = createRemoteRelayCoordinator<{ chat_state: { chatId: string } }>({
    emit: (e) => emitted.push(e),
    onUnknownResponse: (id) => unknown.push(id),
    newRequestId: () => `req-${++n}`,
    idPrefix: 'rpeek',
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  return { coord, emitted, unknown };
}

describe('remote relay coordinator', () => {
  it('emits a request carrying the requestId the answer must echo', async () => {
    const { coord, emitted } = harness();
    const p = coord.call(
      (requestId) =>
        ({
          type: 'patch.peek.request',
          sourceChatId: 'mgr',
          targetChatId: 'chat-remote',
          requestId,
        }) as WireEvent,
      () => 'timed out',
    );
    expect(emitted[0]).toMatchObject({ type: 'patch.peek.request', requestId: 'req-1' });
    coord.resolve({
      requestId: 'req-1',
      ok: true,
      result: { chat_state: { chatId: 'chat-remote' } },
    });
    await expect(p).resolves.toEqual({ chat_state: { chatId: 'chat-remote' } });
  });

  it('REJECTS on a refusal, naming the reason', async () => {
    const { coord } = harness();
    const p = coord.call(
      (requestId) =>
        ({
          type: 'patch.peek.request',
          sourceChatId: 'mgr',
          targetChatId: 'chat-remote',
          requestId,
        }) as WireEvent,
      () => 'timed out',
    );
    coord.resolve({
      requestId: 'req-1',
      ok: false,
      error: { code: 'chat_not_found', message: 'no such chat: chat-remote' },
    });
    await expect(p).rejects.toThrow(RemoteRelayError);
    await p.catch((err: RemoteRelayError) => {
      expect(err.code).toBe('chat_not_found');
      expect(err.message).toBe('no such chat: chat-remote');
    });
  });

  it('an expiry is a loud error, never a silent success', async () => {
    vi.useFakeTimers();
    try {
      const { coord } = harness(50);
      const p = coord.call(
        (requestId) =>
          ({
            type: 'patch.peek.request',
            sourceChatId: 'mgr',
            targetChatId: 'chat-remote',
            requestId,
          }) as WireEvent,
        () => 'machine host-b did not answer within 50ms',
      );
      const assertion = expect(p).rejects.toThrow(/did not answer/);
      await vi.advanceTimersByTimeAsync(51);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('a late answer after the expiry is reported as unknown, not resolved twice', async () => {
    vi.useFakeTimers();
    try {
      const { coord, unknown } = harness(50);
      const p = coord.call(
        (requestId) =>
          ({
            type: 'patch.peek.request',
            sourceChatId: 'mgr',
            targetChatId: 'chat-remote',
            requestId,
          }) as WireEvent,
        () => 'timed out',
      );
      const assertion = expect(p).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(51);
      await assertion;
      coord.resolve({ requestId: 'req-1', ok: true, result: {} });
      expect(unknown).toEqual(['req-1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps two in-flight calls apart', async () => {
    const { coord, emitted } = harness();
    const a = coord.call(
      (requestId) =>
        ({
          type: 'patch.peek.request',
          sourceChatId: 'mgr',
          targetChatId: 'chat-a',
          requestId,
        }) as WireEvent,
      () => 'timeout',
    );
    const b = coord.call(
      (requestId) =>
        ({
          type: 'patch.peek.request',
          sourceChatId: 'mgr',
          targetChatId: 'chat-b',
          requestId,
        }) as WireEvent,
      () => 'timeout',
    );
    expect(emitted.map((e) => (e as { requestId: string }).requestId)).toEqual(['req-1', 'req-2']);
    coord.resolve({ requestId: 'req-2', ok: true, result: { chat_state: { chatId: 'chat-b' } } });
    coord.resolve({ requestId: 'req-1', ok: true, result: { chat_state: { chatId: 'chat-a' } } });
    await expect(a).resolves.toEqual({ chat_state: { chatId: 'chat-a' } });
    await expect(b).resolves.toEqual({ chat_state: { chatId: 'chat-b' } });
  });

  it('a refusal with no reason still fails, worded as such', async () => {
    const { coord } = harness();
    const p = coord.call(
      (requestId) =>
        ({
          type: 'patch.peek.request',
          sourceChatId: 'mgr',
          targetChatId: 'chat-remote',
          requestId,
        }) as WireEvent,
      () => 'timeout',
    );
    coord.resolve({ requestId: 'req-1', ok: false });
    await expect(p).rejects.toThrow(/without a reason/);
  });

  it('mints its own correlation id, prefixed for its caller, when none is injected', async () => {
    const emitted: WireEvent[] = [];
    const coord = createRemoteRelayCoordinator({
      emit: (e) => emitted.push(e),
      onUnknownResponse: () => {},
      idPrefix: 'rsend',
    });
    const p = coord.call(
      (requestId) =>
        ({
          type: 'patch.send_to',
          sourceChatId: 'mgr',
          targetChatId: 'chat-remote',
          message: 'hi',
          requestId,
        }) as WireEvent,
      () => 'timeout',
    );
    const requestId = (emitted[0] as { requestId: string }).requestId;
    expect(requestId).toMatch(/^rsend-/);
    coord.resolve({ requestId, ok: true });
    await p;
  });

  it('reports a response for a request it never made', () => {
    const { coord, unknown } = harness();
    coord.resolve({ requestId: 'nope', ok: true, result: {} });
    expect(unknown).toEqual(['nope']);
  });

  it('waits 15s by default', () => {
    expect(REMOTE_RELAY_TIMEOUT_MS).toBe(15_000);
  });
});
