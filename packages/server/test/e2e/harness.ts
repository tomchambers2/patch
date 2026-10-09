// End-to-end test harness — REAL server + REAL host over REAL WebSockets.
//
// WHY: Patch chats keep getting "stuck with no response and no error" in
// production. Every other test mocks the network or host seam, so a turn that
// never completes — or a host link that drops mid-turn — is structurally
// invisible. This harness boots the ACTUAL Fastify server and the ACTUAL
// `Daemon` connected by the ACTUAL `serverLink` WebSocket client, and drives
// every chat mode through the full round trip. The ONLY mock is the SDK backend
// (so turns complete deterministically without hitting Anthropic).
//
// The real path exercised is:
//   surface WS client (WireTestClient)
//     → server /ws hub (InboundDaemonLink)
//       → server ↔ host serverLink WS (REAL createServerLink)
//         → REAL Host (chatRunner)
//           → mock SDK backend (scripted reply, real JSONL for replay)
//         ← back out to the surface WS
//
// This is NOT the in-memory `link.emit` shortcut some existing tests use — the
// server's InboundDaemonLink accepts a genuine authenticated host socket and
// the host dials in with a real Ed25519 daemonKey, exactly like production
// (packages/daemon/src/index.ts). The host-side frame routing below mirrors
// index.ts's onFrame / onAuthed / emit closures faithfully.

import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import pino from 'pino';
import { generateUserKeypair, mintSurfaceCredential, mintDaemonKey } from '@patch/auth';
import { WireTestClient } from '@patch/wire/test-client';
import type { WireEvent, ChatErrorCode, ChatMessageEvent, ChatErrorEvent } from '@patch/wire';
import {
  Daemon,
  FolderNotFoundError,
  ChatNotFoundError,
  AttachmentChatNotFoundError,
} from '../../../daemon/src/chatRunner.js';
import { createMetaStore } from '../../../daemon/src/meta.js';
import { createMockSdkBackend, type MockSdkBackend } from '../../../daemon/src/sdkBackend.js';
import { createHistoryReader } from '../../../daemon/src/history.js';
import { createServerLink, type ServerLink } from '../../../daemon/src/serverLink.js';
import { ensureSpecialThreads } from '../../../daemon/src/specialThreads.js';
// J1: the REAL host files handler (server↔host file-content round-trip was
// previously untested end-to-end — see files.e2e.test.ts). `handleFileOpRequest`
// is its destructive sibling (create / rename / delete — file-ops.e2e.test.ts).
import {
  handleFilesRequest,
  handleFileOpRequest,
  handleDocRequest,
  handleDocActionRequest,
  handleDocConvertRequest,
  handleDocExportRequest,
} from '../../../daemon/src/index.js';
import { buildAll, type BuiltApp } from '../../src/app.js';
import { Registry } from '../../src/registry.js';

const silent = pino({ level: 'silent' });

/** Poll `pred` until true or reject after `timeoutMs`. Deterministic waiter. */
export async function until(pred: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`until(${label}): condition not met within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

export interface HarnessOptions {
  /**
   * Working window (ms) the mock SDK holds a turn `running` after emitting its
   * content, before returning. Gives a real in-flight window for queueing /
   * stop / mid-turn-drop scenarios. Abortable (stop unwinds it). Default 0.
   */
  turnDelayMs?: number;
  /**
   * Stub title summariser (spec/04 § Name). Injected directly into the host —
   * it NEVER touches the mock SDK queue, so it can't interfere with enqueued
   * turn scripts. Defaults to a counting stub returning `AI: <first msg>`.
   */
  generateTitle?: (input: {
    chatId: string;
    firstUserMessage: string;
    folder: string;
  }) => Promise<string | null>;
  /**
   * Stub transcriber for the voice-note path. Replaces Whisper (we NEVER call
   * real Whisper). Given the uploaded clip bytes + format, returns the
   * transcript the server then injects as a chat.input. Default echoes a fixed
   * transcript.
   */
  transcribe?: (audio: Buffer, format: string) => Promise<string>;
  /**
   * Host serverLink reconnect backoff. Short by default so reconnect
   * scenarios resolve fast + deterministically (no arbitrary sleeps).
   */
  daemonBackoffMs?: readonly number[];
  /** Bootstrap the special threads (thread_manager etc.) on the host. */
  specialThreads?: boolean;
}

export interface E2EHarness {
  /** ws://127.0.0.1:<port> */
  wsUrl: string;
  /**
   * The machine this harness registered and boots its host as. Every
   * host-addressed request a test makes must name THIS id — the server refuses
   * one it has not registered (spec/04 § Spawn).
   */
  daemonId: string;
  /** http://127.0.0.1:<port> */
  httpBase: string;
  port: number;
  built: BuiltApp;
  registry: Registry;
  daemon: Daemon;
  link: ServerLink;
  sdk: MockSdkBackend;
  user: { publicKey: string; privateKey: string };
  /** A real project folder that exists on disk (canonical realpath). */
  folder: string;
  /** Host's Claude-projects root (where the mock writes JSONL for replay). */
  claudeRoot: string;
  /** Host's `~/.patch` root — chat meta lives at chats/<chatId>/meta.json. */
  patchHome: string;
  /** Count of stub-title invocations (mode 13). */
  titleCalls(): number;
  /** Mint a fresh surface JWT and register the surface. */
  mintSurface(surfaceId: string): Promise<string>;
  /** Connect a surface WS client, complete the hello, and wait for auth.ok. */
  connectSurface(surfaceId: string): Promise<WireTestClient>;
  /**
   * Drop the host's serverLink socket WITHOUT stopping the host — the real
   * spec/12 "host → server disconnect" path. The host stays alive and its
   * reconnect loop fires. Returns true if a live socket was dropped.
   */
  dropDaemonLink(): boolean;
  /** Wait until the server sees the host link online. */
  waitDaemonOnline(timeoutMs?: number): Promise<void>;
  /** Wait until the server sees the host link offline. */
  waitDaemonOffline(timeoutMs?: number): Promise<void>;
  /**
   * Simulate an in-transit LOSS of the next inbound `chat.input` carrying this
   * `localId` — the frame reaches the host's serverLink but is swallowed
   * before `daemon.sendInput`, so the host never records or runs it. Models
   * the two holes spec/12 § Guaranteed input delivery closes: a link FLAP (a
   * frame handed to a socket that dies before the host reads it — never
   * buffered) and a SERVER RESTART (the buffered copy flushed to the host but
   * lost). One-shot per call: only the first matching delivery is dropped, so a
   * subsequent redelivery of the same localId gets through. The surface's
   * pending-timeout retry (same localId) is what heals it; the host dedups so
   * the eventual delivery runs exactly once.
   */
  dropNextInput(localId: string): void;
  close(): Promise<void>;
}

/**
 * Boot the whole stack. Returns once the host serverLink is authenticated
 * (the server reports the link online), so tests never race the handshake.
 */
export async function startHarness(opts: HarnessOptions = {}): Promise<E2EHarness> {
  const dataDir = mkdtempSync(join(tmpdir(), 'patch-e2e-data-'));
  const patchHome = mkdtempSync(join(tmpdir(), 'patch-e2e-home-'));
  const claudeRoot = mkdtempSync(join(tmpdir(), 'patch-e2e-claude-'));
  // Canonicalise: the host realpathSync-es every spawn folder so the SDK's
  // transcript dir + the HistoryReader's encoded-folder lookup stay in lockstep
  // (macOS /tmp → /private/tmp). Replay depends on this.
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-e2e-folder-')));
  mkdirSync(folder, { recursive: true });

  const user = generateUserKeypair();

  // ---- Registry: account + host key + a default surface ----
  const registry = Registry.load(dataDir);
  registry.bootstrapAccount({ keypair: user });
  const daemonId = 'daemon-e2e-1';
  registry.setDaemonKey({
    daemonId,
    publicKey: user.publicKey,
    issuedAt: Math.floor(Date.now() / 1000),
  });

  // ---- Server (REAL InboundDaemonLink — no daemonLink injected) ----
  const built = await buildAll({ registry, logger: false });
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = built.app.server.address() as AddressInfo;
  const port = addr.port;
  const wsUrl = `ws://127.0.0.1:${port}`;
  const httpBase = `http://127.0.0.1:${port}`;

  // ---- Host: REAL Host + mock SDK backend ----
  let titleCalls = 0;
  const generateTitle =
    opts.generateTitle ??
    (async (input: { firstUserMessage: string }) => {
      titleCalls++;
      return `AI: ${input.firstUserMessage.slice(0, 20)}`;
    });
  const wrappedTitle = async (input: {
    chatId: string;
    firstUserMessage: string;
    folder: string;
  }): Promise<string | null> => {
    if (!opts.generateTitle) return generateTitle(input);
    titleCalls++;
    return opts.generateTitle(input);
  };

  const transcribe =
    opts.transcribe ?? (async (_audio: Buffer, _format: string) => 'transcribed voice note');

  const sdk = createMockSdkBackend({
    claudeProjectsRoot: claudeRoot,
    ...(opts.turnDelayMs !== undefined ? { turnDelayMs: opts.turnDelayMs } : {}),
  });

  const metaStore = createMetaStore(patchHome);
  // localIds whose next inbound `chat.input` delivery is swallowed at the
  // host's serverLink (models flap/server-restart loss — see `dropNextInput`).
  const dropNextInputLocalIds = new Set<string>();
  // Forward-declared so `emit` (built before `link`) can route through it.
  let link: ServerLink;
  const emit = (event: WireEvent): void => {
    link.send(event);
  };

  const daemon = new Daemon({
    daemonId,
    metaStore,
    sdkBackend: sdk,
    sdkBackendKind: 'mock',
    oauthAccessToken: 'fake-oauth',
    historyReader: createHistoryReader({ claudeProjectsRoot: claudeRoot }),
    emit,
    logger: silent,
    generateTitle: wrappedTitle,
  });
  daemon.hydrate();

  if (opts.specialThreads) {
    ensureSpecialThreads({
      // The special threads live under the host's `~/.patch` (spec/06 § Where
      // special threads run), not under the project folder — same `patchHome`
      // the MetaStore is built on, so meta and folders agree.
      patchHome,
      metaStore,
      chatState: daemon.chatState,
      now: () => Date.now(),
      logger: silent,
      permissionModeDefault: daemon.permissionModeDefault(),
    });
  }

  const daemonKey = await mintDaemonKey({
    userPrivateKey: user.privateKey,
    daemonId,
    label: 'e2e',
  });

  link = createServerLink({
    url: `${wsUrl}/ws`,
    daemonKey,
    clientVersion: '1',
    logger: silent,
    backoffSchedule: opts.daemonBackoffMs ?? [25, 50, 100, 200],
    onAuthed: (send) => {
      // Mirror index.ts onAuthed: seed the server's ChatRegistry with every
      // currently-known chat so its `chat.state` gate admits them after a
      // (re)connect (Group 8 fix, DX-M1).
      for (const state of daemon.list()) {
        send({ type: 'chat.spawned', daemonId, chatId: state.chatId, folder: state.folder });
        send({
          type: 'chat.state',
          permissionMode: 'bypassPermissions',
          chatId: state.chatId,
          activity: state.activity,
          lastUpdated: state.lastUpdated,
          pinned: state.pinned,
          pinnedAt: state.pinnedAt,
          status: state.status,
          name: state.name,
          preview: state.preview,
          folder: state.folder,
        });
      }
      // …and closes the burst with folders.list, which is what tells the
      // server this host's chat list is complete (unknown-chat.ts).
      send({ type: 'folders.list', daemonId, roots: [], recent: [] });
    },
    onFrame: (event, send) => {
      // Flap / server-restart loss simulation: swallow the frame before the
      // host acts on it, so the host never records the localId nor runs the
      // turn (see `dropNextInput`). One-shot per registered localId.
      if (event.type === 'chat.input' && dropNextInputLocalIds.has(event.localId)) {
        dropNextInputLocalIds.delete(event.localId);
        return;
      }
      routeInboundFrame(event, daemon, transcribe, send);
    },
    onDisconnected: () => {
      /* nothing — the server resolves in-flight chats on its own onStatus */
    },
  });
  link.start();

  const harness: E2EHarness = {
    wsUrl,
    daemonId,
    httpBase,
    port,
    built,
    registry,
    daemon,
    link,
    sdk,
    user,
    folder,
    claudeRoot,
    patchHome,
    titleCalls: () => titleCalls,
    async mintSurface(surfaceId: string): Promise<string> {
      registry.upsertSurface({
        surfaceId,
        surfaceKind: 'web',
        label: 'browser',
        issuedAt: Math.floor(Date.now() / 1000),
      });
      return mintSurfaceCredential({
        userPrivateKey: user.privateKey,
        surfaceId,
        surfaceKind: 'web',
        label: 'browser',
      });
    },
    async connectSurface(surfaceId: string): Promise<WireTestClient> {
      const jwt = await this.mintSurface(surfaceId);
      const client = new WireTestClient({
        url: `${wsUrl}/ws`,
        clientType: 'surface-web',
        auth: jwt,
      });
      await client.connect();
      await client.waitFor('auth.ok', undefined, 5000);
      return client;
    },
    dropDaemonLink(): boolean {
      return link.dropLink();
    },
    async waitDaemonOnline(timeoutMs = 5000): Promise<void> {
      await until(() => built.daemonLink.status() === 'online', timeoutMs, 'host online');
    },
    async waitDaemonOffline(timeoutMs = 5000): Promise<void> {
      await until(() => built.daemonLink.status() === 'offline', timeoutMs, 'host offline');
    },
    dropNextInput(localId: string): void {
      dropNextInputLocalIds.add(localId);
    },
    async close(): Promise<void> {
      await link.close().catch(() => undefined);
      daemon.shutdown();
      await built.app.close().catch(() => undefined);
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(patchHome, { recursive: true, force: true });
      rmSync(claudeRoot, { recursive: true, force: true });
      rmSync(folder, { recursive: true, force: true });
    },
  };

  await harness.waitDaemonOnline();
  return harness;
}

/**
 * Faithful subset of packages/daemon/src/index.ts's onFrame routing: translate
 * inbound server WS frames into Host action calls, and service the two RPCs
 * the chat modes exercise (attachment store, voice-note transcribe).
 */
function routeInboundFrame(
  event: WireEvent,
  daemon: Daemon,
  transcribe: (audio: Buffer, format: string) => Promise<string>,
  send: (e: WireEvent) => void,
): void {
  switch (event.type) {
    case 'patch.attachment.store_request':
      handleAttachmentStore(event, daemon, send);
      return;
    case 'patch.voice_note.transcribe_request':
      void handleVoiceNote(event, transcribe, send);
      return;
    case 'patch.files.request':
      // J1: exercise the REAL host handler (reads the chat folder off disk),
      // not a mirror — this is the path the file browser uses for content.
      void handleFilesRequest(event, daemon, send, silent);
      return;
    case 'patch.file_op.request':
      // The file browser's create / rename / delete. Same rule as its listing
      // sibling above: the REAL host handler, mutating a real temp folder, so
      // the refusals (occupied destination, non-empty directory, escaping path)
      // are proved on the actual filesystem. A frame type the host handles
      // but this router does not reaches no handler at all, so the server's
      // pending request expires and the route answers 504 `daemon_timeout` —
      // which reads as a broken round-trip rather than the missing case it is.
      handleFileOpRequest(event, daemon, send);
      return;
    case 'patch.doc.request':
      // spec/14 § Document editor, step 2 of 3 — same reasoning as the file
      // RPCs above: the REAL host handler, reading the real sidecar.
      handleDocRequest(event, daemon, send);
      return;
    case 'patch.doc_action.request':
      handleDocActionRequest(event, daemon, send);
      return;
    case 'patch.doc_convert.request':
      // spec/14 § Document editor, step 3 of 3 — same reasoning as the doc
      // RPCs above: the REAL host handler, really running mammoth against
      // a real .docx on disk.
      void handleDocConvertRequest(event, daemon, send);
      return;
    case 'patch.doc_export.request':
      void handleDocExportRequest(event, daemon, send);
      return;
    case 'chat.focus_change':
      // Focus-follow routing (voice sessions) is not exercised in these chat
      // modes — the audio stack isn't booted. No-op, same as a host with no
      // open voice session.
      return;
    default:
      void handleServerEvent(event, daemon, send);
  }
}

/** Mirror of index.ts handleServerEvent (chat control-plane actions). */
async function handleServerEvent(
  event: WireEvent,
  daemon: Daemon,
  send: (e: WireEvent) => void,
): Promise<void> {
  const evChatId =
    'chatId' in event && typeof (event as { chatId?: unknown }).chatId === 'string'
      ? (event as { chatId: string }).chatId
      : undefined;
  try {
    switch (event.type) {
      case 'chat.spawn_request':
        await daemon.spawnChat({
          folder: event.folder,
          ...(event.prompt !== undefined ? { prompt: event.prompt } : {}),
          ...(event.name !== undefined ? { name: event.name } : {}),
          ...(event.chatId !== undefined ? { chatId: event.chatId } : {}),
          ...(event.localId !== undefined ? { localId: event.localId } : {}),
          ...(event.archived !== undefined ? { archived: event.archived } : {}),
          ...(event.model !== undefined ? { model: event.model } : {}),
          ...(event.permissionMode !== undefined ? { permissionMode: event.permissionMode } : {}),
        });
        return;
      case 'chat.input':
        await daemon.sendInput({
          chatId: event.chatId,
          message: event.message,
          localId: event.localId,
          // The voice-note path tags source: 'voice-app'; mirror the host's
          // voicePrefix derivation so the reply reflects the ingress.
          ...(event.source?.kind === 'voice-app'
            ? { voicePrefix: `[voice • ${event.source.surfaceKind}] ` }
            : {}),
          ...(event.attachments !== undefined ? { attachments: event.attachments } : {}),
        });
        return;
      case 'chat.stop_request':
        await daemon.stopChat(event.chatId);
        return;
      case 'chat.unqueue_request':
        daemon.unqueueInput(event.chatId, event.localId);
        return;
      case 'chat.resume_request':
        await daemon.resumeChat(event.chatId);
        return;
      case 'chat.pin_request':
        await daemon.setPinned(event.chatId, event.pinned);
        return;
      case 'chat.archive_request':
        await daemon.setArchived(event.chatId, event.archived);
        return;
      case 'chat.rename_request':
        await daemon.setName(event.chatId, event.name);
        return;
      case 'chat.todos_request':
        daemon.setTodos(event.chatId, event.todos);
        return;
      case 'chat.permission_response':
        daemon.submitPermissionResponse({
          requestId: event.requestId,
          decision: event.decision ?? (event.approve ? 'approve' : 'deny'),
          ...(event.editedNewString !== undefined && event.editedNewString !== null
            ? { editedNewString: event.editedNewString }
            : {}),
        });
        return;
      case 'file.write':
        daemon.writeFile(event.chatId, event.path, event.content);
        return;
      case 'chat.replay': {
        const surfaceId = event.forSurfaceId;
        const wrap = (ev: WireEvent): WireEvent =>
          surfaceId ? ({ ...(ev as object), forSurfaceId: surfaceId } as WireEvent) : ev;
        daemon.replayChat(event.chatId, event.fromSeq, (ev) => send(wrap(ev)));
        return;
      }
      default:
        return;
    }
  } catch (err) {
    let code: ChatErrorCode;
    if (err instanceof FolderNotFoundError) code = 'folder_not_found';
    else if (err instanceof ChatNotFoundError) code = 'chat_not_found';
    else code = 'sdk_error';
    const message = err instanceof Error ? err.message : String(err);
    const chatId = evChatId ?? (event.type === 'chat.spawn_request' ? 'pending-spawn' : 'unknown');
    const seq = daemon.allocErrorSeq(chatId);
    send({ type: 'chat.error', chatId, error: { code, message }, seq });
  }
}

/** Mirror of index.ts handleAttachmentStore. */
function handleAttachmentStore(
  event: Extract<WireEvent, { type: 'patch.attachment.store_request' }>,
  daemon: Daemon,
  send: (e: WireEvent) => void,
): void {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(event.dataBase64, 'base64');
  } catch (err) {
    send({
      type: 'patch.attachment.store_response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'invalid_data', message: `bad base64 data: ${(err as Error).message}` },
    });
    return;
  }
  if (bytes.byteLength === 0) {
    send({
      type: 'patch.attachment.store_response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'invalid_data', message: 'empty attachment' },
    });
    return;
  }
  try {
    const { path } = daemon.storeAttachment({
      chatId: event.chatId,
      id: event.id,
      name: event.name,
      mimeType: event.mimeType,
      kind: event.kind,
      bytes,
    });
    send({ type: 'patch.attachment.store_response', requestId: event.requestId, ok: true, path });
  } catch (err) {
    const code = err instanceof AttachmentChatNotFoundError ? 'chat_not_found' : 'internal';
    send({
      type: 'patch.attachment.store_response',
      requestId: event.requestId,
      ok: false,
      error: { code, message: (err as Error).message },
    });
  }
}

/**
 * Voice-note transcribe RPC. The server round-trips the uploaded clip; the
 * host owns Whisper. We stub the transcriber (NEVER call real Whisper) but
 * the FULL server route (multipart upload → round-trip → chat.input injection)
 * is exercised for real.
 */
async function handleVoiceNote(
  event: Extract<WireEvent, { type: 'patch.voice_note.transcribe_request' }>,
  transcribe: (audio: Buffer, format: string) => Promise<string>,
  send: (e: WireEvent) => void,
): Promise<void> {
  let audio: Buffer;
  try {
    audio = Buffer.from(event.audioBase64, 'base64');
  } catch (err) {
    send({
      type: 'patch.voice_note.transcribe_response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'internal', message: `bad base64 audio: ${(err as Error).message}` },
    });
    return;
  }
  try {
    const transcript = await transcribe(audio, event.format);
    send({
      type: 'patch.voice_note.transcribe_response',
      requestId: event.requestId,
      ok: true,
      transcript,
    });
  } catch (err) {
    send({
      type: 'patch.voice_note.transcribe_response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'transcription_failed', message: (err as Error).message },
    });
  }
}

// ------------------------------- assertions --------------------------------

/**
 * THE silent-hang detector. Resolves on the FIRST assistant `chat.message` OR
 * `chat.error` for `chatId`; REJECTS on timeout with a mode-labelled message.
 * A silent hang (no reply and no visible error) therefore FAILS the test — the
 * whole point of this suite.
 */
export function waitReplyOrError(
  client: WireTestClient,
  chatId: string,
  mode: string,
  timeoutMs = 4000,
): Promise<{ kind: 'reply'; event: ChatMessageEvent } | { kind: 'error'; event: ChatErrorEvent }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubM();
      unsubE();
      reject(
        new Error(
          `[${mode}] SILENT HANG: no reply and no visible error for chat ${chatId} within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    const unsubM = client.on('chat.message', (e) => {
      if (e.chatId !== chatId || e.role !== 'assistant') return;
      clearTimeout(timer);
      unsubM();
      unsubE();
      resolve({ kind: 'reply', event: e });
    });
    const unsubE = client.on('chat.error', (e) => {
      if (e.chatId !== chatId) return;
      clearTimeout(timer);
      unsubM();
      unsubE();
      resolve({ kind: 'error', event: e });
    });
  });
}

/**
 * Record every event of the given `types` into a growing array (WireTestClient
 * has no built-in buffer, so a `waitFor` registered late can miss a fanned-out
 * event). Register this BEFORE the action that triggers the events.
 */
export function record(client: WireTestClient, types: WireEvent['type'][]): WireEvent[] {
  const arr: WireEvent[] = [];
  for (const t of types) {
    client.on(t as never, ((e: WireEvent) => arr.push(e)) as never);
  }
  return arr;
}

/** Assert a REPLY (not an error) arrives within the timeout; return it. */
export async function expectReply(
  client: WireTestClient,
  chatId: string,
  mode: string,
  timeoutMs = 4000,
): Promise<ChatMessageEvent> {
  const outcome = await waitReplyOrError(client, chatId, mode, timeoutMs);
  if (outcome.kind === 'error') {
    throw new Error(
      `[${mode}] expected a reply but got a chat.error: ${outcome.event.error.code} — ${outcome.event.error.message}`,
    );
  }
  return outcome.event;
}
