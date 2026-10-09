// Unit tests for the surface-side guaranteed-delivery state machine (spec/12).
// Drives pending → ack / timeout-redelivery / failure / retry / reconnect with
// mock timers, asserting the chatStore delivery flags and the redelivery sends.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { DeliveryTracker } from '../lib/deliveryTracker.js';
import { useChatStore, type ChatEventEntry } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { setActiveWs, getActiveWs } from '../api/ws.js';
import type { PatchWs } from '../api/ws.js';

function entry(chatId: string, localId: string): ChatEventEntry | undefined {
  const tl = useChatStore.getState().timelines[chatId] ?? [];
  return tl.find((e) => e.localId === localId);
}

describe('DeliveryTracker (spec/12 § Guaranteed input delivery)', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('marks pending on submit and clears on chat.input_ack', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send });
    useChatStore.getState().addLocalMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1');

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.input', chatId: 'c1', localId: 'L1' }),
    );
    expect(entry('c1', 'L1')?.deliveryPending).toBe(true);
    expect(t.size()).toBe(1);

    t.observe({ type: 'chat.input_ack', chatId: 'c1', localId: 'L1' });
    expect(entry('c1', 'L1')?.deliveryPending).toBe(false);
    expect(t.size()).toBe(0);
  });

  it('includes the per-chat disabledTools on the chat.input, and reuses it on redelivery', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send, timeoutMs: 1000, maxAttempts: 3 });
    useChatStore.getState().addLocalMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1', undefined, undefined, ['Bash', 'mcp__patch__patch_spawn']);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'chat.input',
        disabledTools: ['Bash', 'mcp__patch__patch_spawn'],
      }),
    );
    // Timeout-driven redelivery reuses the captured OFF set (gates identically).
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ disabledTools: ['Bash', 'mcp__patch__patch_spawn'] }),
    );
  });

  it('omits disabledTools entirely when the OFF set is empty (default all-on)', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send });
    useChatStore.getState().addLocalMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1', undefined, undefined, []);
    expect(send).toHaveBeenCalledWith(
      expect.not.objectContaining({ disabledTools: expect.anything() }),
    );
  });

  it.each<[string, WireEvent]>([
    [
      'chat.queued',
      { type: 'chat.queued', chatId: 'c1', localId: 'L1', message: 'hi', queueSeq: 0 },
    ],
    [
      'assistant chat.message',
      { type: 'chat.message', chatId: 'c1', role: 'assistant', content: 'ok', seq: 1 },
    ],
    [
      'running chat.state',
      {
        type: 'chat.state',
        permissionMode: 'bypassPermissions' as const,
        chatId: 'c1',
        activity: 'running',
        lastUpdated: 0,
      },
    ],
    [
      'chat.error',
      { type: 'chat.error', chatId: 'c1', error: { code: 'sdk_error', message: 'x' }, seq: 2 },
    ],
  ])('clears pending when it observes %s', (_label, ev) => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send });
    useChatStore.getState().addLocalMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1');
    expect(entry('c1', 'L1')?.deliveryPending).toBe(true);

    t.observe(ev);
    expect(entry('c1', 'L1')?.deliveryPending).toBe(false);
    expect(t.size()).toBe(0);
  });

  it('redelivers on timeout while online, then fails after the attempt budget', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send, timeoutMs: 8000, maxAttempts: 3 });
    useChatStore.getState().addLocalMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1'); // initial send

    vi.advanceTimersByTime(8000); // retry 1
    vi.advanceTimersByTime(8000); // retry 2
    vi.advanceTimersByTime(8000); // retry 3
    expect(send).toHaveBeenCalledTimes(4); // initial + 3 redeliveries
    expect(entry('c1', 'L1')?.deliveryFailed).toBeFalsy();

    vi.advanceTimersByTime(8000); // budget exhausted → loud failure
    expect(send).toHaveBeenCalledTimes(4); // no further sends
    expect(entry('c1', 'L1')?.deliveryPending).toBe(false);
    expect(entry('c1', 'L1')?.deliveryFailed).toBe(true);
  });

  it('does NOT redeliver or fail while the host is offline — stays queued', () => {
    usePresenceStore.getState().setHostOnline('d1', false);
    const send = vi.fn();
    const t = new DeliveryTracker({ send, timeoutMs: 8000, maxAttempts: 3 });
    useChatStore.getState().addLocalMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1');

    vi.advanceTimersByTime(8000 * 6);
    expect(send).toHaveBeenCalledTimes(1); // never redelivered while offline
    expect(entry('c1', 'L1')?.deliveryPending).toBe(true);
    expect(entry('c1', 'L1')?.deliveryFailed).toBeFalsy();
    expect(t.size()).toBe(1);
  });

  it('does NOT redeliver while the WS link itself is down', () => {
    usePresenceStore.getState().setConnection('reconnecting');
    const send = vi.fn();
    const t = new DeliveryTracker({ send, timeoutMs: 8000, maxAttempts: 3 });
    useChatStore.getState().addLocalMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1');

    vi.advanceTimersByTime(8000 * 6);
    expect(send).toHaveBeenCalledTimes(1);
    expect(entry('c1', 'L1')?.deliveryPending).toBe(true);
  });

  it('retry() re-sends and clears the failed mark', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send, timeoutMs: 8000, maxAttempts: 1 });
    useChatStore.getState().addLocalMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1'); // send #1
    vi.advanceTimersByTime(8000); // retry 1 (send #2)
    vi.advanceTimersByTime(8000); // budget exhausted → fail
    expect(entry('c1', 'L1')?.deliveryFailed).toBe(true);
    const before = send.mock.calls.length;

    t.retry('c1', 'L1');
    expect(send.mock.calls.length).toBe(before + 1);
    expect(entry('c1', 'L1')?.deliveryPending).toBe(true);
    expect(entry('c1', 'L1')?.deliveryFailed).toBe(false);

    // A subsequent ack retires it.
    t.observe({ type: 'chat.input_ack', chatId: 'c1', localId: 'L1' });
    expect(t.size()).toBe(0);
  });

  it('retry() on a message also re-sends every earlier still-pending message in the same chat (spec/12 — tapping retry is chat-wide)', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send, timeoutMs: 8000, maxAttempts: 1 });
    useChatStore.getState().addLocalMessage('c1', 'one', 'L1');
    useChatStore.getState().addLocalMessage('c1', 'two', 'L2');
    useChatStore.getState().addLocalMessage('c1', 'three', 'L3');
    t.submit('c1', 'one', 'L1');
    t.submit('c1', 'two', 'L2');
    t.submit('c1', 'three', 'L3');

    // All three flap and exhaust their budget — three separate "not delivered" messages.
    vi.advanceTimersByTime(8000); // retry 1 for each
    vi.advanceTimersByTime(8000); // budget exhausted → fail, for each
    expect(entry('c1', 'L1')?.deliveryFailed).toBe(true);
    expect(entry('c1', 'L2')?.deliveryFailed).toBe(true);
    expect(entry('c1', 'L3')?.deliveryFailed).toBe(true);
    send.mockClear();

    // Tap retry on the LAST one — L1 and L2, queued before it, must go too,
    // not just L3 (Tom, Todoist — "sending a queued message should send all
    // the previous messages too").
    t.retry('c1', 'L3');

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map((c) => (c[0] as { localId: string }).localId)).toEqual([
      'L1',
      'L2',
      'L3',
    ]);
    expect(entry('c1', 'L1')?.deliveryFailed).toBe(false);
    expect(entry('c1', 'L2')?.deliveryFailed).toBe(false);
    expect(entry('c1', 'L3')?.deliveryFailed).toBe(false);
    expect(entry('c1', 'L1')?.deliveryPending).toBe(true);
    expect(entry('c1', 'L2')?.deliveryPending).toBe(true);
    expect(entry('c1', 'L3')?.deliveryPending).toBe(true);
  });

  it('retry() does NOT re-send messages submitted AFTER the tapped one, or messages in a different chat', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send, timeoutMs: 8000, maxAttempts: 1 });
    useChatStore.getState().addLocalMessage('c1', 'one', 'L1');
    useChatStore.getState().addLocalMessage('c1', 'two', 'L2');
    useChatStore.getState().addLocalMessage('c2', 'other-chat', 'L9');
    t.submit('c1', 'one', 'L1');
    t.submit('c1', 'two', 'L2');
    t.submit('c2', 'other-chat', 'L9');

    vi.advanceTimersByTime(8000);
    vi.advanceTimersByTime(8000); // all three fail
    send.mockClear();

    // Retry the FIRST message — L2 (later, same chat) and L9 (different chat)
    // must stay untouched.
    t.retry('c1', 'L1');

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ localId: 'L1' }));
    expect(entry('c1', 'L2')?.deliveryFailed).toBe(true);
    expect(entry('c2', 'L9')?.deliveryFailed).toBe(true);
  });

  it('onReconnect re-sends every still-pending input with a fresh budget', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send });
    useChatStore.getState().addLocalMessage('c1', 'a', 'L1');
    useChatStore.getState().addLocalMessage('c1', 'b', 'L2');
    t.submit('c1', 'a', 'L1');
    t.submit('c1', 'b', 'L2');
    expect(send).toHaveBeenCalledTimes(2);

    t.onReconnect();
    expect(send).toHaveBeenCalledTimes(4); // both re-sent
    expect(entry('c1', 'L1')?.deliveryPending).toBe(true);
    expect(entry('c1', 'L2')?.deliveryPending).toBe(true);
  });

  it('uses the default timeout + max-attempts when neither is configured', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send }); // no timeoutMs/maxAttempts override
    useChatStore.getState().addLocalMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1');
    // DELIVERY_TIMEOUT_MS=8000, DELIVERY_MAX_ATTEMPTS=3 — exhaust the default budget.
    vi.advanceTimersByTime(8000 * 4);
    expect(entry('c1', 'L1')?.deliveryFailed).toBe(true);
    expect(send).toHaveBeenCalledTimes(4); // initial + 3 default-budget redeliveries
  });

  it('submit() is idempotent for an already-pending (chatId, localId)', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send });
    useChatStore.getState().addLocalMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1'); // duplicate submit for the same key — no-op
    expect(send).toHaveBeenCalledTimes(1);
    expect(t.size()).toBe(1);
  });

  it('resolve (via observe) on an unknown localId is a no-op', () => {
    const t = new DeliveryTracker({ send: vi.fn() });
    expect(() =>
      t.observe({ type: 'chat.input_ack', chatId: 'c1', localId: 'never-submitted' }),
    ).not.toThrow();
    expect(t.size()).toBe(0);
  });

  it('retry() on an unknown localId is a no-op', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send });
    expect(() => t.retry('c1', 'never-submitted')).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('includes attachments on the outgoing chat.input when provided', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send });
    useChatStore.getState().addLocalMessage('c1', 'hi', 'L1');
    const attachments = [
      { id: 'a1', kind: 'image' as const, name: 'x.png', mimeType: 'image/png' },
    ];
    t.submit('c1', 'hi', 'L1', attachments);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ attachments }));
  });

  it('omits the attachments key entirely when none are given', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send });
    useChatStore.getState().addLocalMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1');
    const sent = send.mock.calls[0]![0] as Record<string, unknown>;
    expect('attachments' in sent).toBe(false);
  });

  it('observe() ignores a user chat.message (only assistant replies resolve pending)', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send });
    useChatStore.getState().addLocalMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1');
    t.observe({ type: 'chat.message', chatId: 'c1', role: 'user', content: 'echo', seq: 1 });
    expect(entry('c1', 'L1')?.deliveryPending).toBe(true);
    expect(t.size()).toBe(1);
  });

  it('observe() ignores a non-running chat.state', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send });
    useChatStore.getState().addLocalMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1');
    t.observe({
      type: 'chat.state',
      permissionMode: 'bypassPermissions' as const,
      chatId: 'c1',
      activity: 'idle',
      lastUpdated: 0,
    });
    expect(entry('c1', 'L1')?.deliveryPending).toBe(true);
  });

  it('observe() ignores unrelated event types (default branch)', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send });
    useChatStore.getState().addLocalMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1');
    t.observe({
      type: 'auth.ok',
      hosts: [],
      accountId: 'acc',
      surfaceId: 'c1',
    } as unknown as WireEvent);
    expect(entry('c1', 'L1')?.deliveryPending).toBe(true);
  });

  it('default send falls back to getActiveWs() when no deps.send/submit-send is given', () => {
    const wsSend = vi.fn();
    setActiveWs({ send: wsSend } as unknown as PatchWs);
    const t = new DeliveryTracker({ timeoutMs: 8000, maxAttempts: 3 });
    useChatStore.getState().addLocalMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1');
    expect(wsSend).toHaveBeenCalledTimes(1);
    expect(wsSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.input', chatId: 'c1', localId: 'L1' }),
    );
    setActiveWs(null);
  });

  it('doSend swallows a throw from the default send when there is no active ws (kept pending)', () => {
    // getActiveWs() is null (nothing registered) — the default send fn throws
    // 'no active ws', which doSend's catch must swallow silently.
    expect(getActiveWs()).toBeNull();
    const t = new DeliveryTracker({ timeoutMs: 8000, maxAttempts: 3 });
    useChatStore.getState().addLocalMessage('c1', 'hi', 'L1');
    expect(() => t.submit('c1', 'hi', 'L1')).not.toThrow();
    expect(entry('c1', 'L1')?.deliveryPending).toBe(true);
    expect(t.size()).toBe(1);
  });

  it('doSend swallows a throw from an active ws whose send() itself fails', () => {
    const wsSend = vi.fn(() => {
      throw new Error('socket not connected');
    });
    setActiveWs({ send: wsSend } as unknown as PatchWs);
    const t = new DeliveryTracker({ timeoutMs: 8000, maxAttempts: 3 });
    useChatStore.getState().addLocalMessage('c1', 'hi', 'L1');
    expect(() => t.submit('c1', 'hi', 'L1')).not.toThrow();
    expect(wsSend).toHaveBeenCalledTimes(1);
    expect(entry('c1', 'L1')?.deliveryPending).toBe(true);
    setActiveWs(null);
  });

  it('reset() drops all timers and tracked inputs (no leaks)', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send, timeoutMs: 8000, maxAttempts: 3 });
    useChatStore.getState().addLocalMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1');
    expect(t.size()).toBe(1);

    t.reset();
    expect(t.size()).toBe(0);
    vi.advanceTimersByTime(8000 * 6);
    expect(send).toHaveBeenCalledTimes(1); // the disarmed timer never fired
  });
});
