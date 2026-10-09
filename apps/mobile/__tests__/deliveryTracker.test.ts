// Mobile guaranteed-delivery state machine (spec/12). Mirrors the web tracker
// tests: pending → ack / timeout-redelivery / failure / retry / reconnect with
// mock timers, asserting the chatStore delivery flags and redelivery sends.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AttachmentRef, WireEvent } from '@patch/wire';
import { DeliveryTracker, deliveryTracker } from '../src/lib/deliveryTracker';
import { useChatStore, type ChatEventEntry } from '../src/stores/chatStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { getWs } from '../src/api/ws';

vi.mock('../src/api/ws', () => ({ getWs: vi.fn() }));

function entry(chatId: string, localId: string): ChatEventEntry | undefined {
  const tl = useChatStore.getState().timelines[chatId] ?? [];
  return tl.find((e) => e.localId === localId);
}

describe('mobile DeliveryTracker (spec/12 § Guaranteed input delivery)', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setDaemon('online');
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('marks pending on submit and clears on chat.input_ack', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send });
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1');

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
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'L1');
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
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'L1');
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
        permissionMode: 'bypassPermissions',
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
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1');
    expect(entry('c1', 'L1')?.deliveryPending).toBe(true);

    t.observe(ev);
    expect(entry('c1', 'L1')?.deliveryPending).toBe(false);
    expect(t.size()).toBe(0);
  });

  it('redelivers on timeout while online, then fails after the attempt budget', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send, timeoutMs: 8000, maxAttempts: 3 });
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1');

    vi.advanceTimersByTime(8000 * 3); // 3 redeliveries
    expect(send).toHaveBeenCalledTimes(4); // initial + 3
    expect(entry('c1', 'L1')?.deliveryFailed).toBeFalsy();

    vi.advanceTimersByTime(8000); // budget exhausted → loud failure
    expect(send).toHaveBeenCalledTimes(4);
    expect(entry('c1', 'L1')?.deliveryFailed).toBe(true);
    expect(entry('c1', 'L1')?.deliveryPending).toBe(false);
  });

  it('re-dials the link once on the first unanswered attempt (half-open socket), not on every timeout', () => {
    const send = vi.fn();
    const reconnect = vi.fn();
    const t = new DeliveryTracker({ send, reconnect, timeoutMs: 1000, maxAttempts: 3 });
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1');
    vi.advanceTimersByTime(999);
    expect(reconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('does not re-dial while the host is offline', () => {
    const reconnect = vi.fn();
    const t = new DeliveryTracker({ send: vi.fn(), reconnect, timeoutMs: 1000 });
    usePresenceStore.getState().setDaemon('offline');
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1');
    vi.advanceTimersByTime(5000);
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('does NOT redeliver or fail while the host is offline — stays queued', () => {
    usePresenceStore.getState().setDaemon('offline');
    const send = vi.fn();
    const t = new DeliveryTracker({ send, timeoutMs: 8000, maxAttempts: 3 });
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1');

    vi.advanceTimersByTime(8000 * 6);
    expect(send).toHaveBeenCalledTimes(1);
    expect(entry('c1', 'L1')?.deliveryPending).toBe(true);
    expect(entry('c1', 'L1')?.deliveryFailed).toBeFalsy();
  });

  it('retry() re-sends and clears the failed mark', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send, timeoutMs: 8000, maxAttempts: 1 });
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1');
    vi.advanceTimersByTime(8000); // retry 1
    vi.advanceTimersByTime(8000); // exhausted → fail
    expect(entry('c1', 'L1')?.deliveryFailed).toBe(true);
    const before = send.mock.calls.length;

    t.retry('c1', 'L1');
    expect(send.mock.calls.length).toBe(before + 1);
    expect(entry('c1', 'L1')?.deliveryPending).toBe(true);
    expect(entry('c1', 'L1')?.deliveryFailed).toBe(false);
  });

  it('retry() on a message also re-sends every earlier still-pending message in the same chat (spec/12 — tapping retry is chat-wide)', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send, timeoutMs: 8000, maxAttempts: 1 });
    useChatStore.getState().appendLocalUserMessage('c1', 'one', 'L1');
    useChatStore.getState().appendLocalUserMessage('c1', 'two', 'L2');
    useChatStore.getState().appendLocalUserMessage('c1', 'three', 'L3');
    t.submit('c1', 'one', 'L1');
    t.submit('c1', 'two', 'L2');
    t.submit('c1', 'three', 'L3');

    vi.advanceTimersByTime(8000);
    vi.advanceTimersByTime(8000); // all three fail
    expect(entry('c1', 'L1')?.deliveryFailed).toBe(true);
    expect(entry('c1', 'L2')?.deliveryFailed).toBe(true);
    expect(entry('c1', 'L3')?.deliveryFailed).toBe(true);
    send.mockClear();

    // Tap retry on the LAST one — L1 and L2, queued before it, must go too.
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
  });

  it('retry() does NOT re-send messages submitted AFTER the tapped one, or messages in a different chat', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send, timeoutMs: 8000, maxAttempts: 1 });
    useChatStore.getState().appendLocalUserMessage('c1', 'one', 'L1');
    useChatStore.getState().appendLocalUserMessage('c1', 'two', 'L2');
    useChatStore.getState().appendLocalUserMessage('c2', 'other-chat', 'L9');
    t.submit('c1', 'one', 'L1');
    t.submit('c1', 'two', 'L2');
    t.submit('c2', 'other-chat', 'L9');

    vi.advanceTimersByTime(8000);
    vi.advanceTimersByTime(8000);
    send.mockClear();

    t.retry('c1', 'L1');

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ localId: 'L1' }));
    expect(entry('c1', 'L2')?.deliveryFailed).toBe(true);
    expect(entry('c2', 'L9')?.deliveryFailed).toBe(true);
  });

  it('onReconnect re-sends every still-pending input', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send });
    useChatStore.getState().appendLocalUserMessage('c1', 'a', 'L1');
    useChatStore.getState().appendLocalUserMessage('c1', 'b', 'L2');
    t.submit('c1', 'a', 'L1');
    t.submit('c1', 'b', 'L2');
    expect(send).toHaveBeenCalledTimes(2);

    t.onReconnect();
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('reset() drops all timers and tracked inputs (no leaks)', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send, timeoutMs: 8000, maxAttempts: 3 });
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1');
    expect(t.size()).toBe(1);

    t.reset();
    expect(t.size()).toBe(0);
    vi.advanceTimersByTime(8000 * 6);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('includes attachments on the chat.input frame when the submit carried any', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send });
    const refs: AttachmentRef[] = [
      { id: 'a1', name: 'x.png', mimeType: 'image/png', kind: 'image' },
    ];
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'L1', refs);
    t.submit('c1', 'hi', 'L1', refs);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ attachments: refs }));
  });

  it('the default (no injected send) path calls getWs().send — the process-wide singleton', () => {
    const wsSend = vi.fn();
    vi.mocked(getWs).mockReturnValue({ send: wsSend } as unknown as ReturnType<typeof getWs>);
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'Lsingleton');
    deliveryTracker.submit('c1', 'hi', 'Lsingleton');
    expect(wsSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.input', localId: 'Lsingleton' }),
    );
    deliveryTracker.reset();
  });

  it('a send failure (not connected) is swallowed — the entry stays pending for the timer/reconnect to retry', () => {
    const send = vi.fn(() => {
      throw new Error('PatchWs: not connected');
    });
    const t = new DeliveryTracker({ send });
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'Lthrow');
    expect(() => t.submit('c1', 'hi', 'Lthrow')).not.toThrow();
    expect(entry('c1', 'Lthrow')?.deliveryPending).toBe(true);
    expect(t.size()).toBe(1);
  });

  it('observe() ignores an event type it does not track (default branch)', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send });
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'L1');
    t.submit('c1', 'hi', 'L1');
    expect(() =>
      t.observe({ type: 'auth.ok', hosts: [], accountId: 'a', surfaceId: 's' }),
    ).not.toThrow();
    expect(entry('c1', 'L1')?.deliveryPending).toBe(true); // untouched
  });

  it('uses the default DELIVERY_MAX_ATTEMPTS / DELIVERY_TIMEOUT_MS when no deps override them', () => {
    const send = vi.fn();
    // No `maxAttempts`/`timeoutMs` in deps — the getters fall back to the
    // module constants; drive them via a real timer fire (a fixed
    // maxAttempts:1/timeoutMs:0 tracker can't exercise the DEFAULT getters).
    const t = new DeliveryTracker({ send });
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'Ldefault');
    t.submit('c1', 'hi', 'Ldefault');
    vi.advanceTimersByTime(8_000 * 3); // DELIVERY_MAX_ATTEMPTS (3) redeliveries
    expect(send).toHaveBeenCalledTimes(4); // initial + 3
    expect(entry('c1', 'Ldefault')?.deliveryFailed).toBeFalsy();
    vi.advanceTimersByTime(8_000); // budget exhausted at the default timeout
    expect(entry('c1', 'Ldefault')?.deliveryFailed).toBe(true);
  });

  it('onTimeout is a no-op if the entry is no longer pending (e.g. reset() ran first)', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send, timeoutMs: 8000, maxAttempts: 3 });
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'Lgone');
    t.submit('c1', 'hi', 'Lgone');
    t.reset();
    expect(() => vi.advanceTimersByTime(8000)).not.toThrow();
    expect(send).toHaveBeenCalledTimes(1); // only the initial submit send
  });

  it('onTimeout guards directly against an entry that was never (or no longer) tracked', () => {
    // reset()/resolve()/fail() all cancel the pending setTimeout when they
    // remove an entry, so the timer callback can never itself fire late for
    // a removed entry through the normal scheduling path — call the private
    // handler directly with a fabricated, untracked entry to pin the guard.
    const send = vi.fn();
    const t = new DeliveryTracker({ send });
    expect(() =>
      (t as unknown as { onTimeout(e: unknown): void }).onTimeout({
        chatId: 'c1',
        localId: 'never-tracked',
        message: 'x',
        attempts: 0,
        timer: null,
      }),
    ).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('submit() is idempotent for an already-pending localId (no duplicate send)', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send });
    useChatStore.getState().appendLocalUserMessage('c1', 'hi', 'Ldup');
    t.submit('c1', 'hi', 'Ldup');
    t.submit('c1', 'hi', 'Ldup'); // duplicate — same chatId+localId
    expect(send).toHaveBeenCalledTimes(1);
    expect(t.size()).toBe(1);
  });

  it('resolve() (via observe) on an unknown localId is a no-op', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send });
    expect(() =>
      t.observe({ type: 'chat.input_ack', chatId: 'c1', localId: 'never-submitted' }),
    ).not.toThrow();
  });

  it('retry() on an unknown localId is a no-op', () => {
    const send = vi.fn();
    const t = new DeliveryTracker({ send });
    expect(() => t.retry('c1', 'never-submitted')).not.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
