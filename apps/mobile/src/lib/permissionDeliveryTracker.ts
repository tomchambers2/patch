// Guaranteed permission/question-answer delivery — companion to
// deliveryTracker.ts's guaranteed input delivery (spec/12), for the OTHER
// direction of traffic that used to be fire-and-forget. Mirrors
// packages/web/src/lib/permissionDeliveryTracker.ts.
//
// Tom, Todoist: "questions are timing out after I answer them". A phone
// answering a question is the worst case for this: the tap usually happens
// moments after the app is foregrounded from a push notification, exactly
// when the socket is most likely to be mid-reconnect or still reporting a
// stale OPEN readyState for a link that is actually dead. That send was
// previously fire-and-forget — `getWs().send(...)` straight from the
// question card's onAnswer, with nothing to notice a drop — so a tap could
// look answered (the card resolves optimistically) while the host never
// heard it, and its own `armAnswerExpiry` timer denied the request as
// expired anyway. This tracker holds every outgoing permission response
// PENDING until it OBSERVES the host's `chat.permission_response` echo for
// the same requestId (sent for a real expiry too — see `ack`), and
// redelivers on a fixed interval while connected, and immediately on
// reconnect. The host dedups a duplicate resolve.
//
// Deliberately invisible to the UI, unlike `deliveryTracker.ts`: the card is
// already resolved optimistically the instant the user taps, and there is no
// further state for this to move it to.

import type { WireEvent } from '@patch/wire';
import { usePresenceStore } from '../stores/presenceStore';
import { getWs } from '../api/ws';

/** How often an unacked response is resent while the link looks up. */
export const PERMISSION_DELIVERY_RETRY_MS = 5_000;

interface PendingResponse {
  requestId: string;
  event: WireEvent;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface PermissionDeliveryTrackerDeps {
  /** Send an event. Defaults to the module-level WS singleton. */
  send?: (event: WireEvent) => void;
  retryMs?: number;
}

export class PermissionDeliveryTracker {
  private readonly pending = new Map<string, PendingResponse>();

  constructor(private readonly deps: PermissionDeliveryTrackerDeps = {}) {}

  private get retryMs(): number {
    return this.deps.retryMs ?? PERMISSION_DELIVERY_RETRY_MS;
  }

  private doSend(entry: PendingResponse, sendOverride?: (event: WireEvent) => void): void {
    const send =
      sendOverride ??
      this.deps.send ??
      ((event: WireEvent) => {
        getWs().send(event);
      });
    try {
      send(entry.event);
    } catch {
      // Not connected right now — held pending; onReconnect / the timer retries.
    }
  }

  private arm(entry: PendingResponse): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.onTimeout(entry), this.retryMs);
  }

  private onTimeout(entry: PendingResponse): void {
    if (!this.pending.has(entry.requestId)) return;
    const { connection, daemon } = usePresenceStore.getState();
    if (connection !== 'connected' || daemon !== 'online') {
      this.arm(entry);
      return;
    }
    this.doSend(entry);
    this.arm(entry);
  }

  /**
   * Submit a permission/question response: send it now and hold it pending
   * until `ack`. `event` must carry the `requestId` the host will echo
   * back.
   */
  send(event: WireEvent & { requestId: string }, send?: (event: WireEvent) => void): void {
    const entry: PendingResponse = { requestId: event.requestId, event, timer: null };
    this.pending.set(event.requestId, entry);
    this.doSend(entry, send);
    this.arm(entry);
  }

  /**
   * The host's `chat.permission_response` echo landed for this requestId —
   * delivered, whatever the outcome. Wired into the WS dispatcher.
   */
  ack(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(requestId);
  }

  /** The link just came back — redeliver every still-pending response now. */
  onReconnect(): void {
    for (const entry of this.pending.values()) {
      this.doSend(entry);
      this.arm(entry);
    }
  }

  /** Number of still-pending responses (tests / introspection). */
  size(): number {
    return this.pending.size;
  }

  /** Drop all timers + tracked responses (on WS close / teardown). No leaks. */
  reset(): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.pending.clear();
  }
}

/** Process-wide tracker wired to the active WS. */
export const permissionDeliveryTracker = new PermissionDeliveryTracker();
