// Guaranteed input delivery for the mobile surface (spec/12 § Guaranteed input
// delivery). Mirrors packages/web/src/lib/deliveryTracker.ts: every outgoing
// `chat.input` is held PENDING until the surface OBSERVES it take effect
// (chat.input_ack / chat.queued / running / assistant reply / error), and is
// REDELIVERED (same localId — the host dedups) if it stays unacked while the
// link + host are up. After a few unanswered attempts it flips to
// "not delivered — tap to retry". A turn NEVER hangs as a silent spinner.
//
// Delivery-pending (was my input received?) is kept strictly separate from the
// type-ahead `chat.queued` (parked behind a running turn).

import type { AttachmentRef, WireEvent } from '@patch/wire';
import { useChatStore } from '../stores/chatStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useUiStore } from '../stores/uiStore';
import { getWs } from '../api/ws';

export const DELIVERY_TIMEOUT_MS = 8_000;
export const DELIVERY_MAX_ATTEMPTS = 3;

interface PendingInput {
  chatId: string;
  localId: string;
  message: string;
  attachments?: AttachmentRef[];
  /**
   * The per-chat Tools panel OFF set captured AT SEND TIME (the setting is
   * live, so the turn is gated by what was off when the user hit send). Rides
   * the `chat.input`; redeliveries reuse the captured set so a retry gates
   * identically. Absent/empty ⇒ every tool available. Mirrors web's
   * deliveryTracker.ts.
   */
  disabledTools?: string[];
  attempts: number;
  /** The link has been re-dialled once for this input (see onTimeout). */
  probed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface DeliveryTrackerDeps {
  send?: (event: WireEvent) => void;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Re-dial the socket; default `getWs().reconnectNow()`. */
  reconnect?: () => void;
}

export class DeliveryTracker {
  private readonly pending = new Map<string, PendingInput>();

  constructor(private readonly deps: DeliveryTrackerDeps = {}) {}

  private key(chatId: string, localId: string): string {
    return `${chatId} ${localId}`;
  }
  private get timeoutMs(): number {
    return this.deps.timeoutMs ?? DELIVERY_TIMEOUT_MS;
  }
  private get maxAttempts(): number {
    return this.deps.maxAttempts ?? DELIVERY_MAX_ATTEMPTS;
  }

  private doSend(entry: PendingInput, sendOverride?: (event: WireEvent) => void): void {
    const send =
      sendOverride ??
      this.deps.send ??
      ((event: WireEvent) => {
        getWs().send(event);
      });
    try {
      send({
        type: 'chat.input',
        chatId: entry.chatId,
        message: entry.message,
        localId: entry.localId,
        ...(entry.attachments && entry.attachments.length > 0
          ? { attachments: entry.attachments }
          : {}),
        ...(entry.disabledTools && entry.disabledTools.length > 0
          ? { disabledTools: entry.disabledTools }
          : {}),
      });
    } catch {
      // Not connected right now — held pending; onReconnect / the timer retries.
    }
  }

  private arm(entry: PendingInput): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.onTimeout(entry), this.timeoutMs);
  }

  private onTimeout(entry: PendingInput): void {
    if (!this.pending.has(this.key(entry.chatId, entry.localId))) return;
    const { connection, daemon } = usePresenceStore.getState();
    // WS down OR host not online → the input is legitimately queued and
    // flushes on reconnect. Keep waiting, do not escalate or burn an attempt.
    if (connection !== 'connected' || daemon !== 'online') {
      this.arm(entry);
      return;
    }
    if (entry.attempts >= this.maxAttempts) {
      this.fail(entry);
      return;
    }
    entry.attempts += 1;
    this.doSend(entry);
    this.arm(entry);
    // A socket can go half-open (phone slept, wifi↔cell handover): it still
    // reads OPEN, swallows the frame, and the OS takes minutes to notice — so
    // a send looks like it "takes ages" and then fails. The first unanswered
    // attempt re-dials the link once; the reconnect redelivers on the fresh
    // socket (onReconnect).
    if (!entry.probed) {
      entry.probed = true;
      try {
        (this.deps.reconnect ?? (() => getWs().reconnectNow()))();
      } catch (e) {
        useUiStore.getState().pushError(`reconnect failed: ${(e as Error).message}`);
      }
    }
  }

  private fail(entry: PendingInput): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    useChatStore.getState().failDelivery(entry.chatId, entry.localId);
  }

  submit(
    chatId: string,
    message: string,
    localId: string,
    attachments?: AttachmentRef[],
    send?: (event: WireEvent) => void,
    disabledTools?: string[],
  ): void {
    const key = this.key(chatId, localId);
    if (this.pending.has(key)) return;
    const entry: PendingInput = {
      chatId,
      localId,
      message,
      attachments,
      ...(disabledTools && disabledTools.length > 0 ? { disabledTools } : {}),
      attempts: 0,
      probed: false,
      timer: null,
    };
    this.pending.set(key, entry);
    this.doSend(entry, send);
    this.arm(entry);
  }

  private resolve(chatId: string, localId: string): void {
    const key = this.key(chatId, localId);
    const entry = this.pending.get(key);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(key);
    useChatStore.getState().clearDelivery(chatId, localId);
  }

  private resolveChat(chatId: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.chatId === chatId) this.resolve(entry.chatId, entry.localId);
    }
  }

  observe(event: WireEvent): void {
    switch (event.type) {
      case 'chat.input_ack':
      case 'chat.queued':
        this.resolve(event.chatId, event.localId);
        return;
      case 'chat.error':
        this.resolveChat(event.chatId);
        return;
      case 'chat.message':
        if (event.role === 'assistant') this.resolveChat(event.chatId);
        return;
      case 'chat.state':
        if (event.activity === 'running') this.resolveChat(event.chatId);
        return;
      default:
        return;
    }
  }

  /**
   * Manual "tap to retry" after a failure. Chat-wide, not message-wide: also
   * re-sends every OTHER still-pending input in the same chat submitted
   * BEFORE this one (spec/12 § Guaranteed input delivery), so one tap
   * un-sticks the whole backlog. `this.pending` is a Map, so iterating it
   * yields entries in submission order; stopping at the tapped entry
   * naturally excludes anything submitted after it.
   */
  retry(chatId: string, localId: string): void {
    const target = this.pending.get(this.key(chatId, localId));
    if (!target) return;
    for (const entry of this.pending.values()) {
      if (entry.chatId !== chatId) continue;
      entry.attempts = 0;
      useChatStore.getState().retryDelivery(entry.chatId, entry.localId);
      this.doSend(entry);
      this.arm(entry);
      if (entry === target) break;
    }
  }

  onReconnect(): void {
    for (const entry of this.pending.values()) {
      entry.attempts = 0;
      useChatStore.getState().retryDelivery(entry.chatId, entry.localId);
      this.doSend(entry);
      this.arm(entry);
    }
  }

  size(): number {
    return this.pending.size;
  }

  reset(): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.pending.clear();
  }
}

/** Process-wide tracker wired to the active WS. */
export const deliveryTracker = new DeliveryTracker();
