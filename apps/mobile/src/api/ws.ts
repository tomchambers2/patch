// React Native WebSocket client. Mirrors packages/web/src/api/ws.ts but
// uses RN's AppState API (no DOM `document.visibility`).
//
// Spec/05 line 71: surface emits `surface.heartbeat` every 10s while
// foregrounded. Spec/12: replay missed events with chat.replay on
// reconnect. NO FALLBACK on auth — bad/missing JWT throws at hello-time.

import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import { CLOSE_AUTH_FAILED, decodeCompat, type WireEvent } from '@patch/wire';
import { clearCredential, loadCredential } from '../lib/credential';
import { useChatStore } from '../stores/chatStore';
import { saveEvents } from '../lib/transcriptCache';
import { useFolderStore } from '../stores/folderStore';
import { useHostRefusalStore } from '../stores/hostRefusalStore';
import { useSettingsStore } from '../stores/settingsStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useTerminalStore } from '../stores/terminalStore';
import { speakInterrupt } from '../lib/speakInterrupt';
import { useUiStore } from '../stores/uiStore';
import { deliveryTracker } from '../lib/deliveryTracker';
import { useComposerDraftStore } from '../lib/composerDraft';
import { permissionDeliveryTracker } from '../lib/permissionDeliveryTracker';
import { mobileBuildInfo } from '../lib/buildInfo';
import { wsUrl } from '../config';

/**
 * Say ONCE, per distinct thing, that we ignored something from a newer sender
 * (spec/03 § Forward compatibility). `chat.state` arrives constantly, so a line
 * per frame would bury the log; the durable record is `wireCompatStats()`,
 * which the diagnostics screen reports.
 */
const compatSeen = new Set<string>();
function noteFirstSight(what: string): void {
  if (compatSeen.has(what)) return;
  compatSeen.add(what);
  console.warn(`[patch] wire: ignoring unknown ${what} — this surface is behind the host`);
}

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
/**
 * How long inbound store events are gathered before being committed together
 * (see `queueForStore`). One frame: long enough that a `chat.replay` burst —
 * 500+ events inside half a second on a busy chat — collapses into a couple of
 * dozen commits instead of 500+, short enough that a single live message still
 * lands within the same frame it arrived in.
 */
export const STORE_BATCH_MS = 16;
/**
 * How long the link must be down, with the app in the FOREGROUND, before the
 * amber banner says so (spec/12 § Surface connection state model). Android
 * drops the socket while the app is backgrounded, so every open used to flash
 * "Reconnecting…" for the second the reconnect took. A real outage outlasts
 * this; a resume reconnect does not. The true state is never delayed —
 * `connection` flips on the close itself, for diagnostics and controls.
 */
export const DISCONNECT_GRACE_MS = 3000;

type TimerHandle = ReturnType<typeof setTimeout>;

export class PatchWs {
  private ws: WebSocket | null = null;
  private backoff = INITIAL_BACKOFF_MS;
  private reconnectTimer: TimerHandle | null = null;
  private heartbeatTimer: TimerHandle | null = null;
  /** Running while a foreground outage is inside its grace period. */
  private outageTimer: TimerHandle | null = null;
  private closed = false;
  private url: string;
  private appStateSub: NativeEventSubscription | null = null;
  private currentAppState: AppStateStatus = AppState.currentState;
  /** Store events received but not yet committed — see `queueForStore`. */
  private storeQueue: WireEvent[] = [];
  private storeFlushTimer: TimerHandle | null = null;
  /**
   * The cursor each chat's last replay was asked from, ON THIS SOCKET. Cleared
   * on every new connection, so a reconnect always re-asks while one connection
   * never asks the same question twice.
   */
  private readonly lastReplayCursor = new Map<string, number>();

  constructor(url: string) {
    this.url = url;
  }

  static default(): PatchWs {
    return new PatchWs(wsUrl());
  }

  connect(): void {
    this.closed = false;
    this.openOnce();
    this.appStateSub = AppState.addEventListener('change', this.handleAppState);
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Commit anything still waiting on the batch timer — events that were
    // received are events the user must see, and the timer is about to be
    // cancelled.
    if (this.storeFlushTimer !== null) {
      clearTimeout(this.storeFlushTimer);
      this.storeFlushTimer = null;
    }
    this.flushStoreQueue();
    this.stopHeartbeat();
    this.clearOutage();
    this.appStateSub?.remove();
    this.appStateSub = null;
    this.ws?.close();
    this.ws = null;
    usePresenceStore.getState().setConnection('offline');
    // The WS is the only channel that carries host presence — once it is
    // gone we no longer know the host's state (spec/12 § connection model).
    usePresenceStore.getState().setDaemon('unknown');
    // App teardown — drop all delivery timers so nothing leaks. (A transient
    // socket-level close does NOT reset; pending inputs survive for redelivery.)
    deliveryTracker.reset();
    permissionDeliveryTracker.reset();
  }

  send(event: WireEvent): void {
    if (!this.ws || this.ws.readyState !== 1 /* OPEN */) {
      throw new Error('PatchWs: not connected');
    }
    this.ws.send(JSON.stringify(event));
  }

  /**
   * Best-effort send: silently no-ops when the socket isn't open. Used for
   * subscribe/heartbeat frames where a dropped frame is re-sent on reconnect
   * (the connect-time replay loop re-subscribes every known chat).
   */
  safeSend(event: WireEvent): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify(event));
  }

  /**
   * The cursor to ask a chat's transcript from: the highest DURABLE seq this
   * surface has actually rendered, or -1 when it holds nothing.
   *
   * Derived here rather than passed in, so the screen opening a chat and the
   * connect handler catching it up always ask the same question — two callers
   * computing it differently is a second replay of the same transcript on the
   * same connection, which the store folds for messages and permission cards
   * but not for tool calls.
   *
   * Optimistic outgoing echoes carry a negative placeholder seq until the
   * host persists them, so they never count toward the cursor. A roster row's
   * `lastSeq` is deliberately not consulted: a metadata-only row has one
   * without the transcript to match, and `fromSeq` is EXCLUSIVE, so asking from
   * it would skip history this surface has never seen.
   */
  private replayCursor(chatId: string): number {
    // Committed store state only — anything still inside the batch window has
    // to land first or the cursor is computed against a transcript missing
    // entries that have already arrived. See `queueForStore`.
    this.flushStoreQueue();
    const timeline = useChatStore.getState().timelines[chatId];
    if (timeline === undefined || timeline.length === 0) return -1;
    return timeline.reduce((max, e) => (e.seq >= 0 && e.seq > max ? e.seq : max), -1);
  }

  /**
   * Ask for a chat's transcript from our cursor, at most once per cursor per
   * CONNECTION. The request is also what subscribes this surface to the chat's
   * live detail events, so a chat that is never replayed never receives one.
   *
   * Opening a chat asks for its transcript; the socket finishing its connect a
   * moment later asks again for every held chat — the open one included, its
   * timeline still empty — so both computed `fromSeq: -1` and the host
   * streamed the whole transcript twice. The store folds a re-delivered turn
   * onto its canonical seq, so this is no longer a correctness fix; a second
   * full transcript over a phone's connection is simply waste.
   *
   * Per connection, not for all time: a reconnect must still catch up from the
   * same cursor, because the earlier request may have died with the old socket
   * before one event came back. A request made while the socket is shut isn't
   * recorded — it never went, and remembering it would suppress the
   * connect-time request that exists to replace it.
   */
  requestReplay(chatId: string, opts?: { force?: boolean }): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    // `force` drops the per-connection guard: a cached track the host
    // disagrees with is cleared and asked for again from -1, which is the
    // same cursor the first ask used and would otherwise be discarded as a
    // repeat (spec/15 § Instant open).
    if (opts?.force === true) this.lastReplayCursor.delete(chatId);
    const fromSeq = this.replayCursor(chatId);
    if (this.lastReplayCursor.get(chatId) === fromSeq) return;
    this.lastReplayCursor.set(chatId, fromSeq);
    this.ws.send(JSON.stringify({ type: 'chat.replay', chatId, fromSeq, batch: true }));
  }

  private handleAppState = (next: AppStateStatus): void => {
    const prev = this.currentAppState;
    this.currentAppState = next;
    if (next !== 'active' && prev === 'active') {
      // Nobody is looking, and Android is about to drop the socket anyway —
      // an outage only counts while the app is on screen. Clearing a banner
      // already up is safe: if the link is still down on return, a fresh
      // grace period brings it back.
      this.clearOutage();
    }
    if (this.closed) return;
    if (next === 'active' && prev !== 'active' && (!this.ws || this.ws.readyState > 1)) {
      // Back on screen with no socket — the backgrounded app lost it. Dial
      // now rather than sitting out whatever backoff step was pending (up to
      // 30s, which WOULD outlast the grace), and start the grace from here:
      // a resume reconnect that lands within it never shows the banner.
      this.armOutage();
      this.reconnectNow();
      return;
    }
    if (!this.ws || this.ws.readyState !== 1) return;
    if (next === 'active' && prev !== 'active') {
      this.safeSend({ type: 'surface.foregrounded' });
      this.startHeartbeat();
    } else if (next !== 'active' && prev === 'active') {
      this.safeSend({ type: 'surface.backgrounded' });
      this.stopHeartbeat();
    }
  };

  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) return;
    this.heartbeatTimer = setInterval(() => {
      this.safeSend({ type: 'surface.heartbeat' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private openOnce(): void {
    const cred = loadCredential();
    if (!cred) {
      // Nothing to authenticate with, so there is nothing to connect to. This
      // THREW, with a comment saying the caller should redirect to pairing —
      // and no caller did: `bootstrap()` calls `connect()` fire-and-forget, so
      // the throw went nowhere, no socket was ever opened, and the app sat on
      // its connecting/reconnecting treatment for ever while the server never
      // heard from it. Nothing on the wire to diagnose, because nothing went
      // out. It is the same terminal state as a refusal — unauthenticated, go
      // and link the device — just arrived at without asking the server.
      this.endUnauthenticated('this device is not linked yet', { clear: false });
      return;
    }
    // Only show the neutral 'connecting' treatment on a FIRST connect. Once we
    // have been connected and dropped we are 'reconnecting'/'offline' (amber)
    // and must keep that treatment through the reconnect attempts, not flash
    // back to the quiet initial state.
    const cur = usePresenceStore.getState().connection;
    if (cur !== 'reconnecting' && cur !== 'offline') {
      usePresenceStore.getState().setConnection('connecting');
    }

    const ws = new WebSocket(this.url);
    this.ws = ws;

    // A new socket has heard nothing: every held chat may need its replay
    // again, including one whose request died with the old connection.
    this.lastReplayCursor.clear();
    ws.onopen = (): void => {
      this.backoff = INITIAL_BACKOFF_MS;
      // Report what this phone is really running (native APK version + the JS
      // bundle actually executing) so the update panel can spot a phone left
      // behind — spec/11 § Version reporting.
      const build = mobileBuildInfo();
      const hello: WireEvent = {
        type: 'hello',
        clientType: 'surface-mobile',
        clientVersion: build.version,
        ...(build.gitSha ? { clientGitSha: build.gitSha } : {}),
        ...(build.builtAt ? { clientBuiltAt: build.builtAt } : {}),
        auth: cred,
      };
      ws.send(JSON.stringify(hello));
      usePresenceStore.getState().setConnection('connected');
      this.clearOutage();
      // Connection forensics for the diagnostics screen (spec/12 § Connection
      // diagnostics screen): a link that has come up at least once is never
      // treated as "this surface can't connect at all".
      usePresenceStore.getState().noteWsOpen(this.url);

      // Replay missed events for the chat the surface has OPEN, plus any chat
      // whose transcript it already holds (spec/12 § When a surface requests a
      // replay).
      const { chats, timelines, activeChatId } = useChatStore.getState();
      // The chat on screen goes first and UNCONDITIONALLY — it is not looked
      // up in the roster. A push tapped from a cold start deep-links straight
      // into a chat this surface has never listed: the roster cache predates
      // it and `GET /api/chats` has not answered, so iterating the chats we
      // hold skips the one chat the user is looking at. It is also the one
      // that must not be skipped, because the replay is what adds the chat to
      // the server's per-connection watch list — without it the chat receives
      // no message, tool call or permission prompt, and stays blank.
      if (activeChatId !== null) this.requestReplay(activeChatId);
      // Then every chat whose transcript this surface already holds, so a
      // reconnect catches up on what it missed. spec/12 § "Cold start loads
      // metadata only": a metadata-only roster row is NOT replayed — blanket
      // replaying every row cost one inbound event stream per chat, thrashing
      // the store and every list row, for transcripts nobody is reading.
      // Transcripts load lazily on open. The active chat repeating here is
      // absorbed by the per-connection cursor guard in `requestReplay`.
      for (const chatId of Object.keys(chats)) {
        if ((timelines[chatId]?.length ?? 0) === 0) continue;
        this.requestReplay(chatId);
      }
      // spec/12 § "Survives a server restart" — the server's surface→host
      // buffer is gone across a restart, so redeliver every still-pending input
      // now that the link is back (same localId; the host dedups).
      deliveryTracker.onReconnect();
      // Same reasoning for permission/question responses — see
      // permissionDeliveryTracker.ts.
      permissionDeliveryTracker.onReconnect();
      if (this.currentAppState === 'active') this.startHeartbeat();
    };

    ws.onmessage = (msg: { data: unknown }): void => {
      const data = typeof msg.data === 'string' ? msg.data : '';
      let result: ReturnType<typeof decodeCompat>;
      try {
        // `decodeCompat`, not `decode`: a phone is the surface most likely to
        // be OLDER than the host — it was off, or offline, or simply has not
        // taken the OTA yet — and an additive field on `chat.state` must not
        // take the whole app down with a wall of banners (spec/03 § Forward
        // compatibility). A frame that is genuinely malformed still throws and
        // still gets a banner.
        result = decodeCompat(data);
      } catch (err) {
        useUiStore.getState().pushError(`malformed wire event: ${(err as Error).message}`);
        return;
      }
      if (!result.ok) {
        // An event type this build has never heard of: dropped, counted in
        // `wireCompatStats()`, reported by the diagnostics screen. One banner
        // per frame would bury the app.
        noteFirstSight(`type ${result.type}`);
        return;
      }
      for (const path of result.tolerated) noteFirstSight(`field ${path}`);
      this.dispatch(result.event);
    };

    ws.onclose = (ev?: { code?: number; reason?: string }): void => {
      // A socket already replaced (`reconnectNow` abandons the old one before
      // dialling) must not null out, or reschedule over, its successor.
      const current = this.ws === ws;
      if (current) {
        this.ws = null;
        this.stopHeartbeat();
      }
      // Record WHY, before the early return — a close during teardown is still
      // the last thing that happened to this socket (spec/12 § Connection
      // diagnostics screen). A failed connect attempt fires 'close' too, which
      // is what makes `failedAttempts` meaningful on a surface that has never
      // reached OPEN.
      usePresenceStore.getState().noteWsClose({
        code: ev?.code ?? 0,
        reason: ev?.reason ?? '',
        at: Date.now(),
      });
      if (this.closed || !current) return;
      // 4401 is the hub REFUSING this credential, not a link that dropped
      // (ws-hub CLOSE_AUTH_FAILED). Retrying cannot fix a refusal — it just
      // reports "reconnecting" for ever while the server has already said no,
      // leaving the user to diagnose it. End the session instead.
      if (ev?.code === CLOSE_AUTH_FAILED) {
        this.endUnauthenticated(
          ev.reason && ev.reason.length > 0 ? ev.reason : 'invalid credential',
        );
        return;
      }
      usePresenceStore.getState().setConnection('reconnecting');
      this.armOutage();
      // Host presence is no longer observable while the WS is down; drop
      // back to `unknown` so the daemon-offline banner does not linger on top
      // of the WS-reconnecting banner (the two states are distinct).
      usePresenceStore.getState().setDaemon('unknown');
      this.scheduleReconnect();
    };

    ws.onerror = (): void => {
      // 'close' will follow.
    };
  }

  /**
   * Dial immediately, abandoning the backoff wait (spec/12 § Connection
   * diagnostics screen — Retry now). Backoff resets to its first step so a
   * subsequent failure doesn't resume at the 30s ceiling.
   */
  reconnectNow(): void {
    if (this.closed) return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
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
    try {
      this.openOnce();
    } catch (err) {
      // NO FALLBACK: a retry that cannot even open (no credential) says so.
      useUiStore.getState().pushError(`ws reopen failed: ${(err as Error).message}`);
    }
  }

  /**
   * The server refused this surface. TERMINAL: stop dialling, drop the dead
   * credential, and say what happened so the app can put the user back at
   * pairing with a reason rather than an unexplained sign-in screen.
   *
   * The credential goes because it can never work again — keeping it would
   * send the app straight back to the same refusal on the next launch, which
   * is the loop this exists to break. An EXPIRED session is a different thing
   * and is deliberately not routed here (spec/10 § Surface).
   */
  private endUnauthenticated(reason: string, opts: { clear?: boolean } = {}): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.clearOutage();
    try {
      this.ws?.close();
    } catch {
      // already gone
    }
    this.ws = null;
    // A REFUSED credential is dropped — keeping it would send the app straight
    // back into the same refusal next launch. A device that never had one has
    // nothing to drop, and saying "signed out" would be a lie.
    const clear = opts.clear !== false;
    if (clear) clearCredential();
    usePresenceStore.getState().setAuthRejected(reason);
    usePresenceStore.getState().setConnection('unauthenticated');
    usePresenceStore.getState().setDaemon('unknown');
    useUiStore
      .getState()
      .pushError(
        clear ? `Signed out: ${reason}. Link this device again.` : `Not connected: ${reason}.`,
      );
  }

  /**
   * Start the disconnect grace, if the app is on screen and it is not already
   * running or spent. When it expires with the link still down, the outage is
   * real and the banner shows. Backgrounded, nothing is armed: the resume
   * handler arms it afresh when the app comes back.
   */
  private armOutage(): void {
    if (this.closed || this.currentAppState !== 'active') return;
    if (this.outageTimer !== null || usePresenceStore.getState().outageVisible) return;
    this.outageTimer = setTimeout(() => {
      this.outageTimer = null;
      if (this.closed || this.currentAppState !== 'active') return;
      if (usePresenceStore.getState().connection === 'connected') return;
      usePresenceStore.getState().setOutageVisible(true);
    }, DISCONNECT_GRACE_MS);
  }

  /** The link is back (or no longer being watched): cancel the grace, drop the banner. */
  private clearOutage(): void {
    if (this.outageTimer !== null) {
      clearTimeout(this.outageTimer);
      this.outageTimer = null;
    }
    usePresenceStore.getState().setOutageVisible(false);
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      try {
        this.openOnce();
      } catch (err) {
        useUiStore.getState().pushError(`ws reopen failed: ${(err as Error).message}`);
      }
    }, delay);
  }

  private dispatch(event: WireEvent): void {
    if (event.type === 'auth.ok') {
      usePresenceStore.getState().setIdentity(event.accountId, event.surfaceId);
      // The greeting carries EVERY registered host with its presence and the
      // server's cached reports, so the phone's Hosts list is complete from the
      // first frame — asleep machines included.
      usePresenceStore.getState().setHosts(event.hosts);
      // spec/14 § Composer — push every draft the server never confirmed
      // (typed while offline, or a save that failed mid-flight) now that the
      // link is back.
      useComposerDraftStore.getState().resendPendingOnReconnect();
      return;
    }
    if (event.type === 'auth.revoked') {
      // The server is telling us the credential is dead, ahead of the close.
      // Same outcome, said sooner.
      this.endUnauthenticated(event.reason);
      return;
    }
    if (event.type === 'auth.expired') {
      // Transient — the credential simply aged out. Surface a non-destructive
      // notice; do NOT wipe the credential or force re-pairing.
      useUiStore.getState().pushError(`session expired: ${event.reason}`);
      return;
    }
    if (event.type === 'daemon.online') {
      usePresenceStore.getState().setHostOnline(event.daemonId, true);
      // The host is back — redeliver pending inputs so queued-while-offline
      // turns land promptly and any lost to a flush-time flap heals (idempotent;
      // the host dedups). spec/12.
      deliveryTracker.onReconnect();
      permissionDeliveryTracker.onReconnect();
      return;
    }
    if (event.type === 'daemon.offline') {
      usePresenceStore.getState().setHostOnline(event.daemonId, false);
      return;
    }
    if (event.type === 'daemon.host') {
      usePresenceStore.getState().setHostReport(event);
      return;
    }
    if (event.type === 'daemon.unauthenticated') {
      // ONE backend's credential on ONE host is missing/expired (spec/10
      // § Backend credentials). NOT a presence fact: the host emitted this over
      // its own live link, so it stays online — a machine that is up and simply
      // logged out of a backend must not be rendered as down.
      usePresenceStore.getState().setHostAccount({
        type: 'daemon.account',
        daemonId: event.daemonId,
        backendId: event.backendId,
        connected: false,
        accountEmail: null,
      });
      useUiStore.getState().pushError(`host unauthenticated: ${event.reason}`);
      return;
    }
    if (event.type === 'daemon.account') {
      // spec/10 § Surface in Settings — a backend's credential on a NAMED host
      // is switchable from ANY surface, so the phone tracks the same live state
      // the desktop does. Stored against the (host, backend) pair it names:
      // flattening it into an account-wide slot let one logged-out machine make
      // every host look logged out.
      usePresenceStore.getState().setHostAccount(event);
      return;
    }
    if (event.type === 'folders.list' || event.type === 'folders.updated') {
      // spec/04 § Folders: each host publishes ITS OWN registry; keep that
      // host's picker group in sync. Both events carry that host's complete
      // roots + recents — replace that host's entry, leave the others alone.
      useFolderStore.getState().setHostFolders({
        daemonId: event.daemonId,
        roots: event.roots,
        recent: event.recent,
      });
      return;
    }
    if (event.type === 'host.removed') {
      // The host was removed from the account (by any surface): drop it and
      // its cached reports. A surface that missed this learns it from the next
      // `auth.ok`, whose roster no longer names the host.
      usePresenceStore.getState().removeHost(event.daemonId);
      return;
    }
    if (event.type === 'claude_settings.list' || event.type === 'claude_settings.updated') {
      // spec/02 § Claude Code settings — that host's settings.json + memory
      // entries, sent whole on connect and after every edit, so Settings →
      // Hosts settles on what the machine actually holds.
      usePresenceStore.getState().setClaudeSettings(event.daemonId, event.drift, event.memories);
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
      useSettingsStore.getState().applyShared(state);
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
    if (
      event.type === 'patch.terminal.ready' ||
      event.type === 'patch.terminal.output' ||
      event.type === 'patch.terminal.exit' ||
      event.type === 'patch.terminal.error'
    ) {
      // spec/15 § Host files and terminal. Straight to the terminal's own
      // store, unbatched: a keystroke's echo is the one thing on this link a
      // person is watching for character by character.
      useTerminalStore.getState().ingest(event);
      return;
    }
    if (event.type === 'chat.call_request') {
      useVoiceStore.getState().setIncoming({
        callId: event.callId,
        chatId: event.chatId,
        message: event.message,
        receivedAt: Date.now(),
      });
      return;
    }
    // spec/09 § Reaching the user — under `auto-notify` a call is spoken aloud
    // rather than ringing. Nothing is accepted and nothing is answered.
    if (event.type === 'chat.speak') {
      speakInterrupt(event.chatId, event.message);
      return;
    }
    if (event.type === 'chat.call_winner' || event.type === 'chat.call_timeout') {
      const incoming = useVoiceStore.getState().incomingCall;
      if (incoming && incoming.callId === event.callId) {
        useVoiceStore.getState().setIncoming(null);
      }
      return;
    }
    // spec/12 § Guaranteed input delivery — retire the pending mark on any event
    // that confirms an outgoing input was received (ack / queued / running /
    // reply / error). Runs for chat.input_ack too, which applyEvent ignores.
    // Stays SYNCHRONOUS: the tracker's timers are keyed to when the event
    // actually arrived, not to when the store next commits.
    if (event.type === 'chat.error' && event.chatId === 'pending-spawn') {
      // A host refusing a Settings edit (invalid settings.json, a memory it
      // does not hold) — addressed to no chat. Recorded for the editor that
      // sent it; still flows on to the store as before.
      useHostRefusalStore.getState().note(event.error.code, event.error.message);
    }
    deliveryTracker.observe(event);
    // Delivered, whatever the outcome — including a request the host
    // itself denied as expired. See permissionDeliveryTracker.ts.
    if (event.type === 'chat.permission_response') {
      permissionDeliveryTracker.ack(event.requestId);
    }
    // A batched replay is one frame carrying the whole answer (spec/12 §
    // Sequence-based replay). Unpack into the same queue the live path uses
    // — same events, same order, same reducer — and commit at once: there is
    // nothing still to come that it could coalesce with, and asking for a
    // batch was exactly so the transcript paints once instead of arriving.
    if (event.type === 'chat.replay_batch') {
      // Each inner event goes back through dispatch() so it gets the same
      // special-case side effects as a live one (diff rail, voice banner,
      // permission ack, host-refusal toast). dispatch() queues the chat events;
      // the flush below commits them at once.
      for (const inner of event.events) this.dispatch(inner as WireEvent);
      this.flushStoreQueue();
      return;
    }
    this.queueForStore(event);
  }

  /**
   * Hold a store event for up to one frame so a burst commits once.
   *
   * A `chat.replay` delivers a whole transcript at once — measured at 582
   * events in 444ms on a busy chat — and a commit per event meant a re-render
   * and a full-timeline regroup per event. Coalescing is what keeps opening a
   * long chat from locking the JS thread. Ordering is preserved: events are
   * committed in arrival order, and the store applies a batch as a single
   * sequential fold, so the result is identical to applying them one by one.
   */
  private queueForStore(event: WireEvent): void {
    this.storeQueue.push(event);
    if (this.storeFlushTimer !== null) return;
    this.storeFlushTimer = setTimeout(() => {
      this.storeFlushTimer = null;
      this.flushStoreQueue();
    }, STORE_BATCH_MS);
  }

  /** Commit everything gathered so far. Safe to call with an empty queue. */
  private flushStoreQueue(): void {
    if (this.storeQueue.length === 0) return;
    const batch = this.storeQueue;
    this.storeQueue = [];
    useChatStore.getState().applyEvents(batch);
    // Keep what was just drawn, so reopening this chat — or coming back after
    // Android has killed the app — paints from the phone instead of asking
    // the host for all of it again (spec/15 § Instant open). Only the durable
    // events are kept, and the write is coalesced; see transcriptCache.
    const byChat = new Map<string, unknown[]>();
    for (const event of batch) {
      const chatId = (event as { chatId?: unknown }).chatId;
      if (typeof chatId !== 'string') continue;
      const list = byChat.get(chatId);
      if (list) list.push(event);
      else byChat.set(chatId, [event]);
    }
    for (const [chatId, events] of byChat) saveEvents(chatId, events);
  }
}

let _singleton: PatchWs | null = null;
export function getWs(): PatchWs {
  if (!_singleton) _singleton = PatchWs.default();
  return _singleton;
}
export function resetWs(): void {
  _singleton?.close();
  _singleton = null;
}
