// Mobile guaranteed permission/question-answer delivery tracker. Mirrors
// packages/web/src/__tests__/permissionDeliveryTracker.test.ts.
//
// Tom, Todoist: "questions are timing out after I answer them" — a phone
// answering a question is the worst case for this: the tap usually happens
// moments after the app is foregrounded from a push notification, exactly
// when the socket is most likely to be mid-reconnect. These cover the exact
// hole: a `chat.permission_response` sent down a socket that silently drops
// it stays pending and gets resent, rather than being lost with no trace.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { PermissionDeliveryTracker } from '../src/lib/permissionDeliveryTracker';
import { usePresenceStore } from '../src/stores/presenceStore';

describe('mobile PermissionDeliveryTracker', () => {
  beforeEach(() => {
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setDaemon('online');
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
    expect(t.size()).toBe(1);

    t.ack('req-1');
    expect(t.size()).toBe(0);
  });

  it('an unacked response is redelivered on a fixed interval while connected', () => {
    const send = vi.fn();
    const t = new PermissionDeliveryTracker({ send, retryMs: 5_000 });
    t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true });
    expect(send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);
    expect(send).toHaveBeenCalledTimes(2);

    t.ack('req-1');
    vi.advanceTimersByTime(20_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('a send that throws (not connected) is swallowed and still redelivers on the next tick', () => {
    const send = vi.fn(() => {
      throw new Error('PatchWs: not connected');
    });
    const t = new PermissionDeliveryTracker({ send, retryMs: 5_000 });
    expect(() =>
      t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true }),
    ).not.toThrow();
    expect(t.size()).toBe(1);

    vi.advanceTimersByTime(5_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('does not burn a redelivery while the host is known to be offline; catches up once back', () => {
    const send = vi.fn();
    const t = new PermissionDeliveryTracker({ send, retryMs: 5_000 });
    t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true });

    usePresenceStore.getState().setDaemon('offline');
    vi.advanceTimersByTime(20_000);
    expect(send).toHaveBeenCalledTimes(1);

    usePresenceStore.getState().setDaemon('online');
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
  });

  it('reset drops every pending response and its timer (no leaked redelivery)', () => {
    const send = vi.fn();
    const t = new PermissionDeliveryTracker({ send, retryMs: 5_000 });
    t.send({ type: 'chat.permission_response', requestId: 'req-1', approve: true });
    t.reset();
    expect(t.size()).toBe(0);

    vi.advanceTimersByTime(60_000);
    expect(send).toHaveBeenCalledTimes(1);
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
