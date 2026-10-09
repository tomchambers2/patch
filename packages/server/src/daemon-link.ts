// Host link — INBOUND model.
//
// Per spec/10 (## Host registration, ## Tokens on the wire) the host
// authenticates INTO the server: it dials the server's `/ws` and presents an
// EdDSA-JWT `daemonKey` in its `hello` frame, exactly like a surface. The
// server no longer dials out to the host.
//
// The WS hello gate (`ws-hub.ts handleHello`) verifies the daemonKey and, on
// success, calls `attach(socket)` here. This object owns the single live
// host socket and presents the same `DaemonLink` interface the rest of the
// server already consumes (`send`, `onEvent`, `onStatus`, `status`, `close`),
// so surface fan-out logic is unchanged.
//
// Lifecycle:
//   - attach(socket): becomes online, flush buffered surface→host events,
//     wire socket frames → onEvent, socket close → detach.
//   - detach(): becomes offline. Surface→host events buffer (cap 10k per
//     surface, drop-oldest with a logged warning) until the host reconnects
//     (spec/12 offline behaviour).
//   - One socket PER MACHINE: attaching a second socket for the same machine
//     closes the older; a socket for a different machine is independent.
//
// For tests we expose `DaemonLink` as an interface; `InProcessDaemonLink` is
// the in-memory fake injected by unit/integration tests.

import type WebSocket from 'ws';
import type { Logger } from 'pino';
import type { HeldInputStore } from './held-input-store.js';
import {
  decode,
  encode,
  isReservedSpecialThread,
  OUT_OF_BAND_SEQ,
  type WireEvent,
} from '@patch/wire';

export interface DaemonLink {
  /**
   * The host on the other end of this link (spec/02 § Host identity).
   *
   * Presence frames name the machine they describe, and the authority on which
   * machine that is has to be the link itself — reading it back from a registry
   * lookup is how an anonymous `daemon.offline` gets attributed to the wrong
   * host once there is more than one. `null` before any host has ever
   * attached, in which case there is nothing truthful to announce.
   *
   * With several machines linked this is the ACCOUNT-DEFAULT machine (the home
   * host): the one an unaddressed, chat-less frame belongs to. Anything
   * host-specific must use `sendTo` / `onlineDaemonIds` instead.
   */
  daemonId(): string | null;
  /** Every machine with a live link right now. */
  onlineDaemonIds(): string[];
  /** Is this machine's link live? */
  isOnline(daemonId: string): boolean;
  /**
   * Send an event to ONE named machine. Buffered (per host, per surface) while
   * that machine is offline, exactly as `send` is.
   */
  sendTo(daemonId: string, surfaceId: string, event: WireEvent): void;
  /** Subscribe to per-host online/offline transitions. Returns unsub. */
  onHostStatus(handler: (daemonId: string, status: 'online' | 'offline') => void): () => void;
  /**
   * Send an event from a surface up to the host that owns it: the machine the
   * frame names, else the machine the frame's chat lives on, else the account's
   * home machine.
   */
  send(surfaceId: string, event: WireEvent): void;
  /**
   * Subscribe to events arriving from any host. The handler is told WHICH
   * machine sent the frame — a cross-host relay has to know the source to avoid
   * bouncing a frame back to the machine that raised it. Returns unsub.
   */
  onEvent(handler: (event: WireEvent, fromDaemonId: string | null) => void): () => void;
  /** Subscribe to online/offline transitions. Returns unsub. */
  onStatus(handler: (status: 'online' | 'offline') => void): () => void;
  /** Current connection status. */
  status(): 'online' | 'offline';
  /**
   * Epoch-ms of the last time the host link transitioned to `online`, or
   * null if it has never connected. Powers the Settings "host — last
   * heartbeat" line (spec/14 ## Routes; G4 settings task).
   */
  lastConnectedAt(): number | null;
  /**
   * DEV/TEST seam — synthesise an inbound host event into the same handler
   * pipeline a real socket frame would feed. Used by the dev-diag routes to
   * exercise host→surface flows (e.g. `device.session`) against the mock
   * stack, where there is no physical host emitting them. Never reachable in
   * production: the dev-diag routes are gated off there.
   */
  injectDaemonEvent(event: WireEvent): void;
  /**
   * Look at every frame a host sends before any handler does. The gate returns
   * the frame to pass on (it may be a changed copy) or `null` to drop it.
   * Frames from `injectDaemonEvent` are not gated.
   */
  setEventGate?(gate: (event: WireEvent, fromDaemonId: string | null) => WireEvent | null): void;
  /**
   * Drop a machine that was removed from the account: close its live socket
   * if any (which announces it offline like any drop), then discard its link
   * state, including frames buffered for it — they can never be delivered.
   * Returns true if a live socket was closed.
   */
  forget(daemonId: string): boolean;
  close(): Promise<void>;
}

export interface InboundDaemonLinkOptions {
  logger: Logger;
  /**
   * Where a person's message to an offline host is kept so a server restart
   * does not lose it. Absent keeps such messages in memory only.
   */
  heldInputs?: HeldInputStore;
  /**
   * The machine that runs the Manager and Speakers right now. Normally the home
   * machine; another one while it stands in for an offline home machine.
   */
  specialThreadHost?: () => string | null;
  /**
   * Which machine a chat lives on (the server's ChatRegistry mirror). A frame
   * that names no machine but names a chat belongs to that chat's machine —
   * routing it to "whichever host is attached" is the exact bug host
   * addressing exists to prevent. Absent before the registry is wired.
   */
  resolveChatHost?: (chatId: string) => string | null;
  /**
   * The account's home machine (spec/06) — where a frame that names neither a
   * machine nor a chat belongs (special threads, job dispatch, locks).
   */
  homeDaemonId?: () => string | null;
  /**
   * Every machine this account has ever registered (`Registry.registeredDaemonIds`)
   * — NOT just the ones with a live link right now. Lets `send()` tell "the
   * home machine is this account's only possible answer" from "there is more
   * than one machine this chat could actually live on, and guessing risks
   * asking the wrong one." Absent (or a single id) preserves the old
   * behaviour exactly: guess home and let `sendTo`'s own buffering carry it
   * until that machine reconnects, which is always correct when it is the
   * only machine there is.
   */
  registeredDaemonIds?: () => string[];
  /** Test seam for `UNKNOWN_CHAT_HOST_WAIT_MS` — defaults to the real wait. */
  unknownChatHostWaitMs?: number;
  /** Test seam for `UNKNOWN_CHAT_HOST_POLL_MS` — defaults to the real interval. */
  unknownChatHostPollMs?: number;
}

/**
 * How long a chat-scoped frame waits for the registry mirror to learn which
 * machine the chat lives on, before giving up (spec/12 § Reconnect races). A
 * server restart empties the mirror; the owning host repopulates it a few
 * seconds later, on reconnect (`onAuthed` replays `chat.spawned` +
 * `chat.state` for every chat it holds — see daemon/src/index.ts). Guessing
 * the account's home machine in that gap is the exact bug host addressing
 * exists to prevent everywhere else in this file: a chat that actually lives
 * on a DIFFERENT machine would be misrouted to the home one and come back
 * `chat_not_found` from a host that never owned it — a real, live chat
 * reported as gone (the reported bug: a redeploy's reconnect window showed
 * this on a chat that was fine).
 */
// Long enough for a host to redial after a deploy restarts the server (its
// reconnect backoff plus the resync) — 3s was shorter than that, so a live
// chat on a second machine got "Connection to this chat's host was lost."
// during every deploy. The frame is only held, never dropped, in the meantime.
const UNKNOWN_CHAT_HOST_WAIT_MS = 15_000;
const UNKNOWN_CHAT_HOST_POLL_MS = 200;

/**
 * Told to the requesting surface when a chat's host still hasn't registered
 * after the wait above. `daemon_unavailable`, not `chat_not_found`: the chat
 * is not gone, its host just has not reconnected yet, and surfaces already
 * treat this code as self-resolving (`TRANSIENT_CHAT_ERROR_CODES` — the
 * notice clears itself the moment the real host's next `chat.state` lands).
 */
const CHAT_HOST_UNKNOWN_MESSAGE = "Connection to this chat's host was lost.";

/**
 * Per-surface outbound buffer. Caps memory at 10k entries and drops oldest
 * when overflowing.
 */
const PER_SURFACE_BUFFER_CAP = 10_000;

/** One machine's live link state. */
interface HostLink {
  socket: WebSocket | null;
  status: 'online' | 'offline';
  connectedAt: number | null;
  /** surfaceId → events queued while this machine is offline. */
  buffers: Map<string, WireEvent[]>;
}

/**
 * Inbound-connection-backed DaemonLink for ANY NUMBER of machines. Each host
 * dials `/ws` and the hello gate hands us its authenticated socket via
 * `attach(socket, daemonId)`; this object keeps one entry per machine and
 * routes each surface frame to the machine it is about.
 */
export class InboundDaemonLink implements DaemonLink {
  private readonly hosts = new Map<string, HostLink>();
  private readonly eventHandlers = new Set<(e: WireEvent, from: string | null) => void>();
  private readonly statusHandlers = new Set<(s: 'online' | 'offline') => void>();
  private readonly hostStatusHandlers = new Set<
    (daemonId: string, s: 'online' | 'offline') => void
  >();
  private eventGate: ((e: WireEvent, from: string | null) => WireEvent | null) | null = null;
  /** Last machine to attach — the account default when nothing else names one. */
  private lastAttachedDaemonId: string | null = null;
  private closed = false;

  constructor(private readonly opts: InboundDaemonLinkOptions) {
    // Messages held for an offline host before this process started go back in
    // front of that host's buffer, so they flush when it attaches.
    for (const held of opts.heldInputs?.all() ?? []) {
      const link = this.hostLink(held.daemonId);
      let buf = link.buffers.get(held.surfaceId);
      if (!buf) {
        buf = [];
        link.buffers.set(held.surfaceId, buf);
      }
      buf.push(held.event);
    }
  }

  private hostLink(daemonId: string): HostLink {
    let link = this.hosts.get(daemonId);
    if (!link) {
      link = { socket: null, status: 'offline', connectedAt: null, buffers: new Map() };
      this.hosts.set(daemonId, link);
    }
    return link;
  }

  /**
   * The Manager and Speakers threads are the account's, and live on the home
   * machine (spec/06 § Where special threads run). A copy a different machine
   * still carries, from before it stopped being home, is not the account's
   * thread, so nothing it says about one is passed on. Without this two machines
   * both announce `thread_manager` and whichever spoke last is "the Manager".
   */
  private isStraySpecialThreadEvent(event: WireEvent, fromDaemonId: string): boolean {
    const chatId = (event as { chatId?: unknown }).chatId;
    if (typeof chatId !== 'string' || !isReservedSpecialThread(chatId)) return false;
    const home = this.opts.specialThreadHost?.() ?? this.opts.homeDaemonId?.() ?? null;
    return home !== null && home !== fromDaemonId;
  }

  /**
   * The account-default machine: the home machine when the registry names one
   * (and it is known here), else the machine that most recently attached, else
   * any machine we have ever seen. `null` when no machine has ever attached.
   */
  daemonId(): string | null {
    const home = this.opts.homeDaemonId?.() ?? null;
    if (home !== null) return home;
    if (this.lastAttachedDaemonId !== null) return this.lastAttachedDaemonId;
    return this.hosts.keys().next().value ?? null;
  }

  onlineDaemonIds(): string[] {
    return [...this.hosts.entries()].filter(([, l]) => l.status === 'online').map(([id]) => id);
  }

  isOnline(daemonId: string): boolean {
    return this.hosts.get(daemonId)?.status === 'online';
  }

  /**
   * Bind an authenticated host socket for ONE machine. Frames arriving on it
   * feed `onEvent`; socket close detaches that machine only. Buffered frames
   * for that machine flush immediately. A second socket for the SAME machine
   * closes the older one; a socket for a DIFFERENT machine is independent.
   */
  attach(socket: WebSocket, daemonId: string): void {
    if (this.closed) {
      try {
        socket.close();
      } catch {
        // ignore — shutting down
      }
      return;
    }
    const link = this.hostLink(daemonId);
    if (link.socket && link.socket !== socket) {
      this.opts.logger.warn({ daemonId }, 'host re-attached; closing previous host socket');
      const prev = link.socket;
      link.socket = null;
      // Force a genuine offline transition NOW, before the new socket takes
      // over. Without this, the trailing `setStatus(daemonId, 'online')`
      // below is a no-op (status never left 'online'), `onHostStatus`
      // handlers never see the drop, and `resolveInFlightChatsOnDaemonOffline`
      // (ws-hub.ts) never runs — stranding any chat that was running on the
      // now-dead process. `prev.close()`'s own async 'close' handler can't
      // cover this either: by the time it fires, `link.socket` already
      // points at the new socket, so its `link.socket !== socket` guard
      // bails.
      this.setStatus(daemonId, 'offline');
      try {
        prev.close();
      } catch {
        // ignore — already gone
      }
    }

    link.socket = socket;
    this.lastAttachedDaemonId = daemonId;

    socket.on('message', (raw: WebSocket.RawData) => {
      if (link.socket !== socket) return;
      const buf = Array.isArray(raw) ? Buffer.concat(raw) : (raw as Buffer);
      let event: WireEvent;
      try {
        event = decode(buf);
      } catch (err) {
        this.opts.logger.warn(
          { err: (err as Error).message, daemonId },
          'host frame decode error; dropping',
        );
        return;
      }
      if (this.isStraySpecialThreadEvent(event, daemonId)) return;
      const gated = this.eventGate ? this.eventGate(event, daemonId) : event;
      if (gated === null) return;
      for (const h of this.eventHandlers) h(gated, daemonId);
    });

    socket.on('close', () => {
      if (link.socket !== socket) return;
      this.opts.logger.warn({ daemonId }, 'host socket closed');
      link.socket = null;
      this.setStatus(daemonId, 'offline');
    });

    socket.on('error', (err: Error) => {
      this.opts.logger.warn({ err: err.message, daemonId }, 'host socket error');
      // `close` follows on its own.
    });

    this.opts.logger.info({ daemonId }, 'host attached');
    this.setStatus(daemonId, 'online');
    this.flushBuffers(daemonId);
  }

  private flushBuffers(daemonId: string): void {
    const link = this.hosts.get(daemonId);
    /* v8 ignore next */
    if (!link?.socket) return;
    const socket = link.socket;
    for (const [surfaceId, buf] of link.buffers.entries()) {
      while (buf.length > 0) {
        const ev = buf.shift();
        /* v8 ignore next */
        if (!ev) break;
        socket.send(encode(ev));
      }
      link.buffers.delete(surfaceId);
    }
    this.opts.heldInputs?.clearHost(daemonId);
  }

  send(surfaceId: string, event: WireEvent): void {
    const named = (event as { daemonId?: unknown }).daemonId;
    if (typeof named === 'string' && named.length > 0) {
      this.sendTo(named, surfaceId, event);
      return;
    }
    const chatId = (event as { chatId?: unknown }).chatId;
    if (typeof chatId === 'string' && chatId.length > 0) {
      const host = this.opts.resolveChatHost?.(chatId) ?? null;
      if (host !== null && host.length > 0) {
        this.sendTo(host, surfaceId, event);
        return;
      }
      // The registry mirror doesn't know this chat's host — most commonly the
      // few seconds right after a server restart, before the host that owns
      // it has reconnected and resynced. With only ONE machine ever
      // registered on this account, the home fallback below IS that chat's
      // host, whatever the mirror currently thinks — guess it and let
      // `sendTo`'s own offline buffering carry the frame until it reconnects,
      // exactly as before. It is only with more than one registered machine
      // that a guess can be WRONG: a chat living on a different one would be
      // misrouted to home and come back a false `chat_not_found` from a
      // host that never owned it — hold the frame instead and give the
      // real host a chance to register.
      const registered = this.opts.registeredDaemonIds?.() ?? [];
      if (registered.length > 1) {
        void this.waitForChatHostThenSend(chatId, surfaceId, event);
        return;
      }
    }
    const fallback = this.daemonId();
    if (fallback === null) {
      this.opts.logger.error(
        { type: event.type, surfaceId },
        'daemon-link: no machine to route this frame to; dropping',
      );
      return;
    }
    this.sendTo(fallback, surfaceId, event);
  }

  /**
   * Poll the registry mirror for a chat's host rather than guess it (see
   * `send()`). Resolves within the wait: routes there, same as an immediate
   * hit. Never resolves: tells the requesting surface `daemon_unavailable`
   * instead of silently dropping the frame or leaving it looking unanswered —
   * true either way, since we genuinely don't know this chat's host yet.
   */
  private async waitForChatHostThenSend(
    chatId: string,
    surfaceId: string,
    event: WireEvent,
  ): Promise<void> {
    const waitMs = this.opts.unknownChatHostWaitMs ?? UNKNOWN_CHAT_HOST_WAIT_MS;
    const pollMs = this.opts.unknownChatHostPollMs ?? UNKNOWN_CHAT_HOST_POLL_MS;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (this.closed) return;
      await this.sleep(pollMs);
      const host = this.opts.resolveChatHost?.(chatId) ?? null;
      if (host !== null && host.length > 0) {
        this.sendTo(host, surfaceId, event);
        return;
      }
    }
    if (this.closed) return;
    this.opts.logger.warn(
      { chatId, surfaceId, type: event.type },
      'daemon-link: chat host still unknown after wait; telling the surface rather than guessing',
    );
    // Fed through the same `onEvent` pipeline a real host frame would use
    // (`injectDaemonEvent`'s own mechanism, inlined here rather than calling
    // that method — it is a documented dev/test seam, and this is a genuine
    // production notice) so it reaches the requesting surface exactly like
    // any other addressed reply (`chat.replay`'s own `forSurfaceId` tagging).
    const notice: WireEvent = {
      type: 'chat.error',
      chatId,
      error: { code: 'daemon_unavailable', message: CHAT_HOST_UNKNOWN_MESSAGE },
      seq: OUT_OF_BAND_SEQ,
      forSurfaceId: surfaceId,
    };
    for (const h of this.eventHandlers) h(notice, null);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      t.unref();
    });
  }

  sendTo(daemonId: string, surfaceId: string, event: WireEvent): void {
    const link = this.hostLink(daemonId);
    if (link.socket && link.status === 'online') {
      link.socket.send(encode(event));
      return;
    }
    let buf = link.buffers.get(surfaceId);
    if (!buf) {
      buf = [];
      link.buffers.set(surfaceId, buf);
    }
    buf.push(event);
    if (event.type === 'chat.input') this.opts.heldInputs?.add(daemonId, surfaceId, event);
    if (buf.length > PER_SURFACE_BUFFER_CAP) {
      const dropped = buf.shift();
      this.opts.logger.warn(
        { surfaceId, daemonId, droppedType: dropped?.type, cap: PER_SURFACE_BUFFER_CAP },
        'daemon-link buffer overflow, dropped oldest',
      );
    }
  }

  onEvent(handler: (e: WireEvent, from: string | null) => void): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  onStatus(handler: (s: 'online' | 'offline') => void): () => void {
    this.statusHandlers.add(handler);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  onHostStatus(handler: (daemonId: string, s: 'online' | 'offline') => void): () => void {
    this.hostStatusHandlers.add(handler);
    return () => {
      this.hostStatusHandlers.delete(handler);
    };
  }

  /** Account-wide: online while ANY machine is linked. */
  status(): 'online' | 'offline' {
    return this.onlineDaemonIds().length > 0 ? 'online' : 'offline';
  }

  lastConnectedAt(): number | null {
    let latest: number | null = null;
    for (const link of this.hosts.values()) {
      if (link.connectedAt !== null && (latest === null || link.connectedAt > latest)) {
        latest = link.connectedAt;
      }
    }
    return latest;
  }

  injectDaemonEvent(event: WireEvent): void {
    for (const h of this.eventHandlers) h(event, this.daemonId());
  }

  setEventGate(gate: (e: WireEvent, from: string | null) => WireEvent | null): void {
    this.eventGate = gate;
  }

  /**
   * spec/10 ## Revocation — sever one machine's live socket (if any) without
   * permanently closing the link. A revoked machine's next hello is rejected by
   * the gate; this just stops the currently-open socket from relaying. Returns
   * true if a live socket was closed.
   */
  terminateDaemonSocket(daemonId?: string): boolean {
    const ids = daemonId !== undefined ? [daemonId] : [...this.hosts.keys()];
    let closedAny = false;
    for (const id of ids) {
      const link = this.hosts.get(id);
      if (!link?.socket) continue;
      const socket = link.socket;
      link.socket = null;
      this.setStatus(id, 'offline');
      closedAny = true;
      try {
        socket.close();
      } catch {
        // ignore — already gone
      }
    }
    return closedAny;
  }

  forget(daemonId: string): boolean {
    const closed = this.terminateDaemonSocket(daemonId);
    this.hosts.delete(daemonId);
    this.opts.heldInputs?.clearHost(daemonId);
    if (this.lastAttachedDaemonId === daemonId) this.lastAttachedDaemonId = null;
    return closed;
  }

  private setStatus(daemonId: string, s: 'online' | 'offline'): void {
    const link = this.hostLink(daemonId);
    if (link.status === s) return;
    const accountBefore = this.status();
    link.status = s;
    if (s === 'online') link.connectedAt = Date.now();
    for (const h of this.hostStatusHandlers) h(daemonId, s);
    const accountAfter = this.status();
    if (accountBefore !== accountAfter) {
      for (const h of this.statusHandlers) h(accountAfter);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [id, link] of this.hosts.entries()) {
      const socket = link.socket;
      link.socket = null;
      this.setStatus(id, 'offline');
      if (!socket) continue;
      try {
        socket.close();
      } catch {
        // ignore — already gone
      }
    }
  }
}

/**
 * In-process fake DaemonLink — used by integration tests as the upstream
 * that the server connects to. Tests can also push synthetic events
 * directly via `emit` and inspect what the server forwarded via `sent`.
 */
export class InProcessDaemonLink implements DaemonLink {
  /**
   * The host this stand-in link represents. Settable so a test can run two
   * links as two distinct machines, which is what every multi-host assertion
   * needs.
   */
  private attachedDaemonId: string | null = 'd1';
  /**
   * Extra machines this fake reports as online, so a test can exercise
   * multi-host routing without two real sockets. The primary
   * `attachedDaemonId` is always included while status is online.
   */
  private readonly extraOnline = new Set<string>();
  private readonly hostStatusHandlers = new Set<
    (daemonId: string, s: 'online' | 'offline') => void
  >();
  private readonly eventHandlers = new Set<(e: WireEvent, from: string | null) => void>();
  private readonly statusHandlers = new Set<(s: 'online' | 'offline') => void>();
  private currentStatus: 'online' | 'offline' = 'online';
  private connectedAt: number | null = Date.now();
  /**
   * Frames this fake link "sent". `daemonId` records the machine the frame was
   * ADDRESSED to (null when it went through the routing `send()` rather than
   * `sendTo()`), so a test can assert a reply went back to the requester and
   * not to the account's home machine.
   */
  readonly sent: Array<{ surfaceId: string; event: WireEvent; daemonId?: string }> = [];

  daemonId(): string | null {
    return this.attachedDaemonId;
  }

  /** Test helper: become a different host. */
  setDaemonId(id: string | null): void {
    this.attachedDaemonId = id;
  }

  /** Test helper: report an ADDITIONAL machine as linked. */
  addOnlineHost(id: string): void {
    this.extraOnline.add(id);
    for (const h of this.hostStatusHandlers) h(id, 'online');
  }

  /** Test helper: take one ADDITIONAL machine offline. */
  dropOnlineHost(id: string): void {
    if (!this.extraOnline.delete(id)) return;
    for (const h of this.hostStatusHandlers) h(id, 'offline');
  }

  onlineDaemonIds(): string[] {
    if (this.currentStatus !== 'online') return [];
    const ids = new Set(this.extraOnline);
    if (this.attachedDaemonId !== null) ids.add(this.attachedDaemonId);
    return [...ids];
  }

  isOnline(daemonId: string): boolean {
    return this.onlineDaemonIds().includes(daemonId);
  }

  sendTo(daemonId: string, surfaceId: string, event: WireEvent): void {
    this.sent.push({ surfaceId, event, daemonId });
  }

  onHostStatus(handler: (daemonId: string, s: 'online' | 'offline') => void): () => void {
    this.hostStatusHandlers.add(handler);
    return () => {
      this.hostStatusHandlers.delete(handler);
    };
  }

  send(surfaceId: string, event: WireEvent): void {
    this.sent.push({ surfaceId, event });
  }

  /** Test helper: push an event from the host to the server. */
  private eventGate: ((e: WireEvent, from: string | null) => WireEvent | null) | null = null;

  setEventGate(gate: (e: WireEvent, from: string | null) => WireEvent | null): void {
    this.eventGate = gate;
  }

  emit(event: WireEvent, fromDaemonId?: string): void {
    const from = fromDaemonId ?? this.attachedDaemonId;
    const gated = this.eventGate ? this.eventGate(event, from) : event;
    if (gated === null) return;
    for (const h of this.eventHandlers) h(gated, from);
  }

  injectDaemonEvent(event: WireEvent): void {
    const from = this.attachedDaemonId;
    for (const h of this.eventHandlers) h(event, from);
  }

  /** Machines `forget` was called for, in order — for tests to assert on. */
  readonly forgotten: string[] = [];

  forget(daemonId: string): boolean {
    this.forgotten.push(daemonId);
    const wasOnline = this.isOnline(daemonId);
    this.extraOnline.delete(daemonId);
    if (wasOnline) for (const h of this.hostStatusHandlers) h(daemonId, 'offline');
    if (this.attachedDaemonId === daemonId) this.attachedDaemonId = null;
    return wasOnline;
  }

  /** Test helper: flip status. */
  setStatus(s: 'online' | 'offline'): void {
    if (this.currentStatus === s) return;
    this.currentStatus = s;
    if (s === 'online') this.connectedAt = Date.now();
    for (const h of this.statusHandlers) h(s);
    if (this.attachedDaemonId !== null) {
      for (const h of this.hostStatusHandlers) h(this.attachedDaemonId, s);
    }
  }

  onEvent(handler: (e: WireEvent, from: string | null) => void): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }
  onStatus(handler: (s: 'online' | 'offline') => void): () => void {
    this.statusHandlers.add(handler);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }
  status(): 'online' | 'offline' {
    return this.currentStatus;
  }
  lastConnectedAt(): number | null {
    return this.connectedAt;
  }
  async close(): Promise<void> {
    /* nothing to do */
  }
}
