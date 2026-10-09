// Guaranteed permission/question-answer delivery — companion to
// deliveryTracker.ts's guaranteed input delivery (spec/12), for the OTHER
// direction of traffic that used to be fire-and-forget.
//
// Tom, Todoist: "questions are timing out after I answer them". A
// `chat.permission_response` sent down a socket whose `readyState` still
// reports OPEN but is actually dead (the zombie-link window ws.ts's heartbeat
// exists to close — up to 30s before it forces a reconnect) is simply lost:
// nothing on the wire says it failed, the tap already resolved the card
// optimistically (`resolvePermission`), and the host's own
// `armAnswerExpiry` timer keeps running regardless — so an answered question
// can still expire, and the expiry echo later overwrites the optimistic
// "answered" state with "expired". This tracker holds every outgoing
// permission response PENDING until it OBSERVES the host's
// `chat.permission_response` echo for the same requestId (sent whether the
// request was answered OR expired, so a request that expired for real still
// clears itself out here — see `ack`), and redelivers on a fixed interval
// while connected, and immediately on reconnect. The host dedups a
// duplicate resolve, so a redelivery of an already-landed answer is a no-op.
//
// Invisible to the UI WHILE IT IS WORKING: the card is already resolved
// optimistically the instant the user taps, and a redelivery that lands needs
// no announcement. But silence was the whole failure mode when it does NOT
// land — the card greys out as though answered, the tracker retries into the
// void forever, and nothing on screen or in any log distinguishes an answer
// the daemon acted on from one it never received. Tom: "it submits, goes grey,
// then nothing." A pending response that stays unacked past
// `PERMISSION_DELIVERY_WARN_AFTER_MS` therefore says so, with a retry, and
// says so again when it finally gets through — otherwise the optimistic
// resolve is exactly the silent-failure fallback CLAUDE.md forbids.
//
// PERSISTED, because in-memory retry cannot survive the thing that actually
// breaks it. Forensics on chat 01M4AWWG59CJCE8DTBK903WCX7: a question was
// asked at 10:04:52 and the patch SERVER — the relay between surface and
// daemon — was redeployed at 10:12:19 (0.1.1507) and restarted again at
// 10:30:46, both inside the window Tom answered in. The desktop app loads its
// bundle from that server, so a deploy drops the link and reloads the
// renderer; the pending map went with it, and the answer was gone with no
// trace on any machine, no retry possible, and nothing to warn about because
// the code that would warn had been torn down too. A surface is therefore the
// source of truth for an unacked answer ACROSS RELOADS, not merely across
// socket blips: entries are written to localStorage and re-armed on startup.
// The daemon dedups, and a response for a request that no longer exists is a
// logged no-op there, so a late redelivery is safe.

import type { WireEvent } from '@patch/wire';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { getActiveWs } from '../api/ws.js';

/** How often an unacked response is resent while the link looks up. */
export const PERMISSION_DELIVERY_RETRY_MS = 5_000;

/**
 * How long a response may go unacknowledged before the user is told. Several
 * retry intervals, so an ordinary reconnect blip — which the tracker recovers
 * from on its own within one or two ticks — never raises anything.
 */
export const PERMISSION_DELIVERY_WARN_AFTER_MS = 20_000;

export const UNDELIVERED_MESSAGE = 'Your answer hasn’t reached the agent yet — still retrying.';
export const DELIVERED_MESSAGE = 'Your answer reached the agent.';

interface PendingResponse {
  requestId: string;
  event: WireEvent;
  timer: ReturnType<typeof setTimeout> | null;
  /** When it was first submitted — what the warning threshold measures from. */
  firstSentAt: number;
  /** Whether the user has been told this one is not getting through. */
  warned: boolean;
}

/** localStorage key for the process-wide tracker's unacked responses. */
export const PERMISSION_DELIVERY_STORAGE_KEY = 'patch.permission-responses.v1';

/**
 * How long a persisted response is still worth redelivering. Past this the
 * turn it belonged to is long gone, and replaying it would at best be a no-op
 * on the daemon; keeping it would only grow the key forever.
 */
const MAX_AGE_MS = 60 * 60 * 1000;

export interface PermissionDeliveryTrackerDeps {
  /** Send an event. Defaults to the module-level active WS. */
  send?: (event: WireEvent) => void;
  retryMs?: number;
  warnAfterMs?: number;
  /** Clock seam for tests. */
  now?: () => number;
  /**
   * Where to persist unacked responses. The process-wide instance sets this;
   * ad-hoc instances (tests) default to no persistence, so they cannot stomp
   * each other or the real key through a shared store.
   */
  storageKey?: string | undefined;
}

export class PermissionDeliveryTracker {
  private readonly pending = new Map<string, PendingResponse>();

  constructor(private readonly deps: PermissionDeliveryTrackerDeps = {}) {}

  private get retryMs(): number {
    return this.deps.retryMs ?? PERMISSION_DELIVERY_RETRY_MS;
  }

  private get warnAfterMs(): number {
    return this.deps.warnAfterMs ?? PERMISSION_DELIVERY_WARN_AFTER_MS;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /**
   * Write the unacked set through. Best-effort and deliberately quiet: the
   * response is still in memory and still being retried, so a storage failure
   * costs only the across-reload guarantee, and a toast per keystroke-free
   * background write would be noise on top of whatever already went wrong.
   */
  private persist(): void {
    const key = this.deps.storageKey;
    if (key === undefined) return;
    try {
      const out: Record<string, { event: WireEvent; firstSentAt: number }> = {};
      for (const [requestId, entry] of this.pending) {
        out[requestId] = { event: entry.event, firstSentAt: entry.firstSentAt };
      }
      window.localStorage.setItem(key, JSON.stringify(out));
    } catch {
      // Held in memory regardless; nothing further this can honestly do.
    }
  }

  /**
   * Re-arm everything a previous page life left unacked. Called once at
   * startup. Nothing is SENT here — `arm` schedules the first attempt, and
   * `onTimeout` only fires it once the link and a host are actually up, which
   * at startup they are not yet.
   *
   * NO FALLBACK: an unreadable or malformed entry is dropped, never guessed
   * at — redelivering a mangled answer is worse than redelivering none.
   */
  restore(): void {
    const key = this.deps.storageKey;
    if (key === undefined) return;
    let raw: string | null;
    try {
      raw = window.localStorage.getItem(key);
    } catch {
      return;
    }
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
    const now = this.now();
    for (const [requestId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const v = value as { event?: unknown; firstSentAt?: unknown };
      if (typeof v.firstSentAt !== 'number' || now - v.firstSentAt > MAX_AGE_MS) continue;
      if (typeof v.event !== 'object' || v.event === null) continue;
      if (this.pending.has(requestId)) continue;
      const entry: PendingResponse = {
        requestId,
        event: v.event as WireEvent,
        timer: null,
        firstSentAt: v.firstSentAt,
        // Already past the threshold on a restored entry, so the user is told
        // on the first tick — which is right: an answer that survived a reload
        // unacked is exactly the one that needs saying out loud.
        warned: false,
      };
      this.pending.set(requestId, entry);
      this.arm(entry);
    }
    this.persist();
  }

  /**
   * Tell the user ONCE that this answer has not got through, and give them a
   * send-it-again. Raised whether or not we are currently able to retry: a
   * link that has been down for twenty seconds is precisely when the agent
   * looks like it is ignoring an answer that was given.
   */
  private maybeWarn(entry: PendingResponse): void {
    if (entry.warned) return;
    if (this.now() - entry.firstSentAt < this.warnAfterMs) return;
    entry.warned = true;
    useUiStore.getState().pushError(UNDELIVERED_MESSAGE, () => this.doSend(entry));
  }

  /**
   * Best-effort: if the socket isn't there we simply keep the entry pending —
   * the timer / reconnect path re-sends. Mirrors `deliveryTracker.ts`'s
   * `doSend`.
   */
  private doSend(entry: PendingResponse, sendOverride?: (event: WireEvent) => void): void {
    // Initial send prefers the caller's socket (the route's `ws` prop);
    // retries always resolve the LIVE active socket, since the one that
    // carried the first send may be gone by then.
    const send =
      sendOverride ??
      this.deps.send ??
      ((event: WireEvent) => {
        const ws = getActiveWs();
        if (!ws) throw new Error('no active ws');
        ws.send(event);
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
    this.maybeWarn(entry);
    const { connection, daemonOnline } = usePresenceStore.getState();
    // Our own link is down, or the host is knowingly offline: wait rather
    // than burn a redelivery into a socket we already know is no good.
    if (connection !== 'connected' || !daemonOnline) {
      this.arm(entry);
      return;
    }
    this.doSend(entry);
    this.arm(entry);
  }

  /**
   * Submit a permission/question response: send it now and hold it pending
   * until `ack`. `event` must carry the `requestId` the host will echo
   * back. `send` is the caller's socket for the initial send (retries
   * resolve the live active socket).
   */
  send(event: WireEvent & { requestId: string }, send?: (event: WireEvent) => void): void {
    const entry: PendingResponse = {
      requestId: event.requestId,
      event,
      timer: null,
      firstSentAt: this.now(),
      warned: false,
    };
    this.pending.set(event.requestId, entry);
    // Persisted BEFORE the attempt: the whole point is that this survives the
    // attempt failing in ways this process never gets to observe.
    this.persist();
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
    this.persist();
    // Only if we raised the alarm: having been told the answer was stuck, the
    // user is owed the other half of that story. A response that was never
    // in doubt says nothing, as before.
    if (entry.warned) useUiStore.getState().pushNotice(DELIVERED_MESSAGE);
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

  /**
   * Drop all timers + tracked responses (on WS close / teardown). No leaks.
   *
   * Deliberately does NOT clear what is persisted: teardown is precisely the
   * moment an unacked answer must outlive this process, and wiping the store
   * here would reinstate the bug `restore` exists to close.
   */
  reset(): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.pending.clear();
  }

  /** Test seam — forget the persisted set as well as the live one. */
  _clearPersisted(): void {
    this.reset();
    const key = this.deps.storageKey;
    if (key === undefined) return;
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Nothing to clear if storage is unavailable.
    }
  }
}

/** Process-wide tracker wired to the active WS, and the only persisting one. */
export const permissionDeliveryTracker = new PermissionDeliveryTracker({
  storageKey: PERMISSION_DELIVERY_STORAGE_KEY,
});

// Pick up anything a previous page life left unacked — a reload, a crash, or
// the server deploy that reloads every connected surface underneath it.
permissionDeliveryTracker.restore();
