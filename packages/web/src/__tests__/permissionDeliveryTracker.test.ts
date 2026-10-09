// Unit tests for the surface-side guaranteed permission/question-answer
// delivery tracker (companion to deliveryTracker.test.ts). Drives
// pending → ack / timeout-redelivery / reconnect with mock timers.
//
// Tom, Todoist: "questions are timing out after I answer them" — these cover
// the exact hole that produced it: a `chat.permission_response` sent down a
// socket that silently drops it (readyState lags a dead link) stays pending
// and gets resent, rather than being lost with no trace until the host's
// own expiry timer denies the request out from under an answer that was
// actually given.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WireEvent } from '@patch/wire';
import {
  PermissionDeliveryTracker,
  UNDELIVERED_MESSAGE,
  DELIVERED_MESSAGE,
} from '../lib/permissionDeliveryTracker.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';

describe('PermissionDeliveryTracker', () => {
  beforeEach(() => {
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    useUiStore.getState().clearToasts();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('sends immediately on submit and clears on the matching ack', () => {
    const send = vi.fn();
    const t = new PermissionDeliveryTracker({ send });
    t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.permission_response', requestId: 'req-1' }),
    );
    expect(t.size()).toBe(1);

    t.ack('req-1');
    expect(t.size()).toBe(0);
  });

  it('an ack for a different requestId does not clear an unrelated pending response', () => {
    const send = vi.fn();
    const t = new PermissionDeliveryTracker({ send });
    t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true });
    t.ack('req-other');
    expect(t.size()).toBe(1);
  });

  it('an unacked response is redelivered on a fixed interval while connected', () => {
    const send = vi.fn();
    const t = new PermissionDeliveryTracker({ send, retryMs: 5_000 });
    t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true });
    expect(send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);
    expect(send).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5_000);
    expect(send).toHaveBeenCalledTimes(3);

    // Acking stops further redelivery.
    t.ack('req-1');
    vi.advanceTimersByTime(20_000);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('a send that throws (not connected) is swallowed and still redelivers on the next tick', () => {
    const send = vi.fn(() => {
      throw new Error('not connected');
    });
    const t = new PermissionDeliveryTracker({ send, retryMs: 5_000 });
    // Must not throw out of `send` — the caller's optimistic UI update runs
    // unconditionally right after this call.
    expect(() =>
      t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true }),
    ).not.toThrow();
    expect(t.size()).toBe(1);

    vi.advanceTimersByTime(5_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not burn a redelivery while the link/daemon is known to be down; catches up once back', () => {
    const send = vi.fn();
    const t = new PermissionDeliveryTracker({ send, retryMs: 5_000 });
    t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true });
    expect(send).toHaveBeenCalledTimes(1);

    usePresenceStore.getState().setConnection('reconnecting');
    vi.advanceTimersByTime(20_000);
    // No redelivery attempted while disconnected.
    expect(send).toHaveBeenCalledTimes(1);

    usePresenceStore.getState().setConnection('connected');
    vi.advanceTimersByTime(5_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('onReconnect immediately redelivers every still-pending response', () => {
    const send = vi.fn();
    const t = new PermissionDeliveryTracker({ send, retryMs: 30_000 });
    t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true });
    t.send({ type: 'chat.permission_response', requestId: 'req-2', approve: false });
    expect(send).toHaveBeenCalledTimes(2);

    t.onReconnect();
    expect(send).toHaveBeenCalledTimes(4);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-1' }));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-2' }));
  });

  it('reset drops every pending response and its timer (no leaked redelivery)', () => {
    const send = vi.fn();
    const t = new PermissionDeliveryTracker({ send, retryMs: 5_000 });
    t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true });
    t.reset();
    expect(t.size()).toBe(0);

    vi.advanceTimersByTime(60_000);
    expect(send).toHaveBeenCalledTimes(1); // the original send only
  });

  it('a duplicate ack (or one after reset) is a harmless no-op', () => {
    const send = vi.fn();
    const t = new PermissionDeliveryTracker({ send });
    t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true });
    t.ack('req-1');
    expect(() => t.ack('req-1')).not.toThrow();
    expect(t.size()).toBe(0);
  });

  // The failure Tom actually hit: the card greys out as though answered, the
  // tracker retries into the void, and NOTHING says the daemon never heard it.
  // An answer that does not land must not be indistinguishable from one that
  // did (CLAUDE.md: no fallback — if something doesn't work we need to know).
  describe('an answer that is not getting through says so', () => {
    const toasts = () => useUiStore.getState().errors;
    const messages = () => toasts().map((t) => t.message);

    it('stays silent while delivery is still plausibly in flight', () => {
      const t = new PermissionDeliveryTracker({ send: vi.fn(), retryMs: 5_000 });
      t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true });

      vi.advanceTimersByTime(15_000);
      expect(messages()).not.toContain(UNDELIVERED_MESSAGE);
    });

    it('warns once the response has gone unacked past the threshold', () => {
      const t = new PermissionDeliveryTracker({ send: vi.fn(), retryMs: 5_000 });
      t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true });

      vi.advanceTimersByTime(25_000);
      expect(messages()).toContain(UNDELIVERED_MESSAGE);
    });

    it('warns only once, however long it stays stuck', () => {
      // Counted at the call, not by surviving toasts: they auto-dismiss, so a
      // count of what is still on screen after five minutes is always zero.
      const pushError = vi.spyOn(useUiStore.getState(), 'pushError');
      const t = new PermissionDeliveryTracker({ send: vi.fn(), retryMs: 5_000 });
      t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true });

      vi.advanceTimersByTime(5 * 60_000);
      expect(pushError.mock.calls.filter(([m]) => m === UNDELIVERED_MESSAGE)).toHaveLength(1);
      pushError.mockRestore();
    });

    it('warns even while the link is down — that is exactly when it looks ignored', () => {
      const t = new PermissionDeliveryTracker({ send: vi.fn(), retryMs: 5_000 });
      t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true });
      usePresenceStore.getState().setConnection('reconnecting');

      vi.advanceTimersByTime(25_000);
      expect(messages()).toContain(UNDELIVERED_MESSAGE);
    });

    it('the warning offers a retry that re-sends the same response', () => {
      const send = vi.fn();
      const t = new PermissionDeliveryTracker({ send, retryMs: 5_000 });
      t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true });
      vi.advanceTimersByTime(25_000);

      const warning = toasts().find((e) => e.message === UNDELIVERED_MESSAGE);
      expect(warning?.retry).toBeTypeOf('function');
      const before = send.mock.calls.length;
      warning?.retry?.();
      expect(send).toHaveBeenCalledTimes(before + 1);
      expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: 'req-1' }));
    });

    it('confirms when a previously-stuck answer finally lands', () => {
      const t = new PermissionDeliveryTracker({ send: vi.fn(), retryMs: 5_000 });
      t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true });
      vi.advanceTimersByTime(25_000);
      expect(messages()).toContain(UNDELIVERED_MESSAGE);

      t.ack('req-1');
      expect(messages()).toContain(DELIVERED_MESSAGE);
    });

    it('an answer that was never in doubt lands silently, as before', () => {
      const t = new PermissionDeliveryTracker({ send: vi.fn(), retryMs: 5_000 });
      t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true });
      t.ack('req-1');

      expect(messages()).not.toContain(DELIVERED_MESSAGE);
      expect(messages()).not.toContain(UNDELIVERED_MESSAGE);
    });
  });

  // The root cause behind chat 01M4AWWG59CJCE8DTBK903WCX7: the patch SERVER
  // was redeployed (0.1.1507 at 10:12:19) and restarted again at 10:30:46,
  // both inside the window the question was answered in. The desktop app loads
  // its bundle from that server, so the renderer reloaded and took the
  // in-memory pending map with it — the answer was gone with no trace, no
  // retry possible, and no warning, because the code that would warn had been
  // torn down too.
  describe('an unacked answer survives the surface being reloaded', () => {
    const KEY = 'patch.test.permission-responses';
    const read = () => JSON.parse(window.localStorage.getItem(KEY) ?? '{}');

    beforeEach(() => window.localStorage.removeItem(KEY));

    it('persists a response the moment it is submitted, before the send is attempted', () => {
      const send = vi.fn(() => {
        // Even a send that dies on the way out must already be recorded.
        throw new Error('not connected');
      });
      const t = new PermissionDeliveryTracker({ send, storageKey: KEY });
      t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true });

      expect(Object.keys(read())).toEqual(['req-1']);
    });

    it('a fresh tracker re-arms what the previous page life left unacked', () => {
      const first = new PermissionDeliveryTracker({ send: vi.fn(), storageKey: KEY });
      first.send({
        type: 'chat.permission_response',
        requestId: 'req-1',
        approve: true,
        decision: 'approve_with_edits',
        editedNewString: JSON.stringify({ 'Pick one': 'A' }),
      });
      first.reset(); // the reload: timers and memory gone

      const send = vi.fn();
      const revived = new PermissionDeliveryTracker({ send, retryMs: 5_000, storageKey: KEY });
      revived.restore();
      expect(revived.size()).toBe(1);

      // Nothing is sent at restore time; the first live tick delivers it,
      // payload intact.
      expect(send).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5_000);
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: 'req-1',
          decision: 'approve_with_edits',
          editedNewString: JSON.stringify({ 'Pick one': 'A' }),
        }),
      );
    });

    it('teardown does not discard the persisted answer — that is when it matters most', () => {
      const t = new PermissionDeliveryTracker({ send: vi.fn(), storageKey: KEY });
      t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true });
      t.reset();

      expect(Object.keys(read())).toEqual(['req-1']);
    });

    it('an acked response is dropped from storage, so it is never replayed', () => {
      const t = new PermissionDeliveryTracker({ send: vi.fn(), storageKey: KEY });
      t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true });
      t.ack('req-1');

      expect(read()).toEqual({});
      const revived = new PermissionDeliveryTracker({ send: vi.fn(), storageKey: KEY });
      revived.restore();
      expect(revived.size()).toBe(0);
    });

    it('a restored answer that is still stuck warns, having already outlived the threshold', () => {
      const t = new PermissionDeliveryTracker({ send: vi.fn(), storageKey: KEY });
      t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true });
      t.reset();

      const revived = new PermissionDeliveryTracker({
        send: vi.fn(),
        retryMs: 5_000,
        storageKey: KEY,
      });
      revived.restore();
      vi.advanceTimersByTime(25_000);

      expect(useUiStore.getState().errors.map((e) => e.message)).toContain(UNDELIVERED_MESSAGE);
    });

    it('drops a stale entry rather than replaying an answer from an hour ago', () => {
      let clock = 1_000_000;
      const t = new PermissionDeliveryTracker({
        send: vi.fn(),
        storageKey: KEY,
        now: () => clock,
      });
      t.send({ type: 'chat.permission_response', requestId: 'req-old', approve: true });

      clock += 2 * 60 * 60 * 1000; // two hours later
      const revived = new PermissionDeliveryTracker({
        send: vi.fn(),
        storageKey: KEY,
        now: () => clock,
      });
      revived.restore();

      expect(revived.size()).toBe(0);
      expect(read()).toEqual({});
    });

    it('a corrupt store yields nothing, never a guessed-at response', () => {
      window.localStorage.setItem(KEY, 'not json at all');
      const revived = new PermissionDeliveryTracker({ send: vi.fn(), storageKey: KEY });
      expect(() => revived.restore()).not.toThrow();
      expect(revived.size()).toBe(0);
    });

    it('an ad-hoc tracker persists nothing, so it cannot stomp the real key', () => {
      const t = new PermissionDeliveryTracker({ send: vi.fn() });
      t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true });
      expect(window.localStorage.getItem(KEY)).toBeNull();
    });
  });

  it('carries an AskUserQuestion answer payload (approve_with_edits) through unchanged', () => {
    const send = vi.fn();
    const t = new PermissionDeliveryTracker({ send });
    const event: WireEvent & { requestId: string } = {
      type: 'chat.permission_response',
      requestId: 'req-q1',
      approve: true,
      decision: 'approve_with_edits',
      editedNewString: JSON.stringify({ 'Pick one': 'A' }),
    };
    t.send(event);
    expect(send).toHaveBeenCalledWith(event);
  });
});
