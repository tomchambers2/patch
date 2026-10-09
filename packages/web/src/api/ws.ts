// Browser WebSocket client. Connects to /ws on the same origin; handshake
// sends `hello` with stored bearer; reconnects with capped exponential
// backoff and replays missed events per chat via `chat.replay`.
//
// Surfaces:
//   - dispatches into chatStore / presenceStore / voiceStore
//   - exposes `send(event)` for outbound (chat.input, chat.permission_response,
//     chat.archive_request, chat.pin_request, chat.call_response, etc.)

import { CLOSE_AUTH_FAILED, decodeCompat, type WireEvent } from '@patch/wire';
import { loadCredential } from '../lib/credential.js';
import { useChatStore } from '../stores/chatStore.js';
import { saveEvents } from '../lib/transcriptCache.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { speakInterrupt } from '../lib/speakInterrupt.js';
import { useUiStore } from '../stores/uiStore.js';
import { useMeetingStore } from '../stores/meetingStore.js';
import { useTerminalStore } from '../stores/terminalStore.js';
import { useComposerDraftStore } from '../stores/composerDraftStore.js';
import { useDraftStore } from '../stores/draftStore.js';
import { getDesktopBridge } from '../lib/desktopBridge.js';
import { deliveryTracker } from '../lib/deliveryTracker.js';
import { permissionDeliveryTracker } from '../lib/permissionDeliveryTracker.js';
import { stripMarkdown } from '../lib/stripMarkdown.js';
import { onServerVersion } from '../lib/liveUpdate.js';

/**
 * Say ONCE, per distinct thing, that we ignored something from a newer sender
 * (spec/03 § Forward compatibility). `chat.state` arrives constantly, so a line
 * per frame would bury the console; the durable record is `wireCompatStats()`,
 * which the diagnostics screen reports.
 */
const compatSeen = new Set<string>();
function noteFirstSight(what: string): void {
  if (compatSeen.has(what)) return;
  compatSeen.add(what);
  console.warn(`[patch] wire: ignoring unknown ${what} — this surface is behind the host`);
}

/**
 * A frame `decodeCompat` could not tolerate at all (not "newer sender, unknown
 * field/type" — a genuine shape mismatch: bad enum, wrong type, invalid JSON).
 * That is stronger evidence of stale-bundle skew than anything `onServerVersion`
 * can see, because it fires on a live connection with no reconnect in between —
 * exactly the case `onServerVersion` (the `auth.ok` bundle-hash check) cannot
 * catch, since nothing forced this socket to reconnect and re-announce a
 * version.
 *
 * Previously this dropped the one frame and showed a dismissible toast: the
 * chat kept rendering, missing whatever that frame was, with no visible sign
 * anything was wrong beyond a banner easy to miss mid-conversation — a surface
 * silently missing content it has no way to know it's missing, which is
 * exactly what NO FALLBACK (CLAUDE.md) exists to rule out. Reload is not a
 * shot in the dark either: the surface most likely to hit this is running the
 * exact stale bundle `onServerVersion` exists to replace, so reusing that
 * reload path (not a bespoke error screen) fixes the actual cause, not just
 * the symptom.
 *
 * Guarded so a burst of bad frames before navigation actually completes can't
 * call `reload()` more than once. `deps.reload` is a test seam (default
 * `window.location.reload()`), same shape as `onServerVersion`.
 */
let reloadingOnWireMismatch = false;
function reloadOnWireMismatch(detail: string, deps: { reload?: () => void } = {}): void {
  if (reloadingOnWireMismatch) return;
  reloadingOnWireMismatch = true;
  console.error(`[patch] wire: ${detail} — reloading to pick up the current bundle`);
  (deps.reload ?? ((): void => window.location.reload()))();
}

/** Test seam: clear reload-guard state between cases. */
export function __resetWireMismatchReloadForTests(): void {
  reloadingOnWireMismatch = false;
}
import { BUILD_INFO } from '../lib/buildInfo.js';
import {
  INPUT_REPORT_INTERVAL_MS,
  listenForPageInput,
  readInputReport,
} from '../lib/inputPresence.js';

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
/** spec/05 line 71: surface emits surface.heartbeat every 10s while foregrounded. */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * How often the open chat is re-synced from its cursor while its turn is
 * running. The host records every event, but a live detail event that never
 * reaches this surface (a dropped subscription, a lost frame) is otherwise
 * never noticed: the pane freezes mid-turn with the spinner up. The replay
 * back-fills the gap and re-subscribes the socket to the chat.
 */
export const RUNNING_RESYNC_MS = 5_000;
/**
 * Zombie-socket watchdog window (patch/todo.md "Test with slow, unreliable
 * train internet"). On flaky mobile data a socket can go HALF-OPEN — TCP dies
 * silently, the browser never fires `close`, `readyState` stays OPEN — so the
 * surface would sit "connected" forever while nothing flows. The server pongs
 * every `surface.heartbeat` with a `surface.heartbeat_ack`; once we've seen one
 * ack (proving the server supports it) we treat NO inbound traffic for this
 * long as a dead link and force a reconnect. 30s = 3 missed heartbeat cycles,
 * matching the server's own stale-surface window (spec/01).
 */
export const HEARTBEAT_LIVENESS_TIMEOUT_MS = 30_000;
/**
 * How long an inbound store event is held so a burst commits once (~one frame).
 *
 * A `chat.replay` delivers a whole transcript at once — measured at 582 events
 * in 444ms on a busy chat — and a commit per event meant a re-render of the
 * whole stream per message. That is what made opening a chat fill in visibly,
 * one message at a time, with the scroll chasing the growing content all the
 * way down. Matches `apps/mobile/src/api/ws.ts`.
 */
export const STORE_BATCH_MS = 16;

export class PatchWs {
  private ws: WebSocket | null = null;
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  /** spec/09 § Presence heuristic — `surface.input` reports, hidden or not. */
  private inputTimer: number | null = null;
  private resyncTimer: number | null = null;
  private closed = false;
  private url: string;
  private visibilityHandler: (() => void) | null = null;
  /** Epoch ms of the last inbound frame — the zombie-socket watchdog input. */
  private lastInboundAt = 0;
  /** True once this socket has received a heartbeat ack (arms the watchdog). */
  private pongSupported = false;
  /**
   * The cursor each chat's last replay was asked from, ON THIS SOCKET. Cleared
   * on every new connection, so a reconnect always re-asks (a drop before any
   * events arrived must still catch up) while one connection never asks the same
   * question twice.
   */
  private readonly lastReplayCursor = new Map<string, number>();
  /** Store events gathered so far in the current batch window, in arrival order. */
  private storeQueue: WireEvent[] = [];
  private storeFlushTimer: number | null = null;

  constructor(url: string) {
    this.url = url;
  }

  connect(): void {
    this.closed = false;
    this.openOnce();
    this.attachVisibility();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.stopInputReports();
    this.stopRunningResync();
    this.detachVisibility();
    // Commit anything still inside the batch window. Dropping it would lose
    // real, already-received transcript — the queue is not a cache.
    if (this.storeFlushTimer !== null) {
      window.clearTimeout(this.storeFlushTimer);
      this.storeFlushTimer = null;
    }
    this.flushStoreQueue();
    this.ws?.close();
    this.ws = null;
    usePresenceStore.getState().setConnection('offline');
    // App teardown — drop all delivery timers so nothing leaks. (A transient
    // socket-level 'close' does NOT reset: pending inputs must survive to be
    // redelivered on reconnect.)
    deliveryTracker.reset();
    permissionDeliveryTracker.reset();
  }

  private attachVisibility(): void {
    /* v8 ignore next -- jsdom (the test environment) always defines `document`; this SSR/non-DOM guard cannot be exercised under vitest+jsdom. */
    if (typeof document === 'undefined') return;
    const handler = (): void => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (document.hidden) {
        this.safeSend({ type: 'surface.backgrounded' });
        this.stopHeartbeat();
      } else {
        this.safeSend({ type: 'surface.foregrounded' });
        this.startHeartbeat();
      }
    };
    this.visibilityHandler = handler;
    document.addEventListener('visibilitychange', handler);
  }

  private detachVisibility(): void {
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    this.visibilityHandler = null;
  }

  /**
   * Explicit foreground/background control (spec/05 ## Menu-bar surface). The
   * menu-bar tray popover is an Electron `BrowserWindow` whose `.hide()` does
   * NOT fire the renderer's `visibilitychange` (Electron only fires it on
   * occlude/minimize, not on hide), so the document-visibility path alone can't
   * stop the heartbeat when the dropdown closes — heartbeats would leak while
   * only the tray icon is visible. The desktop main process therefore drives
   * these directly from the popover's show/hide. `surface.heartbeat` then fires
   * only while the dropdown is open, exactly as spec/05 requires.
   */
  foreground(): void {
    this.safeSend({ type: 'surface.foregrounded' });
    this.startHeartbeat();
  }

  background(): void {
    this.safeSend({ type: 'surface.backgrounded' });
    this.stopHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    this.heartbeatTimer = window.setInterval(() => {
      this.safeSend({ type: 'surface.heartbeat' });
      this.checkLiveness();
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Detect a half-open ("zombie") socket. Only meaningful once we've seen a
   * heartbeat ack (`pongSupported`): from then on the server pongs every 10s,
   * so a gap in ALL inbound traffic wider than the liveness window means the
   * link is dead even though `readyState` still reports OPEN. Force a reconnect.
   */
  private checkLiveness(): void {
    if (!this.pongSupported) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastInboundAt > HEARTBEAT_LIVENESS_TIMEOUT_MS) {
      this.onZombie();
    }
  }

  /**
   * Tear down a socket the watchdog has judged dead. Stop the heartbeat and
   * close the socket — the 'close' handler then flips us to 'reconnecting' and
   * schedules the reconnect (which redelivers every still-pending input). We
   * also set 'reconnecting' up front so the amber banner shows immediately,
   * even if the underlying socket is slow to fire its own 'close'. NO FALLBACK
   * that pretends the link is alive.
   */
  /**
   * Public escape hatch for "the socket looks open but nothing is coming back".
   * The heartbeat watchdog only catches a link that has gone silent ENTIRELY;
   * it cannot catch a socket the SERVER has stopped addressing while still
   * pong'ing on it (a routing orphan). The delivery tracker calls this when an
   * input goes unanswered, so the reconnect — which re-registers this surface
   * server-side and redelivers every pending input — is tried BEFORE the user
   * is shown a failure.
   */
  forceReconnect(reason: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    console.warn(`[patch] forcing WS reconnect: ${reason}`);
    this.onZombie();
    return true;
  }

  private onZombie(): void {
    this.stopHeartbeat();
    usePresenceStore.getState().setConnection('reconnecting');
    try {
      this.ws?.close();
    } catch {
      // best-effort: closing an already-dead socket may throw; ignore.
    }
  }

  private startInputReports(): void {
    listenForPageInput();
    if (this.inputTimer !== null) return;
    const report = (): void => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      readInputReport().then(
        (event) => this.safeSend(event),
        (err: unknown) => console.error('[patch] could not read input idle time', err),
      );
    };
    report();
    this.inputTimer = window.setInterval(report, INPUT_REPORT_INTERVAL_MS);
  }

  private startRunningResync(): void {
    if (this.resyncTimer !== null) return;
    this.resyncTimer = window.setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const { activeChatId, chats } = useChatStore.getState();
      if (activeChatId === null || chats[activeChatId]?.activity !== 'running') return;
      this.lastReplayCursor.delete(activeChatId);
      this.requestReplay(activeChatId);
    }, RUNNING_RESYNC_MS);
  }

  private stopRunningResync(): void {
    if (this.resyncTimer !== null) {
      window.clearInterval(this.resyncTimer);
      this.resyncTimer = null;
    }
  }

  private stopInputReports(): void {
    if (this.inputTimer !== null) {
      window.clearInterval(this.inputTimer);
      this.inputTimer = null;
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private safeSend(event: WireEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(event));
  }

  send(event: WireEvent): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('PatchWs: not connected');
    }
    this.ws.send(JSON.stringify(event));
    // The hub reads `chatId: null` as "unsubscribe from everything": this
    // socket stops receiving every chat's detail events (the replies). The
    // replay cursors record what the hub was last ASKED, and none of those
    // subscriptions stand any more — so a re-open that lands on the same
    // cursor must be sent, not discarded as a repeat, or the chat is never
    // resubscribed and the reply that arrived while away never renders.
    if (event.type === 'chat.focus_change' && event.chatId === null) this.lastReplayCursor.clear();
  }

  /**
   * Ask for a replay of every chat whose transcript this surface is holding —
   * the chat it has open, plus any chat with a rendered timeline. Chats known
   * only as metadata rows are skipped: their transcripts load lazily on open
   * (spec/12 § Cold start loads metadata only).
   *
   * `daemonId` narrows the sweep to one host, for a host that has just come
   * back; omitted on a fresh socket, where every host is equally unknown.
   * `force` drops each swept chat's dedup cursor first — a returning host
   * usually leaves the cursor exactly where it was, so the request that heals
   * the chat would otherwise be discarded as a repeat of the one that fetched
   * the history we are now missing the tail of. Scoped to the chats being
   * swept, so one host's restart never re-asks another host's.
   */
  private replayHeldChats(daemonId?: string, force = false): void {
    const { chats, timelines, activeChatId } = useChatStore.getState();
    for (const chatId of Object.keys(chats)) {
      const row = chats[chatId];
      /* v8 ignore next -- defensive only: `chatId` is drawn from `Object.keys(chats)`, so `chats[chatId]` is always defined; this only exists to satisfy noUncheckedIndexedAccess. */
      if (row === undefined) continue;
      if (daemonId !== undefined && row.daemonId !== daemonId) continue;
      const held = chatId === activeChatId || (timelines[chatId]?.length ?? 0) > 0;
      if (!held) continue;
      if (force) this.lastReplayCursor.delete(chatId);
      this.requestReplay(chatId);
    }
  }

  /**
   * Request the host replay a chat's transcript from our current cursor.
   * Sent by a surface when it OPENS a chat, and on connect only for the chats
   * whose transcript we already hold (spec/12 § Cold start loads metadata
   * only): the connect-time loop covers neither a metadata-only roster row nor
   * a chat that first appears afterward — spawned on another
   * surface and learned about via the always-on state-level fanout — has no
   * transcript until it is replayed. The replay also subscribes this surface
   * to the chat's live detail events (spec/12 § Replay vs history cursors).
   *
   * `fromSeq` is EXCLUSIVE: only DURABLE entries count toward the cursor — an
   * optimistic outgoing message carries a `localId` + a `Date.now()`
   * placeholder seq (reconciled to its real seq on replay) and a streaming
   * assistant entry isn't persisted yet, so including either would poison the
   * cursor and skip real history. `-1` means "seen nothing" (full history);
   * `0` deliberately skips the seq-0 first user message. No-op when the socket
   * isn't open — the connect handler replays all known chats once the link is
   * up.
   *
   * `force` skips the dedup guard below. A caller that just cleared the
   * chat's timeline itself (switching tracks — `ChatRoute.tsx`'s
   * `handleSwitchTrack`) recomputes `fromSeq -1` from that now-empty
   * timeline, which collides with the cursor cached by the chat's very
   * first load (also `-1`, set before any of its history had arrived) even
   * though the active branch has since changed server-side. Without `force`
   * the guard reads that as the exact repeat it exists to drop, the request
   * never goes, and the cleared timeline never refills — the chat's history
   * looks like it went missing until a full reload re-syncs it.
   */
  requestReplay(chatId: string, opts?: { force?: boolean }): void {
    // The cursor is derived from committed store state, so anything still
    // sitting in the batch window has to land first — otherwise `fromSeq` is
    // computed against a transcript missing its most recent entries and the
    // host re-sends history we already hold. See `queueForStore`.
    this.flushStoreQueue();
    const timeline = useChatStore.getState().timelines[chatId];
    const fromSeq =
      timeline && timeline.length > 0
        ? timeline.reduce(
            (max, e) =>
              e.localId === undefined && e.streaming !== true && e.seq > max ? e.seq : max,
            -1,
          )
        : -1;
    // Don't ask twice from the same cursor. Opening a chat requests its
    // transcript, and the socket completing its connect a moment later requests
    // every held chat — the active chat included, timeline still empty. Both
    // computed `fromSeq: -1`, so the host streamed the whole transcript twice.
    // The store now folds a re-delivered turn onto its canonical seq, so this is
    // no longer a correctness fix — but a second full transcript over the wire
    // is pure waste, and the request that would produce it is the wrong one to
    // send. Keyed on the cursor: a LATER replay from a further-on cursor (a
    // genuine reconnect catch-up) is a different question and always goes.
    if (!opts?.force && this.lastReplayCursor.get(chatId) === fromSeq) return;
    // Recorded only if it actually went. A request made before the socket was
    // open is dropped by `safeSend`, and remembering THAT would suppress the
    // connect-time request that is supposed to replace it — leaving the chat
    // empty forever, which is worse than the duplicate this guard prevents.
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.lastReplayCursor.set(chatId, fromSeq);
    // A replay is the host's authoritative statement of what is still true
    // for this chat from `fromSeq` on — including whether anything is still
    // pending a decision. Clear first: a host restart wipes its in-memory
    // pendingPermissions with no wire event to say so, so a request answered
    // (or simply forgotten) before this client reconnected has no other way
    // to stop showing the indigo badge forever. `replayChat` re-emits
    // `chat.permission_request` only for what is genuinely still open, so
    // anything real re-lands within the same replay.
    useChatStore.getState().clearPendingPermissions(chatId);
    this.safeSend({ type: 'chat.replay', chatId, fromSeq, batch: true });
  }

  private openOnce(): void {
    const cred = loadCredential();
    usePresenceStore.getState().setConnection('connecting');
    // Fresh socket — the watchdog is disarmed until this connection proves the
    // server pongs (a new server across a reconnect might not support acks).
    this.pongSupported = false;
    this.lastInboundAt = Date.now();
    // A new socket has heard nothing: every held chat may need its replay again,
    // including one whose previous request died with the old connection.
    this.lastReplayCursor.clear();

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.backoff = INITIAL_BACKOFF_MS;
      this.lastInboundAt = Date.now();
      // hello with bearer (per spec/10 — auth is on the hello frame, not
      // a query param, since browsers can't set custom headers on WS).
      // Report the bundle THIS surface booted from (spec/11 § Version reporting),
      // so the server can tell a surface still running an old bundle from one
      // that's picked up the current deploy.
      const hello: WireEvent = {
        type: 'hello',
        clientType: 'surface-web',
        clientVersion: BUILD_INFO.version,
        clientGitSha: BUILD_INFO.gitSha,
        clientBuiltAt: BUILD_INFO.builtAt,
        ...(cred ? { auth: cred } : {}),
      };
      ws.send(JSON.stringify(hello));
      usePresenceStore.getState().setConnection('connected');
      // Connection forensics for the diagnostics screen (spec/12 § Connection
      // diagnostics screen): a link that has come up at least once is never
      // treated as "this surface can't connect at all".
      usePresenceStore.getState().noteWsOpen(this.url);

      // Replay missed events for every chat we know about.
      //
      // `chat.replay.fromSeq` is EXCLUSIVE (host emits seq > fromSeq) and is a
      // reconnect/dedup cursor: the highest seq we have ALREADY rendered.
      // spec/12 § "Replay vs history cursors": a surface that has seen nothing
      // must pass `-1` to get full history — `0` deliberately SKIPS seq 0 (the
      // chat's first user message). A freshly-hydrated chat (GET /api/chats
      // carries no stream state) has `lastSeq: 0` but an EMPTY timeline, so
      // replaying from `0` would silently drop the seq-0 user turn. Derive the
      // cursor from the timeline we have actually applied: the max rendered seq,
      // or `-1` when nothing has been rendered yet.
      //
      // We replay ONLY the chats whose transcript this surface is already
      // holding: the chat it has open, plus any chat with a rendered timeline.
      // spec/12 § "Cold start loads metadata only": a freshly-booted surface
      // has nothing but the `GET /api/chats` metadata snapshot, and replaying
      // every row from it cost one inbound event stream per chat — each
      // rewriting store rows and re-rendering the sidebar — for transcripts
      // nobody is looking at. Transcripts load lazily on open (ChatRoute calls
      // requestReplay), so the cold-start cost is the single metadata call.
      // Reconnect is unchanged: anything already rendered still catches up.
      this.replayHeldChats();

      // spec/12 § "Survives a server restart" — the server's in-memory
      // surface→host buffer is gone across a restart, so any input we sent
      // before the drop was never delivered. The surface is the source of truth
      // until it sees an ack: redeliver every still-pending input now that the
      // link is back (same localId; the host dedups).
      deliveryTracker.onReconnect();
      // Same reasoning for permission/question responses — see
      // permissionDeliveryTracker.ts.
      permissionDeliveryTracker.onReconnect();
    });

    ws.addEventListener('message', (msg) => {
      // Any inbound frame proves the socket is alive — feed the zombie watchdog
      // before we even decode (a malformed frame still means the link is up).
      this.lastInboundAt = Date.now();
      const data = typeof msg.data === 'string' ? msg.data : '';
      let result: ReturnType<typeof decodeCompat>;
      try {
        // `decodeCompat`, not `decode`: this surface can be OLDER than the
        // host that sent the frame — a phone that was off during a deploy, a
        // desktop shell that has not restarted — and an additive field on
        // `chat.state` must not take the sidebar and the chat view down with a
        // wall of banners (spec/03 § Forward compatibility). Everything that is
        // actually malformed still throws: NO FALLBACK applies to frames that
        // are wrong, not to frames that are newer — see `reloadOnWireMismatch`.
        result = decodeCompat(data);
      } catch (err) {
        reloadOnWireMismatch(`malformed wire event: ${(err as Error).message}`);
        return;
      }
      if (!result.ok) {
        // An event type this build has never heard of. There is nothing to do
        // with it, and one banner per frame would bury the app. It is counted
        // in `wireCompatStats()` and reported by the diagnostics screen, which
        // is where "this surface is behind the host" belongs.
        noteFirstSight(`type ${result.type}`);
        return;
      }
      for (const path of result.tolerated) noteFirstSight(`field ${path}`);
      this.dispatch(result.event);
    });

    ws.addEventListener('close', (ev) => {
      this.ws = null;
      this.stopHeartbeat();
      // Record WHY, before the early return — a close during teardown is still
      // the last thing that happened to this socket (spec/12 § Connection
      // diagnostics screen). A failed connect attempt fires 'close' too, which
      // is what makes `failedAttempts` meaningful on a surface that has never
      // reached 'open'.
      const close = ev as unknown as { code?: number; reason?: string };
      usePresenceStore.getState().noteWsClose({
        code: close.code ?? 0,
        reason: close.reason ?? '',
        at: Date.now(),
      });
      if (this.closed) return;
      // 4401 is the hub REFUSING this credential, not a link that dropped
      // (ws-hub CLOSE_AUTH_FAILED). Retrying cannot fix a refusal — it would
      // report "reconnecting" for ever while the server has already said no.
      // Announce it on the same channel a REST 401 uses, so the shell drops the
      // credential and shows sign-in with a reason, and stop dialling.
      if (close.code === CLOSE_AUTH_FAILED) {
        this.endUnauthenticated(
          close.reason && close.reason.length > 0 ? close.reason : 'invalid credential',
        );
        return;
      }
      usePresenceStore.getState().setConnection('reconnecting');
      this.scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // 'close' will follow; nothing to do here. Browsers don't expose the
      // close reason on errored sockets.
    });
  }

  /**
   * Dial immediately, abandoning the backoff wait (spec/12 § Connection
   * diagnostics screen — Retry now). Backoff resets to its first step so a
   * subsequent failure doesn't resume at the 30s ceiling.
   */
  reconnectNow(): void {
    if (this.closed) return;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.backoff = INITIAL_BACKOFF_MS;
    this.stopHeartbeat();
    const existing = this.ws;
    this.ws = null;
    try {
      existing?.close();
    } catch {
      // best-effort: closing an already-dead socket may throw; ignore.
    }
    this.openOnce();
  }

  /**
   * The server refused this surface. TERMINAL: stop dialling and announce it on
   * the channel `main.tsx` listens to, which drops the stored credential and
   * renders the sign-in screen with a reason. An EXPIRED session is a different
   * thing and deliberately does not come here (spec/10 § Surface).
   */
  private endUnauthenticated(reason: string): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.stopInputReports();
    this.stopRunningResync();
    usePresenceStore.getState().setConnection('offline');
    window.dispatchEvent(new CustomEvent('patch:credential-rejected', { detail: reason }));
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openOnce();
    }, delay);
  }

  private dispatch(event: WireEvent): void {
    // Heartbeat pong (patch/todo.md train-internet resilience): the server acks
    // every surface.heartbeat. The first ack arms the zombie-socket watchdog;
    // `lastInboundAt` was already stamped by the message listener. Nothing else
    // to do — swallow it before the stores ever see it.
    if (event.type === 'surface.heartbeat_ack') {
      this.pongSupported = true;
      return;
    }
    // Terminal session stream (spec/14 § Terminal). Per-surface by construction
    // — the hub only routes these to the surface that opened the session — so
    // they go straight into the terminal store, never the chat stores.
    if (
      event.type === 'patch.terminal.ready' ||
      event.type === 'patch.terminal.output' ||
      event.type === 'patch.terminal.command-exit' ||
      event.type === 'patch.terminal.exit' ||
      event.type === 'patch.terminal.error'
    ) {
      useTerminalStore.getState().ingest(event);
      return;
    }
    // spec/14 § File browser — live updates: a file on this chat's folder
    // just landed a real write on disk (the editor's own save, another
    // surface's save, or the agent's own Edit/Write/NotebookEdit). Not a
    // chat-timeline event — recorded straight into uiStore, where
    // `BrowsePanel` (EditorRail.tsx) picks it up and invalidates its own
    // TanStack Query caches. Never reaches chatStore/applyEvents.
    if (event.type === 'patch.file_changed') {
      useUiStore.getState().recordFileChanged(event.chatId, event.path);
      return;
    }
    // Auth identity from hello.
    if (event.type === 'auth.ok') {
      usePresenceStore.getState().setIdentity(event.accountId, event.surfaceId);
      // The greeting carries EVERY registered host with its presence and the
      // server's cached reports, so the Hosts list is complete from the first
      // frame — including machines that are asleep and will never announce
      // themselves.
      usePresenceStore.getState().setHosts(event.hosts);
      // Live update (spec/14 § Live updates): the server reports the bundle it
      // serves on every auth.ok. A deploy restarts the server, so this
      // reconnect delivers the new hash — reload if it changed.
      onServerVersion(event.webBundleHash);
      // Start heartbeat once authenticated. Pause if document is currently
      // hidden (visibility handler will resume on foreground).
      if (typeof document === 'undefined' || !document.hidden) {
        this.startHeartbeat();
      }
      // Unlike the heartbeat, input reports carry on while the window is
      // hidden: typing in another app is exactly what they exist to see.
      this.startInputReports();
      this.startRunningResync();
      // Resend this surface's currently-open chat (spec/09 § Chat completion).
      // `PresenceTracker.online()` replaces the whole record on every hello,
      // so a reconnect (network blip, sleep/wake) silently wipes
      // `lastFocusedChatId` — without this, the desktop doorbell's
      // focused-surface suppression would stay broken until the user next
      // navigated. `null` when nothing is open is itself the correct state to
      // announce, not a no-op to skip.
      this.send({ type: 'chat.focus_change', chatId: useChatStore.getState().activeChatId });
      // The hub reads `chatId: null` as "unsubscribe from everything" and
      // clears this socket's watched chats — including every chat the
      // open-time replay (sent before auth completed) had just subscribed. A
      // pane showing such a chat then sat on stale state while the chat moved
      // on, missing every live event after a reconnect. Ask again now that
      // the focus frame is behind us: the replay re-subscribes and catches up
      // from the cursor. Forced, because the cursor is unchanged since the
      // request it replaces.
      this.replayHeldChats(undefined, true);
      // spec/14 § Composer — push every draft the server never confirmed
      // (typed while offline, or a save that failed mid-flight) now that the
      // link is back.
      useComposerDraftStore.getState().resendPendingOnReconnect();
      useDraftStore.getState().resendPendingOnReconnect();
      return;
    }
    if (event.type === 'auth.revoked') {
      // The server is telling us the credential is dead, ahead of the close.
      // Same outcome, said sooner — the shell drops it and shows sign-in NOW,
      // rather than "on next load" with a banner in the meantime.
      this.endUnauthenticated(event.reason);
      return;
    }
    if (event.type === 'auth.expired') {
      // Transient — the credential aged out rather than being revoked. Show a
      // non-destructive notice; do NOT clear the credential or force re-pair.
      useUiStore.getState().pushError(`session expired: ${event.reason}`);
      return;
    }
    if (event.type === 'daemon.online') {
      usePresenceStore.getState().setHostOnline(event.daemonId, true);
      // The host just came back, and this surface's socket to the SERVER may
      // never have dropped — a host restart (a deploy, a crash) does not
      // reconnect us. Nothing else asks for what we missed: the connect-time
      // sweep only runs on a fresh socket, and ChatRoute only replays when the
      // chat or the link changes identity. Without this a chat sits there
      // holding whatever it had when the host went down, silently missing
      // every event emitted since, with no error anywhere.
      this.replayHeldChats(event.daemonId, true);
      // The server flushes its buffer, but a copy lost to a flap at flush time
      // would never arrive — redeliver every still-pending input so
      // queued-while-offline turns land promptly and any lost one heals
      // (idempotent; the host dedups). spec/12.
      deliveryTracker.onReconnect();
      return;
    }
    if (event.type === 'daemon.offline') {
      usePresenceStore.getState().setHostOnline(event.daemonId, false);
      return;
    }
    if (event.type === 'daemon.unauthenticated') {
      // A backend on a NAMED host has no usable credential — on boot and on a
      // refused query. Dropping it is what once produced a silent app: you
      // could open a chat, type and send, and the turn simply never ran. It is
      // authoritative "not connected" for that (host, backend) pair only —
      // another machine's credential is unaffected.
      usePresenceStore.getState().setHostAccount({
        type: 'daemon.account',
        daemonId: event.daemonId,
        backendId: event.backendId,
        connected: false,
        accountEmail: null,
      });
      return;
    }
    if (event.type === 'daemon.host') {
      usePresenceStore.getState().setHostReport(event);
      return;
    }
    // spec/03 § Settings — the shared settings, in the greeting and after every change.
    if (event.type === 'settings.changed') {
      const state = {
        version: event.version,
        settings: event.settings,
        secrets: event.secrets,
        hosts: event.hosts,
      };
      // Loaded on demand: the preferences store reaches `api/rest.js`, and this
      // module is imported by the chat store, so a static import would drag the
      // REST client into every test that only wants the chat store. `apply`
      // keeps the higher version, so a late-resolving import cannot regress it.
      void import('../stores/preferencesStore.js').then((m) =>
        m.usePreferencesStore.getState().apply(state),
      );
      return;
    }
    // spec/09 § bell — the agent-notification log changed; refetch.
    if (event.type === 'notifications.changed') {
      void import('../stores/notificationsStore.js').then((m) =>
        m.useNotificationsStore.getState().load(),
      );
      return;
    }
    if (event.type === 'daemon.account') {
      const previous = usePresenceStore.getState().hosts[event.daemonId]?.accounts[event.backendId];
      const fingerprint = (
        account: Pick<NonNullable<typeof previous>, 'connected' | 'accounts'> | undefined,
      ): string =>
        JSON.stringify([
          account?.connected,
          account?.accounts?.map((a) => [a.id, a.kind, a.connected]),
        ]);
      if (fingerprint(previous) !== fingerprint(event))
        void import('../lib/models.js').then((m) => m.refreshModelsForHost(event.daemonId));

      // Addressed to ONE (host, backend) pair and stored as such. Flattening it
      // into an account-wide slot is what let a logged-out machine block sending
      // in a chat pinned to a machine whose credential was fine.
      usePresenceStore.getState().setHostAccount(event);
      return;
    }
    // spec/04 § Folders — that host's designated roots + recently-used folders,
    // sent whole on connect and re-sent on every change (including after an
    // add/remove made from Settings → Hosts → Project folders).
    if (event.type === 'folders.list' || event.type === 'folders.updated') {
      usePresenceStore.getState().setHostFolders(event.daemonId, event.roots, event.recent);
      return;
    }
    // The server removed a host from the account (Settings → Hosts → Remove,
    // from any surface). Its credential is revoked; forget it and its reports.
    if (event.type === 'host.removed') {
      usePresenceStore.getState().removeHost(event.daemonId);
      return;
    }
    // A host refused a Claude Code settings.json / memory edit (invalid JSON, an
    // entry it does not have). The host says so as an out-of-band chat.error
    // with no real chat behind it, so say it where the edit was made — as an
    // error — rather than filing it under a phantom chat nobody opens.
    if (event.type === 'chat.error' && event.error.code === 'claude_settings_invalid') {
      useUiStore.getState().pushError(event.error.message);
      return;
    }
    if (event.type === 'claude_settings.list' || event.type === 'claude_settings.updated') {
      usePresenceStore.getState().setClaudeSettings(event.daemonId, event.drift, event.memories);
      return;
    }
    if (event.type === 'meeting.state') {
      useMeetingStore.getState().apply(event.chatId, event.meeting);
      return;
    }
    // spec/14 § New chat drafts — server-owned, same shape as composer drafts.
    if (event.type === 'new_chat_draft.list') {
      useDraftStore.getState().applyList(event.drafts);
      return;
    }
    if (event.type === 'new_chat_draft.updated') {
      useDraftStore.getState().applyUpdated(event.draft, event.updatedAt);
      return;
    }
    if (event.type === 'new_chat_draft.removed') {
      useDraftStore.getState().applyRemoved(event.id);
      return;
    }
    // spec/14 § Composer — server-owned drafts. The cold-start snapshot, sent
    // once right after auth.ok, and the live per-chat updates that follow.
    if (event.type === 'composer_draft.list') {
      useComposerDraftStore.getState().applyDraftList(event.drafts);
      return;
    }
    if (event.type === 'composer_draft.updated') {
      useComposerDraftStore.getState().applyDraftUpdated(event.chatId, event.text, event.updatedAt);
      return;
    }
    if (event.type === 'composer_draft.cleared') {
      useComposerDraftStore.getState().applyDraftCleared(event.chatId, event.updatedAt);
      return;
    }
    // spec/09 § `### desktop` — a desktop-channel notify becomes a native OS
    // toast. Only the main process can raise one, so it goes out over the
    // preload bridge; in a plain browser there is no bridge and nothing to do
    // (the server only fans this channel out to `desktop` surfaces).
    if (event.type === 'notify' && event.channel === 'desktop') {
      getDesktopBridge()?.notify?.({
        title: 'Patch',
        // The OS toast renders the body verbatim, not as markdown — flatten it
        // so `**x**` etc. don't show as literal syntax.
        body: stripMarkdown(event.message),
        chatId: event.chatId,
        // spec/09 § Reaching the user — the rung decides the toast's sound.
        ...(event.priority ? { priority: event.priority } : {}),
        // spec/09 § Batch check-in — `kind: 'batch'` tells the shell's click
        // handler to land on the batch view instead of `chatId` (a reserved
        // non-chat sentinel on that one).
        ...(event.kind ? { kind: event.kind } : {}),
        // spec/09 § Notification actions — Reply/Approve-Deny/question
        // options/quickReplies on the native toast.
        ...(event.actions ? { actions: event.actions } : {}),
      });
      return;
    }
    // spec/14 ## Sidebar — a physical voice device opening/closing a session
    // drives the "🎙 <name>" pill on the Speakers row.
    if (event.type === 'device.session') {
      useVoiceStore.getState().setDeviceSession(event.deviceId, event.name, event.active);
      return;
    }
    if (event.type === 'chat.call_request') {
      useVoiceStore.getState().setIncoming({
        callId: event.callId,
        chatId: event.chatId,
        message: event.message,
        receivedAt: Date.now(),
      });
      // Window-raise + chime per spec/14 ## Manager incoming-call UX.
      // In the Electron desktop shell the renderer's window.focus() cannot
      // foreground a backgrounded window on macOS — route through the main
      // process via the preload bridge. Fall through to window.focus() for the
      // plain browser surface (where it does bring the tab forward).
      const bridge = getDesktopBridge();
      if (bridge?.requestRaise) {
        bridge.requestRaise();
      } else {
        window.focus();
      }
      try {
        playChime();
      } catch {
        // chime is best-effort; don't crash the dispatcher
      }
      return;
    }
    // spec/09 § Reaching the user — under `auto-notify` a call is spoken aloud
    // rather than ringing. Nothing is accepted and nothing is answered.
    if (event.type === 'chat.speak') {
      void speakInterrupt(event.chatId, event.message);
      return;
    }
    if (event.type === 'chat.call_winner' || event.type === 'chat.call_timeout') {
      const incoming = useVoiceStore.getState().incomingCall;
      if (incoming && incoming.callId === event.callId) {
        useVoiceStore.getState().setIncoming(null);
      }
      return;
    }
    // spec/07 ## Permission prompts during voice: if a voice note or call is
    // in flight when a permission request arrives, surface the voice banner
    // (Approve/Deny + "say yes / no"). The spoken answer rides the open audio
    // session's Whisper path; tap works too. This is in ADDITION to the
    // diff-rail path below for file-edit tools.
    if (event.type === 'chat.permission_request') {
      const voice = useVoiceStore.getState();
      if (voice.note !== null || voice.call !== null) {
        const req = event.request;
        const summary = req.description ?? `Approve ${req.tool}?`;
        voice.setPermission({ requestId: event.requestId, chatId: event.chatId, summary });
      }
    }
    // Group 19: file-edit permission requests open the diff editor rail.
    if (event.type === 'chat.permission_request') {
      const tool = event.request.tool;
      if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
        const args = event.request.args;
        if (typeof args === 'object' && args !== null) {
          const a = args as Record<string, unknown>;
          let pending: import('../stores/uiStore.js').PendingDiff | null = null;
          // Group 20: prefer the daemon-attached proposedDiff text when
          // present (canonical source of the user-facing patch). Fall
          // back to reconstructing from raw args for older hosts.
          if (tool === 'Edit' && typeof a['file_path'] === 'string') {
            pending = {
              requestId: event.requestId,
              chatId: event.chatId,
              tool,
              filePath: a['file_path'] as string,
              original: typeof a['old_string'] === 'string' ? (a['old_string'] as string) : '',
              modified: typeof a['new_string'] === 'string' ? (a['new_string'] as string) : '',
            };
          } else if (tool === 'Write' && typeof a['file_path'] === 'string') {
            pending = {
              requestId: event.requestId,
              chatId: event.chatId,
              tool,
              filePath: a['file_path'] as string,
              original: '',
              modified: typeof a['content'] === 'string' ? (a['content'] as string) : '',
            };
          } else if (tool === 'NotebookEdit' && typeof a['notebook_path'] === 'string') {
            pending = {
              requestId: event.requestId,
              chatId: event.chatId,
              tool,
              filePath: a['notebook_path'] as string,
              original: typeof a['old_source'] === 'string' ? (a['old_source'] as string) : '',
              modified: typeof a['new_source'] === 'string' ? (a['new_source'] as string) : '',
            };
          }
          if (pending) {
            // spec/14 § Panes and tabs: no more docked rail to force open —
            // the inline transcript card already offers Approve/Deny on its
            // own; `pendingDiffByChat` just makes the bigger Monaco view
            // available to whichever `FileEditorTab` (if any) is open on
            // this exact path.
            useUiStore.getState().setPendingDiff(pending);
          }
        }
      }
    }
    // spec/07 ## Permission prompts during voice: the host echoes a
    // `chat.permission_response` to surfaces when it resolves a request —
    // notably for the spoken yes/no path, where the surface never sent the
    // response itself. Flip the matching inline permission card to
    // approved/denied (the chat.state echo only settles activity, not the
    // card), and clear any mid-voice banner for that chat. Idempotent with the
    // optimistic local resolve the inline/right-rail tap paths already do.
    if (event.type === 'chat.permission_response' && typeof event.chatId === 'string') {
      // Delivered, whatever the outcome — including a request the host
      // itself denied as expired. See permissionDeliveryTracker.ts.
      permissionDeliveryTracker.ack(event.requestId);
      const decision: 'approve' | 'deny' =
        event.decision === 'deny' || event.approve === false ? 'deny' : 'approve';
      // `resolvePermission` edits the ALREADY-COMMITTED timeline, but the
      // `chat.permission_request` that created the card may still be sitting in
      // the batch window — the request and its echo can arrive in the same
      // frame. Resolving first would find no card, and the request would then
      // commit unresolved: a permission prompt stuck pending forever on a
      // question that was already answered. Land the queue first.
      this.flushStoreQueue();
      useChatStore
        .getState()
        .resolvePermission(event.chatId, event.requestId, decision, event.answers);
      const pending = useVoiceStore.getState().permission;
      if (pending && pending.requestId === event.requestId) {
        useVoiceStore.getState().setPermission(null);
      }
      return;
    }
    // spec/02 § Questions are not approvals: the host reset a still-
    // outstanding question's deadline because a `chat.focus_change` this
    // surface (or another one) sent named, or stopped naming, its chat. Same
    // batch-window race as `chat.permission_response` above — the request
    // that created the card may still be queued.
    if (event.type === 'chat.permission_expiry_update') {
      this.flushStoreQueue();
      useChatStore.getState().updatePermissionExpiry(event.chatId, event.requestId, event.expiry);
      return;
    }
    // Clear a mid-voice permission banner once the chat leaves the awaiting-
    // permission state (e.g. the spoken "yes"/"no" was parsed host-side and
    // the turn resumed) so the banner doesn't linger after a voice answer.
    if (event.type === 'chat.state') {
      const pending = useVoiceStore.getState().permission;
      if (pending && pending.chatId === event.chatId && event.activity !== 'awaiting-permission') {
        useVoiceStore.getState().setPermission(null);
      }
    }
    // A host refusing an action that has no chat of its own to land on — e.g.
    // `host.update` finding nothing newer, a bad digest, or the download
    // failing — is addressed to no chat (`pending-spawn`). Nothing in the
    // sidebar ever shows that id, so without this the host's own reason sat
    // in a chat no surface displays: the Settings → Hosts "Update" button
    // looked like it had done nothing at all. Surfaced as the same toast every
    // other host refusal in Settings uses (mirrors mobile's hostRefusalStore).
    if (event.type === 'chat.error' && event.chatId === 'pending-spawn') {
      useUiStore.getState().pushError(event.error.message);
    }
    // spec/12 § Guaranteed input delivery — retire the pending mark on any
    // outgoing input this event confirms was received (ack / queued / running /
    // reply / error). Must run for `chat.input_ack` too, which applyEvent
    // ignores. Observed BEFORE applyEvent so the delivery flags and the render
    // state settle in one pass.
    // Stays SYNCHRONOUS: the tracker's timers are keyed to when the event
    // actually arrived, not to when the store next commits.
    deliveryTracker.observe(event);
    // A batched replay is one frame carrying the whole answer (spec/12 §
    // Sequence-based replay). Unpack it into the same queue the live path
    // uses — same events, same order, same reducer — and commit immediately
    // rather than waiting out the coalescing frame: there is nothing more
    // coming to coalesce WITH, and the point of asking for a batch was to
    // paint the transcript once instead of watching it arrive.
    if (event.type === 'chat.replay_batch') {
      // Each inner event goes back through dispatch() so it gets the same
      // special-case side effects as a live one (diff rail, voice banner,
      // permission ack, host-refusal toast). dispatch() queues the chat events;
      // the flush below commits them at once.
      for (const inner of event.events) this.dispatch(inner as WireEvent);
      this.flushStoreQueue();
      return;
    }
    // Chat events go to chatStore — coalesced, see queueForStore.
    this.queueForStore(event);
  }

  /**
   * Hold a store event for up to one frame so a burst commits once.
   *
   * Ordering is preserved: events are committed in arrival order, and the store
   * applies a batch as a single sequential fold, so the result is identical to
   * applying them one by one.
   */
  private queueForStore(event: WireEvent): void {
    this.storeQueue.push(event);
    if (this.storeFlushTimer !== null) return;
    this.storeFlushTimer = window.setTimeout(() => {
      this.storeFlushTimer = null;
      this.flushStoreQueue();
    }, STORE_BATCH_MS);
  }

  /**
   * Commit everything gathered so far. Safe to call with an empty queue.
   *
   * `applyEvents` folds the whole batch into one `set()` at the end — a throw
   * anywhere in that fold (an edge case the reducer didn't account for) skips
   * that `set()` entirely, so every event in the batch is lost, not just the
   * one that broke: a user message and a tool call could reach the timeline
   * from an earlier, already-committed batch while the assistant's final
   * reply and the `chat.state` that clears the spinner — queued together in
   * the batch that threw — never land, leaving the chat spinning forever with
   * no error on screen. Same remedy as a malformed frame above: fail loud and
   * reload, which re-syncs every open chat from the host's own replay
   * instead of leaving the store's in-memory state silently short.
   */
  private flushStoreQueue(): void {
    if (this.storeQueue.length === 0) return;
    const batch = this.storeQueue;
    this.storeQueue = [];
    try {
      useChatStore.getState().applyEvents(batch);
    } catch (err) {
      reloadOnWireMismatch(`store apply failed: ${(err as Error).message}`);
      return;
    }
    // Keep what we just drew, so reopening this chat — or restarting the app
    // — paints from the device instead of asking the host for it all again
    // (spec/12 § Cold start). Only AFTER the fold succeeded: caching events
    // the store refused would hand the same poison back on the next open.
    // `saveEvents` keeps only the durable ones and is tolerant of a broken
    // store; a cache that cannot be written is simply no cache.
    const byChat = new Map<string, unknown[]>();
    for (const event of batch) {
      const chatId = (event as { chatId?: unknown }).chatId;
      if (typeof chatId !== 'string') continue;
      const list = byChat.get(chatId);
      if (list) list.push(event);
      else byChat.set(chatId, [event]);
    }
    for (const [chatId, events] of byChat) void saveEvents(chatId, events);
  }
}

function playChime(): void {
  // Single-shot 880Hz tone via Web Audio API. Per spec — one short tone.
  // Peak gain 0.06 (~-10dB below the original 0.2, which read as too loud).
  // The 0.001 floor either side is a floor, not silence:
  // exponentialRampToValueAtTime cannot target 0.
  const Ctx =
    (
      window as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      }
    ).AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return;
  const ctx = new Ctx();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.value = 880;
  osc.type = 'sine';
  gain.gain.setValueAtTime(0.001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.06, ctx.currentTime + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.7);
}

export function defaultWsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

// Module-level active connection. AppShell registers its PatchWs here on mount
// so leaf routes that aren't prop-threaded the socket (Settings, Menubar) can
// still emit surface→host events without prop-drilling. NO FALLBACK: sending
// when nothing is connected throws (PatchWs.send) so the caller surfaces it.
let activeWs: PatchWs | null = null;
export function setActiveWs(ws: PatchWs | null): void {
  activeWs = ws;
}
export function getActiveWs(): PatchWs | null {
  return activeWs;
}
