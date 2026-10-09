// WebSocket hub at /ws — surface auth gate + host relay.
//
// Per spec/01 + spec/03 + spec/10:
//   - accept WS upgrade, expect `hello` within 5s carrying an EdDSA-JWT
//   - verify JWT against the registry's user public key (and revocation)
//   - relay surface-events up to the host, daemon-events down to surfaces
//   - heartbeats drive presence
//   - dedup `chat.input` on (chatId, localId)
//
// NO FALLBACKS: malformed frame → close(4400). Auth failure → close(4401).
// Hello timeout → close(4408).

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type WebSocket from 'ws';
import { CLOSE_AUTH_FAILED, CLOSE_MALFORMED_FRAME as CLOSE_BAD_FRAME } from '@patch/wire';
import {
  decode,
  encode,
  isHostAddressedSurfaceEvent,
  isReadOnlyMirrorThread,
  OUT_OF_BAND_SEQ,
  SPECIAL_THREAD_IDS,
  type AuthOkHost,
  type ClaudeSettingsListEvent,
  type DaemonAccountEvent,
  type DaemonHostEvent,
  type FoldersListEvent,
  type WireEvent,
} from '@patch/wire';
import { verifySurfaceCredential, verifyDaemonKey, CredentialExpiredError } from '@patch/auth';
import type { Registry } from './registry.js';
import type { PresenceTracker, ClientBuildInfo } from './presence.js';
import type { DaemonLink } from './daemon-link.js';
import type { ChatRegistry } from './chat-registry.js';
import type { ComposerDraftStore } from './composer-drafts.js';
import type { ChatLogStore } from './chat-log-store.js';
import type { CommitAcks } from './commit-acks.js';
import type { ManagerFailover } from './manager-failover.js';
import type { QueueTracker } from './queue-tracker.js';
import type { ServerQueue } from './server-queue.js';
import type { NewChatDraftStore } from './new-chat-drafts.js';
import { InputDedupe } from './dedupe.js';
import { daemonLockstep } from './daemon-lockstep.js';

/**
 * Message shown to the user when an in-flight chat is force-resolved to
 * `errored` because the host link dropped mid-turn (spec/04 § Activity,
 * spec/12). It asks for nothing, because there is nothing to do: the host
 * persists the turns it owes (`pendingTurns` in its chat meta) and re-sends
 * them on hydrate, and a turn that outlived the blip was never interrupted and
 * reports its own completion when the link is back. Do not reword this into an
 * instruction to resend — that describes behaviour the system does not have.
 */
const DAEMON_LINK_LOST_MESSAGE = 'Connection to the host was lost. Message will resend.';

const HELLO_TIMEOUT_MS = 5_000;
const AUTH_BUFFER_LIMIT = 50;

// Both live in @patch/wire: a surface needs them to tell a dropped link from a
// REFUSED credential, so they are protocol, not server internals. Re-exported
// here because every existing caller imports them from the hub.
export { CLOSE_BAD_FRAME, CLOSE_AUTH_FAILED };
export const CLOSE_HELLO_TIMEOUT = 4408;
export const CLOSE_BUFFER_OVERFLOW = 4413;

type ConnState = 'awaiting-hello' | 'authenticating' | 'authed' | 'daemon' | 'closed';

/** Sentinel returned by handleHello when the authenticated client is the host. */
const DAEMON_CONN = Symbol('daemon-connection');

export type SurfaceKind = 'terminal' | 'web' | 'desktop' | 'mobile' | 'voice-device';

interface ConnectedSurface {
  socket: WebSocket;
  accountId: string;
  surfaceId: string;
  surfaceKind: 'terminal' | 'web' | 'desktop' | 'mobile' | 'voice-device';
  /**
   * Chats this surface is actively watching for *detail-level* events
   * (chat.message / chat.tool_call / chat.tool_result). Populated by
   * `chat.focus_change {chatId}`. State-level events (chat.spawned /
   * chat.state / chat.stopped) are always fanned out per spec/04.
   *
   * A pending replay also adds the chatId for the duration of the replay
   * stream so a surface that requests `chat.replay` doesn't have to also
   * `chat.focus_change` first.
   */
  watchedChats: Set<string>;
}

/**
 * Detail-level chat events that surfaces must explicitly subscribe to via
 * `chat.focus_change`. State-level events (spawned/state/stopped) are
 * unconditionally fanned out to all account surfaces — those drive the
 * sidebar.
 */
/** Events per `chat.replay_batch` frame when the server answers a replay itself. */
const REPLAY_CHUNK_EVENTS = 500;

const DETAIL_LEVEL_EVENT_TYPES = new Set<WireEvent['type']>([
  'chat.message',
  'chat.message_delta',
  'chat.tool_call',
  'chat.tool_result',
  'chat.permission_request',
  // A live reset of a question's countdown (spec/02 § Questions are not
  // approvals) matters only to a surface actually drawing that countdown —
  // which means this chat's detail stream, same as the request it updates.
  'chat.permission_expiry_update',
  // Queued type-ahead (spec/04 ## Message queueing) is part of a chat's detail
  // timeline — only surfaces focused on the chat render the pending queue.
  'chat.queued',
  'chat.dequeued',
  // A published artifact is a card in the chat's transcript (spec/14
  // § Artifacts) — only surfaces focused on the chat render it.
  'chat.artifact',
  // A tool run's one-line summary labels a row of that transcript.
  'chat.tool_run_summary',
  // spec/14 § File browser — live updates: only a surface with this chat's
  // file browser/editor actually open needs to know its cached copy of a
  // path just went stale. Every other watching-nothing surface has nothing
  // to invalidate.
  'patch.file_changed',
  // Meeting mode: the whole panel (transcript included) re-sent on every clip.
  // Only a surface watching the chat draws it.
  'meeting.state',
]);

export interface WsHubDeps {
  logger: Logger;
  /** The shared settings as a surface may see them, sent in every greeting. */
  sharedSettings?: () => WireEvent;
  registry: Registry;
  presence: PresenceTracker;
  daemonLink: DaemonLink;
  /**
   * Server-side mirror of chat activity. On daemon-link loss the hub queries it
   * for chats that were mid-turn so it can resolve them to `errored` (their
   * turn-completion event will never arrive from the now-gone host).
   */
  chatRegistry: ChatRegistry;
  /**
   * Server-owned composer drafts (spec/14 § Composer, spec/15 § Composer).
   * Account-wide, not per-machine — set/clear frames from a surface write
   * straight here, and the hub broadcasts every change to every OTHER
   * connected surface. Optional only so the many existing unit tests that
   * construct a bare hub and don't touch drafts don't all need one; production
   * (`app.ts`) always supplies a real store.
   */
  composerDrafts?: ComposerDraftStore;
  /**
   * What each chat is holding behind a running turn. A surface that asks for a
   * chat's replay is told the waiting messages too, since the host announces
   * them live only.
   */
  queueTracker?: QueueTracker;
  /** The server-run message queue, when it is turned on. */
  serverQueue?: ServerQueue;
  /**
   * The transcripts the server has seen pass through it. Answers a replay for a
   * chat whose host is offline, so the chat stays readable.
   */
  chatLogStore?: ChatLogStore;
  /** Told what the server committed, so each host can be told how far its chats reach. */
  commitAcks?: CommitAcks;
  /**
   * Which host runs the Manager when the home host is away, and the stretch of
   * the Manager's transcript the home host's own log is missing.
   */
  managerFailover?: ManagerFailover;
  /** Server-owned new-chat drafts (spec/14 § New chat drafts). */
  newChatDrafts?: NewChatDraftStore;
  /**
   * Bind the host's authenticated WS socket to the host link. Called by
   * the hello gate when a host presents a valid daemonKey. Production wires
   * `InboundDaemonLink.attach`; tests inject a spy. Absent → host hellos are
   * rejected (the in-process test link can't accept a real socket).
   */
  attachDaemon?: (socket: WebSocket, daemonId: string) => void;
  /** Override clock for tests (returns unix seconds). */
  nowSec?: () => number;
  /** Hello-frame timeout (override for tests). */
  helloTimeoutMs?: number;
  /** ULID generator for server-side ChatId allocation. */
  idGenerator: () => string;
  /** Group 11: optional surface→server call-response relay. */
  onCallResponse?: (surfaceId: string, event: import('@patch/wire').ChatCallResponseEvent) => void;
  /**
   * Content hash of the web bundle this server serves (`assets/index-<hash>.js`)
   * — sent on `auth.ok` so a surface live-reloads when a deploy changed it
   * (spec/14 § Live updates). A getter so it can be set after the SPA is
   * mounted; returns undefined when no SPA is served.
   */
  getAppVersion?: () => string | undefined;
  /**
   * This server's own version and the host build the update channel
   * currently publishes (`daemon-latest.json`: its version and the os/arch
   * targets it has artifacts for), so a host that connects on an older build
   * can be told to update (daemon-lockstep.ts). Absent in tests that do not
   * exercise it.
   */
  serverVersion?: string;
  publishedDaemon?: () => { version: string; targets: string[] } | null;
}

export class WsHub {
  /**
   * surfaceId → EVERY live socket authed as that surface.
   *
   * A surface can hold MORE THAN ONE connection at a time: the desktop app
   * opens extra windows (`/app/sidebar-window`, the tray popover) that auth
   * with the SAME surface credential. This used to be `surfaceId → conn`,
   * last-writer-wins — and that silently broke the first window: the second
   * connection evicted it from the map, then the second window's `close`
   * deleted the entry that (by then) belonged to nobody, leaving the FIRST
   * socket alive but unroutable. Its uplink still worked (`chat.input` kept
   * arriving) and heartbeats still pong'd on the socket directly, so nothing
   * on either side noticed — while every downstream event addressed to the
   * surface was dropped, and the chat sat on "Sending…" forever.
   *
   * So: a SET, fanned out to on every send, from which `close` removes only
   * the socket that actually closed.
   */
  private readonly surfaces = new Map<string, Set<ConnectedSurface>>();
  private readonly dedupe = new InputDedupe();
  private daemonStatusUnsub: (() => void) | null = null;
  private daemonEventUnsub: (() => void) | null = null;
  private composerDraftsUnsub: (() => void) | null = null;
  private newChatDraftsUnsub: (() => void) | null = null;
  /**
   * The last `daemon.host` self-description each host reported, keyed by
   * daemonId. A host emits it on link auth, so a surface that connects LATER
   * never sees it live — the server caches it and replays it inside the
   * `auth.ok` greeting so the Hosts list renders from the greeting alone
   * (spec/03 § Control → `auth.ok`).
   */
  private readonly lastHostReport = new Map<string, DaemonHostEvent>();
  /**
   * The last `daemon.account` per (daemonId, backendId). Keyed per BACKEND, not
   * per host: a machine can be connected on one backend and logged out on
   * another, and collapsing them would lose exactly the distinction Settings
   * has to show (spec/10 § Backend credentials).
   */
  private readonly lastAccountReport = new Map<string, Map<string, DaemonAccountEvent>>();
  /** ms-epoch each host's link was last seen; survives the link dropping. */
  private readonly hostLastSeenAt = new Map<string, number>();
  /**
   * The last folder registry each host published (`folders.list` /
   * `folders.updated` carry the COMPLETE list). Replayed to a surface in its
   * greeting so the picker is populated from the connect alone.
   */
  private readonly lastFolderList = new Map<string, FoldersListEvent>();
  /**
   * The last Claude Code settings + memory snapshot each host published
   * (`claude_settings.list` / `claude_settings.updated` carry the COMPLETE
   * state). Replayed to a surface in its greeting, same reasoning as
   * `lastFolderList`.
   */
  private readonly lastClaudeSettings = new Map<string, ClaudeSettingsListEvent>();
  /**
   * Which machine each live terminal session's shell is running on —
   * `sessionId → daemonId`, stamped from `patch.terminal.open` (the only
   * terminal frame that carries a `daemonId`; spec/03 § Terminal sessions).
   *
   * Every later frame for that session (`input`, `signal`, `close`) names only
   * the `sessionId`, so without this table the host link falls through to the
   * account-default machine and the keystrokes land on whichever host
   * attached last — a shell opened on host A becomes unreachable the moment a
   * second machine is online. Routing is by SESSION, not by "whatever the link
   * points at". NO FALLBACK: a session id we have never seen is refused.
   */
  private readonly terminalSessionHost = new Map<string, string>();
  /**
   * Build the host reported on its last successful hello (spec/11 § Version
   * reporting). The host has no presence record, and we deliberately KEEP this
   * after the link drops so the update panel can still name the build that went
   * offline instead of showing a blank.
   */
  private daemonBuild: ClientBuildInfo | null = null;
  /** Every host that has said hello, with the version it stated (daemon-lockstep.ts). */
  private readonly connectedDaemons = new Map<
    string,
    { socket: WebSocket; version: string; log: Logger }
  >();
  /** The published host build the last recheck saw; undefined before the first. */
  private lastPublishedDaemon: string | null | undefined = undefined;

  /** The host's last-reported build, or null if it has never linked. */
  getDaemonBuild(): ClientBuildInfo | null {
    return this.daemonBuild;
  }

  /**
   * Every host id in the registry — ANY number of machines (spec/01 § "a relay
   * for any number of machines"). Callers must already handle N.
   */
  private registeredDaemonIds(): string[] {
    // Single source of truth with the host-addressing gate: a revoked machine
    // is not registered, so it must not appear in the roster either — otherwise
    // a surface renders a machine whose every frame is refused.
    const ids = this.deps.registry.registeredDaemonIds();
    // A link can be attached before (or without) a registry record in dev and
    // test bring-ups. It is still a real host with a real id, and a surface
    // must see it in the roster — otherwise the machine it is talking to is
    // absent from its own Hosts list.
    for (const linked of this.deps.daemonLink.onlineDaemonIds()) {
      if (!ids.includes(linked)) ids.push(linked);
    }
    return ids;
  }

  /**
   * The account's HOME machine (spec/06). Exactly one machine holds it: the
   * registry's explicit choice, else the first registered machine.
   */
  private homeDaemonId(): string | null {
    return this.deps.registry.homeDaemonId() ?? this.registeredDaemonIds()[0] ?? null;
  }

  /**
   * Apply the SERVER-owned fields to a machine's self-description before it
   * reaches a surface: the user-editable name (`host.rename` is surface →
   * server) and the home flag (`host.set_home`). The registry is the authority
   * for both, so exactly one machine can claim home and a rename survives the
   * machine restarting.
   */
  private withServerOwnedHostFields(event: DaemonHostEvent): DaemonHostEvent {
    const name = this.deps.registry.hostName(event.daemonId);
    return {
      ...event,
      ...(name !== undefined ? { hostName: name } : {}),
      isHomeHost: this.homeDaemonId() === event.daemonId,
    };
  }

  /**
   * The `auth.ok` host roster: EVERY registered host with its presence and the
   * server's cached reports about it. A host that has never spoken gets
   * `host: null` and no accounts — the server says what it knows and does not
   * invent a description for a machine it has not heard from.
   */
  /**
   * The same roster the greeting carries, for `GET /api/hosts` (spec/01
   * § Endpoints). One source of truth: a REST caller and a connecting surface
   * must never be told different things about which machines exist.
   */
  hosts(): AuthOkHost[] {
    return this.hostRoster();
  }

  /**
   * Where the server can reach `daemonId`'s own audio WSS to relay a voice
   * session for a chat that lives there (`audio-relay.ts`). `undefined` when
   * this host has never reported in — there is nothing to relay to yet.
   */
  audioRelayHost(daemonId: string): string | undefined {
    return this.lastHostReport.get(daemonId)?.audioRelayHost;
  }

  private hostRoster(): AuthOkHost[] {
    return this.registeredDaemonIds().map((daemonId) => {
      const cachedRaw = this.lastHostReport.get(daemonId);
      const cached = cachedRaw ? this.withServerOwnedHostFields(cachedRaw) : undefined;
      // Strip the wire envelope; the greeting carries the payload.
      const { type: _envelope, ...host } = cached ?? { type: 'daemon.host' as const };
      void _envelope;
      const accounts = [...(this.lastAccountReport.get(daemonId)?.values() ?? [])].map((a) => {
        const { type: _accountEnvelope, ...rest } = a;
        void _accountEnvelope;
        return rest;
      });
      return {
        daemonId,
        online: this.deps.daemonLink.isOnline(daemonId),
        lastSeenAt: this.hostLastSeenAt.get(daemonId) ?? null,
        host: cached ? (host as Omit<DaemonHostEvent, 'type'>) : null,
        accounts: accounts as Omit<DaemonAccountEvent, 'type'>[],
      };
    });
  }

  constructor(private readonly deps: WsHubDeps) {
    // Pipe host → surfaces.
    this.daemonEventUnsub = deps.daemonLink.onEvent((event) => this.onDaemonEvent(event));
    // Presence names the machine it describes: the link tells us WHICH machine
    // changed, so a surface can never mistake one machine going offline for
    // another's. NO unaddressed presence frame is ever sent.
    this.daemonStatusUnsub = deps.daemonLink.onHostStatus((daemonId, status) => {
      if (status === 'online') this.hostLastSeenAt.set(daemonId, Date.now());
      const ev: WireEvent =
        status === 'online'
          ? { type: 'daemon.online', daemonId }
          : { type: 'daemon.offline', daemonId };
      for (const conn of this.allConns()) {
        conn.socket.send(encode(ev));
      }
      // Machines need the roster too: an agent's cross-chat call naming another
      // machine has to fail INSIDE the turn when that machine is down (spec/03
      // § Cross-chat tools), which means the calling machine must know it is
      // down without asking.
      for (const otherId of this.deps.daemonLink.onlineDaemonIds()) {
        if (otherId === daemonId) continue;
        this.deps.daemonLink.sendTo(otherId, 'presence', ev);
      }
      // The host owns every in-flight turn. When the link drops, the
      // turn-completion / activity event will never arrive, so a chat left in
      // `running` / `awaiting-permission` would spin forever — a SILENT failure
      // (the reported bug). Resolve those chats to `errored` LOUDLY so the UI
      // unsticks and the user can retry. Only chats on the machine that went
      // away: another machine's turns are unaffected. NO FALLBACK. spec/12 +
      // spec/04.
      if (status === 'offline') {
        this.resolveInFlightChatsOnDaemonOffline(daemonId);
        // Every shell on that machine died with it. Drop the routes so a
        // surface still holding those ids is told `unknown_session` instead of
        // having its keystrokes buffered for a shell that no longer exists.
        for (const [sessionId, host] of this.terminalSessionHost.entries()) {
          if (host === daemonId) this.terminalSessionHost.delete(sessionId);
        }
      }
    });
    // Composer drafts are account-wide, not per-machine (spec/14 § Composer):
    // every change — from a surface's own `composer_draft.set`/`clear`, or
    // from the chat-delete REST route clearing one server-side — fans out to
    // EVERY connected surface, including the one that sent it (harmless: it
    // already has this exact text, and re-applying is idempotent).
    this.composerDraftsUnsub =
      deps.composerDrafts?.onChange((change) => {
        const event: WireEvent =
          change.type === 'set'
            ? {
                type: 'composer_draft.updated',
                chatId: change.chatId,
                text: change.text,
                updatedAt: change.updatedAt,
              }
            : {
                type: 'composer_draft.cleared',
                chatId: change.chatId,
                updatedAt: change.updatedAt,
              };
        this.sendToAll(event);
      }) ?? null;
    // New-chat drafts: same account-wide fan-out.
    this.newChatDraftsUnsub =
      deps.newChatDrafts?.onChange((change) => {
        let event: WireEvent;
        if (change.type === 'set') {
          const { updatedAt, ...draft } = change.draft;
          event = { type: 'new_chat_draft.updated', draft, updatedAt };
        } else {
          event = { type: 'new_chat_draft.removed', id: change.id, updatedAt: change.updatedAt };
        }
        this.sendToAll(event);
      }) ?? null;
  }

  /**
   * On daemon-link loss, force every chat that was mid-turn into a visible
   * `errored` state for all connected surfaces. Emits the same pair the host
   * itself emits when a turn errors (chatRunner): a `chat.error` (toast) plus a
   * `chat.state` with `activity: 'errored'` + `lastError` (what flips the
   * spinner off). The registry mirror is updated so REST surfaces (cold-start /
   * pull-to-refresh) agree with the live stream. On reconnect the host
   * remains source of truth: a retried turn drives the chat back to `running`.
   */
  private resolveInFlightChatsOnDaemonOffline(daemonId: string): void {
    const inFlight = this.deps.chatRegistry
      .inFlightChatIds()
      .filter((chatId) => this.deps.chatRegistry.get(chatId)?.daemonId === daemonId);
    if (inFlight.length === 0) return;
    const at = Date.now();
    for (const chatId of inFlight) {
      const error = { code: 'daemon_unavailable' as const, message: DAEMON_LINK_LOST_MESSAGE };
      const errorEvent: WireEvent = {
        type: 'chat.error',
        chatId,
        error,
        // Server-generated control error, not part of the host's replayable
        // per-chat stream — surfaces must not treat it as a stream event.
        seq: OUT_OF_BAND_SEQ,
      };
      const stateEvent = this.deps.chatRegistry.markErrored(chatId, error, at);
      for (const conn of this.allConns()) {
        conn.socket.send(encode(errorEvent));
        if (stateEvent) conn.socket.send(encode(stateEvent));
      }
      this.deps.logger.warn(
        { chatId },
        'host link lost while chat in-flight; resolved chat to errored',
      );
    }
  }

  register(app: FastifyInstance): void {
    app.get('/ws', { websocket: true }, (socket, req) => {
      // Unreachable: Fastify always generates a request id (genReqId), so
      // req.id is never undefined in practice. Defensive fallback only.
      /* v8 ignore next */
      this.onConnect(socket, req.id ?? 'unknown');
    });
  }

  /** Drop all upstream subscriptions (test cleanup). */
  shutdown(): void {
    this.daemonEventUnsub?.();
    this.daemonStatusUnsub?.();
    this.composerDraftsUnsub?.();
    this.newChatDraftsUnsub?.();
    for (const conn of this.allConns()) {
      try {
        conn.socket.close();
      } catch {
        // ignore — socket already gone
        // (intentional swallow during teardown only)
      }
    }
    this.surfaces.clear();
  }

  // ---- surface socket registry ----

  /** Every live surface socket, across every surfaceId. */
  private *allConns(): Generator<ConnectedSurface> {
    for (const conns of this.surfaces.values()) yield* conns;
  }

  /** Live sockets for one surface (a snapshot — safe to send while iterating). */
  private connsFor(surfaceId: string): ConnectedSurface[] {
    const conns = this.surfaces.get(surfaceId);
    return conns ? [...conns] : [];
  }

  private addConn(conn: ConnectedSurface): void {
    let conns = this.surfaces.get(conn.surfaceId);
    if (!conns) {
      conns = new Set();
      this.surfaces.set(conn.surfaceId, conns);
    }
    conns.add(conn);
  }

  /** Remove one socket. Returns true when it was the surface's LAST one. */
  private removeConn(conn: ConnectedSurface): boolean {
    const conns = this.surfaces.get(conn.surfaceId);
    if (!conns) return false;
    conns.delete(conn);
    if (conns.size > 0) return false;
    this.surfaces.delete(conn.surfaceId);
    return true;
  }

  /**
   * Send to every live socket of one surface. Returns the number reached — 0
   * means the surface is genuinely gone (its windows all closed), which is the
   * only case in which an addressed event may be dropped.
   */
  private sendToConns(surfaceId: string, event: WireEvent): number {
    const conns = this.connsFor(surfaceId);
    if (conns.length === 0) return 0;
    const wire = encode(event);
    let sent = 0;
    for (const conn of conns) {
      try {
        conn.socket.send(wire);
        sent++;
      } catch (err) {
        this.deps.logger.error(
          { err: (err as Error).message, type: event.type, surfaceId },
          'failed to send addressed event to surface socket',
        );
      }
    }
    return sent;
  }

  // ---- connection lifecycle ----

  private onConnect(socket: WebSocket, reqId: string): void {
    const log = this.deps.logger.child({ reqId });
    log.info({}, 'ws connect');

    let state: ConnState = 'awaiting-hello';
    let authed: ConnectedSurface | null = null;
    const pending: WireEvent[] = [];

    const helloTimer = setTimeout(() => {
      // Unreachable: the hello frame handler always calls clearTimeout(
      // helloTimer) synchronously before any await, so this timer callback
      // only ever fires while state is still 'awaiting-hello'. Defensive
      // guard against a future refactor reordering that.
      /* v8 ignore next */
      if (state !== 'awaiting-hello') return;
      log.warn({}, 'ws hello timeout');
      // NOT auth.revoked — a hello timeout is transient, not a revocation. A
      // well-built client treats auth.revoked as "wipe credential + re-pair",
      // so sending it here would trigger a destructive re-pair loop. The close
      // code (4408) already signals the timeout distinctly.
      state = 'closed';
      socket.close(CLOSE_HELLO_TIMEOUT, 'hello timeout');
    }, this.deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS);

    const closeOnce = (code: number, reason: string): void => {
      // Unreachable: every 'message' handler branch that calls closeOnce
      // returns immediately afterward, and the handler's own top-of-function
      // `if (state === 'closed') return;` guard (below) already prevents any
      // later message from reaching closeOnce a second time on this
      // connection. Defensive idempotency guard, not a live branch today.
      /* v8 ignore next */
      if (state === 'closed') return;
      state = 'closed';
      try {
        socket.close(code, reason);
      } catch {
        // ignore
      }
    };

    socket.on('message', (raw: WebSocket.RawData) => {
      if (state === 'closed') return;
      // Host socket: the InboundDaemonLink owns inbound frames (it attached
      // its own `message` listener). The hub stays out of the way — including
      // skipping decode, since the link decodes for itself.
      if (state === 'daemon') return;

      const buf = Array.isArray(raw) ? Buffer.concat(raw) : (raw as Buffer);
      let event: WireEvent;
      try {
        event = decode(buf);
      } catch (err) {
        const reason = (err as Error).message;
        log.warn({ err: reason }, 'ws decode error');
        // Name the offending field and value back to the sender before closing.
        // A frame refused with a bare close code is indistinguishable from an
        // edit that did not save (spec/03 § Host events, unhappy paths).
        if (authed) {
          try {
            this.sendControlError(authed, 'invalid_frame', reason);
          } catch {
            // ignore — closing anyway
          }
        }
        closeOnce(CLOSE_BAD_FRAME, 'malformed frame');
        return;
      }

      if (state === 'awaiting-hello') {
        if (event.type !== 'hello') {
          log.warn({ type: event.type }, 'ws first frame not hello');
          closeOnce(CLOSE_AUTH_FAILED, 'expected hello');
          return;
        }
        clearTimeout(helloTimer);
        state = 'authenticating';
        // Auth verification is async; close on failure.
        void this.handleHello(socket, event, log)
          .then((conn) => {
            if (state !== 'authenticating') {
              // socket already closed (e.g. timeout, error) — drop result
              return;
            }
            if (!conn) {
              // handleHello already closed the socket
              state = 'closed';
              pending.length = 0;
              return;
            }
            if (conn === DAEMON_CONN) {
              // Host authenticated. The InboundDaemonLink now owns this
              // socket (message/close/error). The hub must not interpret
              // frames as surface events — drop anything buffered pre-auth.
              state = 'daemon';
              pending.length = 0;
              return;
            }
            authed = conn;
            state = 'authed';
            // Drain buffered frames in arrival order.
            const drained = pending.splice(0, pending.length);
            for (const buffered of drained) {
              if (state !== 'authed') break;
              this.handleSurfaceEvent(conn, buffered, log);
            }
          })
          .catch((err: unknown) => {
            log.warn({ err: (err as Error).message }, 'handleHello rejected');
            if (state === 'authenticating') {
              state = 'closed';
              pending.length = 0;
              // NOT auth.revoked — an unexpected auth-handling error (e.g. a
              // malformed token that threw) is not a revocation. The close code
              // (4401) already signals auth failure; sending auth.revoked would
              // make a client wipe its credential and force re-pair.
              try {
                socket.close(CLOSE_AUTH_FAILED, 'auth error');
              } catch {
                // ignore
              }
            }
          });
        return;
      }

      if (state === 'authenticating') {
        if (pending.length >= AUTH_BUFFER_LIMIT) {
          log.warn({ limit: AUTH_BUFFER_LIMIT }, 'ws auth-buffer overflow');
          pending.length = 0;
          closeOnce(CLOSE_BUFFER_OVERFLOW, 'auth buffer overflow');
          return;
        }
        pending.push(event);
        return;
      }

      // state === 'authed'
      // Unreachable: `authed` and `state = 'authed'` are always assigned
      // together in the hello-resolution handler above (never one without
      // the other) — this is a defensive invariant check, not a live branch.
      /* v8 ignore next 5 */
      if (!authed) {
        log.warn({}, 'authed state without conn');
        closeOnce(CLOSE_AUTH_FAILED, 'invariant');
        return;
      }
      this.handleSurfaceEvent(authed, event, log);
    });

    socket.on('close', () => {
      clearTimeout(helloTimer);
      state = 'closed';
      if (authed) {
        const conn = authed;
        const lastForSurface = this.removeConn(conn);
        log.info({ surfaceId: conn.surfaceId, lastForSurface }, 'ws close');
        // Presence goes offline only when the surface's LAST socket goes: a
        // second window closing must not mark the whole surface offline (nor,
        // as it once did, unroute the window that is still open).
        if (lastForSurface) this.deps.presence.offline(conn.accountId, conn.surfaceId);
      } else {
        log.info({}, 'ws close (pre-auth)');
      }
    });

    socket.on('error', (err: Error) => {
      log.warn({ err: err.message }, 'ws error');
    });
  }

  private async handleHello(
    socket: WebSocket,
    hello: Extract<WireEvent, { type: 'hello' }>,
    log: Logger,
  ): Promise<ConnectedSurface | typeof DAEMON_CONN | null> {
    const account = this.deps.registry.getAccount();
    if (!account) {
      log.warn({}, 'hello rejected: no account bootstrapped');
      socket.send(encode({ type: 'auth.revoked', reason: 'no account' }));
      socket.close(CLOSE_AUTH_FAILED, 'no account');
      return null;
    }
    if (!hello.auth) {
      log.warn({}, 'hello rejected: missing auth token');
      socket.send(encode({ type: 'auth.revoked', reason: 'missing auth' }));
      socket.close(CLOSE_AUTH_FAILED, 'missing auth');
      return null;
    }

    const nowSec = this.deps.nowSec ? this.deps.nowSec() : Math.floor(Date.now() / 1000);

    if (hello.clientType === 'daemon') {
      return this.handleDaemonHello(socket, hello, account, nowSec, log);
    }

    let claims;
    try {
      claims = await verifySurfaceCredential(hello.auth, {
        userPublicKey: account.userPublicKey,
        now: nowSec,
      });
    } catch (err) {
      // An EXPIRED-but-otherwise-valid credential is transient: the surface
      // should refresh / re-mint, NOT wipe its pairing. Emitting auth.revoked
      // here (the destructive "wipe credential + re-pair" signal) would force a
      // needless re-pair loop on every token expiry. Send the dedicated
      // auth.expired frame instead; reserve auth.revoked for genuine
      // revocations and tampered/forged credentials.
      if (err instanceof CredentialExpiredError) {
        log.warn(
          { err: err.message, clientType: hello.clientType, clientVersion: hello.clientVersion },
          'hello rejected: credential expired',
        );
        socket.send(encode({ type: 'auth.expired', reason: 'credential expired' }));
        socket.close(CLOSE_AUTH_FAILED, 'credential expired');
        return null;
      }
      // Name the client. Diagnosing a retry storm in the live log otherwise
      // means guessing WHICH surface holds the dead credential — phone, desktop,
      // a browser tab left open — and the crypto error alone cannot tell them
      // apart. The hello says who it is; record it.
      log.warn(
        {
          err: (err as Error).message,
          clientType: hello.clientType,
          clientVersion: hello.clientVersion,
        },
        'hello rejected: bad credential',
      );
      socket.send(encode({ type: 'auth.revoked', reason: 'invalid credential' }));
      socket.close(CLOSE_AUTH_FAILED, 'invalid credential');
      return null;
    }

    if (this.deps.registry.isRevoked(claims.surface_id)) {
      log.warn({ surfaceId: claims.surface_id }, 'hello rejected: revoked');
      socket.send(encode({ type: 'auth.revoked', reason: 'surface revoked' }));
      socket.close(CLOSE_AUTH_FAILED, 'revoked');
      return null;
    }

    const conn: ConnectedSurface = {
      socket,
      accountId: account.accountId,
      surfaceId: claims.surface_id,
      surfaceKind: claims.surface_kind as ConnectedSurface['surfaceKind'],
      watchedChats: new Set(),
    };
    this.addConn(conn);
    // Record the client's self-reported build alongside presence, so
    // `GET /api/version` can report what each DEVICE is running (spec/11 §
    // Version reporting) — not just what the box has published. This is the only
    // moment a client states its build, so it must be captured here.
    this.deps.presence.online(
      account.accountId,
      claims.surface_id,
      claims.surface_kind as ConnectedSurface['surfaceKind'],
      Date.now(),
      {
        version: hello.clientVersion,
        ...(hello.clientGitSha ? { gitSha: hello.clientGitSha } : {}),
        ...(hello.clientBuiltAt ? { builtAt: hello.clientBuiltAt } : {}),
      },
    );

    log.info(
      {
        accountId: account.accountId,
        surfaceId: claims.surface_id,
        surfaceKind: claims.surface_kind,
      },
      'ws authed',
    );

    // auth.ok welcome — surfaces don't have to infer success. Carries the
    // served web-bundle hash so the surface live-reloads after a deploy
    // (spec/14 § Live updates): every deploy restarts the server, so this
    // reconnect delivers the new version.
    const webBundleHash = this.deps.getAppVersion?.();
    socket.send(
      encode({
        type: 'auth.ok',
        accountId: account.accountId,
        surfaceId: claims.surface_id,
        hosts: this.hostRoster(),
        ...(webBundleHash ? { webBundleHash } : {}),
      }),
    );

    // Composer drafts (spec/14 § Composer): account-wide, not per-machine, so
    // unlike the per-host loop below this is sent once, right after auth.ok —
    // a newly-connecting surface needs the full snapshot even if every host is
    // asleep.
    const drafts = this.deps.composerDrafts?.list() ?? [];
    if (drafts.length > 0) {
      socket.send(encode({ type: 'composer_draft.list', drafts }));
    }

    // New-chat drafts: always sent (even empty) so a surface drops any draft
    // that was deleted elsewhere while it was away.
    if (this.deps.newChatDrafts) {
      socket.send(encode({ type: 'new_chat_draft.list', drafts: this.deps.newChatDrafts.list() }));
    }

    // Greet with each registered host's presence. Every registered host is
    // named — including ones that have never connected — so a surface can
    // render the whole Hosts list without waiting for a `daemon.online` that
    // an asleep machine will never send.
    for (const daemonId of this.registeredDaemonIds()) {
      socket.send(
        encode(
          this.deps.daemonLink.isOnline(daemonId)
            ? { type: 'daemon.online', daemonId }
            : { type: 'daemon.offline', daemonId },
        ),
      );
      // Each machine's folder registry, from the greeting alone (spec/03 §
      // Host events — `folders.list` is "sent on connect"). A host only emits
      // it when its own link authenticates, so a surface that connects later
      // would otherwise have an empty picker until something changed on that
      // machine. The server replays its cached snapshot per machine.
      const folders = this.lastFolderList.get(daemonId);
      if (folders) socket.send(encode(folders));
      // Each machine's Claude Code settings + memory entries, same reasoning
      // (spec/03 § Host events — `claude_settings.list` is "sent on connect").
      const claudeSettings = this.lastClaudeSettings.get(daemonId);
      if (claudeSettings) socket.send(encode(claudeSettings));
    }
    // The shared settings, from the greeting alone (spec/03 § Settings).
    const shared = this.deps.sharedSettings?.();
    if (shared) socket.send(encode(shared));

    return conn;
  }

  /**
   * Host hello gate (spec/10 ## Host registration). The host presents an
   * EdDSA-JWT daemonKey; we verify it against the account user key, confirm the
   * presented daemon_id matches the one registered in the registry, and check
   * revocation. On success the socket is handed to the InboundDaemonLink via
   * `attachDaemon`, and `daemon.online` fans out to surfaces.
   *
   * Close-code discipline mirrors the surface gate: only a *genuine* revocation
   * emits `auth.revoked` (a destructive signal that tells a client to wipe its
   * credential + re-pair). A bad/unknown/foreign daemonKey just closes 4401.
   */
  private async handleDaemonHello(
    socket: WebSocket,
    hello: Extract<WireEvent, { type: 'hello' }>,
    account: NonNullable<ReturnType<Registry['getAccount']>>,
    nowSec: number,
    log: Logger,
  ): Promise<typeof DAEMON_CONN | null> {
    if (!this.deps.attachDaemon) {
      log.error({}, 'host hello rejected: no attachDaemon wired');
      socket.close(CLOSE_AUTH_FAILED, 'host link unavailable');
      return null;
    }
    // Non-null: the surface-gate caller rejects a hello with no `auth` before
    // dispatching here, so a host hello always carries one.
    const auth = hello.auth as string;

    let claims;
    try {
      claims = await verifyDaemonKey(auth, {
        userPublicKey: account.userPublicKey,
        now: nowSec,
      });
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'host hello rejected: bad daemonKey');
      socket.close(CLOSE_AUTH_FAILED, 'invalid daemonKey');
      return null;
    }

    // A host must be registered, and the presented daemon_id must match.
    const registered = this.deps.registry.getDaemonKey(claims.daemon_id);
    if (!registered) {
      log.warn({ daemonId: claims.daemon_id }, 'host hello rejected: unknown host');
      socket.close(CLOSE_AUTH_FAILED, 'unknown host');
      return null;
    }

    if (this.deps.registry.isRevoked(claims.daemon_id)) {
      // Genuine revocation — emit auth.revoked so the host wipes its key.
      log.warn({ daemonId: claims.daemon_id }, 'host hello rejected: revoked');
      socket.send(encode({ type: 'auth.revoked', reason: 'host revoked' }));
      socket.close(CLOSE_AUTH_FAILED, 'host revoked');
      return null;
    }

    log.info({ daemonId: claims.daemon_id, label: claims.label }, 'host authed');

    // The host isn't a surface, so it has no presence record — stash its
    // self-reported build here for `GET /api/version` (spec/11 § Version
    // reporting). Survives the link dropping, so the panel can still say WHICH
    // host build went offline.
    this.daemonBuild = {
      version: hello.clientVersion,
      ...(hello.clientGitSha ? { gitSha: hello.clientGitSha } : {}),
      ...(hello.clientBuiltAt ? { builtAt: hello.clientBuiltAt } : {}),
    };

    // auth.ok welcome.
    socket.send(
      encode({
        type: 'auth.ok',
        accountId: account.accountId,
        surfaceId: claims.daemon_id,
        hosts: this.hostRoster(),
      }),
    );

    // Hand the live socket to the link. This flips status → online and fans
    // out daemon.online to surfaces (via the link's onStatus subscription set
    // up in the constructor). attach() also closes any prior host socket.
    this.deps.attachDaemon(socket, claims.daemon_id);
    this.connectedDaemons.set(claims.daemon_id, { socket, version: hello.clientVersion, log });
    this.bringDaemonInStep(socket, claims.daemon_id, hello.clientVersion, log);

    return DAEMON_CONN;
  }

  /**
   * Re-check every connected host when the published host build changes.
   *
   * A deploy restarts this server BEFORE it publishes the host (the host
   * lane runs last), so the hosts reconnect while the manifest still names
   * the old build and there is nothing yet to send them to. Without this they
   * would stay behind until they next happened to reconnect. Called on a timer
   * by the app; does nothing unless the published build actually moved.
   *
   * "Moved" includes a target being added at the same version: the Linux and
   * Mac artifacts are published a minute apart, and a Mac told to update in
   * that minute refuses (no darwin artifact yet) — so the Mac build landing
   * has to count as a change, or the Mac is never told again.
   */
  recheckDaemonVersions(): void {
    const published = this.deps.publishedDaemon?.() ?? null;
    const key = published
      ? `${published.version} ${[...published.targets].sort().join(',')}`
      : null;
    if (key === this.lastPublishedDaemon) return;
    this.lastPublishedDaemon = key;
    for (const [daemonId, d] of this.connectedDaemons) {
      if (d.socket.readyState !== d.socket.OPEN) {
        this.connectedDaemons.delete(daemonId);
        continue;
      }
      this.bringDaemonInStep(d.socket, daemonId, d.version, d.log);
    }
  }

  /**
   * A host on a different version from this server is a fault, not a state
   * (daemon-lockstep.ts). Behind with the matching build published: tell it to
   * update — its own gate holds the restart until its running turns finish.
   * Anything else it cannot fix is logged as an error naming which side is
   * stale, never left to surface later as a chat that cannot be reached.
   */
  private bringDaemonInStep(
    socket: WebSocket,
    daemonId: string,
    daemonVersion: string,
    log: Logger,
  ): void {
    const serverVersion = this.deps.serverVersion;
    if (!serverVersion || !this.deps.publishedDaemon) return;
    const publishedVersion = this.deps.publishedDaemon()?.version ?? null;
    const step = daemonLockstep({ serverVersion, daemonVersion, publishedVersion });
    const ctx = { daemonId, daemonVersion, serverVersion, publishedVersion };
    switch (step.kind) {
      case 'in-step':
      case 'incomparable':
        return;
      case 'update':
        log.warn(ctx, 'host is behind the server; telling it to update');
        socket.send(encode({ type: 'host.update', daemonId }));
        return;
      case 'unpublished':
        log.error(
          ctx,
          'host is behind the server and the matching host build is not published — deploy the host',
        );
        return;
      case 'server-behind':
        log.error(ctx, 'host is AHEAD of the server — the server is stale; deploy the server');
        return;
    }
  }

  /**
   * Refuse a surface frame with a named reason. Control errors carry
   * `OUT_OF_BAND_SEQ`: they are not part of any chat's replayable stream.
   */
  private sendControlError(
    conn: ConnectedSurface,
    code: 'invalid_frame' | 'host_not_registered',
    message: string,
    chatId = 'pending-spawn',
  ): void {
    conn.socket.send(
      encode({
        type: 'chat.error',
        chatId,
        error: { code, message },
        seq: OUT_OF_BAND_SEQ,
      }),
    );
  }

  /**
   * Re-publish a machine's self-description to every surface after the SERVER
   * changed something it owns (its name, the home flag). Without this the
   * change would only appear the next time the machine happened to speak.
   */
  private republishHost(daemonId: string): void {
    const cached = this.lastHostReport.get(daemonId);
    if (!cached) return;
    const updated = this.withServerOwnedHostFields(cached);
    this.lastHostReport.set(daemonId, cached);
    const wire = encode(updated);
    for (const conn of this.allConns()) conn.socket.send(wire);
  }

  // ---- surface → host ----

  private handleSurfaceEvent(conn: ConnectedSurface, event: WireEvent, log: Logger): void {
    const slog = log.child({
      accountId: conn.accountId,
      surfaceId: conn.surfaceId,
      ...('chatId' in event && typeof event.chatId === 'string' ? { chatId: event.chatId } : {}),
    });

    // ---- host addressing gate (spec/03 § Host events, spec/04 § Spawn) ----
    // Every surface→server frame that carries a `daemonId` names ONE machine.
    // If that machine is not registered against this account the frame is
    // refused HERE, before any id is allocated or anything is relayed, and the
    // surface is told which value was wrong. Relaying it would hand the work to
    // whichever host happens to be attached — indistinguishable from correct
    // routing while one machine is online, and the wrong filesystem the moment
    // there are two. NO FALLBACK.
    // Gated by TYPE, not merely by "has a daemonId": a frame of a type that is
    // not valid surface→server at all must still be rejected as a bad type
    // (4400) rather than answered with a host error, so the two checks must not
    // compete for the same frame.
    const addressed = isHostAddressedSurfaceEvent(event.type)
      ? (event as { daemonId?: unknown }).daemonId
      : undefined;
    if (typeof addressed === 'string' && !this.deps.registry.isRegisteredDaemon(addressed)) {
      slog.warn(
        { type: event.type, daemonId: addressed, known: this.deps.registry.registeredDaemonIds() },
        'host-addressed frame rejected: unregistered daemonId',
      );
      const chatId =
        'chatId' in event && typeof event.chatId === 'string' ? event.chatId : 'pending-spawn';
      conn.socket.send(
        encode({
          type: 'chat.error',
          chatId,
          error: {
            code: 'host_not_registered',
            message: `no machine registered with daemonId: ${addressed}`,
          },
          // Control error with no chat behind it — never a replayable stream event.
          seq: OUT_OF_BAND_SEQ,
        }),
      );
      return;
    }

    // The server-run queue (spec/04 § Message queueing) answers the controls
    // for the messages it holds itself; any other message is the host's.
    const queue = this.deps.serverQueue;
    if (queue) {
      if (event.type === 'chat.unqueue_request' && queue.unqueue(event.chatId, event.localId)) {
        return;
      }
      if (
        event.type === 'chat.edit_queued_request' &&
        queue.edit(event.chatId, event.localId, event.message)
      ) {
        return;
      }
      if (
        event.type === 'chat.promote_request' &&
        queue.promote(event.chatId, event.localId, conn.surfaceId)
      ) {
        return;
      }
    }
    switch (event.type) {
      case 'surface.heartbeat': {
        this.deps.presence.heartbeat(conn.accountId, conn.surfaceId);
        // Pong so the surface has an application-level liveness signal and can
        // detect a half-open ("zombie") socket on flaky mobile / train data —
        // where TCP dies silently and the browser never fires `close`. Best
        // effort: a throwing socket must not take the hub down (terminateSurface
        // handles dead sockets elsewhere).
        try {
          conn.socket.send(encode({ type: 'surface.heartbeat_ack' }));
        } catch (err) {
          slog.warn({ err }, 'failed to send surface.heartbeat_ack');
        }
        return;
      }
      case 'surface.input': {
        this.deps.presence.input(conn.accountId, conn.surfaceId, event.idleMs);
        return;
      }
      case 'surface.foregrounded':
      case 'surface.backgrounded': {
        // Not persisted (we reuse heartbeat semantics so a surface that
        // explicitly foregrounds doesn't fall stale).
        this.deps.presence.heartbeat(conn.accountId, conn.surfaceId);
        return;
      }
      case 'chat.focus_change': {
        this.deps.presence.setFocus(conn.accountId, conn.surfaceId, event.chatId);
        if (event.chatId === null) {
          // Unsubscribe from everything.
          conn.watchedChats.clear();
        } else {
          conn.watchedChats.add(event.chatId);
        }
        // Forward upstream so the host can route notifications correctly.
        // Stamp the originating surfaceId (same pattern as chat.replay) so the
        // host can re-target that surface's open voice session — the bare
        // event has no surfaceId and the host link drops the routing arg.
        // spec/07 ## Focus-follow.
        const taggedFocus: WireEvent = { ...event, forSurfaceId: conn.surfaceId };
        this.deps.daemonLink.send(conn.surfaceId, taggedFocus);
        return;
      }
      case 'chat.input': {
        // spec/06 ## Composer policy: Speakers is a read-only
        // mirror. The web/mobile composer is hidden there, but a buggy or
        // hostile surface could still emit a raw `chat.input`. Reject it at
        // the hub so a desk-typed turn can never land on a passive-mirror
        // thread (whose real ingress is the voice device).
        if (isReadOnlyMirrorThread(event.chatId)) {
          slog.warn(
            { chatId: event.chatId, localId: event.localId },
            'chat.input rejected: read-only mirror thread (composer disabled)',
          );
          return;
        }
        // Idempotency is enforced at the HOST on `(chatId, localId)` — it is
        // the single source of truth (spec/03 § Idempotency, spec/12 §
        // Guaranteed input delivery). The server must NOT drop a duplicate: a
        // surface's pending-timeout REDELIVERY (healing a link flap that lost
        // the first send to a dying socket, or a server-restart that wiped the
        // buffer) carries the same `localId` and MUST reach the host, which
        // dedups it and re-emits `chat.input_ack` so the retry is answered. A
        // server-side drop here would strand the flap case forever (the host
        // never got the original, and never sees the retry) — the exact silent
        // hang this mechanism closes. We still `observe` so the dedup window is
        // populated for metrics/logging, but forward regardless of freshness.
        const fresh = this.dedupe.observe(conn.accountId, event.chatId, event.localId);
        if (!fresh) {
          slog.info(
            { localId: event.localId },
            'chat.input redelivery — forwarding to host (host dedups + re-acks)',
          );
        }
        // chat.input is a focus signal too — surface clearly cares about this chat.
        conn.watchedChats.add(event.chatId);
        // Group 12 (HIGH-1): strip `source` on the surface ingress path.
        // Only the voice-device hook may attach `source`
        // (per ChatInputSource JSDoc). A surface that sets it would otherwise
        // spoof the reply-router into routing the next assistant message to
        // an attacker-chosen voice device.
        const { source: _spoofGuard, ...sanitized } = event;
        void _spoofGuard;
        const sanitizedEvent = sanitized as typeof event;
        if (this.deps.serverQueue?.enqueueIfBusy(conn.surfaceId, sanitizedEvent)) return;
        this.deps.serverQueue?.noteForwarded(sanitizedEvent.chatId);
        this.deps.daemonLink.send(conn.surfaceId, sanitizedEvent);
        return;
      }
      case 'chat.spawn_request': {
        // Allocate the ChatId server-side per spec/04 (ULID). The host
        // honours the supplied id rather than generating its own.
        const chatId = event.chatId ?? this.deps.idGenerator();
        const tagged: WireEvent = { ...event, chatId };
        conn.watchedChats.add(chatId);
        this.deps.daemonLink.send(conn.surfaceId, tagged);
        return;
      }
      case 'chat.call_response': {
        // Group 11: surface-side accept/decline. Server-routed to the
        // call orchestrator via the dedicated callbacks rather than the
        // host link.
        if (this.deps.onCallResponse) {
          this.deps.onCallResponse(conn.surfaceId, event);
        }
        return;
      }
      // ---- composer drafts the SERVER owns (spec/14 § Composer) ----
      // Not relayed to the host at all — a chat's host can be asleep while
      // its draft still has to reach every other open surface. The store's own
      // `onChange` (wired in the constructor) does the broadcast, so these
      // cases are just the write.
      case 'composer_draft.set': {
        this.deps.composerDrafts?.set(event.chatId, event.text);
        return;
      }
      case 'composer_draft.clear': {
        this.deps.composerDrafts?.clear(event.chatId);
        return;
      }
      case 'new_chat_draft.set': {
        this.deps.newChatDrafts?.set(event.draft);
        return;
      }
      case 'new_chat_draft.remove': {
        this.deps.newChatDrafts?.remove(event.id);
        return;
      }
      // ---- host-scoped controls the SERVER owns (spec/03 § Host events) ----
      // The registry entry — not the machine — holds the user-editable name and
      // which machine is home, so these two are answered here and the result is
      // pushed to every surface. The machine is told as well, so its own CLI
      // and self-description agree with the registry.
      case 'host.rename': {
        try {
          this.deps.registry.setHostName(event.daemonId, event.hostName);
        } catch (err) {
          this.sendControlError(conn, 'invalid_frame', (err as Error).message);
          return;
        }
        slog.info(
          { daemonId: event.daemonId, hostName: event.hostName },
          'host renamed (server registry)',
        );
        this.deps.daemonLink.sendTo(event.daemonId, conn.surfaceId, event);
        this.republishHost(event.daemonId);
        return;
      }
      case 'host.set_home': {
        try {
          this.deps.registry.setHomeDaemonId(event.daemonId);
        } catch (err) {
          this.sendControlError(conn, 'invalid_frame', (err as Error).message);
          return;
        }
        slog.info({ daemonId: event.daemonId }, 'home machine changed');
        // EVERY machine's flag moves: the new home gains it and the previous
        // one loses it, so exactly one machine reports it.
        for (const daemonId of this.registeredDaemonIds()) {
          this.deps.daemonLink.sendTo(daemonId, conn.surfaceId, {
            type: 'host.set_home',
            daemonId: event.daemonId,
          });
          this.republishHost(daemonId);
        }
        return;
      }
      // ---- host-scoped controls the MACHINE owns ----
      // Relayed to the machine the frame names (never to whichever machine
      // happens to be attached — the gate above already refused an id this
      // account has not registered).
      case 'host.settings':
      case 'host.component_install':
      case 'host.component_remove':
      case 'host.update':
      case 'host.folder_add':
      case 'host.folder_remove':
      // These three reach the host the same way as their siblings above, and
      // were missing from this list — so the surface sent them, the host knew
      // how to handle them, and the SERVER dropped them in between. Because the
      // gap lands in `default:`, the frame was not merely ignored: it was warned
      // about as "disallowed" and the surface's socket was closed under it. Its
      // pending state ("Adding…") then had nothing to resolve it, so the account
      // simply never appeared and nothing said why.
      //
      // Anything relayed to a machine needs a case here as well as a wire type,
      // a UI sender and a host handler; three of those four are no use.
      case 'host.backend_add_account':
      case 'host.backend_usage_refresh':
      case 'host.claude_settings_discard':
      case 'host.claude_memory_delete':
      case 'host.claude_memory_set': {
        this.deps.daemonLink.sendTo(event.daemonId, conn.surfaceId, event);
        return;
      }
      case 'chat.permission_response':
      case 'chat.stop_request':
      case 'chat.unqueue_request':
      case 'chat.resume_now_request':
      case 'chat.promote_request':
      case 'chat.edit_queued_request':
      case 'chat.fork_request':
      case 'chat.side_request':
      case 'chat.branch_switch_request':
      case 'chat.branch_rename_request':
      case 'chat.send_back_request':
      case 'chat.resume_request':
      case 'chat.pin_request':
      case 'meeting.control_request':
      case 'meeting.get_request':
      case 'meeting.audio':
      case 'meeting.action_request':
      case 'chat.archive_request':
      case 'chat.snooze_request':
      case 'chat.hide_request':
      case 'file.write':
      case 'chat.settings':
      // spec/04 § Model — the chat's host owns its model, so the surface's
      // switch is relayed untouched and answered by the `chat.state` that host
      // emits. The server holds no model of its own to keep in step.
      case 'chat.model_request':
      case 'patch.peek.request':
      case 'patch.send_to':
      case 'patch.spawn':
      case 'ack': {
        if ('chatId' in event && typeof event.chatId === 'string') {
          conn.watchedChats.add(event.chatId);
        }
        this.deps.daemonLink.send(conn.surfaceId, event);
        return;
      }
      case 'patch.terminal.open': {
        // spec/03 § Terminal sessions. A terminal is per-SURFACE, not per-chat:
        // stamp the originating surfaceId so the host streams stdout/stderr
        // back to this surface alone (onDaemonEvent's forSurfaceId path) rather
        // than fanning a shell's output out to every connected client.
        //
        // `open` is the ONLY terminal frame that names a machine, so it is also
        // where this session's host is recorded for every later frame.
        this.terminalSessionHost.set(event.sessionId, event.daemonId);
        const tagged: WireEvent = { ...event, forSurfaceId: conn.surfaceId };
        this.deps.daemonLink.sendTo(event.daemonId, conn.surfaceId, tagged);
        return;
      }
      case 'patch.terminal.input':
      case 'patch.terminal.signal':
      case 'patch.terminal.resize':
      case 'patch.terminal.close': {
        // Route by SESSION: the shell lives on exactly one machine and these
        // frames carry no daemonId of their own. Falling through to the link's
        // account-default machine would deliver a host-A session's keystrokes
        // to host B. NO FALLBACK — an unknown session is refused to the surface
        // that sent it.
        const daemonId = this.terminalSessionHost.get(event.sessionId);
        if (daemonId === undefined) {
          slog.warn(
            { type: event.type, sessionId: event.sessionId },
            'terminal frame for a session this server never opened; refusing',
          );
          conn.socket.send(
            encode({
              type: 'patch.terminal.error',
              sessionId: event.sessionId,
              code: 'unknown_session',
              message: `no terminal session ${event.sessionId}`,
            }),
          );
          return;
        }
        if (event.type === 'patch.terminal.close') this.terminalSessionHost.delete(event.sessionId);
        const tagged: WireEvent = { ...event, forSurfaceId: conn.surfaceId };
        this.deps.daemonLink.sendTo(daemonId, conn.surfaceId, tagged);
        return;
      }
      case 'chat.replay': {
        // Replay is per-surface: tag with the surfaceId so the host can
        // direct the stream back to this surface only.
        conn.watchedChats.add(event.chatId);
        const tagged: WireEvent = { ...event, forSurfaceId: conn.surfaceId };
        this.deps.daemonLink.send(conn.surfaceId, tagged);
        this.replayHeldTranscript(conn, event);
        for (const queued of this.deps.queueTracker?.snapshot(event.chatId) ?? []) {
          conn.socket.send(encode(queued));
        }
        return;
      }
      case 'hello': {
        slog.warn({}, 'unexpected hello after auth');
        conn.socket.close(CLOSE_BAD_FRAME, 'duplicate hello');
        return;
      }
      // Frames that should never arrive surface→server are an immediate close.
      default: {
        slog.warn({ type: event.type }, 'rejecting surface→server frame of disallowed type');
        conn.socket.close(CLOSE_BAD_FRAME, 'frame type not valid surface→server');
        return;
      }
    }
  }

  /**
   * A replay for a chat whose host is offline cannot be answered by the host,
   * so answer it from the transcript the server holds. The request is still
   * sent on: the host answers it when it is back, and a surface drops the
   * events it already has.
   */
  private replayHeldTranscript(
    conn: { socket: { send(data: string): void } },
    request: Extract<WireEvent, { type: 'chat.replay' }>,
  ): void {
    const store = this.deps.chatLogStore;
    if (!store) return;
    const hostId = this.deps.chatRegistry.get(request.chatId)?.daemonId;
    const hostOffline = hostId !== undefined && !this.deps.daemonLink.isOnline(hostId);
    // The home host's own log does not hold what the Manager said while another
    // host stood in for it, so that stretch is added from the server's copy.
    const events = hostOffline
      ? store.read(request.chatId, request.fromSeq)
      : request.chatId === SPECIAL_THREAD_IDS.manager
        ? (this.deps.managerFailover?.gapEvents(request.fromSeq) ?? [])
        : [];
    if (events.length === 0) return;
    if (request.batch !== true) {
      for (const e of events) conn.socket.send(encode(e));
      return;
    }
    for (let i = 0; i < events.length; i += REPLAY_CHUNK_EVENTS) {
      conn.socket.send(
        encode({
          type: 'chat.replay_batch',
          chatId: request.chatId,
          events: events.slice(i, i + REPLAY_CHUNK_EVENTS),
          done: i + REPLAY_CHUNK_EVENTS >= events.length,
        }),
      );
    }
  }

  /** Does this host say it takes queued messages from the server? */
  hostServerQueue(daemonId: string): boolean {
    return this.lastHostReport.get(daemonId)?.serverQueue === true;
  }

  // ---- host → surfaces ----

  private onDaemonEvent(event: WireEvent): void {
    // The server is the log of record (spec/01 § Message log): a finished event
    // is written before anything is broadcast, so what a surface sees live is
    // already on the server's disk. A resend of one it holds is not broadcast
    // again, and an event that contradicts the log is refused and said so.
    // A replay (addressed to one surface) is not new and is only kept.
    if (this.deps.chatLogStore) {
      const replay =
        event.type === 'chat.replay_batch' ||
        typeof (event as { forSurfaceId?: unknown }).forSurfaceId === 'string';
      if (replay) {
        this.deps.chatLogStore.observe(event);
      } else {
        const outcome = this.deps.chatLogStore.commit(event);
        if (outcome === 'duplicate') return;
        if (outcome === 'conflict') {
          this.deps.logger.error(
            { type: event.type, chatId: (event as { chatId?: string }).chatId },
            'ws-hub: a host event contradicts the committed log; not broadcast',
          );
          return;
        }
        if (outcome === 'new' || outcome === 'updated') {
          const { chatId, seq } = event as { chatId: string; seq: number };
          const host = this.deps.chatRegistry.get(chatId)?.daemonId;
          if (host !== undefined) this.deps.commitAcks?.note(chatId, host, seq);
        }
      }
    }
    // Host↔server-only frames are consumed by a server-side bridge and never
    // relayed onward. `patch.artifact.publish_request` carries a whole HTML
    // page and a chatId, so without this it would fan out to every watching
    // surface (spec/03 § Artifacts: "Never fanned out to surfaces").
    // `patch.host_files.response` is answered over REST to the one caller that
    // asked (spec/03 § Host files); relaying it would put a file's whole
    // content on every connected surface. `patch.chat_search.response` is the
    // same: answered over REST, and it carries message text. So is
    // `patch.chat_move.response`, which can carry a whole chat.
    // `patch.host_keys.response` carries no key value, but it is one caller's
    // answer (spec/02 § Provider keys); everyone else learns from `daemon.host`.
    if (
      event.type === 'patch.artifact.publish_request' ||
      event.type === 'patch.artifact.publish_response' ||
      // Pad file bundles and answers: consumed by the pads bridge (spec/14 § Pads).
      event.type === 'patch.pad.request' ||
      event.type === 'patch.pad.response' ||
      event.type === 'patch.host_files.response' ||
      event.type === 'patch.chat_move.response' ||
      event.type === 'patch.chat_search.response' ||
      // A host's question to the server-run queue is answered by the server alone.
      event.type === 'patch.queue_pull.request' ||
      // What the server asked a host to resend is taken into the log, not shown to surfaces.
      event.type === 'patch.log_sync.batch' ||
      // Shared settings (spec/03 § Settings): consumed by the settings service.
      // `settings.secret_update`, `settings.adopt.response` and
      // `settings.account_signed_in` carry credential values; surfaces learn the
      // outcome from `settings.changed`, which never does.
      event.type === 'settings.applied' ||
      event.type === 'settings.secret_update' ||
      event.type === 'settings.adopt.response' ||
      event.type === 'settings.account_signed_in'
    ) {
      return;
    }
    // A session that has ended can no longer be addressed — forget which
    // machine it was on so a stale id is refused rather than mis-routed.
    if (event.type === 'patch.terminal.exit') {
      this.terminalSessionHost.delete(event.sessionId);
    }
    // Cache each host's self-description and per-backend credential state so a
    // late-joining surface gets them inside its auth.ok greeting (a host only
    // emits them on link auth and on change).
    if (event.type === 'daemon.host') {
      this.lastHostReport.set(event.daemonId, event);
      this.hostLastSeenAt.set(event.daemonId, Date.now());
      // The name and the home flag are SERVER-owned (spec/03: `host.rename` and
      // `host.set_home` are surface → server). Overwrite what the machine
      // reported before any surface sees it, so a rename is not undone by the
      // machine's next self-description and two machines can never both claim
      // home.
      event = this.withServerOwnedHostFields(event);
    }
    if (event.type === 'folders.list' || event.type === 'folders.updated') {
      // Cache per machine so a late-joining surface gets the snapshot in its
      // greeting (see handleHello). `folders.updated` supersedes it: both carry
      // the COMPLETE list for that machine.
      this.lastFolderList.set(event.daemonId, {
        type: 'folders.list',
        daemonId: event.daemonId,
        roots: event.roots,
        recent: event.recent,
      });
    }
    if (event.type === 'claude_settings.list' || event.type === 'claude_settings.updated') {
      // Cache per machine so a late-joining surface gets the snapshot in its
      // greeting (see handleHello). `claude_settings.updated` supersedes it:
      // both carry the COMPLETE state for that machine.
      this.lastClaudeSettings.set(event.daemonId, {
        type: 'claude_settings.list',
        daemonId: event.daemonId,
        ...(event.drift !== undefined ? { drift: event.drift } : {}),
        memories: event.memories,
      });
    }
    // Automations sidebar group (spec/14 § Sidebar): a `spawn`-fired chat's
    // jobId must reach LIVE surfaces on the very `chat.spawned` frame, not
    // just via a later REST refetch. `chatRegistry.observe` is subscribed to
    // the host link before this hub (see app.ts wiring order), so by the
    // time this handler runs for the SAME event the mirror already has the
    // link recorded (spec/08 § Action) — read it back rather than
    // re-deriving it here.
    if (event.type === 'chat.spawned') {
      const jobId = this.deps.chatRegistry.get(event.chatId)?.jobId;
      if (jobId) {
        event = { ...event, jobId };
      }
    }
    if (event.type === 'daemon.account') {
      let perBackend = this.lastAccountReport.get(event.daemonId);
      if (!perBackend) {
        perBackend = new Map();
        this.lastAccountReport.set(event.daemonId, perBackend);
      }
      perBackend.set(event.backendId, event);
    }
    // Per-surface replay events: route only to the requesting surface.
    if (
      'forSurfaceId' in event &&
      typeof (event as { forSurfaceId?: unknown }).forSurfaceId === 'string'
    ) {
      const targetId = (event as { forSurfaceId: string }).forSurfaceId;
      const { forSurfaceId: _strip, ...rest } = event as WireEvent & { forSurfaceId?: string };
      void _strip;
      const sent = this.sendToConns(targetId, rest as WireEvent);
      if (sent === 0) {
        // An addressed event with nowhere to go. `chat.input_ack` is one of
        // these, so a drop here is exactly what leaves a surface stuck on
        // "Sending…" — log it at ERROR with the surfaces we DO hold, never as
        // routine noise.
        this.deps.logger.error(
          {
            type: event.type,
            targetId,
            connectedSurfaceIds: Array.from(this.surfaces.keys()),
          },
          'addressed event undeliverable: no live socket for surface; dropping',
        );
      }
      return;
    }

    if ('chatId' in event && typeof event.chatId === 'string') {
      const chatId: string = event.chatId;
      const isDetail = DETAIL_LEVEL_EVENT_TYPES.has(event.type);
      const wire = encode(event);
      let fanout = 0;
      for (const conn of this.allConns()) {
        if (isDetail && !conn.watchedChats.has(chatId)) continue;
        conn.socket.send(wire);
        fanout++;
      }
      this.deps.logger.debug(
        { type: event.type, chatId, fanout, isDetail },
        'fanout chat-scoped event',
      );
      return;
    }

    // Account-scoped (notifications, daemon.online/offline, etc.)
    const wire = encode(event);
    for (const conn of this.allConns()) {
      conn.socket.send(wire);
    }
  }

  // ---- introspection (used by /api/presence) ----

  connectedSurfaceIds(): string[] {
    return Array.from(this.surfaces.keys());
  }

  /** Public: list connected surfaces with their kinds. Used by notification router. */
  listConnectedSurfaces(): { surfaceId: string; accountId: string; surfaceKind: string }[] {
    return Array.from(this.surfaces.values(), (conns) => [...conns][0]!).map((c) => ({
      surfaceId: c.surfaceId,
      accountId: c.accountId,
      surfaceKind: c.surfaceKind,
    }));
  }

  /**
   * spec/10 ## Revocation — terminate a live WebSocket for a revoked surface.
   * Sends `auth.revoked` then closes with CLOSE_AUTH_FAILED. The registry
   * record is the source of truth for revocation (set before this is called);
   * this severs any currently-open socket so the surface can't keep relaying.
   * Returns true if a live connection was found and closed.
   */
  terminateSurface(surfaceId: string, reason = 'surface revoked'): boolean {
    const conns = this.connsFor(surfaceId);
    if (conns.length === 0) return false;
    // EVERY window of a revoked surface is severed, not just the newest.
    for (const conn of conns) {
      try {
        conn.socket.send(encode({ type: 'auth.revoked', reason }));
      } catch {
        // ignore — closing anyway
      }
      try {
        conn.socket.close(CLOSE_AUTH_FAILED, reason);
      } catch {
        // ignore — socket may already be gone
      }
    }
    // `close` handler removes from surfaces + presence; do it eagerly too so a
    // synchronous caller observes the removal immediately.
    this.surfaces.delete(surfaceId);
    this.deps.presence.offline(conns[0]!.accountId, surfaceId);
    return true;
  }

  /** Send an event to a single surface by id. Returns true if delivered. */
  sendToSurface(surfaceId: string, event: WireEvent): boolean {
    return this.sendToConns(surfaceId, event) > 0;
  }

  /**
   * Send to all surfaces whose kind is in `surfaceKinds`. Returns count
   * delivered. Used by the call orchestrator (group 12 DX-3) so only
   * ringer-capable surfaces (mobile + desktop per spec/09) receive
   * `chat.call_request` — terminal/web/voice-device sit out of the ring.
   */
  sendToKinds(surfaceKinds: ReadonlySet<SurfaceKind>, event: WireEvent): number {
    let count = 0;
    const wire = encode(event);
    for (const conn of this.allConns()) {
      if (!surfaceKinds.has(conn.surfaceKind)) continue;
      try {
        conn.socket.send(wire);
        count++;
      } catch {
        // ignore write failures — caller does its own retry/log
      }
    }
    return count;
  }

  /** Send to all surfaces of a given kind. Returns count delivered. */
  sendToKind(surfaceKind: string, event: WireEvent): number {
    let count = 0;
    const wire = encode(event);
    for (const conn of this.allConns()) {
      if (conn.surfaceKind !== surfaceKind) continue;
      try {
        conn.socket.send(wire);
        count++;
      } catch {
        // ignore write failures — caller does its own retry/log
      }
    }
    return count;
  }

  /**
   * Send to every surface of `surfaceKind` EXCEPT one that already has
   * `chatId` focused (`chat.focus_change` → `PresenceTracker.setFocus`).
   * Used by `NotificationRouter.routeDesktop` for the chat-completion /
   * awaiting-permission doorbells (spec/09): a surface already looking at the
   * chat that just finished or blocked does not need a toast telling it so.
   * Returns count delivered.
   */
  sendToKindUnlessFocused(surfaceKind: string, chatId: string, event: WireEvent): number {
    let count = 0;
    const wire = encode(event);
    for (const conn of this.allConns()) {
      if (conn.surfaceKind !== surfaceKind) continue;
      const focused = this.deps.presence.get(conn.accountId, conn.surfaceId)?.lastFocusedChatId;
      if (focused === chatId) continue;
      try {
        conn.socket.send(wire);
        count++;
      } catch {
        // ignore write failures — caller does its own retry/log
      }
    }
    return count;
  }

  /**
   * A machine was removed from the account (`DELETE /api/hosts/:daemonId`):
   * forget everything cached about it — its self-description, account and
   * folder/settings reports, last-seen time and terminal routes — so no later
   * greeting replays it, and tell every connected surface `host.removed` so
   * its host list drops it now. A surface that was not connected learns it
   * from its next `auth.ok`, whose roster no longer names the machine.
   */
  removeHost(daemonId: string): number {
    this.lastHostReport.delete(daemonId);
    this.lastAccountReport.delete(daemonId);
    this.hostLastSeenAt.delete(daemonId);
    this.lastFolderList.delete(daemonId);
    this.lastClaudeSettings.delete(daemonId);
    for (const [sessionId, host] of this.terminalSessionHost.entries()) {
      if (host === daemonId) this.terminalSessionHost.delete(sessionId);
    }
    return this.sendToAll({ type: 'host.removed', daemonId });
  }

  /**
   * Re-publish every machine's self-description after the home machine moved
   * without anyone choosing it (the home machine was removed), so exactly one
   * machine reads as home on every surface.
   */
  republishAllHosts(): void {
    for (const daemonId of this.registeredDaemonIds()) this.republishHost(daemonId);
  }

  /** Send to all connected surfaces. Returns count delivered. */
  sendToAll(event: WireEvent): number {
    let count = 0;
    const wire = encode(event);
    for (const conn of this.allConns()) {
      try {
        conn.socket.send(wire);
        count++;
      } catch {
        // ignore
      }
    }
    return count;
  }
}
