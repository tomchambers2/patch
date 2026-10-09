// Full-process boot coverage for src/index.ts's `main()` — the host's
// actual entry point. Every other test in this package exercises the pieces
// main() wires together (Host, buildControl, createServerLink, the audio
// stack, ...) in isolation; this file is the only one that boots main()
// ITSELF, end-to-end, with a fake "patch-server" WS peer standing in for the
// real patch-server, so the wiring code in index.ts (which is otherwise 0%
// covered — nothing else imports index.ts) gets exercised for real.
//
// `main()` takes an optional `testHooks` parameter (see MainTestHooks in
// src/index.ts) that is NEVER populated by the real CLI entry at the bottom
// of that file (it calls `main()` with no arguments) — it exists solely so
// this test can (a) obtain the real `shutdown()` closure to tear the host
// down cleanly instead of going through the `process.exit`-calling
// control-IPC `/stop` path, and (b) inspect the live daemon/folderRegistry/
// secretsStore/app graph `main()` builds.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
  chmodSync,
  existsSync,
  statSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { request as httpRequest, createServer as createHttpServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { WebSocketServer, WebSocket as WSClient } from 'ws';
import pino from 'pino';
import { generateUserKeypair, mintDaemonKey } from '@patch/auth';
import { DEFAULT_SHARED_SETTINGS, decode, encode, type WireEvent } from '@patch/wire';
import type { DaemonManifest } from '../src/selfUpdate.js';
import {
  main,
  handleSkillsRequest,
  handleFoldersBrowseRequest,
  handleAttachmentStore,
  handleVoiceNoteTranscribe,
  handleSecretsMutation,
  handleFilesRequest,
  handleChatHistoryRequest,
  handleServerEvent,
  type MainTestHooks,
} from '../src/index.js';
import { Daemon, ChatNotFoundError, type DaemonOptions } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { FolderRegistry } from '../src/folders.js';
import { createSecretsStore } from '../src/secrets.js';
import { UnsupportedClipFormatError, type WhisperBackend } from '../src/audio/whisper.js';
import { mintVoiceToken } from '../src/audio/token-verifier.js';
import { encodeAudio, decodeAudio, type AudioEvent } from '@patch/wire/audio';
import { appendBroadcast, readPendingBroadcasts } from '../src/specialThreads.js';

// Nearly every test here boots main() end-to-end: a UDS control server, a raw
// healthz listener, an audio WSS, a WS link to the fake server, and an MCP
// server CHILD PROCESS started through tsx. That is seconds of real work, and
// the file runs alongside the rest of a 1500-test suite on shared cores, so
// vitest's 5s default was never a bound on anything real here — it was a bound
// on how busy the machine was. Tests failed with "MCP server child failed to
// start … signal=SIGTERM" (the timeout killing boot mid-flight) and a different
// one lost the race on each run. The heavier cases already declared 15-30s
// individually; this makes the whole file honest about what it does. A genuine
// hang still fails — 25s later, and it says so.
vi.setConfig({ testTimeout: 30_000 });

// registerDaemon is mocked ONLY so the "no daemon.key on disk" boot test can
// control its result deterministically instead of actually dialing a (fake)
// patch-server's pairing endpoint over HTTP. Every other test in this file
// pre-writes a real daemon.key and never reaches this code path, so they are
// unaffected by the mock — the real implementation is used everywhere else
// via `importOriginal`.
vi.mock('../src/registration.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/registration.js')>();
  return { ...actual, registerDaemon: vi.fn(actual.registerDaemon) };
});
import { registerDaemon } from '../src/registration.js';

// This test runs from TypeScript source, so `version.ts`'s real BUILD_TARGET
// (read from a bundled `build-info.json` beside the installed artifact, per
// installPaths.ts) is undefined here — self-update's own `checkForUpdate`
// treats that as "not running from a built artifact" and returns
// available:false before making any HTTP call at all, for every test in this
// file equally. A fixed target lets the "cross-host patch_send_to" describe
// block's self-update cases below exercise the real HTTP check/apply flow;
// no other test in this file asserts on VERSION/GIT_SHA/BUILT_AT/BUILD_TARGET,
// so the fixed values are otherwise inert.
vi.mock('../src/version.js', () => ({
  VERSION: '0.1.100',
  GIT_SHA: 'testsha0',
  BUILT_AT: new Date(0).toISOString(),
  BUILD_TARGET: 'linux-x64',
}));

// The control socket is gated as a whole (spec/02 § Control IPC): every
// route but /healthz needs the host's local key.
const LOCAL_KEY = 'local-secret';
const AUTH = { authorization: `Bearer ${LOCAL_KEY}` };

// `onnxruntime-node` is a heavy native dependency that src/audio/vad.ts only
// dynamic-imports on the VAD_BACKEND=silero path — mocked here (the same
// technique test/audio-vad-silero.test.ts uses for vad.ts's OWN exhaustive
// coverage) purely so index.ts's `createSileroVadFactory()` call site can be
// exercised at boot without a real ONNX model or the native runtime.
vi.mock('onnxruntime-node', () => ({
  InferenceSession: {
    create: vi.fn(async () => ({ inputNames: ['input'], outputNames: ['output'] })),
  },
  Tensor: class FakeTensor {
    constructor(
      public type: string,
      public data: unknown,
      public dims: number[],
    ) {}
  },
}));

const silent = pino({ level: 'silent' });

// This file boots the real main() many times over in a single process (each
// call registers its own SIGINT/SIGTERM `process.once` handlers that the real
// CLI entry only ever registers ONCE per process lifetime). Silence the
// resulting (harmless, test-harness-only) MaxListenersExceededWarning.
process.setMaxListeners(0);

/** Minimal real Host, same pattern as control-ipc.test.ts's setup(). */
function makeDaemon(overrides: { resolveOAuth?: DaemonOptions['resolveOAuth'] } = {}): {
  daemon: Daemon;
  events: WireEvent[];
  home: string;
} {
  const home = mkdtempSync(join(tmpdir(), 'patch-handler-home-'));
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: createMockSdkBackend(),
    oauthAccessToken: 'tok',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
    ...(overrides.resolveOAuth ? { resolveOAuth: overrides.resolveOAuth } : {}),
  });
  return { daemon, events, home };
}

function makeFolder(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'patch-handler-folder-')));
}

/**
 * A folder the registry will actually PUBLISH — i.e. one a person could really
 * be working in.
 *
 * `makeFolder()` builds under `os.tmpdir()`, and `isJunkFolder` filters `/tmp`
 * (and macOS's `/var/folders`) out of `recent` on purpose, so the registry's
 * published set never changes when a chat opens one. Any test that waits on
 * `folders.updated` for a scratch folder therefore waits forever — which is
 * exactly what happened when the junk filter landed: the fan-out assertion
 * below went from proving the wiring to timing out on every machine.
 *
 * Under the home directory instead: a real path, no dot segment, not scratch.
 */
const projectFolders: string[] = [];
function makeProjectFolder(): string {
  const dir = realpathSync(mkdtempSync(join(homedir(), 'patch-test-project-')));
  projectFolders.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of projectFolders) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

interface FakeServer {
  port: number;
  url: string;
  /** Every decoded frame received from the currently-connected client. */
  received: WireEvent[];
  /** Send a frame to the currently-connected client. */
  send(event: WireEvent): void;
  /**
   * Resolves once a client has said hello, WITHOUT replying auth.ok yet — lets
   * the test do something (e.g. spawn a chat over the control UDS) before the
   * link actually authenticates.
   */
  waitForHello(): Promise<void>;
  /** Reply auth.ok + daemon.online to the most recent hello. */
  authNow(): void;
  /** Resolves once a client has said hello and been auth'd (waitForHello + authNow, auto). */
  waitForAuthed(): Promise<void>;
  /** Resolves when `pred` first matches an already-received or future frame. */
  waitForFrame(pred: (e: WireEvent) => boolean, timeoutMs?: number): Promise<WireEvent>;
  /** Forcibly drop the current client connection (simulates a link drop). */
  dropClient(): void;
  /**
   * Serve `GET /api/daemon/daemon-latest.json` as this manifest and
   * `GET /api/daemon/<artifacts[].file>` as the matching bytes, for the
   * host's own `checkForUpdate`/`applyUpdate` HTTP calls (spec/02 §
   * Installation) — unconfigured, every path 404s, which `checkForUpdate`
   * reads the same as "no manifest published".
   */
  serveSelfUpdateManifest(manifest: DaemonManifest, files: Record<string, Buffer>): void;
  close(): Promise<void>;
}

/**
 * Fake patch-server `/ws` peer: decodes every frame through the real
 * `@patch/wire` codec (so this only accepts genuinely wire-valid frames — same
 * as the real server) and lets the test control exactly when a hello gets its
 * auth.ok reply, and push arbitrary frames at the host afterward.
 */
async function startFakeServer(): Promise<FakeServer> {
  const received: WireEvent[] = [];
  const waiters: { pred: (e: WireEvent) => boolean; resolve: (e: WireEvent) => void }[] = [];
  let current: WSClient | undefined;
  let helloResolvers: (() => void)[] = [];
  let sawHello = false;
  let selfUpdateManifest: DaemonManifest | undefined;
  let selfUpdateFiles: Record<string, Buffer> = {};

  // A real http.Server (not the bare `{ port }` ws defaults to) so this fake
  // server can also answer the host's own self-update HTTP calls — those
  // hit this same `PATCH_SERVER_URL`/port, not the WS link.
  const httpServer = createHttpServer((req, res) => {
    if (req.url === '/api/daemon/daemon-latest.json') {
      if (!selfUpdateManifest) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(selfUpdateManifest));
      return;
    }
    const file = req.url?.startsWith('/api/daemon/') ? req.url.slice('/api/daemon/'.length) : null;
    const bytes = file ? selfUpdateFiles[file] : undefined;
    if (bytes) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(bytes);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const port = (httpServer.address() as AddressInfo).port;

  wss.on('connection', (ws) => {
    current = ws;
    sawHello = false;
    ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      if (msg['type'] === 'hello') {
        sawHello = true;
        for (const r of helloResolvers.splice(0)) r();
        return;
      }
      const event = decode(raw.toString('utf8'));
      received.push(event);
      // Auto-ack jobs RPCs so RemoteJobsStore.list()/etc (which awaits a real
      // patch.jobs.response) doesn't hang for its full timeout in tests that
      // just want to prove the request went out.
      if (event.type === 'patch.jobs.request') {
        ws.send(
          encode({ type: 'patch.jobs.response', requestId: event.requestId, ok: true, result: [] }),
        );
      }
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (w && w.pred(event)) {
          waiters.splice(i, 1);
          w.resolve(event);
        }
      }
    });
  });

  return {
    port,
    url: `ws://127.0.0.1:${port}/ws`,
    received,
    send: (event) => current?.send(encode(event)),
    waitForHello: () =>
      sawHello ? Promise.resolve() : new Promise<void>((resolve) => helloResolvers.push(resolve)),
    authNow: () => {
      current?.send(
        JSON.stringify({ type: 'auth.ok', hosts: [], accountId: 'acct-1', surfaceId: 'daemon-1' }),
      );
      current?.send(JSON.stringify({ type: 'daemon.online', daemonId: 'd1' }));
    },
    waitForAuthed: async function (this: FakeServer) {
      await this.waitForHello();
      this.authNow();
    },
    waitForFrame: (pred, timeoutMs = 5000) => {
      const already = received.find(pred);
      if (already) return Promise.resolve(already);
      return new Promise<WireEvent>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.pred === pred);
          if (idx >= 0) waiters.splice(idx, 1);
          // Name the predicate and the frames that DID arrive. A bare "timed
          // out after 5000ms" from a test with two dozen waits says nothing
          // about which frame never came, which is the only thing worth
          // knowing about it.
          const seen = [...new Set(received.map((e) => e.type))].join(', ');
          reject(
            new Error(
              `waitForFrame: timed out after ${timeoutMs}ms waiting for ${String(pred)}\n` +
                `frames received (${received.length}): ${seen}`,
            ),
          );
        }, timeoutMs);
        waiters.push({
          pred,
          resolve: (e) => {
            clearTimeout(timer);
            resolve(e);
          },
        });
      });
    },
    dropClient: () => current?.close(),
    serveSelfUpdateManifest: (manifest, files) => {
      selfUpdateManifest = manifest;
      selfUpdateFiles = files;
    },
    close: () => new Promise<void>((resolve) => wss.close(() => httpServer.close(() => resolve()))),
  };
}

function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (pred()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor: timed out'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

/** GET a path off the raw TCP /healthz listener main() binds directly (not buildControl's UDS app). */
function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString('utf8')));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

interface Boot {
  ready: Parameters<NonNullable<MainTestHooks['onReady']>>[0];
  fakeServer: FakeServer;
  home: string;
  localKey: string;
  audioPort: number;
  healthzPort: number;
  /** Shuts everything down cleanly (mocks process.exit for the duration). */
  cleanup(): Promise<void>;
}

/**
 * Boots the real `main()` against a temp PATCH_HOME + a fake patch-server,
 * with SDK/whisper/kokoro/vad all mocked so no real credentials/models/
 * sidecars are needed. Returns once `testHooks.onReady` fires (full boot
 * complete: control UDS + TCP healthz + audio WSS all listening, server link
 * dialed).
 */
async function bootMain(
  envOverrides: Record<string, string | undefined> = {},
  opts: {
    /** Written to `<PATCH_HOME>/host.json` before boot — the host's persisted state. */
    hostJson?: Record<string, unknown>;
    /** Written to `<PATCH_HOME>/claude-oauth.json` before boot — the Claude account store. */
    claudeStore?: Record<string, unknown>;
    /** Receives the host's log lines instead of stdout. */
    logStream?: NonNullable<MainTestHooks['logStream']>;
    /**
     * Served from `fakeServer`'s HTTP port BEFORE `main()` boots, so the
     * host's own on-boot self-update check (spec/02 § Installation) sees it
     * on its very first look — the only chance a test gets, short of waiting
     * out the real hourly interval.
     */
    selfUpdateManifest?: { manifest: DaemonManifest; files: Record<string, Buffer> };
  } = {},
): Promise<Boot> {
  const home = mkdtempSync(join(tmpdir(), 'patch-main-home-'));
  if (opts.hostJson) writeFileSync(join(home, 'host.json'), JSON.stringify(opts.hostJson));
  if (opts.claudeStore) {
    writeFileSync(join(home, 'claude-oauth.json'), JSON.stringify(opts.claudeStore), {
      mode: 0o600,
    });
  }
  const daemonCwd = mkdtempSync(join(tmpdir(), 'patch-main-cwd-'));
  const fakeServer = await startFakeServer();
  if (opts.selfUpdateManifest) {
    fakeServer.serveSelfUpdateManifest(
      opts.selfUpdateManifest.manifest,
      opts.selfUpdateManifest.files,
    );
  }
  const healthzPort = await freePort();
  const audioPort = await freePort();

  // Pre-write a valid (genuinely EdDSA-signed) daemon.key so boot skips the
  // QR-registration flow by default — individual tests override this.
  if (envOverrides['__NO_DAEMON_KEY__'] === undefined) {
    const user = generateUserKeypair();
    const daemonKey = await mintDaemonKey({
      userPrivateKey: user.privateKey,
      daemonId: 'd1',
      label: 'test',
    });
    writeFileSync(join(home, 'daemon.key'), daemonKey, { mode: 0o600 });
  }

  const previousCwd = process.cwd();
  process.chdir(daemonCwd);

  const savedEnv: Record<string, string | undefined> = {};
  const env: Record<string, string | undefined> = {
    PATCH_HOME: home,
    // The Manager and Speakers exist only on the home machine (spec/06).
    PATCH_IS_HOME_HOST: '1',
    PATCH_DAEMON_SOCKET: join(home, 'daemon.sock'),
    PATCH_DAEMON_HEALTHZ_PORT: String(healthzPort),
    PATCH_DAEMON_HEALTHZ_HOST: '127.0.0.1',
    PATCH_SERVER_WS_URL: fakeServer.url,
    PATCH_SERVER_URL: `http://127.0.0.1:${fakeServer.port}`,
    PATCH_INTERNAL_TOKEN: 'test-internal-token',
    SDK_BACKEND: 'mock',
    PATCH_CLAUDE_PROJECTS_ROOT: join(home, 'claude-projects'),
    PATCH_DAEMON_AUDIO_PORT: String(audioPort),
    PATCH_DAEMON_AUDIO_HOST: '127.0.0.1',
    WHISPER_BACKEND: 'mock',
    KOKORO_BACKEND: 'mock',
    VAD_BACKEND: 'mock',
    PATCH_VOICE_MAX_SESSIONS: '4',
    // Deterministic OAuth resolution regardless of the host's real Keychain
    // state (this test may run on a Mac where `claude login` genuinely ran).
    CLAUDE_OAUTH_NO_KEYCHAIN: '1',
    CLAUDE_CREDENTIALS_PATH: join(home, 'no-such-credentials.json'),
    // CRITICAL: disconnectClaude()/claudeConfigPath() fall back to the REAL
    // `~/.claude.json` (Claude Code's own account-metadata file) unless this
    // is overridden — and `claude.disconnect` unconditionally rmSync()s it.
    // Point it at a sandboxed path so a `claude.disconnect` frame in this
    // test can never touch the real file on the host running these tests.
    CLAUDE_CONFIG_PATH: join(home, 'fake-claude-config.json'),
    // Strip the AMBIENT Claude credential (see `loadClaudeOAuth` resolution
    // order: CLAUDE_CODE_OAUTH_TOKEN wins over the credentials file, which the
    // vars above already sandbox). Without this the suite's result depends on
    // who launched it: `seedPatchStore` adopts the token into the host's
    // store, so a run started from a Patch chat (which carries the token in its
    // environment) boots WITH an account, and the same commit run from a plain
    // ssh shell boots WITHOUT one. That silently flipped the usage test below —
    // green in CI-via-chat on 2026-08-18, red on the identical commit run by
    // hand on 2026-08-20. A test whose outcome depends on the shell that
    // started it is not a test. Individual cases opt back IN by name.
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    ...envOverrides,
  };
  delete env['__NO_DAEMON_KEY__'];
  for (const [k, v] of Object.entries(env)) {
    savedEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  const ready = await new Promise<Parameters<NonNullable<MainTestHooks['onReady']>>[0]>(
    (resolve, reject) => {
      main({
        onReady: (handle) => resolve(handle),
        ...(opts.logStream ? { logStream: opts.logStream } : {}),
      }).catch(reject);
    },
  );

  // The host MINTS its own control key on start and writes it beside the
  // socket (spec/02 § Control IPC). Reading it from that file is exactly what
  // a person running the CLI on this machine does — and it is the only way to
  // get it, since nothing outside the host may set it.
  const localKey = readFileSync(join(home, 'local.key'), 'utf8').trim();

  return {
    ready,
    fakeServer,
    home,
    localKey,
    audioPort,
    healthzPort,
    cleanup: async () => {
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as unknown as never);
      try {
        await ready.shutdown();
      } finally {
        exitSpy.mockRestore();
        for (const [k, v] of Object.entries(savedEnv)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        process.chdir(previousCwd);
        await fakeServer.close();
        rmSync(home, { recursive: true, force: true });
        rmSync(daemonCwd, { recursive: true, force: true });
      }
    },
  };
}

describe('src/index.ts main() — full host boot', () => {
  it('replays a hidden chat as hidden on (re)connect, so a restarted server does not list it as active', async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForHello();
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-main-hidden-')));
      const spawnRes = await boot.ready.app.inject({
        method: 'POST',
        url: '/spawn-chat',
        headers: { authorization: `Bearer ${boot.localKey}` },
        payload: { folder, model: 'claude-opus-5' },
      });
      expect(spawnRes.statusCode).toBe(200);
      const { chatId } = spawnRes.json() as { chatId: string };
      await boot.ready.daemon.setHidden(chatId, true);

      boot.fakeServer.authNow();
      // folders.list is sent after the whole chat replay, so by then the LAST
      // chat.state for this chat is the replayed one (earlier ones predate the hide).
      await boot.fakeServer.waitForFrame((e) => e.type === 'folders.list' && e.daemonId === 'd1');
      const states = boot.fakeServer.received.filter(
        (e) => e.type === 'chat.state' && e.chatId === chatId,
      );
      expect(states.at(-1)).toMatchObject({ hidden: true });
    } finally {
      await boot.cleanup();
    }
  });

  it('boots control UDS + healthz + audio WSS, dials the server link, and dispatches every server->host RPC frame type', async () => {
    const boot = await bootMain();
    try {
      // Wait for the host's hello WITHOUT replying auth.ok yet, so we can
      // spawn a chat over the control UDS first — this proves onAuthed's
      // "replay every known chat" loop (chat.spawned + chat.state per
      // existing chat) by giving it something to iterate over.
      await boot.fakeServer.waitForHello();

      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-main-chat-')));
      // spec/04 § Spawn — this machine has never read a model catalogue (its
      // backend is logged out in this boot), so a spawn naming no model is
      // REFUSED saying exactly that rather than guessing a model id.
      const noModelRes = await boot.ready.app.inject({
        method: 'POST',
        url: '/spawn-chat',
        headers: { authorization: `Bearer ${boot.localKey}` },
        payload: { folder },
      });
      expect(noModelRes.statusCode).toBe(409);
      expect(noModelRes.json()).toMatchObject({ error: 'no_model_catalogue' });
      expect((noModelRes.json() as { message: string }).message).toContain('d1');
      const spawnRes = await boot.ready.app.inject({
        method: 'POST',
        url: '/spawn-chat',
        headers: { authorization: `Bearer ${boot.localKey}` },
        payload: { folder, model: 'claude-opus-5' },
      });
      expect(spawnRes.statusCode).toBe(200);
      const { chatId: preExistingChatId } = spawnRes.json() as { chatId: string };

      boot.fakeServer.authNow();
      // onAuthed publishes daemon.host, daemon.account, folders.list,
      // secrets.list, AND (the loop this test cares about) chat.spawned +
      // chat.state for every chat the host already knows about.
      //
      // Every one of these names the machine it is about — a host that could
      // not state its own id would leave the server unable to say which host a
      // chat lives on, so `daemon_id` is read out of the daemon.key at boot.
      await boot.fakeServer.waitForFrame((e) => e.type === 'daemon.host' && e.daemonId === 'd1');
      await boot.fakeServer.waitForFrame(
        (e) => e.type === 'daemon.account' && e.daemonId === 'd1' && e.backendId === 'claude-code',
      );
      await boot.fakeServer.waitForFrame((e) => e.type === 'folders.list' && e.daemonId === 'd1');
      await boot.fakeServer.waitForFrame((e) => e.type === 'secrets.list');
      await boot.fakeServer.waitForFrame(
        (e) => e.type === 'chat.spawned' && e.chatId === preExistingChatId,
      );
      await boot.fakeServer.waitForFrame(
        (e) => e.type === 'chat.state' && e.chatId === preExistingChatId,
      );

      // GET /list over the control UDS app.inject (exercises buildControl
      // wiring main() passed in, not just the raw TCP listener below).
      const listRes = await boot.ready.app.inject({
        method: 'GET',
        url: '/list',
        headers: { authorization: `Bearer ${boot.localKey}` },
      });
      expect(listRes.statusCode).toBe(200);

      // The raw TCP /healthz listener main() binds directly with node:http
      // (distinct from buildControl's own UDS-only /healthz) — a real
      // socket connect + HTTP request, both its 200 and its 404 branches.
      const healthzRes = await httpGet(boot.healthzPort, '/healthz');
      expect(healthzRes.status).toBe(200);
      expect(JSON.parse(healthzRes.body)).toMatchObject({ ok: true });
      const notFoundRes = await httpGet(boot.healthzPort, '/nope');
      expect(notFoundRes.status).toBe(404);

      // --- chat.spawn_request (handleServerEvent switch — a SECOND, live,
      //     server-originated spawn, in a DISTINCT folder so the folder
      //     registry's list genuinely changes post-baseline, proving its
      //     `onChange` -> `link.send({type:'folders.updated'})` wiring) ---
      const secondFolder = makeProjectFolder();
      boot.fakeServer.send({
        type: 'chat.spawn_request',
        daemonId: 'd1',
        folder: secondFolder,
        chatId: 'chat-main-1',
        localId: 'spawn-1',
        // Every optional field set, so each of this dispatch's `!==
        // undefined` spreads gets its TRUE side exercised too (the OTHER
        // spawn_request below, and every other spawn_request in this file,
        // omits them all — covering the FALSE side).
        name: 'a spawned chat',
        model: 'claude-3-5-haiku-20241022',
        permissionMode: 'bypassPermissions',
        archived: false,
      });
      await waitFor(() => boot.ready.daemon.chatState.has('chat-main-1'));
      await boot.fakeServer.waitForFrame((e) => e.type === 'folders.updated');

      // --- chat.input, WITH an attachment (the other chat.input sends in
      //     this file omit it, covering the FALSE side of that spread).
      //     Stored on disk first — sendInput resolves the ref against the
      //     real manifest and throws for one that was never stored. ---
      boot.ready.daemon.storeAttachment({
        chatId: 'chat-main-1',
        id: 'att-live-1',
        name: 'note.txt',
        mimeType: 'text/plain',
        kind: 'file',
        bytes: Buffer.from('hi'),
      });
      boot.fakeServer.send({
        type: 'chat.input',
        chatId: 'chat-main-1',
        message: 'hello from the fake server',
        localId: 'input-1',
        attachments: [{ id: 'att-live-1', name: 'note.txt', mimeType: 'text/plain', kind: 'file' }],
      });
      await boot.fakeServer.waitForFrame(
        (e) => e.type === 'chat.state' && e.chatId === 'chat-main-1' && e.activity === 'idle',
        10_000,
      );
      // --- chat.input, WITH disabledTools (per-chat Tools panel OFF set) — the
      //     TRUE side of the disabledTools spread; other chat.input sends here
      //     omit it, covering the FALSE side. patch/todo.md — "turn them on/off".
      boot.fakeServer.send({
        type: 'chat.input',
        chatId: 'chat-main-1',
        message: 'run with a tool switched off',
        localId: 'input-tools-off',
        disabledTools: ['Bash'],
      });
      await boot.fakeServer.waitForFrame(
        (e) => e.type === 'chat.state' && e.chatId === 'chat-main-1' && e.activity === 'idle',
        10_000,
      );

      // --- chat.focus_change (intercepted before handleServerEvent) ---
      boot.fakeServer.send({
        type: 'chat.focus_change',
        chatId: 'chat-main-1',
        forSurfaceId: 'surface-1',
      });
      // --- chat.focus_change unsubscribe (chatId null — no-op branch) ---
      boot.fakeServer.send({
        type: 'chat.focus_change',
        chatId: null,
        forSurfaceId: 'surface-1',
      });
      // --- chat.focus_change with no forSurfaceId (no-op branch) ---
      boot.fakeServer.send({ type: 'chat.focus_change', chatId: 'chat-main-1' });

      // --- patch.diag.inject_permission ---
      boot.fakeServer.send({
        type: 'patch.diag.inject_permission',
        chatId: 'chat-main-1',
        tool: 'Bash',
        description: 'run a command',
      });

      // --- patch.diag.voice_inject (audioServer defined, surfaceId unknown -> no-op internally) ---
      boot.fakeServer.send({
        type: 'patch.diag.voice_inject',
        surfaceId: 'no-such-surface',
        text: 'hello',
      });

      // --- patch.files.request (dispatch line) ---
      boot.fakeServer.send({
        type: 'patch.files.request',
        requestId: 'freq-1',
        chatId: 'chat-main-1',
        path: '',
      });
      await boot.fakeServer.waitForFrame((e) => e.type === 'patch.files.response');

      // --- patch.chat_history.request (dispatch line), WITH since+limit
      //     (the earlier direct handleChatHistoryRequest unit tests never
      //     set these, covering their FALSE side) ---
      boot.fakeServer.send({
        type: 'patch.chat_history.request',
        requestId: 'hreq-1',
        chatId: 'chat-main-1',
        since: 0,
        limit: 10,
      });
      await boot.fakeServer.waitForFrame((e) => e.type === 'patch.chat_history.response');

      // --- patch.skills.request (dispatch line) ---
      boot.fakeServer.send({
        type: 'patch.skills.request',
        requestId: 'sreq-1',
        folder,
        daemonId: 'd1',
      });
      await boot.fakeServer.waitForFrame((e) => e.type === 'patch.skills.response');

      // --- patch.folders.browse.request (dispatch line) ---
      boot.fakeServer.send({
        type: 'patch.folders.browse.request',
        daemonId: 'd1',
        requestId: 'breq-1',
      });
      await boot.fakeServer.waitForFrame((e) => e.type === 'patch.folders.browse.response');

      // --- patch.host_files.request (dispatch line): a host-level save of a
      //     file inside a chat's folder tells THAT chat's surfaces it changed
      //     (spec/03 § Host files) ---
      const hostFile = join(realpathSync(secondFolder), 'host-edited.md');
      writeFileSync(hostFile, 'before');
      boot.fakeServer.send({
        type: 'patch.host_files.request',
        daemonId: 'd1',
        requestId: 'hfreq-1',
        op: 'read',
        path: hostFile,
      });
      const hostRead = await boot.fakeServer.waitForFrame(
        (e) => e.type === 'patch.host_files.response' && e.requestId === 'hfreq-1',
      );
      boot.fakeServer.send({
        type: 'patch.host_files.request',
        daemonId: 'd1',
        requestId: 'hfreq-2',
        op: 'write',
        path: hostFile,
        content: 'after',
        baseVersion: (hostRead as Extract<WireEvent, { type: 'patch.host_files.response' }>)
          .version as string,
      });
      await boot.fakeServer.waitForFrame(
        (e) => e.type === 'patch.host_files.response' && e.requestId === 'hfreq-2' && e.ok,
      );
      await boot.fakeServer.waitForFrame(
        (e) =>
          e.type === 'patch.file_changed' &&
          e.chatId === 'chat-main-1' &&
          e.path === 'host-edited.md',
      );
      expect(readFileSync(hostFile, 'utf8')).toBe('after');

      // --- patch.voice_note.transcribe_request (dispatch line; whisper is
      //     assigned by boot time since startAudioServer already resolved) ---
      boot.fakeServer.send({
        type: 'patch.voice_note.transcribe_request',
        requestId: 'vreq-1',
        surfaceKind: 'mobile',
        format: 'wav',
        audioBase64: Buffer.from('not-real-audio').toString('base64'),
      });
      await boot.fakeServer.waitForFrame((e) => e.type === 'patch.voice_note.transcribe_response');

      // --- patch.attachment.store_request (dispatch line) ---
      boot.fakeServer.send({
        type: 'patch.attachment.store_request',
        requestId: 'areq-1',
        chatId: 'chat-main-1',
        id: 'att-1',
        name: 'note.txt',
        mimeType: 'text/plain',
        kind: 'file',
        dataBase64: Buffer.from('hello attachment').toString('base64'),
      });
      await boot.fakeServer.waitForFrame((e) => e.type === 'patch.attachment.store_response');

      // --- patch.secrets.set_request / delete_request (dispatch line) ---
      boot.fakeServer.send({
        type: 'patch.secrets.set_request',
        requestId: 'screq-1',
        key: 'MY_SECRET',
        value: 'shh',
      });
      await boot.fakeServer.waitForFrame((e) => e.type === 'secrets.updated');
      boot.fakeServer.send({
        type: 'patch.secrets.delete_request',
        requestId: 'screq-2',
        key: 'MY_SECRET',
      });
      await boot.fakeServer.waitForFrame(
        (e) => e.type === 'patch.secrets.response' && e.requestId === 'screq-2',
      );

      // --- chat.permission_response (handleServerEvent switch; no pending
      //     request for this id — exercises the host-side no-op path) ---
      boot.fakeServer.send({
        type: 'chat.permission_response',
        requestId: 'no-such-request',
        approve: true,
      });

      // --- file.write (handleServerEvent switch) ---
      boot.fakeServer.send({
        type: 'file.write',
        chatId: 'chat-main-1',
        path: 'x.txt',
        content: 'hi',
      });

      // --- chat.replay (handleServerEvent switch, with forSurfaceId wrap) ---
      boot.fakeServer.send({
        type: 'chat.replay',
        chatId: 'chat-main-1',
        fromSeq: -1,
        forSurfaceId: 'surface-1',
      });
      await boot.fakeServer.waitForFrame(
        (e) => 'forSurfaceId' in e && (e as { forSurfaceId?: string }).forSurfaceId === 'surface-1',
      );

      // --- chat.unqueue_request / resume_request / pin_request / archive_request
      //     (handleServerEvent switch) ---
      boot.fakeServer.send({
        type: 'chat.unqueue_request',
        chatId: 'chat-main-1',
        localId: 'nope',
      });
      boot.fakeServer.send({ type: 'chat.pin_request', chatId: 'chat-main-1', pinned: true });
      boot.fakeServer.send({
        type: 'chat.archive_request',
        chatId: 'chat-main-1',
        archived: false,
      });
      // E5: soft-delete + restore over the daemon-link (handleServerEvent switch).
      boot.fakeServer.send({ type: 'chat.delete_request', chatId: 'chat-main-1', deleted: true });
      boot.fakeServer.send({ type: 'chat.delete_request', chatId: 'chat-main-1', deleted: false });
      boot.fakeServer.send({ type: 'chat.stop_request', chatId: 'chat-main-1' });

      // --- unknown-chat error path (FolderNotFoundError / ChatNotFoundError
      //     -> chat.error mapping in handleServerEvent's catch) ---
      boot.fakeServer.send({
        type: 'chat.spawn_request',
        daemonId: 'd1',
        folder: '/no/such/folder-xyz',
        localId: 'spawn-bad',
        // A prompt on a spawn that fails FolderNotFoundError before ever
        // reaching a turn — covers `event.prompt !== undefined`'s TRUE
        // side without needing to actually run + wait out an initial turn.
        prompt: 'get started',
      });
      await boot.fakeServer.waitForFrame(
        (e) => e.type === 'chat.error' && e.error.code === 'folder_not_found',
      );
      boot.fakeServer.send({ type: 'chat.resume_request', chatId: 'no-such-chat' });
      await boot.fakeServer.waitForFrame(
        (e) => e.type === 'chat.error' && e.chatId === 'no-such-chat',
      );

      // --- default branch: a legitimately-typed but daemon-ignored frame ---
      boot.fakeServer.send({ type: 'surface.heartbeat' });

      // --- a snapshot whose only Claude account is disconnected (spec/01 §
      //     Settings): the host runs on the server's accounts, so it reports
      //     itself signed out ---
      boot.fakeServer.send({
        type: 'settings.snapshot',
        daemonId: 'd1',
        version: 1,
        settings: DEFAULT_SHARED_SETTINGS,
        secrets: {
          claude: [{ id: 'default', label: 'Default', credential: null }],
          codex: [],
          providerKeys: {},
        },
      });
      await boot.fakeServer.waitForFrame((e) => e.type === 'settings.applied' && e.version === 1);
      await boot.fakeServer.waitForFrame(
        (e) => e.type === 'daemon.account' && e.connected === false,
      );

      // --- control-UDS closures main() wires into buildControl: listDevices
      //     (-> presence.enumerate/isOnline/isMuted), toolLogger, the
      //     serverLink diagnostics/dropLink/floodBuffer triad, and
      //     onBroadcast (via /internal/notify). All otherwise unreachable
      //     without hitting these exact endpoints — nothing else invokes them. ---
      boot.ready.deviceRegistry.register({
        deviceId: 'device-paired-1',
        name: 'kitchen',
        accountId: 'acct-1',
        publicKey: 'fake-pubkey',
        registeredAt: Date.now(),
      });
      const devicesRes = await boot.ready.app.inject({
        method: 'GET',
        url: '/internal/devices',
        headers: AUTH,
        headers: { authorization: `Bearer ${boot.localKey}` },
      });
      expect(devicesRes.statusCode).toBe(200);
      // Registered but never connected -> reported offline (presence.isOnline
      // + isMuted are exercised on the real per-device iteration path).
      expect(devicesRes.json()).toMatchObject({
        devices: [{ deviceId: 'device-paired-1', online: false }],
      });

      const diagRes = await boot.ready.app.inject({
        method: 'GET',
        url: '/internal/diag/link',
        headers: AUTH,
        headers: { authorization: `Bearer ${boot.localKey}` },
      });
      expect(diagRes.statusCode).toBe(200);

      // GET /internal/jobs -> RemoteJobsStore.list() -> the `isLinkOnline`
      // closure main() wires (`() => linkOnline`) — otherwise unreachable,
      // since nothing else in index.ts reads that flag.
      const jobsRes = await boot.ready.app.inject({
        method: 'GET',
        url: '/internal/jobs',
        headers: AUTH,
        headers: { authorization: `Bearer ${boot.localKey}` },
      });
      expect(jobsRes.statusCode).toBe(200);

      // patch_notify on 'push' — onBroadcast's `threadForChannel(channel)`
      // returns null for a channel with no mediating thread (only
      // 'speakers' has one), hitting its `!threadId -> return`
      // branch (the 'speakers' sends below cover the other side).
      const notifyPushRes = await boot.ready.app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        headers: { authorization: `Bearer ${boot.localKey}` },
        payload: { callerChatId: 'chat-main-1', channel: 'push', message: 'a push notify' },
      });
      expect(notifyPushRes.statusCode).toBe(200);
      await boot.fakeServer.waitForFrame((e) => e.type === 'notify' && e.channel === 'push');

      // patch_notify on 'speakers' from an ordinary (non-thread) chat ->
      // onBroadcast appends to thread_speakers's sidecar (not a self-loop).
      const notifyRes = await boot.ready.app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        headers: { authorization: `Bearer ${boot.localKey}` },
        payload: { callerChatId: 'chat-main-1', channel: 'speakers', message: 'hello speakers' },
      });
      expect(notifyRes.statusCode).toBe(200);
      await boot.fakeServer.waitForFrame((e) => e.type === 'notify' && e.channel === 'speakers');

      // patch_notify on 'speakers' from a chat with NO name yet (spawned via
      // /spawn-chat above with no `name` payload field, and never turned) ->
      // onBroadcast's `sourceState?.name ?? sourceChatId` fallback branch
      // (the send above always had a named source chat, covering only the
      // `sourceState.name` truthy side).
      const notifyUnnamedRes = await boot.ready.app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        headers: { authorization: `Bearer ${boot.localKey}` },
        payload: {
          callerChatId: preExistingChatId,
          channel: 'speakers',
          message: 'hello from an unnamed chat',
        },
      });
      expect(notifyUnnamedRes.statusCode).toBe(200);
      await boot.fakeServer.waitForFrame(
        (e) => e.type === 'notify' && e.channel === 'speakers' && e.chatId === preExistingChatId,
      );

      // patch_notify fired FROM thread_speakers ON its own 'speakers'
      // channel -> onBroadcast's `isBroadcastSelfLoop` branch suppresses
      // the sidecar append (the wire event still fans out — only the local
      // broadcasts.jsonl write is skipped).
      const beforePending = readPendingBroadcasts(process.cwd(), 'thread_speakers').length;
      const selfLoopRes = await boot.ready.app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        headers: { authorization: `Bearer ${boot.localKey}` },
        payload: {
          callerChatId: 'thread_speakers',
          channel: 'speakers',
          message: 'self-loop, should not append',
        },
      });
      expect(selfLoopRes.statusCode).toBe(200);
      await boot.fakeServer.waitForFrame(
        (e) => e.type === 'notify' && e.channel === 'speakers' && e.chatId === 'thread_speakers',
      );
      expect(readPendingBroadcasts(process.cwd(), 'thread_speakers').length).toBe(beforePending);

      // patch_notify on 'speakers' targeting the paired-but-never-connected
      // device explicitly: the cascade's step-1 `reachable()` check calls
      // the `speakers.presence.isOnline`/`isMuted` closures (main()'s OWN
      // wiring — otherwise unreachable, since the step-2/3 candidate pool
      // uses `presence.enumerate()`'s own online/muted fields directly, not
      // these closures). Offline -> falls through to `pushFallback`.
      const notifySpeakersRes = await boot.ready.app.inject({
        method: 'POST',
        url: '/internal/notify',
        headers: AUTH,
        headers: { authorization: `Bearer ${boot.localKey}` },
        payload: {
          callerChatId: 'chat-main-1',
          channel: 'speakers',
          message: 'ring ring',
          deviceId: 'device-paired-1',
        },
      });
      expect(notifySpeakersRes.statusCode).toBe(200);
      await boot.fakeServer.waitForFrame(
        (e) => e.type === 'notify' && e.channel === 'push' && e.message.includes('ring ring'),
      );

      // dropLink (control-UDS diag) — severs the socket without stopping the
      // host; the auto-reconnect below proves it comes back up.
      const dropRes = await boot.ready.app.inject({
        method: 'POST',
        url: '/internal/diag/drop-link',
        headers: AUTH,
        headers: { authorization: `Bearer ${boot.localKey}` },
      });
      expect(dropRes.statusCode).toBe(200);
      expect(dropRes.json()).toMatchObject({ dropped: true });

      // floodBuffer (control-UDS diag) — pushes synthetic events straight
      // into the (now-offline, post-dropLink) EventBuffer.
      const floodRes = await boot.ready.app.inject({
        method: 'POST',
        url: '/internal/diag/flood-buffer',
        headers: AUTH,
        headers: { authorization: `Bearer ${boot.localKey}` },
        payload: { chatId: 'chat-main-1', count: 3 },
      });
      expect(floodRes.statusCode).toBe(200);
      expect((floodRes.json() as { bufferSize: number }).bufferSize).toBeGreaterThanOrEqual(3);

      // --- reconnect: drop the link (onDisconnected fires), let the
      //     serverLink back off + auto-redial on the same fake-server port,
      //     and prove onAuthed's "replay every known chat" loop runs again
      //     with BOTH chats now in daemon.list(). ---
      const beforeReconnect = boot.fakeServer.received.length;
      boot.fakeServer.dropClient();
      // waitForAuthed() = waitForHello() + authNow() against whichever
      // connection is current when each resolves — i.e. the NEW one, since
      // the host's reconnect (first backoff step 250ms) replaces `current`
      // before the hello arrives.
      await boot.fakeServer.waitForAuthed();
      await boot.fakeServer.waitForFrame(
        (e) => e.type === 'chat.spawned' && e.chatId === 'chat-main-1',
      );
      expect(boot.fakeServer.received.length).toBeGreaterThanOrEqual(beforeReconnect);

      // --- POST /stop over the control app -> shutdownHook -> shutdown()
      //     -> process.exit(0). Mock process.exit so the worker survives. ---
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as unknown as never);
      try {
        const stopRes = await boot.ready.app.inject({
          method: 'POST',
          url: '/stop',
          headers: { authorization: `Bearer ${boot.localKey}` },
        });
        expect(stopRes.statusCode).toBe(200);
        await waitFor(() => exitSpy.mock.calls.length > 0);
        expect(exitSpy).toHaveBeenCalledWith(0);
      } finally {
        exitSpy.mockRestore();
      }
    } finally {
      // shutdown() has already run via the POST /stop path above; calling
      // it again is safe (every sub-close is idempotent / catches).
      await boot.cleanup();
    }
  }, 30_000);

  it('drives one real voice-device session against the booted audio server (submitUserTurn, chatExists, onDeviceSession, onSessionClosed)', async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForAuthed();
      const folder = makeFolder();
      const spawnRes = await boot.ready.app.inject({
        method: 'POST',
        url: '/spawn-chat',
        headers: { authorization: `Bearer ${boot.localKey}` },
        // Named: this boot has read no model catalogue, and a model-less spawn
        // on such a machine is refused rather than guessed (spec/04 § Spawn).
        payload: { folder, model: 'claude-opus-5' },
      });
      const { chatId } = spawnRes.json() as { chatId: string };

      const ws = new WSClient(`ws://127.0.0.1:${boot.audioPort}/audio/dev-session-1`);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      const events: AudioEvent[] = [];
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        try {
          events.push(decodeAudio(data.toString('utf8')));
        } catch {
          /* ignore non-audio-codec frames */
        }
      });

      const { token } = mintVoiceToken({
        secret: 'test-internal-token',
        accountId: 'acct-1',
        surfaceId: 'device-9',
        sessionId: 'dev-session-1',
        chatId,
      });
      ws.send(
        encodeAudio({
          type: 'audio.session_start',
          sessionId: 'dev-session-1',
          accountId: 'acct-1',
          surfaceId: 'device-9',
          surfaceKind: 'device',
          chatId,
          role: 'voice-device-conv',
          token,
          surfaceHasAec: false,
          deviceId: 'device-9',
        }),
      );

      function sendFrame(loud: boolean): void {
        const samples = 480;
        ws.send(encodeAudio({ type: 'audio.pcm16', ts: Date.now(), sampleRate: 16000, samples }));
        const pcm = new Int16Array(samples);
        if (loud) {
          for (let i = 0; i < samples; i++) pcm[i] = Math.round(8000 * Math.sin(i / 4));
        }
        ws.send(Buffer.from(pcm.buffer), { binary: true });
      }

      // device.session (active:true) fires once the session is accepted —
      // proves `onDeviceSession`.
      await waitFor(
        () =>
          boot.fakeServer.received.some(
            (e) => e.type === 'device.session' && e.deviceId === 'device-9' && e.active === true,
          ),
        10_000,
      );

      // One loud frame -> utterance_start; ~600ms of silence -> utterance_end
      // (MockVad's 500ms hangover) -> the host transcribes (mock whisper)
      // and calls submitUserTurn, which sends the utterance in as a real
      // chat.input (proving `chatExists` said yes) and streams the reply
      // back as TTS (mock kokoro).
      sendFrame(true);
      for (let i = 0; i < 25; i++) sendFrame(false);

      await waitFor(
        () =>
          events.some((e) => e.type === 'audio.tts_start') ||
          boot.fakeServer.received.some(
            (e) => e.type === 'chat.state' && e.chatId === chatId && e.activity !== 'idle',
          ),
        10_000,
      );

      // Let the turn actually reach idle (the mock SDK backend's default
      // ~2.5s turn delay) — this is what drives main()'s own `emit()`
      // voice-reply-waiter resolution (`chat.state:idle` -> resolves the
      // `replyPromise` submitUserTurn returned). NOT a bare
      // `chat.state:idle` wait — a freshly-spawned chat is ALREADY idle at
      // spawn time (before any turn runs), so that frame is already stale
      // in `received` by the time we get here. Wait for the assistant's
      // reply message instead — only a genuinely-completed turn produces one.
      await waitFor(
        () =>
          boot.fakeServer.received.some(
            (e) => e.type === 'chat.message' && e.chatId === chatId && e.role === 'assistant',
          ),
        10_000,
      );

      // Register the device (with a human name) BETWEEN the open and close
      // firings of `onDeviceSession`, so its `record?.name ?? deviceId`
      // ternary hits BOTH sides in one test: the OPEN firing above ran
      // unregistered (the `?? deviceId` fallback), and this CLOSE firing
      // now finds a name on file (the `record.name` truthy side).
      boot.ready.deviceRegistry.register({
        deviceId: 'device-9',
        name: 'the office',
        accountId: 'acct-1',
        publicKey: 'fake-pubkey-device-9',
        registeredAt: Date.now(),
      });

      // Close the session -> onSessionClosed({wasPhoneCall:false}); proves
      // the host-side session-teardown wiring runs without throwing.
      ws.close();
      await waitFor(
        () =>
          boot.fakeServer.received.some(
            (e) =>
              e.type === 'device.session' &&
              e.deviceId === 'device-9' &&
              e.active === false &&
              e.name === 'the office',
          ),
        10_000,
      );
    } finally {
      await boot.cleanup();
    }
  }, 30_000);

  it('a call on an app surface is costed when it ends: its line in the chat, its totals on daemon.host (spec/07 § Call cost)', async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForAuthed();
      const folder = makeFolder();
      const spawnRes = await boot.ready.app.inject({
        method: 'POST',
        url: '/spawn-chat',
        headers: { authorization: `Bearer ${boot.localKey}` },
        payload: { folder, model: 'claude-opus-5' },
      });
      const { chatId } = spawnRes.json() as { chatId: string };

      const ws = new WSClient(`ws://127.0.0.1:${boot.audioPort}/audio/call-session-1`);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      const { token } = mintVoiceToken({
        secret: 'test-internal-token',
        accountId: 'acct-1',
        surfaceId: 'web-1',
        sessionId: 'call-session-1',
        chatId,
      });
      ws.send(
        encodeAudio({
          type: 'audio.session_start',
          sessionId: 'call-session-1',
          accountId: 'acct-1',
          surfaceId: 'web-1',
          surfaceKind: 'web',
          chatId,
          role: 'voice-call',
          token,
          surfaceHasAec: true,
        }),
      );
      const samples = 480;
      const frame = (loud: boolean): void => {
        ws.send(encodeAudio({ type: 'audio.pcm16', ts: Date.now(), sampleRate: 16000, samples }));
        const pcm = new Int16Array(samples);
        if (loud) for (let i = 0; i < samples; i++) pcm[i] = Math.round(8000 * Math.sin(i / 4));
        ws.send(Buffer.from(pcm.buffer), { binary: true });
      };
      await new Promise((r) => setTimeout(r, 200));
      frame(true);
      for (let i = 0; i < 25; i++) frame(false);
      // The spoken turn ran on the chat's agent.
      await waitFor(
        () =>
          boot.fakeServer.received.some(
            (e) => e.type === 'chat.message' && e.chatId === chatId && e.role === 'assistant',
          ),
        10_000,
      );
      // Hung up straight after the reply: the call's line lands at once, costing
      // the voice engine alone.
      ws.close();

      await waitFor(
        () =>
          boot.fakeServer.received.some(
            (e) =>
              e.type === 'chat.message' &&
              e.chatId === chatId &&
              e.role === 'system' &&
              typeof e.content === 'string' &&
              e.content.startsWith('[call] Call 0:') &&
              e.content.includes('· Local ·') &&
              !e.content.includes('agent'),
          ),
        10_000,
      );
      await waitFor(
        () =>
          boot.fakeServer.received.some(
            (e) =>
              e.type === 'daemon.host' &&
              (e as { voiceUsage?: { allCalls: number } }).voiceUsage?.allCalls === 1,
          ),
        10_000,
      );
    } finally {
      await boot.cleanup();
    }
  }, 30_000);

  it('a call stays on the chat it was started on when the surface navigates to another chat (spec/07 § A call stays on its chat)', async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForAuthed();
      const spawn = async (): Promise<string> => {
        const res = await boot.ready.app.inject({
          method: 'POST',
          url: '/spawn-chat',
          headers: { authorization: `Bearer ${boot.localKey}` },
          payload: { folder: makeFolder(), model: 'claude-opus-5' },
        });
        return (res.json() as { chatId: string }).chatId;
      };
      const chatA = await spawn();
      const chatB = await spawn();

      const ws = new WSClient(`ws://127.0.0.1:${boot.audioPort}/audio/stay-session-1`);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      const { token } = mintVoiceToken({
        secret: 'test-internal-token',
        accountId: 'acct-1',
        surfaceId: 'web-1',
        sessionId: 'stay-session-1',
        chatId: chatA,
      });
      ws.send(
        encodeAudio({
          type: 'audio.session_start',
          sessionId: 'stay-session-1',
          accountId: 'acct-1',
          surfaceId: 'web-1',
          surfaceKind: 'web',
          chatId: chatA,
          role: 'voice-call',
          token,
          surfaceHasAec: true,
        }),
      );
      await new Promise((r) => setTimeout(r, 200));
      // The surface navigates to chat B mid-call, as the app does on every navigation.
      boot.fakeServer.send({ type: 'chat.focus_change', chatId: chatB, forSurfaceId: 'web-1' });
      await new Promise((r) => setTimeout(r, 200));

      const samples = 480;
      const frame = (loud: boolean): void => {
        ws.send(encodeAudio({ type: 'audio.pcm16', ts: Date.now(), sampleRate: 16000, samples }));
        const pcm = new Int16Array(samples);
        if (loud) for (let i = 0; i < samples; i++) pcm[i] = Math.round(8000 * Math.sin(i / 4));
        ws.send(Buffer.from(pcm.buffer), { binary: true });
      };
      frame(true);
      for (let i = 0; i < 25; i++) frame(false);
      // The spoken turn ran on the chat the call was started on …
      await waitFor(
        () =>
          boot.fakeServer.received.some(
            (e) => e.type === 'chat.message' && e.chatId === chatA && e.role === 'assistant',
          ),
        10_000,
      );
      // … and nothing was said into the chat the surface moved to.
      expect(
        boot.fakeServer.received.some(
          (e) =>
            e.type === 'chat.message' &&
            e.chatId === chatB &&
            (e.role === 'user' || e.role === 'assistant'),
        ),
      ).toBe(false);
      ws.close();
    } finally {
      await boot.cleanup();
    }
  }, 30_000);

  it('chatExists falls back to the on-disk meta store for a chat not (yet) hydrated into live chatState', async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForAuthed();
      const folder = makeFolder();
      // Write directly to the on-disk meta store AFTER boot — daemon.hydrate()
      // already ran, so this chat is on disk but absent from live chatState,
      // exercising `chatExists`'s `metaStore.read(chatId) !== undefined`
      // fallback (every OTHER voice session in this file targets a chat
      // spawned live, which short-circuits on `chatState.has()` alone).
      const metaStore = createMetaStore(boot.home);
      const chatId = 'chat-on-disk-only';
      metaStore.write({
        chatId,
        folder,
        name: null,
        nextSeq: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      expect(boot.ready.daemon.chatState.has(chatId)).toBe(false);

      const ws = new WSClient(`ws://127.0.0.1:${boot.audioPort}/audio/disk-only-session-1`);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      const events: AudioEvent[] = [];
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) return;
        try {
          events.push(decodeAudio(data.toString('utf8')));
        } catch {
          /* ignore non-audio-codec frames */
        }
      });
      const { token } = mintVoiceToken({
        secret: 'test-internal-token',
        accountId: 'acct-1',
        surfaceId: 'surface-disk-only',
        sessionId: 'disk-only-session-1',
        chatId,
      });
      ws.send(
        encodeAudio({
          type: 'audio.session_start',
          sessionId: 'disk-only-session-1',
          accountId: 'acct-1',
          surfaceId: 'surface-disk-only',
          surfaceKind: 'mobile',
          chatId,
          role: 'voice-call',
          token,
          surfaceHasAec: true,
        }),
      );
      // Accepted (not rejected `session_not_found`) proves `chatExists` found
      // it via the metaStore fallback. Non-device sessions ack acceptance with
      // an `audio.state` frame on the session's own listening transition.
      await waitFor(
        () => events.some((e) => e.type === 'audio.state' && e.state === 'listening'),
        10_000,
      );
      expect(events.some((e) => e.type === 'audio.error')).toBe(false);
      ws.close();
    } finally {
      await boot.cleanup();
    }
  }, 30_000);

  it('a non-device voice session (mobile) spoken "yes" resolves a pending permission via resolvePermission', async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForAuthed();
      const folder = makeFolder();
      const spawnRes = await boot.ready.app.inject({
        method: 'POST',
        url: '/spawn-chat',
        headers: { authorization: `Bearer ${boot.localKey}` },
        // Named: this boot has read no model catalogue, and a model-less spawn
        // on such a machine is refused rather than guessed (spec/04 § Spawn).
        payload: { folder, model: 'claude-opus-5' },
      });
      const { chatId } = spawnRes.json() as { chatId: string };

      const ws = new WSClient(`ws://127.0.0.1:${boot.audioPort}/audio/mobile-session-1`);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      const { token } = mintVoiceToken({
        secret: 'test-internal-token',
        accountId: 'acct-1',
        surfaceId: 'surface-mobile-1',
        sessionId: 'mobile-session-1',
        chatId,
      });
      // surfaceKind:'mobile' (NOT 'device') -> exercises the OTHER side of
      // submitUserTurn's voicePrefix/localIdSuffix ternaries (the
      // `[voice • <surfaceKind>]` / `source.sessionId ?? source.surfaceKind`
      // branches main()'s device-kind test above never reaches).
      ws.send(
        encodeAudio({
          type: 'audio.session_start',
          sessionId: 'mobile-session-1',
          accountId: 'acct-1',
          surfaceId: 'surface-mobile-1',
          surfaceKind: 'mobile',
          chatId,
          role: 'voice-call',
          token,
          surfaceHasAec: true,
        }),
      );
      // Give the session_start handshake a moment to be accepted before
      // injecting the utterance.
      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      // A spoken "no" first — proves resolvePermission's `approve: false`
      // (deny) side; the "yes" a moment later proves its `approve: true`
      // side. patch.diag.voice_inject bypasses STT entirely (injects
      // transcribed TEXT straight into the open session), so no mock
      // whisper needs to somehow transcribe real audio as these words.
      const requestId2 = boot.ready.daemon.injectPermissionRequest(
        chatId,
        'Bash',
        'run another command',
      );
      expect(boot.ready.daemon.getPendingPermissionForChat(chatId)).toBe(requestId2);
      boot.fakeServer.send({
        type: 'patch.diag.voice_inject',
        surfaceId: 'surface-mobile-1',
        text: 'no',
      });
      await waitFor(
        () => boot.ready.daemon.getPendingPermissionForChat(chatId) === undefined,
        10_000,
      );

      boot.ready.daemon.injectPermissionRequest(chatId, 'Bash', 'run a third command');
      boot.fakeServer.send({
        type: 'patch.diag.voice_inject',
        surfaceId: 'surface-mobile-1',
        text: 'yes',
      });
      await waitFor(
        () => boot.ready.daemon.getPendingPermissionForChat(chatId) === undefined,
        10_000,
      );

      // Now inject an ORDINARY (non-yes/no) utterance on the same mobile
      // session — with no pending permission left, this falls through to a
      // real turn via `submitUserTurn`, exercising the surfaceKind branch
      // of its voicePrefix/localIdSuffix ternaries (`[voice • mobile]` /
      // `source.sessionId ?? source.surfaceKind`) that the device-kind test
      // above never reaches.
      boot.fakeServer.send({
        type: 'patch.diag.voice_inject',
        surfaceId: 'surface-mobile-1',
        text: 'what is the weather like today',
      });
      // NOT a `chat.state:activity!=='idle'` wire-frame wait — the earlier
      // injectPermissionRequest already put an `awaiting-permission` (also
      // non-idle) chat.state frame in `received`, which would make that
      // predicate resolve instantly on the WRONG (stale) frame. Poll the
      // host's own turn-tracking directly instead.
      await waitFor(() => boot.ready.daemon.chatState.get(chatId)?.activity === 'running', 5_000);

      // Closing this session -> the server's `ws.on('close', ...)` handler
      // computes `wasPhoneCall = role === 'voice-call' && surfaceKind !==
      // 'device'` — TRUE here (role:'voice-call', surfaceKind:'mobile') ->
      // `onSessionClosed({wasPhoneCall: true})` -> main()'s
      // `deviceControl.onPhoneCallEnded()` branch (the device-kind test
      // above always closes a `surfaceKind:'device'` session, so it only
      // ever exercises the FALSE side). Wait for the client's own close
      // round-trip, then a short settle, so the server-side handler (which
      // runs synchronously off the underlying socket's own close) has
      // actually fired before `boot.cleanup()` tears the process down.
      ws.close();
      await new Promise<void>((resolve) => ws.once('close', () => resolve()));
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await boot.cleanup();
    }
  }, 30_000);

  it('SDK_BACKEND=real constructs createRealSdkBackend() at boot (never queries — no OAuth is provided)', async () => {
    // Only proves index.ts's own `config.sdkBackend === 'real'` construction
    // branch wires up cleanly at boot. createRealSdkBackend()'s own behavior
    // (lazy SDK import, query/session handling, every branch of its wrapper)
    // is exhaustively covered directly in test/sdkBackend-real.test.ts — this
    // does NOT send any chat.input, so no real Claude query is ever attempted
    // (the OAuth gate would refuse it before reaching the SDK regardless,
    // since no credential is configured, but we don't rely on that: simply
    // never triggering a turn is the safer, more direct guarantee).
    const boot = await bootMain({ SDK_BACKEND: 'real' });
    await boot.cleanup();
  });

  it("CLAUDE_CREDENTIALS_PATH unset -> makeResolveOAuth()'s no-override construction branch", async () => {
    // The `config.claudeCredentialsPath !== undefined` ternary at the
    // makeResolveOAuth() call site — safe to leave genuinely unset here
    // (unlike the claude.disconnect handler's OWN use of the same config
    // field, which is destructive and always gets a real override in every
    // other test in this file): with SDK_BACKEND=mock, makeResolveOAuth()'s
    // resolver is a documented no-op that never touches Claude credentials
    // regardless of this path, and this test deliberately never sends a
    // `claude.disconnect` frame (the one path that WOULD read/write real
    // host files with no override).
    const boot = await bootMain({ CLAUDE_CREDENTIALS_PATH: undefined });
    await boot.cleanup();
  });

  it('VAD_BACKEND=silero loads a (mocked) onnxruntime-node session via createSileroVadFactory() at boot', async () => {
    const modelHome = mkdtempSync(join(tmpdir(), 'patch-vad-model-'));
    const modelPath = join(modelHome, 'silero_vad.onnx');
    writeFileSync(modelPath, 'not a real onnx model, just needs to exist');
    const boot = await bootMain({ VAD_BACKEND: 'silero', VAD_MODEL_PATH: modelPath });
    await boot.cleanup();
    rmSync(modelHome, { recursive: true, force: true });
  });

  it("PATCH_MOCK_TURN_DELAY_MS overrides the mock SDK backend's default 2.5s turn delay", async () => {
    const boot = await bootMain({ PATCH_MOCK_TURN_DELAY_MS: '5' });
    await boot.cleanup();
  });

  it('a resolvable Claude OAuth credential -> the "loaded" branch + daemon.claude_account{connected:true}', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-oauth-ok-'));
    const credsPath = join(home, 'creds.json');
    writeFileSync(
      credsPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'tok-abc',
          refreshToken: 'refresh-abc',
          expiresAt: Date.now() + 60 * 60_000,
        },
      }),
    );
    const boot = await bootMain({ CLAUDE_CREDENTIALS_PATH: credsPath });
    try {
      await boot.fakeServer.waitForAuthed();
      const account = await boot.fakeServer.waitForFrame((e) => e.type === 'daemon.account');
      expect(account).toMatchObject({ type: 'daemon.account', connected: true });
    } finally {
      await boot.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a malformed daemon.key (no payload segment / missing sub) rejects boot before any listener starts', async () => {
    // Both cases fail inside main() BEFORE any socket/port is bound, so there
    // is nothing to clean up beyond the temp dirs bootMain itself made before
    // main() threw (bootMain's own promise rejects, so we build the pieces
    // manually here instead of using the happy-path helper).
    const home = mkdtempSync(join(tmpdir(), 'patch-badkey-home-'));
    const daemonCwd = mkdtempSync(join(tmpdir(), 'patch-badkey-cwd-'));
    const fakeServer = await startFakeServer();
    const healthzPort = await freePort();
    const audioPort = await freePort();
    const previousCwd = process.cwd();
    const savedEnv: Record<string, string | undefined> = {};
    const setEnv = (env: Record<string, string>): void => {
      for (const [k, v] of Object.entries(env)) {
        savedEnv[k] = process.env[k];
        process.env[k] = v;
      }
    };
    const restoreEnv = (): void => {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
    process.chdir(daemonCwd);
    setEnv({
      PATCH_HOME: home,
      PATCH_DAEMON_SOCKET: join(home, 'daemon.sock'),
      PATCH_DAEMON_HEALTHZ_PORT: String(healthzPort),
      PATCH_DAEMON_HEALTHZ_HOST: '127.0.0.1',
      PATCH_SERVER_WS_URL: fakeServer.url,
      PATCH_SERVER_URL: `http://127.0.0.1:${fakeServer.port}`,
      PATCH_INTERNAL_TOKEN: 'test-internal-token',
      SDK_BACKEND: 'mock',
      PATCH_CLAUDE_PROJECTS_ROOT: join(home, 'claude-projects'),
      PATCH_DAEMON_AUDIO_PORT: String(audioPort),
      PATCH_DAEMON_AUDIO_HOST: '127.0.0.1',
      WHISPER_BACKEND: 'mock',
      KOKORO_BACKEND: 'mock',
      VAD_BACKEND: 'mock',
      PATCH_VOICE_MAX_SESSIONS: '4',
      CLAUDE_OAUTH_NO_KEYCHAIN: '1',
      CLAUDE_CREDENTIALS_PATH: join(home, 'no-such-credentials.json'),
      CLAUDE_CONFIG_PATH: join(home, 'fake-claude-config.json'),
    });
    try {
      // Case 1: no payload segment at all.
      writeFileSync(join(home, 'daemon.key'), 'onlyoneseg');
      await expect(main()).rejects.toThrow(/no payload segment/);

      // Case 2: valid JSON payload, but no `sub` claim.
      const payload = Buffer.from(JSON.stringify({ notSub: 'x' }), 'utf8').toString('base64url');
      writeFileSync(join(home, 'daemon.key'), `header.${payload}.sig`);
      await expect(main()).rejects.toThrow(/no `sub`/);
    } finally {
      restoreEnv();
      process.chdir(previousCwd);
      await fakeServer.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(daemonCwd, { recursive: true, force: true });
    }
  });

  it('no daemon.key on disk -> runs the QR registration flow and persists the returned key', async () => {
    vi.mocked(registerDaemon).mockResolvedValueOnce({
      daemonKey: await mintDaemonKey({
        userPrivateKey: generateUserKeypair().privateKey,
        daemonId: 'd-registered',
        label: 'test',
      }),
      daemonId: 'd-registered',
    });
    const boot = await bootMain({ __NO_DAEMON_KEY__: 'true' });
    try {
      expect(existsSync(join(boot.home, 'daemon.key'))).toBe(true);
      expect(vi.mocked(registerDaemon).mock.calls.at(-1)?.[0]).not.toHaveProperty('prePairedNonce');
    } finally {
      await boot.cleanup();
    }
  });

  it('no daemon.key + PATCH_PAIR_NONCE set -> forwards prePairedNonce to registerDaemon', async () => {
    vi.mocked(registerDaemon).mockResolvedValueOnce({
      daemonKey: await mintDaemonKey({
        userPrivateKey: generateUserKeypair().privateKey,
        daemonId: 'd-registered-2',
        label: 'test',
      }),
      daemonId: 'd-registered-2',
    });
    const boot = await bootMain({ __NO_DAEMON_KEY__: 'true', PATCH_PAIR_NONCE: 'nonce-abc' });
    try {
      expect(vi.mocked(registerDaemon).mock.calls.at(-1)?.[0]).toMatchObject({
        prePairedNonce: 'nonce-abc',
      });
    } finally {
      await boot.cleanup();
    }
  });

  it('KOKORO_BACKEND=real pre-warms the sidecar at boot (success, non-fatal failure)', async () => {
    // validateKokoroModel (a boot-time gate, unrelated to the prewarm itself)
    // requires KOKORO_MODEL_PATH to exist on disk whenever backend=real, even
    // though the fake sidecar below never actually reads the file.
    const modelHome = mkdtempSync(join(tmpdir(), 'patch-kokoro-model-'));
    const modelPath = join(modelHome, 'fake-kokoro.onnx');
    writeFileSync(modelPath, 'not a real model, just needs to exist');

    // Success case: point KOKORO_SIDECAR_URL at a tiny fake WS "sidecar" that
    // answers the synthesize handshake with one PCM frame + {end:true}.
    const sidecarPort = await freePort();
    const sidecarWss = new WebSocketServer({ port: sidecarPort });
    sidecarWss.on('connection', (ws) => {
      ws.on('message', () => {
        ws.send(Buffer.from(new Int16Array(4).buffer), { binary: true });
        ws.send(JSON.stringify({ end: true }));
      });
    });
    await new Promise<void>((resolve) => sidecarWss.once('listening', () => resolve()));
    const bootOk = await bootMain({
      KOKORO_BACKEND: 'real',
      KOKORO_MODEL_PATH: modelPath,
      KOKORO_SIDECAR_URL: `ws://127.0.0.1:${sidecarPort}`,
    });
    // The prewarm is a fire-and-forget async IIFE (main() never awaits it —
    // onReady fires the instant the rest of boot completes, by design, so a
    // slow model load never blocks host readiness). Give it a beat to
    // actually finish streaming + logging before cleanup() tears the kokoro
    // client down out from under it (which would otherwise race the
    // "pre-warmed" success log with a spurious "client closed" failure).
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    await bootOk.cleanup();
    await new Promise<void>((resolve) => sidecarWss.close(() => resolve()));

    // No-sidecar-listening case: RealKokoroBackend's request/stream contract
    // (persistent-ws) deliberately converts ANY mid-stream sidecar failure
    // into a logged warn + a gracefully-EMPTY iterator (see the `requestPromise
    // .catch()` in kokoro.ts) rather than a rejection — by design, so a
    // dropped sidecar mid-reply degrades to silence, not a thrown error. So
    // `kokoro.synthesize('Ready.')` here still resolves and its iterator
    // still completes normally (zero chunks) even with nothing listening;
    // this is exercising the boot-time prewarm's tolerance of that, not a
    // literal exception path (see the v8-ignore on index.ts's prewarm catch
    // block for why that branch is unreachable under any config that passes
    // boot validation).
    const deadPort = await freePort();
    const bootFail = await bootMain({
      KOKORO_BACKEND: 'real',
      KOKORO_MODEL_PATH: modelPath,
      KOKORO_SIDECAR_URL: `ws://127.0.0.1:${deadPort}`,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    await bootFail.cleanup();
    rmSync(modelHome, { recursive: true, force: true });
  });

  it('whisper/kokoro optional-field construction spreads (groqApiKey, sidecar URLs/model paths)', async () => {
    // All of these fields are accepted regardless of the SELECTED backend
    // (still 'mock' here) — main() spreads them into createWhisper/createKokoro
    // whenever they're SET, independent of which backend is active. Setting
    // them exercises index.ts's own `!== undefined` branches without needing
    // the mock backend to actually use them.
    const boot = await bootMain({
      GROQ_API_KEY: 'groq-test-key',
      WHISPER_LOCAL_SIDECAR_URL: 'ws://127.0.0.1:1/whisper-unused',
      WHISPER_MODEL_PATH: '/no/such/whisper-model',
      KOKORO_SIDECAR_URL: 'ws://127.0.0.1:1/kokoro-unused',
      KOKORO_MODEL_PATH: '/no/such/kokoro-model',
    });
    await boot.cleanup();

    // The "self-spawn a local sidecar" cwd branches (index.ts computes a
    // `localSidecarCwd`/`sidecarCwd` when NO external sidecar URL is given).
    // Constructing these options doesn't itself spawn anything — createWhisper/
    // createKokoro only spawn lazily on first real use (transcribeClip /
    // synthesize) — EXCEPT kokoroBackend='real' also fires the boot-time
    // prewarm, so KOKORO_SIDECAR_CWD is pinned at a throwaway temp dir (never
    // a real project path) so that `uv run` fails fast on an invalid cwd
    // instead of risking it resolving somewhere real and doing actual work.
    const whisperModelHome = mkdtempSync(join(tmpdir(), 'patch-whisper-model-'));
    const whisperModelPath = join(whisperModelHome, 'fake-whisper-model');
    writeFileSync(whisperModelPath, 'not a real model');
    const bootLocalWhisper = await bootMain({
      WHISPER_BACKEND: 'local',
      WHISPER_MODEL_PATH: whisperModelPath,
    });
    await bootLocalWhisper.cleanup();
    rmSync(whisperModelHome, { recursive: true, force: true });

    const kokoroModelHome = mkdtempSync(join(tmpdir(), 'patch-kokoro-selfspawn-model-'));
    const kokoroModelPath = join(kokoroModelHome, 'fake-kokoro-model.onnx');
    writeFileSync(kokoroModelPath, 'not a real model');
    const bootRealKokoroSelfSpawn = await bootMain({
      KOKORO_BACKEND: 'real',
      KOKORO_MODEL_PATH: kokoroModelPath,
      KOKORO_SIDECAR_CWD: join(kokoroModelHome, 'no-such-sidecar-dir'),
    });
    await bootRealKokoroSelfSpawn.cleanup();
    rmSync(kokoroModelHome, { recursive: true, force: true });
  });

  it('a machine that is not the home machine creates no Manager or Speakers, and does once it becomes home', async () => {
    const boot = await bootMain({ PATCH_IS_HOME_HOST: '0' });
    try {
      await boot.fakeServer.waitForAuthed();
      expect(boot.ready.daemon.chatState.has('thread_manager')).toBe(false);
      expect(boot.ready.daemon.chatState.has('thread_speakers')).toBe(false);

      boot.fakeServer.send({ type: 'host.set_home', daemonId: 'd1' });
      await waitFor(() => boot.ready.daemon.chatState.has('thread_manager'));
      expect(boot.ready.daemon.chatState.has('thread_speakers')).toBe(true);
      // The server learns of them, or no surface would ever see the new Manager.
      await boot.fakeServer.waitForFrame(
        (e) => e.type === 'chat.spawned' && e.chatId === 'thread_manager',
      );
    } finally {
      await boot.cleanup();
    }
  }, 30_000);

  it('takes the goal settings from the snapshot and keeps them across a restart of the host', async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForAuthed();
      boot.fakeServer.send({
        type: 'settings.snapshot',
        daemonId: 'd1',
        version: 41,
        settings: {
          ...DEFAULT_SHARED_SETTINGS,
          goalEvalPrompt: 'Judge harshly.',
          goalModel: 'claude-sonnet-5',
          goalRefusalLimit: 5,
        },
        secrets: { claude: [], codex: [], providerKeys: {} },
      } as WireEvent);
      const hostJson = (): Record<string, unknown> =>
        JSON.parse(readFileSync(join(boot.home, 'host.json'), 'utf8'));
      await waitFor(() => hostJson()['goalRefusalLimit'] === 5);
      expect(hostJson()).toMatchObject({
        goalEvalPrompt: 'Judge harshly.',
        goalModel: 'claude-sonnet-5',
        goalRefusalLimit: 5,
      });
    } finally {
      await boot.cleanup();
    }
  }, 30_000);

  it("rebuilds a chat's log from log_restore frames and hands its own log back on log_sync", async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForAuthed();
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-main-logsync-')));
      const chatId = await boot.ready.daemon.spawnChat({ folder, model: 'claude-opus-5' });
      const say = (seq: number, role: 'user' | 'assistant', content: string): WireEvent =>
        ({ type: 'chat.message', chatId, role, content, seq }) as WireEvent;

      boot.fakeServer.send({
        type: 'patch.log_restore',
        chatId,
        events: [say(5, 'user', 'question'), say(6, 'assistant', 'answer')],
        done: true,
      } as WireEvent);
      await waitFor(() => boot.ready.daemon.eventsAfter(chatId, -1).length === 2);

      boot.fakeServer.send({ type: 'patch.log_sync.request', chatId, afterSeq: 5 } as WireEvent);
      const batch = (await boot.fakeServer.waitForFrame(
        (e) => e.type === 'patch.log_sync.batch' && e.chatId === chatId,
      )) as { events: Array<{ seq: number; content: string }>; done: boolean };
      expect(batch.done).toBe(true);
      expect(batch.events.map((e) => [e.seq, e.content])).toEqual([[6, 'answer']]);

      // A chat the host does not have is answered with an empty, finished batch.
      boot.fakeServer.send({
        type: 'patch.log_sync.request',
        chatId: 'nope',
        afterSeq: -1,
      } as WireEvent);
      const none = (await boot.fakeServer.waitForFrame(
        (e) => e.type === 'patch.log_sync.batch' && e.chatId === 'nope',
      )) as { events: unknown[]; done: boolean };
      expect(none).toMatchObject({ events: [], done: true });
    } finally {
      await boot.cleanup();
    }
  }, 30_000);

  it('a machine told to stand in for the Manager creates it, remembers the takeover once, and lets go on release', async () => {
    const boot = await bootMain({ PATCH_IS_HOME_HOST: '0' });
    try {
      await boot.fakeServer.waitForAuthed();
      expect(boot.ready.daemon.chatState.has('thread_manager')).toBe(false);

      boot.fakeServer.send({
        type: 'host.manager_adopt',
        daemonId: 'd1',
        epoch: 3,
        handoff: 'recent conversation',
        nextSeq: 12,
      });
      await waitFor(() => boot.ready.daemon.chatState.has('thread_manager'));
      await boot.fakeServer.waitForFrame(
        (e) => e.type === 'chat.spawned' && e.chatId === 'thread_manager',
      );
      const hostJson = (): { managerEpoch?: number; managerHandoff?: string } =>
        JSON.parse(readFileSync(join(boot.home, 'host.json'), 'utf8'));
      expect(hostJson()).toMatchObject({ managerEpoch: 3, managerHandoff: 'recent conversation' });

      // The same takeover told again, or an older one, changes nothing.
      boot.fakeServer.send({
        type: 'host.manager_adopt',
        daemonId: 'd1',
        epoch: 3,
        handoff: 'something else',
        nextSeq: 99,
      });
      await new Promise((r) => setTimeout(r, 100));
      expect(hostJson().managerHandoff).toBe('recent conversation');

      boot.fakeServer.send({ type: 'host.manager_release', daemonId: 'd1', epoch: 4 });
      await waitFor(() => hostJson().managerEpoch === 4);
      expect(hostJson().managerHandoff).toBeUndefined();
    } finally {
      await boot.cleanup();
    }
  }, 30_000);

  it('ignores a takeover addressed to another machine', async () => {
    const boot = await bootMain({ PATCH_IS_HOME_HOST: '0' });
    try {
      await boot.fakeServer.waitForAuthed();
      boot.fakeServer.send({
        type: 'host.manager_adopt',
        daemonId: 'someone-else',
        epoch: 1,
        handoff: 'x',
        nextSeq: 0,
      });
      await new Promise((r) => setTimeout(r, 150));
      expect(boot.ready.daemon.chatState.has('thread_manager')).toBe(false);
    } finally {
      await boot.cleanup();
    }
  }, 30_000);

  it('special-thread broadcast sidecar: preprocessInput prepends pending broadcasts, onTurnCommitted flushes them', async () => {
    // Two sequential ~2.5s mock-backend turns (thread_speakers, then
    // thread_manager) — comfortably over the default 5s test timeout.
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForAuthed();
      // The sidecar lives under the host's PATCH_HOME, not its cwd.
      const daemonCwd = boot.home;
      appendBroadcast(daemonCwd, 'thread_speakers', {
        ts: Date.now(),
        sourceChatName: 'some-other-chat',
        message: 'a broadcast that arrived earlier',
      });
      expect(readPendingBroadcasts(daemonCwd, 'thread_speakers').length).toBeGreaterThan(0);

      boot.fakeServer.send({
        type: 'chat.input',
        chatId: 'thread_speakers',
        message: 'hi from speakers',
        localId: 'speakers-input-1',
      });
      // NOT a single `waitForFrame` on `chat.state:idle` — thread_speakers is
      // ALREADY idle at boot (ensureSpecialThreads), and onAuthed's baseline
      // replay already sent that stale idle state before this turn ever ran,
      // which would make a naive "first idle frame" wait resolve on the WRONG
      // (pre-turn) frame. Poll the actual on-disk effect instead — robust to
      // exactly how many/which frames land in between.
      await waitFor(() => readPendingBroadcasts(daemonCwd, 'thread_speakers').length === 0, 15_000);

      // thread_manager is a SPECIAL_THREAD_ID but NOT in
      // BROADCAST_SIDECAR_THREADS — a turn on it exercises preprocessInput's
      // and onTurnCommitted's `!BROADCAST_SIDECAR_THREADS.has(threadId)`
      // early-return branches (thread_speakers, above, is always IN that
      // set, so it never took this side).
      boot.fakeServer.send({
        type: 'chat.input',
        chatId: 'thread_manager',
        message: 'hi from manager',
        localId: 'manager-input-1',
      });
      await waitFor(
        () => boot.ready.daemon.chatState.get('thread_manager')?.activity === 'running',
        5_000,
      );
      await waitFor(
        () => boot.ready.daemon.chatState.get('thread_manager')?.activity === 'idle',
        10_000,
      );
    } finally {
      await boot.cleanup();
    }
  }, 30_000);

  it('preprocessInput: no pending broadcasts on a sidecar thread -> the `!block` early-return branch', async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForAuthed();
      const daemonCwd = process.cwd();
      expect(readPendingBroadcasts(daemonCwd, 'thread_speakers').length).toBe(0);
      boot.fakeServer.send({
        type: 'chat.input',
        chatId: 'thread_speakers',
        message: 'no broadcasts pending here',
        localId: 'speakers-no-broadcast-1',
      });
      await waitFor(
        () =>
          boot.fakeServer.received.some(
            (e) =>
              e.type === 'chat.message' && e.chatId === 'thread_speakers' && e.role === 'assistant',
          ),
        10_000,
      );
      const assistant = boot.fakeServer.received.find(
        (e) =>
          e.type === 'chat.message' && e.chatId === 'thread_speakers' && e.role === 'assistant',
      ) as { content: string };
      // preprocessInput returned undefined (`block` was falsy, no pending
      // broadcasts) -> the mock SDK's echoed reply is the RAW turn message,
      // with no <system-reminder> prepended (the sibling test above always
      // has a broadcast pending, covering only the truthy side).
      expect(assistant.content).toContain('no broadcasts pending here');
      expect(assistant.content).not.toContain('<system-reminder>');
    } finally {
      await boot.cleanup();
    }
  }, 15_000);

  it("preprocessInput: pending broadcast + a voice-tagged chat.input -> the block/voicePrefix ternaries' other true side", async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForAuthed();
      // The sidecar lives under the host's PATCH_HOME, not its cwd.
      const daemonCwd = boot.home;
      appendBroadcast(daemonCwd, 'thread_speakers', {
        ts: Date.now(),
        sourceChatName: 'some-other-chat',
        message: 'a voice-tagged broadcast',
      });
      // `source` carries voice-device ingress metadata -> voicePrefixForSource
      // returns a non-empty prefix, so preprocessInput's rewritten message is
      // `block + voicePrefix + message` (every other broadcast-sidecar test in
      // this file omits `source`, covering only the plain-`req.message` side).
      boot.fakeServer.send({
        type: 'chat.input',
        chatId: 'thread_speakers',
        message: 'hello from a device',
        localId: 'speakers-voice-1',
        source: { kind: 'voice-device', deviceId: 'kitchen' },
      });
      await waitFor(
        () =>
          boot.fakeServer.received.some(
            (e) =>
              e.type === 'chat.message' && e.chatId === 'thread_speakers' && e.role === 'assistant',
          ),
        15_000,
      );
      const assistant = boot.fakeServer.received.find(
        (e) =>
          e.type === 'chat.message' && e.chatId === 'thread_speakers' && e.role === 'assistant',
      ) as { content: string };
      expect(assistant.content).toContain('<system-reminder>');
      expect(assistant.content).toContain('[voice • device:kitchen] hello from a device');
    } finally {
      await boot.cleanup();
    }
  }, 15_000);

  it('UDS control socket path handling: creates a missing parent dir, and removes a stale leftover socket', async () => {
    // Case 1: the socket's parent directory doesn't exist yet (a fresh
    // PATCH_HOME nested under a dir that hasn't been created).
    const home = mkdtempSync(join(tmpdir(), 'patch-sockdir-home-'));
    const nestedSocketPath = join(home, 'nested', 'sub', 'daemon.sock');
    const bootNested = await bootMain({ PATCH_DAEMON_SOCKET: nestedSocketPath });
    expect(existsSync(nestedSocketPath)).toBe(true);
    await bootNested.cleanup();

    // Case 2: a stale UNIX socket file already sits at the target path (as if
    // a previous host process crashed without cleaning up) — boot removes
    // it and binds fresh rather than refusing to start. `net.Server#close()`
    // unlinks its own socket file, so we can't create-then-close to leave a
    // stale one behind — instead leave this server LISTENING (never close()
    // it) so the file persists on disk exactly like a crashed host's would,
    // and let main()'s own unlink+rebind claim the path out from under it.
    const socketPath = join(home, 'stale.sock');
    const staleServer = createServer();
    await new Promise<void>((resolve) => staleServer.listen(socketPath, () => resolve()));
    expect(existsSync(socketPath)).toBe(true);
    const bootStale = await bootMain({ PATCH_DAEMON_SOCKET: socketPath });
    await bootStale.cleanup();
    await new Promise<void>((resolve) => staleServer.close(() => resolve()));

    // Case 3: a plain (non-socket) file already sits at the target path ->
    // boot refuses to silently delete an unrelated file and throws loudly.
    const regularFilePath = join(home, 'not-a-socket');
    writeFileSync(regularFilePath, 'just a regular file');
    await expect(bootMain({ PATCH_DAEMON_SOCKET: regularFilePath })).rejects.toThrow(
      /Refusing to remove non-socket file/,
    );

    rmSync(home, { recursive: true, force: true });
  });

  it('SIGINT and SIGTERM both trigger graceful shutdown + process.exit(0)', async () => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const boot = await bootMain();
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => undefined) as unknown as never);
      try {
        process.emit(signal);
        await waitFor(() => exitSpy.mock.calls.length > 0);
        expect(exitSpy).toHaveBeenCalledWith(0);
      } finally {
        exitSpy.mockRestore();
        // The signal handler already ran shutdown() for us; boot.cleanup()
        // calling ready.shutdown() again is safe (every sub-close catches),
        // and still needed to restore env/cwd and remove temp dirs.
        await boot.cleanup();
      }
    }
  });

  // spec/03 § Host events — a host-addressed frame names ONE machine. Reaching
  // a host that is not that machine means the server mis-routed, and acting
  // on it would spawn the chat / edit the registry on the wrong filesystem.
  it('drops a host-addressed frame that names a different machine, and answers a mis-routed spawn', async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();
      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-misroute-')));
      // A folder edit for another machine must leave THIS machine's registry
      // alone.
      boot.fakeServer.send({
        type: 'host.folder_add',
        daemonId: 'some-other-host',
        path: folder,
      });
      // A spawn for another machine is refused as a frame, because a surface is
      // synchronously waiting on it.
      boot.fakeServer.send({
        type: 'chat.spawn_request',
        daemonId: 'some-other-host',
        chatId: 'chat-misrouted-1',
        folder,
      });
      const err = await boot.fakeServer.waitForFrame(
        (e) => e.type === 'chat.error' && e.chatId === 'chat-misrouted-1',
      );
      expect(err).toMatchObject({
        error: { code: 'host_not_registered' },
      });
      expect((err as { error: { message: string } }).error.message).toContain('some-other-host');
      // …and no chat was created for it.
      expect(boot.ready.daemon.list().map((c) => c.chatId)).not.toContain('chat-misrouted-1');
      // The same spawn naming THIS machine goes through, proving the guard
      // discriminates rather than blanket-refusing.
      boot.fakeServer.send({
        type: 'chat.spawn_request',
        daemonId: 'd1',
        chatId: 'chat-routed-1',
        folder,
        // Named explicitly: this machine has read no catalogue in this boot,
        // and a model-less spawn there is its own (separately tested) refusal.
        model: 'claude-opus-5',
      });
      await boot.fakeServer.waitForFrame(
        (e) => e.type === 'chat.spawned' && e.chatId === 'chat-routed-1',
      );
    } finally {
      await boot.cleanup();
    }
  });

  // spec/02 § Claude Code settings: the host publishes this host's memory
  // entries on connect; settings.json is written from the shared settings'
  // snapshot, except when changed on the machine, which is reported as drift
  // until it is discarded; memory edits land on disk and republish.
  it('publishes memory on connect, writes settings.json from the snapshot, reports drift, and memory frames write through', async () => {
    const boot = await bootMain();
    try {
      const claudeProjectsRoot = join(boot.home, 'claude-projects');
      const memoryDir = join(claudeProjectsRoot, 'my-project', 'memory');
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(
        join(memoryDir, 'feedback_tests.md'),
        '---\nname: feedback_tests\ndescription: a seeded memory\ntype: feedback\n---\n\nBody text.\n',
        'utf8',
      );

      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();

      const listFrame = await boot.fakeServer.waitForFrame(
        (e) => e.type === 'claude_settings.list' && e.daemonId === 'd1',
      );
      expect(listFrame).toMatchObject({
        memories: [
          {
            project: 'my-project',
            file: 'feedback_tests.md',
            name: 'feedback_tests',
            description: 'a seeded memory',
            memoryType: 'feedback',
            body: 'Body text.\n',
            updatedAt: expect.any(Number),
          },
        ],
      });
      expect(listFrame).not.toHaveProperty('drift');

      const snapshot = (version: number, shared: string, daemonId = 'd1'): WireEvent => ({
        type: 'settings.snapshot',
        daemonId,
        version,
        settings: { ...DEFAULT_SHARED_SETTINGS, claudeSettings: { shared, darwin: '', linux: '' } },
        secrets: { claude: [], codex: [], providerKeys: {} },
      });
      const settingsPath = join(boot.home, 'settings.json');

      // The shared text is written where Claude Code reads it.
      boot.fakeServer.send(snapshot(1, '{"model":"opus"}'));
      await boot.fakeServer.waitForFrame((e) => e.type === 'settings.applied' && e.version === 1);
      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ model: 'opus' });

      // Changed on the machine: the next snapshot leaves it alone and reports it.
      writeFileSync(settingsPath, '{"model":"sonnet"}');
      boot.fakeServer.send(snapshot(2, '{"model":"haiku"}'));
      const drifted = await boot.fakeServer.waitForFrame(
        (e) => e.type === 'claude_settings.updated' && e.daemonId === 'd1' && 'drift' in e,
      );
      expect(drifted).toMatchObject({ drift: '{"model":"sonnet"}' });
      expect(readFileSync(settingsPath, 'utf8')).toBe('{"model":"sonnet"}');

      // Discard rewrites it from the snapshot.
      boot.fakeServer.send({ type: 'host.claude_settings_discard', daemonId: 'd1' });
      await vi.waitFor(() =>
        expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ model: 'haiku' }),
      );

      // A snapshot naming a different machine is not applied here.
      boot.fakeServer.send(snapshot(3, '{"model":"should-not-land"}', 'some-other-host'));
      boot.fakeServer.send(snapshot(4, '{"model":"sonnet"}'));
      await boot.fakeServer.waitForFrame((e) => e.type === 'settings.applied' && e.version === 4);
      expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({ model: 'sonnet' });

      // host.claude_memory_set rewrites the text under the same frontmatter
      // and republishes the entry with its new body.
      boot.fakeServer.send({
        type: 'host.claude_memory_set',
        daemonId: 'd1',
        project: 'my-project',
        file: 'feedback_tests.md',
        body: 'Edited text.\n',
      });
      const edited = await boot.fakeServer.waitForFrame(
        (e) =>
          e.type === 'claude_settings.updated' &&
          e.daemonId === 'd1' &&
          (e as { memories: Array<{ body?: string }> }).memories[0]?.body === 'Edited text.\n',
      );
      expect((edited as { memories: unknown[] }).memories[0]).toMatchObject({
        name: 'feedback_tests',
        description: 'a seeded memory',
      });
      expect(readFileSync(join(memoryDir, 'feedback_tests.md'), 'utf8')).toBe(
        '---\nname: feedback_tests\ndescription: a seeded memory\ntype: feedback\n---\n\nEdited text.\n',
      );
      // Editing an entry the host does not have is refused, named, the same way
      // a delete of one is — and creates nothing.
      boot.fakeServer.send({
        type: 'host.claude_memory_set',
        daemonId: 'd1',
        project: 'my-project',
        file: 'not_there.md',
        body: 'x',
      });
      const setMissing = await boot.fakeServer.waitForFrame(
        (e) =>
          e.type === 'chat.error' &&
          e.error.code === 'claude_settings_invalid' &&
          e.error.message.includes('host.claude_memory_set'),
      );
      expect((setMissing as { error: { message: string } }).error.message).toContain(
        'not_there.md',
      );
      expect(existsSync(join(memoryDir, 'not_there.md'))).toBe(false);

      // host.claude_memory_delete removes the file AND republishes without it.
      boot.fakeServer.send({
        type: 'host.claude_memory_delete',
        daemonId: 'd1',
        project: 'my-project',
        file: 'feedback_tests.md',
      });
      const updated2 = await boot.fakeServer.waitForFrame(
        (e) =>
          e.type === 'claude_settings.updated' &&
          e.daemonId === 'd1' &&
          (e as { memories: unknown[] }).memories.length === 0,
      );
      expect((updated2 as { memories: unknown[] }).memories).toEqual([]);
      expect(existsSync(join(memoryDir, 'feedback_tests.md'))).toBe(false);

      // Deleting a memory entry that does not exist is refused, named.
      boot.fakeServer.send({
        type: 'host.claude_memory_delete',
        daemonId: 'd1',
        project: 'my-project',
        file: 'feedback_tests.md',
      });
      const missingErr = await boot.fakeServer.waitForFrame(
        (e) =>
          e.type === 'chat.error' &&
          e.error.code === 'claude_settings_invalid' &&
          e.error.message.includes('host.claude_memory_delete'),
      );
      expect((missingErr as { error: { message: string } }).error.message).toContain(
        'feedback_tests.md',
      );
    } finally {
      await boot.cleanup();
    }
  });

  // Settings → MCP: the host's MCP server list is persisted in host.json,
  // reported on every daemon.host, replaced whole by host.settings, and is what
  // a chat's harness gets. A host that predates the list is seeded from the
  // retired Browser tools toggle, and that toggle still works for surfaces that
  // have not caught up.
  it('seeds the MCP server list from the legacy toggle, reports it, and host.settings replaces it', async () => {
    const boot = await bootMain({}, { hostJson: { harnessBrowserToolsEnabled: true } });
    const harness = (): { mcpServers?: Array<{ name: string }> } =>
      (boot.ready.daemon as unknown as { harnessConfig: { mcpServers?: Array<{ name: string }> } })
        .harnessConfig;
    const hostJson = (): Record<string, unknown> =>
      JSON.parse(readFileSync(join(boot.home, 'host.json'), 'utf8')) as Record<string, unknown>;
    type HostReport = {
      harnessMcpServers?: Array<{ name: string; enabled: boolean; command: string }>;
      harnessBrowserToolsEnabled?: boolean;
    };
    const lastHost = (): HostReport =>
      boot.fakeServer.received.filter((e) => e.type === 'daemon.host').at(-1) as HostReport;
    try {
      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();
      await boot.fakeServer.waitForFrame((e) => e.type === 'daemon.host');

      // Seeded with the toggle's pair, enabled as the toggle was, and persisted.
      expect(lastHost().harnessMcpServers).toEqual([
        {
          name: 'playwright',
          command: 'npx',
          args: ['@playwright/mcp@latest', '--headless'],
          env: {},
          enabled: true,
        },
        {
          name: 'chrome-devtools',
          command: 'npx',
          args: ['-y', 'chrome-devtools-mcp@latest', '--headless'],
          env: {},
          enabled: true,
        },
      ]);
      expect(lastHost().harnessBrowserToolsEnabled).toBe(true);
      expect((hostJson()['harnessMcpServers'] as unknown[]).length).toBe(2);
      expect(harness().mcpServers?.map((s) => s.name)).toEqual(['playwright', 'chrome-devtools']);

      // The legacy toggle, off: both browser servers flip, the list keeps them.
      const before = boot.fakeServer.received.length;
      boot.fakeServer.send({
        type: 'host.settings',
        daemonId: 'd1',
        harnessBrowserToolsEnabled: false,
      });
      await boot.fakeServer.waitForFrame(
        (e) =>
          e.type === 'daemon.host' &&
          boot.fakeServer.received.indexOf(e) >= before &&
          e.harnessBrowserToolsEnabled === false,
      );
      expect(lastHost().harnessMcpServers?.map((s) => [s.name, s.enabled])).toEqual([
        ['playwright', false],
        ['chrome-devtools', false],
      ]);
      expect(harness().mcpServers).toEqual([]);

      // A whole new list: persisted, re-reported, and only its enabled entries
      // reach a chat. Without chrome-devtools the legacy reading is false even
      // though playwright is on.
      const list = [
        { name: 'my-tools', command: '/opt/tools', args: ['--x'], env: { K: 'v' }, enabled: true },
        {
          name: 'playwright',
          command: 'npx',
          args: ['@playwright/mcp@latest', '--headless'],
          env: {},
          enabled: true,
        },
        { name: 'off-one', command: 'off', args: [], env: {}, enabled: false },
      ];
      const before2 = boot.fakeServer.received.length;
      boot.fakeServer.send({ type: 'host.settings', daemonId: 'd1', harnessMcpServers: list });
      await boot.fakeServer.waitForFrame(
        (e) =>
          e.type === 'daemon.host' &&
          boot.fakeServer.received.indexOf(e) >= before2 &&
          (e.harnessMcpServers?.length ?? 0) === 3,
      );
      expect(lastHost().harnessMcpServers).toEqual(list);
      expect(lastHost().harnessBrowserToolsEnabled).toBe(false);
      expect(hostJson()['harnessMcpServers']).toEqual(list);
      expect(harness().mcpServers?.map((s) => s.name)).toEqual(['my-tools', 'playwright']);
    } finally {
      await boot.cleanup();
    }
  });

  it('spec/02 § Browser — Route through: host.settings sets/clears it, reported and persisted; naming itself is refused', async () => {
    const boot = await bootMain({});
    const hostJson = (): Record<string, unknown> =>
      JSON.parse(readFileSync(join(boot.home, 'host.json'), 'utf8')) as Record<string, unknown>;
    type HostReport = { browserRouteThrough?: string | null };
    const lastHost = (): HostReport =>
      boot.fakeServer.received.filter((e) => e.type === 'daemon.host').at(-1) as HostReport;
    try {
      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();
      await boot.fakeServer.waitForFrame((e) => e.type === 'daemon.host');
      expect(lastHost().browserRouteThrough).toBeNull();
      expect(hostJson()['browserRouteThrough']).toBeUndefined();

      const before = boot.fakeServer.received.length;
      boot.fakeServer.send({
        type: 'host.settings',
        daemonId: 'd1',
        browserRouteThrough: 'host-b',
      });
      await boot.fakeServer.waitForFrame(
        (e) =>
          e.type === 'daemon.host' &&
          boot.fakeServer.received.indexOf(e) >= before &&
          e.browserRouteThrough === 'host-b',
      );
      expect(hostJson()['browserRouteThrough']).toBe('host-b');

      // Naming THIS host itself is not a valid "another of the user's hosts"
      // — ignored, the prior value survives.
      const before2 = boot.fakeServer.received.length;
      boot.fakeServer.send({ type: 'host.settings', daemonId: 'd1', browserRouteThrough: 'd1' });
      await boot.fakeServer.waitForFrame(
        (e) => e.type === 'daemon.host' && boot.fakeServer.received.indexOf(e) >= before2,
      );
      expect(lastHost().browserRouteThrough).toBe('host-b');

      // null clears it — direct again.
      const before3 = boot.fakeServer.received.length;
      boot.fakeServer.send({ type: 'host.settings', daemonId: 'd1', browserRouteThrough: null });
      await boot.fakeServer.waitForFrame(
        (e) =>
          e.type === 'daemon.host' &&
          boot.fakeServer.received.indexOf(e) >= before3 &&
          e.browserRouteThrough === null,
      );
      expect(hostJson()['browserRouteThrough']).toBeUndefined();
    } finally {
      await boot.cleanup();
    }
  });

  // The CLAUDE.md toggle is gone from Settings: the shipped Manager/
  // Speakers CLAUDE.md always loads. A `false` persisted by an older build, or
  // sent by a surface that still shows the toggle, is ignored and said once.
  it('always loads the special-thread CLAUDE.md, ignoring a persisted or incoming false', async () => {
    const lines: string[] = [];
    const boot = await bootMain(
      {},
      {
        hostJson: { harnessClaudeMdEnabled: false },
        logStream: { write: (chunk: string) => void lines.push(chunk) },
      },
    );
    const harness = (): { claudeMdExcludePaths?: string[] } =>
      (boot.ready.daemon as unknown as { harnessConfig: { claudeMdExcludePaths?: string[] } })
        .harnessConfig;
    const ignoredLogs = (): number =>
      lines.filter((l) => l.includes('harnessClaudeMdEnabled: false ignored')).length;
    try {
      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();
      const host = await boot.fakeServer.waitForFrame((e) => e.type === 'daemon.host');
      expect((host as { harnessClaudeMdEnabled?: boolean }).harnessClaudeMdEnabled).toBe(true);
      expect(harness().claudeMdExcludePaths).toBeUndefined();
      expect(ignoredLogs()).toBe(1);

      const before = boot.fakeServer.received.length;
      boot.fakeServer.send({
        type: 'host.settings',
        daemonId: 'd1',
        harnessClaudeMdEnabled: false,
      });
      await boot.fakeServer.waitForFrame(
        (e) => e.type === 'daemon.host' && boot.fakeServer.received.indexOf(e) >= before,
      );
      const after = boot.fakeServer.received.filter((e) => e.type === 'daemon.host').at(-1);
      expect((after as { harnessClaudeMdEnabled?: boolean }).harnessClaudeMdEnabled).toBe(true);
      expect(harness().claudeMdExcludePaths).toBeUndefined();
      // Said once for the whole process, not once per frame.
      expect(ignoredLogs()).toBe(1);
    } finally {
      await boot.cleanup();
    }
  });

  it('seeds a host that never set the Browser tools toggle with the pair switched off', async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();
      const host = (await boot.fakeServer.waitForFrame((e) => e.type === 'daemon.host')) as {
        harnessMcpServers?: Array<{ name: string; enabled: boolean }>;
        harnessBrowserToolsEnabled?: boolean;
      };
      expect(host.harnessMcpServers?.map((s) => [s.name, s.enabled])).toEqual([
        ['playwright', false],
        ['chrome-devtools', false],
      ]);
      expect(host.harnessBrowserToolsEnabled).toBe(false);
    } finally {
      await boot.cleanup();
    }
  });

  // Settings → drag to rank: the stored accounts array IS the failover
  // priority (accountFailover.ts), so host.backend_reorder_accounts rewrites it,
  // reports the new order, and the next turn runs on whichever is now first.
  // spec/10 § Backend credentials: the accounts, their order and the strategy
  // are shared settings; a host takes them from the snapshot and every turn
  // resolves them afresh.
  it('takes the Claude accounts and their order from the snapshot, and turns follow the strategy and a chat’s preference', async () => {
    const boot = await bootMain();
    type AccountReport = { backendId: string; accounts?: Array<{ id: string }> };
    const snapshot = (version: number, strategy: 'priority' | 'round-robin'): WireEvent => ({
      type: 'settings.snapshot',
      daemonId: 'd1',
      version,
      settings: {
        ...DEFAULT_SHARED_SETTINGS,
        accountStrategy: { claude: strategy, codex: 'priority' },
      },
      secrets: {
        claude: [
          { id: 'acct-b', label: 'B', credential: { accessToken: 'tok-b' } },
          { id: 'acct-c', label: 'C', credential: null },
          { id: 'acct-a', label: 'A', credential: { accessToken: 'tok-a' } },
        ],
        codex: [],
        providerKeys: {},
      },
    });
    const storeOrder = (): string[] =>
      (
        JSON.parse(readFileSync(join(boot.home, 'claude-oauth.json'), 'utf8')) as {
          accounts: Array<{ id: string }>;
        }
      ).accounts.map((a) => a.id);
    const mockSdk = boot.ready.sdkBackend as unknown as {
      enqueue(events: Array<Record<string, unknown>>): void;
      lastOptions(): { accountId?: string } | undefined;
    };
    const turn = async (): Promise<void> => {
      mockSdk.enqueue([{ type: 'assistant', content: 'Title' }]);
      mockSdk.enqueue([{ type: 'assistant', content: 'hi' }]);
      const res = await boot.ready.app.inject({
        method: 'POST',
        url: '/spawn-chat',
        headers: { authorization: `Bearer ${boot.localKey}` },
        payload: {
          folder: realpathSync(mkdtempSync(join(tmpdir(), 'patch-main-order-'))),
          model: 'claude-opus-5',
          prompt: 'go',
        },
      });
      expect(res.statusCode).toBe(200);
    };
    try {
      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();
      boot.fakeServer.send(snapshot(1, 'priority'));
      await boot.fakeServer.waitForFrame((e) => e.type === 'settings.applied' && e.version === 1);
      const report = (await boot.fakeServer.waitForFrame(
        (e) =>
          e.type === 'daemon.account' &&
          e.backendId === 'claude-code' &&
          (e as AccountReport).accounts?.[0]?.id === 'acct-b',
      )) as AccountReport;
      expect(report.accounts?.map((a) => a.id)).toEqual(['acct-b', 'acct-c', 'acct-a']);
      expect(storeOrder()).toEqual(['acct-b', 'acct-c', 'acct-a']);

      // Priority: the first connected key.
      await turn();
      await vi.waitFor(() => expect(mockSdk.lastOptions()?.accountId).toBe('acct-b'));

      // Round robin: the next turn starts on the next connected key.
      boot.fakeServer.send(snapshot(2, 'round-robin'));
      await boot.fakeServer.waitForFrame((e) => e.type === 'settings.applied' && e.version === 2);
      await turn();
      await vi.waitFor(() => expect(mockSdk.lastOptions()?.accountId).toBe('acct-b'));
      await turn();
      await vi.waitFor(() => expect(mockSdk.lastOptions()?.accountId).toBe('acct-a'));

      // A chat naming a preferred account starts there; one naming an account
      // this host does not hold is refused, named.
      mockSdk.enqueue([{ type: 'assistant', content: 'Title' }]);
      mockSdk.enqueue([{ type: 'assistant', content: 'hi' }]);
      boot.fakeServer.send({
        type: 'chat.spawn_request',
        daemonId: 'd1',
        folder: realpathSync(mkdtempSync(join(tmpdir(), 'patch-main-pref-'))),
        model: 'claude-opus-5',
        prompt: 'go',
        chatId: 'chat-preferred',
        preferredAccountId: 'acct-a',
      });
      await vi.waitFor(() => expect(mockSdk.lastOptions()?.accountId).toBe('acct-a'));
      boot.fakeServer.send({
        type: 'chat.spawn_request',
        daemonId: 'd1',
        folder: realpathSync(mkdtempSync(join(tmpdir(), 'patch-main-pref-'))),
        model: 'claude-opus-5',
        chatId: 'chat-unknown-account',
        preferredAccountId: 'acct-x',
      });
      const refused = await boot.fakeServer.waitForFrame(
        (e) => e.type === 'chat.error' && e.error.code === 'account_not_found',
      );
      expect((refused as { error: { message: string } }).error.message).toContain('acct-x');
    } finally {
      await boot.cleanup();
    }
  });

  // spec/01 § Settings — values that start on a host: what it held before
  // settings were shared goes up once, and a key in its environment on request.
  it('answers the server’s import with what it held, and adopts a key from its environment', async () => {
    const boot = await bootMain(
      { GROQ_API_KEY: 'env-groq-fake-value-000000-ENV9' },
      {
        hostJson: { permissionModeDefault: 'plan', questionExpirySeconds: 90 },
        claudeStore: {
          accounts: [
            {
              id: 'acct-a',
              label: 'A',
              credential: { accessToken: 'tok-a', organizationId: 'org-a' },
            },
          ],
          activeAccountId: 'acct-a',
        },
      },
    );
    try {
      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();
      boot.fakeServer.send({
        type: 'settings.adopt.request',
        requestId: 'imp-1',
        daemonId: 'd1',
        kind: 'import',
      });
      const imported = (await boot.fakeServer.waitForFrame(
        (e) => e.type === 'settings.adopt.response' && e.requestId === 'imp-1',
      )) as Extract<WireEvent, { type: 'settings.adopt.response' }>;
      expect(imported.ok).toBe(true);
      expect(imported.result).toMatchObject({
        kind: 'import',
        import: {
          settings: { permissionModeDefault: 'plan', questionExpirySeconds: 90 },
          secrets: {
            claude: [
              {
                id: 'acct-a',
                label: 'A',
                credential: { accessToken: 'tok-a', organizationId: 'org-a' },
              },
            ],
            codex: [],
            providerKeys: {},
          },
        },
      });

      boot.fakeServer.send({
        type: 'settings.adopt.request',
        requestId: 'key-1',
        daemonId: 'd1',
        kind: 'provider-key',
        id: 'groq',
      });
      expect(
        await boot.fakeServer.waitForFrame(
          (e) => e.type === 'settings.adopt.response' && e.requestId === 'key-1',
        ),
      ).toMatchObject({
        ok: true,
        result: { kind: 'provider-key', id: 'groq', value: 'env-groq-fake-value-000000-ENV9' },
      });

      boot.fakeServer.send({
        type: 'settings.adopt.request',
        requestId: 'key-2',
        daemonId: 'd1',
        kind: 'provider-key',
        id: 'gemini',
      });
      const none = (await boot.fakeServer.waitForFrame(
        (e) => e.type === 'settings.adopt.response' && e.requestId === 'key-2',
      )) as { ok: boolean; error?: string };
      expect(none.ok).toBe(false);
      expect(none.error).toContain('gemini');
    } finally {
      await boot.cleanup();
    }
  });

  it('refuses to add a Claude account on a host — accounts are added on the server', async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();
      boot.fakeServer.send({
        type: 'host.backend_add_account',
        daemonId: 'd1',
        backendId: 'claude-code',
        authMethod: 'device',
      });
      const err = await boot.fakeServer.waitForFrame(
        (e) => e.type === 'chat.error' && e.error.code === 'invalid_frame',
      );
      expect((err as { error: { message: string } }).error.message).toContain('Credit sources');
    } finally {
      await boot.cleanup();
    }
  });

  it('refuses a usage refresh naming a backend this machine does not have, naming it', async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();
      boot.fakeServer.send({
        type: 'host.backend_usage_refresh',
        daemonId: 'd1',
        backendId: 'gpt5',
      });
      const err = await boot.fakeServer.waitForFrame(
        (e) => e.type === 'chat.error' && e.error.code === 'backend_not_found',
      );
      const message = (err as { error: { message: string } }).error.message;
      expect(message).toContain('gpt5');
      expect(message).toContain('claude-code');
    } finally {
      await boot.cleanup();
    }
  });

  it('re-reports daemon.account with usage when a chat turn observes a rate_limit_event (spec/10 § Surface in Settings — Usage)', async () => {
    // Usage is attributed to an ACCOUNT (`reportUsage` drops the reading rather
    // than guessing when the chat names none and the store has no active one),
    // so this case needs the host to boot with one. The token is adopted into
    // the temp store by `seedPatchStore` at boot; it is never sent anywhere —
    // the SDK backend here is the mock.
    const boot = await bootMain({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test-seed' });
    try {
      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();
      await boot.fakeServer.waitForFrame((e) => e.type === 'daemon.account' && e.daemonId === 'd1');

      const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-main-usage-')));
      const mockSdk = boot.ready.sdkBackend as unknown as {
        enqueue(events: Array<Record<string, unknown>>): void;
      };
      // spawning a chat's first message ALSO fires an async title-generation
      // turn (src/chatRunner.ts maybeGenerateTitle) that calls the SAME mock
      // backend's `run()` and consumes from the SAME FIFO queue. It wins the
      // race (its path to `run()` is shorter than the real turn's), so a
      // harmless script is queued first for it to consume, and the real
      // rate-limit-carrying script is queued second for the actual chat turn.
      mockSdk.enqueue([{ type: 'assistant', content: 'Title' }]);
      mockSdk.enqueue([
        {
          type: 'system',
          rateLimit: {
            scope: 'session',
            window: { status: 'allowed_warning', utilization: 0.82, resetsAt: 1_800_000_000_000 },
          },
        },
        { type: 'assistant', content: 'hi' },
      ]);
      const spawnRes = await boot.ready.app.inject({
        method: 'POST',
        url: '/spawn-chat',
        headers: { authorization: `Bearer ${boot.localKey}` },
        payload: { folder, model: 'claude-opus-5', prompt: 'go' },
      });
      expect(spawnRes.statusCode).toBe(200);

      const withUsage = await boot.fakeServer.waitForFrame(
        (e) => e.type === 'daemon.account' && e.daemonId === 'd1' && 'usage' in e && !!e.usage,
      );
      expect(withUsage).toMatchObject({
        type: 'daemon.account',
        connected: true,
        usage: {
          session: { status: 'allowed_warning', utilization: 0.82, resetsAt: 1_800_000_000_000 },
        },
      });
      // The report carries no `week` window yet — only session has been seen.
      expect((withUsage as { usage: { week?: unknown } }).usage.week).toBeUndefined();
    } finally {
      await boot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-host `patch.spawn` — this machine as the TARGET (spec/03 § Cross-chat
// tools). The calling machine's agent is BLOCKED inside its tool call, so this
// machine has to answer whether it created the chat or refused it. The live
// defect: it answered neither, and the caller was told it had succeeded.

describe('src/index.ts main() — cross-host patch.spawn answers the calling machine', () => {
  it('answers ok with the new chatId, and really creates the chat', async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();
      const folder = makeFolder();
      boot.fakeServer.send({
        type: 'patch.spawn',
        sourceChatId: 'mgr-on-host-a',
        daemonId: 'd1',
        folder,
        model: 'claude-3-5-haiku-20241022',
        prompt: 'hi',
        requestId: 'req-ok-1',
      });
      const resp = (await boot.fakeServer.waitForFrame(
        (e) => e.type === 'patch.spawn.response' && e.requestId === 'req-ok-1',
      )) as {
        ok: boolean;
        chatId?: string;
        daemonId: string;
        sourceChatId: string;
        folder: string;
      };
      expect(resp.ok).toBe(true);
      expect(resp.daemonId).toBe('d1');
      expect(resp.sourceChatId).toBe('mgr-on-host-a');
      expect(resp.folder).toBe(folder);
      expect(typeof resp.chatId).toBe('string');
      // Positively checked, not inferred from the echo: the chat exists here.
      expect(boot.ready.daemon.chatState.has(resp.chatId!)).toBe(true);
    } finally {
      await boot.cleanup();
    }
  });

  it('creates the chat but answers nobody when the relayed spawn carries no requestId', async () => {
    // A `patch.spawn` with no requestId is an audit frame, not a call anyone is
    // waiting on: the chat is still made, and no response is invented for it.
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();
      const folder = makeFolder();
      boot.fakeServer.send({
        type: 'patch.spawn',
        sourceChatId: 'mgr-on-host-a',
        daemonId: 'd1',
        folder,
        model: 'claude-3-5-haiku-20241022',
        // Empty prompt: the chat is created idle, with no first turn.
        prompt: '',
      });
      await boot.fakeServer.waitForFrame((e) => e.type === 'chat.spawned' && e.folder === folder);
      expect(
        boot.fakeServer.received.filter((e) => e.type === 'patch.spawn.response'),
      ).toHaveLength(0);
    } finally {
      await boot.cleanup();
    }
  });

  it('reproduces the live defect: a model-less spawn on a catalogue-less machine answers no_model_catalogue', async () => {
    // Exactly the observed failure — host-logged-out refused
    // `{folder, prompt}` with no model and the caller heard nothing.
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();
      const before = boot.ready.daemon.chatState.size;
      boot.fakeServer.send({
        type: 'patch.spawn',
        sourceChatId: 'mgr-on-host-a',
        daemonId: 'd1',
        folder: makeFolder(),
        prompt: 'hi',
        requestId: 'req-nomodel-1',
      });
      const resp = (await boot.fakeServer.waitForFrame(
        (e) => e.type === 'patch.spawn.response' && e.requestId === 'req-nomodel-1',
      )) as { ok: boolean; error?: { code: string; message: string } };
      expect(resp.ok).toBe(false);
      expect(resp.error?.code).toBe('no_model_catalogue');
      expect(resp.error?.message).toContain('never read a model catalogue');
      expect(boot.ready.daemon.chatState.size).toBe(before);
    } finally {
      await boot.cleanup();
    }
  });

  it('as the CALLER: /internal/spawn blocks on the other machine and returns its chatId', async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();
      // The roster the server pushes — without it a cross-machine spawn is
      // refused before it reaches the wire.
      boot.fakeServer.send({ type: 'daemon.online', daemonId: 'host-b' });
      // The roster update is an inbound WS frame: let it land before asking.
      await new Promise((r) => setTimeout(r, 150));
      const folder = makeFolder();
      const pending = boot.ready.app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: { authorization: `Bearer ${boot.localKey}` },
        payload: { folder, host: 'host-b', callerChatId: 'mgr', model: 'claude-opus-5' },
      });
      const req = (await boot.fakeServer.waitForFrame(
        (e) => e.type === 'patch.spawn' && e.daemonId === 'host-b',
      )) as { requestId?: string; folder: string; model?: string };
      expect(req.requestId).toBeDefined();
      expect(req.model).toBe('claude-opus-5');
      boot.fakeServer.send({
        type: 'patch.spawn.response',
        requestId: req.requestId!,
        sourceChatId: 'mgr',
        daemonId: 'host-b',
        folder,
        ok: true,
        chatId: 'chat-created-on-b',
      });
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        host: 'host-b',
        created: 'remote',
        chatId: 'chat-created-on-b',
      });
    } finally {
      await boot.cleanup();
    }
  });

  it("as the CALLER: the other machine's REFUSAL fails the tool call, naming it", async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();
      boot.fakeServer.send({ type: 'daemon.online', daemonId: 'host-b' });
      // The roster update is an inbound WS frame: let it land before asking.
      await new Promise((r) => setTimeout(r, 150));
      const folder = makeFolder();
      const pending = boot.ready.app.inject({
        method: 'POST',
        url: '/internal/spawn',
        headers: { authorization: `Bearer ${boot.localKey}` },
        payload: { folder, host: 'host-b', callerChatId: 'mgr' },
      });
      const req = (await boot.fakeServer.waitForFrame(
        (e) => e.type === 'patch.spawn' && e.daemonId === 'host-b',
      )) as { requestId?: string };
      boot.fakeServer.send({
        type: 'patch.spawn.response',
        requestId: req.requestId!,
        sourceChatId: 'mgr',
        daemonId: 'host-b',
        folder,
        ok: false,
        error: {
          code: 'no_model_catalogue',
          message: 'machine host-b has never read a model catalogue',
        },
      });
      const res = await pending;
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('no_model_catalogue');
      expect(res.json().message).toContain('host-b');
      // A late/duplicate answer for the same request is reported, not applied.
      boot.fakeServer.send({
        type: 'patch.spawn.response',
        requestId: req.requestId!,
        sourceChatId: 'mgr',
        daemonId: 'host-b',
        folder,
        ok: true,
        chatId: 'too-late',
      });
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      await boot.cleanup();
    }
  });

  it('answers ok:false with its OWN reason when it refuses, and creates nothing', async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();
      const before = boot.ready.daemon.chatState.size;
      boot.fakeServer.send({
        type: 'patch.spawn',
        sourceChatId: 'mgr-on-host-a',
        daemonId: 'd1',
        folder: '/no/such-folder-99',
        model: 'claude-3-5-haiku-20241022',
        prompt: 'hi',
        requestId: 'req-bad-1',
      });
      const resp = (await boot.fakeServer.waitForFrame(
        (e) => e.type === 'patch.spawn.response' && e.requestId === 'req-bad-1',
      )) as { ok: boolean; chatId?: string; error?: { code: string; message: string } };
      expect(resp.ok).toBe(false);
      expect(resp.chatId).toBeUndefined();
      expect(resp.error?.code).toBe('folder_not_found');
      expect(resp.error?.message).toContain('/no/such-folder-99');
      expect(boot.ready.daemon.chatState.size).toBe(before);
    } finally {
      await boot.cleanup();
    }
  });

  it('ignores a spawn addressed to another machine — no answer, no chat', async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();
      const before = boot.ready.daemon.chatState.size;
      boot.fakeServer.send({
        type: 'patch.spawn',
        sourceChatId: 'mgr-on-host-a',
        daemonId: 'not-this-machine',
        folder: makeFolder(),
        prompt: 'hi',
        requestId: 'req-elsewhere',
      });
      await new Promise((r) => setTimeout(r, 200));
      expect(
        boot.fakeServer.received.filter((e) => e.type === 'patch.spawn.response'),
      ).toHaveLength(0);
      expect(boot.ready.daemon.chatState.size).toBe(before);
    } finally {
      await boot.cleanup();
    }
  });
});

describe('src/index.ts main() — cross-host patch_send_to', () => {
  it('as the TARGET: delivers the relayed message into the local chat and acks ok', async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();
      const folder = makeFolder();
      const chatId = await boot.ready.daemon.spawnChat({
        folder,
        model: 'claude-3-5-haiku-20241022',
      });
      boot.fakeServer.send({
        type: 'patch.send_to',
        sourceChatId: 'mgr-on-host-a',
        targetChatId: chatId,
        message: 'hello from another host',
        requestId: 'req-send-ok-1',
      });
      const resp = (await boot.fakeServer.waitForFrame(
        (e) => e.type === 'patch.send_to.response' && e.requestId === 'req-send-ok-1',
      )) as { ok: boolean; sourceChatId: string; targetChatId: string };
      expect(resp.ok).toBe(true);
      expect(resp.sourceChatId).toBe('mgr-on-host-a');
      expect(resp.targetChatId).toBe(chatId);
      // Positively checked, not inferred from the ack: the turn actually ran.
      await boot.fakeServer.waitForFrame(
        (e) =>
          e.type === 'chat.message' &&
          e.chatId === chatId &&
          e.role === 'user' &&
          e.content === 'hello from another host',
      );
    } finally {
      await boot.cleanup();
    }
  });

  it('as the TARGET: a chat_not_found target answers ok:false, naming it', async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();
      boot.fakeServer.send({
        type: 'patch.send_to',
        sourceChatId: 'mgr-on-host-a',
        targetChatId: 'no-such-chat',
        message: 'hello?',
        requestId: 'req-send-missing-1',
      });
      const resp = (await boot.fakeServer.waitForFrame(
        (e) => e.type === 'patch.send_to.response' && e.requestId === 'req-send-missing-1',
      )) as { ok: boolean; error?: { code: string; message: string } };
      expect(resp.ok).toBe(false);
      expect(resp.error?.code).toBe('chat_not_found');
    } finally {
      await boot.cleanup();
    }
  });

  it('as the CALLER: /internal/send-to blocks on the other machine and reports queued', async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();
      const pending = boot.ready.app.inject({
        method: 'POST',
        url: '/internal/send-to',
        headers: { authorization: `Bearer ${boot.localKey}` },
        payload: {
          chatId: 'chat-on-host-b',
          message: 'hi from here',
          callerChatId: 'mgr',
        },
      });
      const req = (await boot.fakeServer.waitForFrame(
        (e) => e.type === 'patch.send_to' && e.targetChatId === 'chat-on-host-b',
      )) as { requestId?: string; sourceChatId: string; message: string };
      expect(req.requestId).toBeDefined();
      expect(req.sourceChatId).toBe('mgr');
      expect(req.message).toBe('hi from here');
      boot.fakeServer.send({
        type: 'patch.send_to.response',
        requestId: req.requestId!,
        sourceChatId: 'mgr',
        targetChatId: 'chat-on-host-b',
        ok: true,
      });
      const res = await pending;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, queued: true });
    } finally {
      await boot.cleanup();
    }
  });

  it("as the CALLER: the owning machine's REFUSAL fails the call, naming it", async () => {
    const boot = await bootMain();
    try {
      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();
      const pending = boot.ready.app.inject({
        method: 'POST',
        url: '/internal/send-to',
        headers: { authorization: `Bearer ${boot.localKey}` },
        payload: {
          chatId: 'chat-on-host-b',
          message: 'hi from here',
          callerChatId: 'mgr',
        },
      });
      const req = (await boot.fakeServer.waitForFrame(
        (e) => e.type === 'patch.send_to' && e.targetChatId === 'chat-on-host-b',
      )) as { requestId?: string };
      boot.fakeServer.send({
        type: 'patch.send_to.response',
        requestId: req.requestId!,
        sourceChatId: 'mgr',
        targetChatId: 'chat-on-host-b',
        ok: false,
        error: { code: 'chat_not_found', message: 'no such chat: chat-on-host-b' },
      });
      const res = await pending;
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'chat_not_found' });
    } finally {
      await boot.cleanup();
    }
  });
});

describe('src/index.ts main() — scheduled self-update actually applies', () => {
  // The bug this locks down (Todoist 6hfrHfG2PwW7CmQc, "patch send to chat
  // not working between hosts"): a cross-host feature was correct and
  // landed, but the host serving the report was still running a build from
  // BEFORE it — refreshUpdateAvailable() only ever flipped a reported flag,
  // never actually pulled the published build, so the host drifted further
  // behind every hour the schedule "checked" and found nothing changed.
  it('downloads and verifies a published build on boot, not just flags it (spec/02 § Installation)', async () => {
    const lines: string[] = [];
    const artifactBytes = Buffer.from('not a real host tarball');
    const manifest: DaemonManifest = {
      version: '9.9.9',
      gitSha: 'deadbeef',
      builtAt: new Date().toISOString(),
      signingPublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      artifacts: [
        {
          target: 'linux-x64',
          file: 'patch-daemon-linux-x64.tar.gz',
          bytes: artifactBytes.length,
          // Deliberately wrong: applyUpdate refuses on the digest mismatch
          // before touching an installer, so this proves the REAL bytes this
          // test served were fetched and checked — not that they matched.
          sha256: '0'.repeat(64),
          sig: 'invalid-sig',
        },
      ],
    };
    const boot = await bootMain(
      {},
      {
        logStream: { write: (chunk: string) => void lines.push(chunk) },
        selfUpdateManifest: {
          manifest,
          files: { 'patch-daemon-linux-x64.tar.gz': artifactBytes },
        },
      },
    );
    try {
      await boot.fakeServer.waitForHello();
      boot.fakeServer.authNow();
      // Nothing in this test asks for an update — no `host.update` frame, no
      // `/internal/.../update` call, no unreadable greeting. Only the
      // boot-time scheduled check is in play.
      await waitFor(() => lines.some((l) => l.includes('self-update: scheduled apply refused')));
      const refusal = lines.find((l) => l.includes('self-update: scheduled apply refused'))!;
      expect(refusal).toContain('sha256');
      expect(refusal).toContain('does not match the manifest');
    } finally {
      await boot.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Direct unit tests for the exported RPC handlers (module-private in
// production; exported here purely for testability — see the `export`
// comment at each declaration site in src/index.ts). The full-boot test above
// proves each dispatch line in `onFrame`/`handleServerEvent` actually routes
// to these; these tests enumerate every branch INSIDE each handler, which is
// far cheaper to do directly than by contriving every edge case over a live
// WS link.

function captureSender(): { sent: WireEvent[]; sender: (e: WireEvent) => void } {
  const sent: WireEvent[] = [];
  return { sent, sender: (e) => sent.push(e) };
}

describe('handleSkillsRequest', () => {
  // The listing now includes the MACHINE's own skills (`~/.claude`), which apply
  // in every folder — so these cases must run against an empty home rather than
  // against whatever this developer happens to have installed.
  let priorHome: string | undefined;
  beforeEach(() => {
    priorHome = process.env['HOME'];
    process.env['HOME'] = makeFolder();
  });
  afterEach(() => {
    if (priorHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = priorHome;
  });

  it('folder not found -> folder_not_found', async () => {
    const { sender, sent } = captureSender();
    await handleSkillsRequest(
      {
        type: 'patch.skills.request',
        requestId: 'r1',
        folder: '/no/such/folder-xyz',
        daemonId: 'd1',
      },
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'folder_not_found' } });
  });

  it('folder exists but has no .claude/skills dir -> ok, empty list', async () => {
    const folder = makeFolder();
    const { sender, sent } = captureSender();
    await handleSkillsRequest(
      { type: 'patch.skills.request', requestId: 'r2', folder, daemonId: 'd1' },
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: true, skills: [] });
  });

  it('lists only subdirs containing SKILL.md, sorted', async () => {
    const folder = makeFolder();
    const skillsDir = join(folder, '.claude', 'skills');
    mkdirSync(join(skillsDir, 'zeta'), { recursive: true });
    writeFileSync(join(skillsDir, 'zeta', 'SKILL.md'), '# zeta');
    mkdirSync(join(skillsDir, 'alpha'), { recursive: true });
    writeFileSync(join(skillsDir, 'alpha', 'SKILL.md'), '# alpha');
    mkdirSync(join(skillsDir, 'no-skill-file'), { recursive: true });
    const { sender, sent } = captureSender();
    await handleSkillsRequest(
      { type: 'patch.skills.request', requestId: 'r3', folder, daemonId: 'd1' },
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: true, skills: ['alpha', 'zeta'] });
  });

  it('readdirSync failure -> internal', async () => {
    const folder = makeFolder();
    const skillsDir = join(folder, '.claude', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    chmodSync(skillsDir, 0o000);
    const { sender, sent } = captureSender();
    try {
      await handleSkillsRequest(
        { type: 'patch.skills.request', requestId: 'r4', folder, daemonId: 'd1' },
        sender,
        silent,
      );
      expect(sent[0]).toMatchObject({ ok: false, error: { code: 'internal' } });
    } finally {
      chmodSync(skillsDir, 0o700);
    }
  });
});

describe('handleFoldersBrowseRequest', () => {
  function makeRegistry(roots: string[]): FolderRegistry {
    return new FolderRegistry({
      source: { listChats: () => [] },
      onChange: () => undefined,
      registered: roots,
    });
  }

  it('roots view (no dir) -> ok', async () => {
    const folder = makeFolder();
    const registry = makeRegistry([folder]);
    const { sender, sent } = captureSender();
    await handleFoldersBrowseRequest(
      { type: 'patch.folders.browse.request', daemonId: 'd1', requestId: 'b1' },
      registry,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: true });
  });

  it('dir outside every root -> folder_not_found (no warn log)', async () => {
    const folder = makeFolder();
    const registry = makeRegistry([folder]);
    const { sender, sent } = captureSender();
    await handleFoldersBrowseRequest(
      {
        type: 'patch.folders.browse.request',
        daemonId: 'd1',
        requestId: 'b2',
        dir: '/no/such/dir-xyz',
      },
      registry,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'folder_not_found' } });
  });

  it('an unexpected error mid-listing -> internal (with a warn log)', async () => {
    // browse() itself deliberately maps every readdir failure (even EACCES) to
    // FolderNotFoundError (see folders.ts) — there is no fs-permission way to
    // reach handleFoldersBrowseRequest's 'internal' branch. Force a genuine
    // unexpected throw from `list()` (via a source.listChats() that throws)
    // instead, which browse() does NOT catch.
    const registry = new FolderRegistry({
      source: {
        listChats: () => {
          throw new Error('listChats backing store exploded');
        },
      },
      onChange: () => undefined,
    });
    const warnLogger = pino({ level: 'silent' });
    const warnSpy = vi.spyOn(warnLogger, 'warn');
    const { sender, sent } = captureSender();
    await handleFoldersBrowseRequest(
      { type: 'patch.folders.browse.request', daemonId: 'd1', requestId: 'b3' },
      registry,
      sender,
      warnLogger,
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('handleAttachmentStore', () => {
  it('empty attachment (0 bytes) -> invalid_data', async () => {
    const { daemon } = makeDaemon();
    const { sender, sent } = captureSender();
    handleAttachmentStore(
      {
        type: 'patch.attachment.store_request',
        requestId: 'a1',
        chatId: 'no-chat',
        id: 'att-1',
        name: 'x.txt',
        mimeType: 'text/plain',
        kind: 'file',
        dataBase64: '',
      },
      daemon,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'invalid_data' } });
  });

  it('unknown chat -> chat_not_found', async () => {
    const { daemon } = makeDaemon();
    const { sender, sent } = captureSender();
    handleAttachmentStore(
      {
        type: 'patch.attachment.store_request',
        requestId: 'a2',
        chatId: 'no-such-chat',
        id: 'att-1',
        name: 'x.txt',
        mimeType: 'text/plain',
        kind: 'file',
        dataBase64: Buffer.from('hi').toString('base64'),
      },
      daemon,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'chat_not_found' } });
  });

  it('success -> ok + path', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    const chatId = await daemon.spawnChat({ folder });
    const { sender, sent } = captureSender();
    handleAttachmentStore(
      {
        type: 'patch.attachment.store_request',
        requestId: 'a3',
        chatId,
        id: 'att-1',
        name: 'x.txt',
        mimeType: 'text/plain',
        kind: 'file',
        dataBase64: Buffer.from('hello').toString('base64'),
      },
      daemon,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: true });
    expect(existsSync((sent[0] as { path: string }).path)).toBe(true);
  });

  it('an unexpected (non-AttachmentChatNotFoundError) failure -> internal', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    const chatId = await daemon.spawnChat({ folder });
    vi.spyOn(daemon, 'storeAttachment').mockImplementation(() => {
      throw new Error('disk full');
    });
    const { sender, sent } = captureSender();
    handleAttachmentStore(
      {
        type: 'patch.attachment.store_request',
        requestId: 'a4',
        chatId,
        id: 'att-1',
        name: 'x.txt',
        mimeType: 'text/plain',
        kind: 'file',
        dataBase64: Buffer.from('hello').toString('base64'),
      },
      daemon,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'internal' } });
  });
});

function fakeWhisper(overrides: Partial<WhisperBackend> = {}): WhisperBackend {
  return {
    transcribeClip: async () => 'transcribed text',
    close: async () => undefined,
    ...overrides,
  } as WhisperBackend;
}

describe('src/index.ts main() — a voice surface on a provider with no key', () => {
  // Tom's live config on 2026-09-24: dictation on gemini, the device on
  // openai, hands-free + call local — and no GEMINI_* / OPENAI_* key in the
  // host's environment. That must NOT stop the host (every chat on the
  // host would go down over one voice setting): it boots, says so in the log,
  // reports the missing keys on daemon.host, and refuses only that surface.
  it('boots, logs each surface whose key is missing, reports voiceKeys, refuses the session', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const logStream = {
      write(chunk: string): void {
        for (const line of chunk.split('\n')) {
          if (line.trim()) lines.push(JSON.parse(line) as Record<string, unknown>);
        }
      },
    };
    const boot = await bootMain(
      { GEMINI_API_KEY: undefined, OPENAI_REALTIME_API_KEY: undefined },
      {
        hostJson: {
          voiceConfig: {
            dictation: { backend: 'gemini' },
            device: { backend: 'openai', layer: 'light' },
            handsFree: { backend: 'local', layer: 'direct' },
            call: { backend: 'local', layer: 'direct' },
          },
        },
        logStream,
      },
    );
    try {
      const missing = lines.filter((l) => l['missingKey'] !== undefined);
      expect(missing.map((l) => [l['level'], l['surface'], l['missingKey'], l['msg']])).toEqual([
        [
          50,
          'dictation',
          'GEMINI_API_KEY',
          'voice: Dictation is set to gemini, but GEMINI_API_KEY is not set on this host. ' +
            'Switch Dictation to another backend in Settings → Voice. Its sessions will be refused.',
        ],
        [
          50,
          'device',
          'OPENAI_REALTIME_API_KEY',
          'voice: Voice device is set to openai, but OPENAI_REALTIME_API_KEY is not set on this host. ' +
            'Switch Voice device to another backend in Settings → Voice. Its sessions will be refused.',
        ],
      ]);

      await boot.fakeServer.waitForAuthed();
      await boot.fakeServer.waitForFrame((e) => e.type === 'daemon.host' && e.daemonId === 'd1');
      const host = boot.fakeServer.received.find((e) => e.type === 'daemon.host');
      expect(host).toMatchObject({ voiceKeys: { gemini: false, openai: false } });

      const folder = makeFolder();
      const spawnRes = await boot.ready.app.inject({
        method: 'POST',
        url: '/spawn-chat',
        headers: { authorization: `Bearer ${boot.localKey}` },
        payload: { folder, model: 'claude-opus-5' },
      });
      const { chatId } = spawnRes.json() as { chatId: string };
      const ws = new WSClient(`ws://127.0.0.1:${boot.audioPort}/audio/dict-1`);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      const events: AudioEvent[] = [];
      const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary) events.push(decodeAudio(data.toString('utf8')));
      });
      const { token } = mintVoiceToken({
        secret: 'test-internal-token',
        accountId: 'acct-1',
        surfaceId: 'phone-1',
        sessionId: 'dict-1',
        chatId,
      });
      ws.send(
        encodeAudio({
          type: 'audio.session_start',
          sessionId: 'dict-1',
          accountId: 'acct-1',
          surfaceId: 'phone-1',
          surfaceKind: 'mobile',
          chatId,
          role: 'voice-note',
          token,
          surfaceHasAec: true,
        }),
      );
      await closed;
      expect(events).toEqual([
        {
          type: 'audio.error',
          code: 'voice_key_missing',
          message:
            'Dictation is set to gemini, but GEMINI_API_KEY is not set on this host. ' +
            'Switch Dictation to another backend in Settings → Voice.',
        },
      ]);
    } finally {
      await boot.cleanup();
    }
  });
});

describe('src/index.ts main() — provider keys set from Settings (spec/02 § Provider keys)', () => {
  // A key set from Settings → Hosts → Keys applies to the NEXT session with
  // no restart: the host report flips, and the surface that was refused for
  // want of the key now opens. Values are fake; no session sends audio, so no
  // provider is ever called.
  const FAKE_GEMINI = 'fake-gemini-key-for-tests-0000-LAST';

  async function openDictation(
    boot: Boot,
    sessionId: string,
    chatId: string,
  ): Promise<{ first: AudioEvent; close: () => void }> {
    const ws = new WSClient(`ws://127.0.0.1:${boot.audioPort}/audio/${sessionId}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    const first = new Promise<AudioEvent>((resolve) => {
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary) resolve(decodeAudio(data.toString('utf8')));
      });
    });
    const { token } = mintVoiceToken({
      secret: 'test-internal-token',
      accountId: 'acct-1',
      surfaceId: 'phone-1',
      sessionId,
      chatId,
    });
    ws.send(
      encodeAudio({
        type: 'audio.session_start',
        sessionId,
        accountId: 'acct-1',
        surfaceId: 'phone-1',
        surfaceKind: 'mobile',
        chatId,
        role: 'voice-note',
        token,
        surfaceHasAec: true,
      }),
    );
    return { first: await first, close: () => ws.close() };
  }

  it('a snapshot with the key → stored 0600, reported without the value, next session runs; without it → refused again', async () => {
    const lines: string[] = [];
    const boot = await bootMain(
      { GEMINI_API_KEY: undefined, OPENAI_REALTIME_API_KEY: undefined, GROQ_API_KEY: undefined },
      {
        hostJson: {
          voiceConfig: {
            dictation: { backend: 'gemini' },
            device: { backend: 'local', layer: 'direct' },
            handsFree: { backend: 'local', layer: 'direct' },
            call: { backend: 'local', layer: 'direct' },
          },
        },
        logStream: { write: (chunk: string) => void lines.push(chunk) },
      },
    );
    try {
      await boot.fakeServer.waitForAuthed();
      await boot.fakeServer.waitForFrame((e) => e.type === 'daemon.host');
      expect(boot.fakeServer.received.find((e) => e.type === 'daemon.host')).toMatchObject({
        voiceKeys: { gemini: false, openai: false },
        providerKeys: [
          { id: 'gemini', source: 'none', envSet: false },
          { id: 'openai', source: 'none', envSet: false },
          { id: 'groq', source: 'none', envSet: false },
        ],
      });
      const spawnRes = await boot.ready.app.inject({
        method: 'POST',
        url: '/spawn-chat',
        headers: { authorization: `Bearer ${boot.localKey}` },
        payload: { folder: makeFolder(), model: 'claude-opus-5' },
      });
      const { chatId } = spawnRes.json() as { chatId: string };
      const before = await openDictation(boot, 'dict-before', chatId);
      expect(before.first).toMatchObject({ type: 'audio.error', code: 'voice_key_missing' });
      before.close();

      const hostsBefore = boot.fakeServer.received.filter((e) => e.type === 'daemon.host').length;
      // The key is a shared setting (spec/01 § Settings): it arrives in the
      // server's snapshot, with the voice config that needs it.
      const withKeys = (version: number, providerKeys: Record<string, string>): WireEvent => ({
        type: 'settings.snapshot',
        daemonId: 'd1',
        version,
        settings: {
          ...DEFAULT_SHARED_SETTINGS,
          voiceConfig: {
            dictation: { backend: 'gemini' },
            device: { backend: 'local', layer: 'direct' },
            handsFree: { backend: 'local', layer: 'direct' },
            call: { backend: 'local', layer: 'direct' },
          },
        },
        secrets: { claude: [], codex: [], providerKeys },
      });
      boot.fakeServer.send(withKeys(1, { gemini: FAKE_GEMINI }));
      const res = await boot.fakeServer.waitForFrame(
        (e) => e.type === 'settings.applied' && e.version === 1,
      );
      expect(res).not.toHaveProperty('error');
      await boot.fakeServer.waitForFrame(
        (e) =>
          e.type === 'daemon.host' &&
          boot.fakeServer.received.filter((x) => x.type === 'daemon.host').length > hostsBefore,
      );
      const hosts = boot.fakeServer.received.filter((e) => e.type === 'daemon.host');
      const latest = hosts[hosts.length - 1]!;
      expect(latest).toMatchObject({
        voiceKeys: { gemini: true, openai: false },
        providerKeys: [
          { id: 'gemini', source: 'ui', last4: 'LAST', envSet: false },
          { id: 'openai', source: 'none', envSet: false },
          { id: 'groq', source: 'none', envSet: false },
        ],
      });
      // Nothing the host sent anywhere carries the value.
      expect(
        JSON.stringify(boot.fakeServer.received.filter((e) => e.type !== 'settings.snapshot')),
      ).not.toContain(FAKE_GEMINI);
      const keysPath = join(boot.home, 'keys.json');
      expect(statSync(keysPath).mode & 0o777).toBe(0o600);

      // Same host, no restart: the next dictation session opens.
      const after = await openDictation(boot, 'dict-after', chatId);
      expect(after.first.type).not.toBe('audio.error');
      after.close();

      boot.fakeServer.send(withKeys(2, {}));
      await boot.fakeServer.waitForFrame((e) => e.type === 'settings.applied' && e.version === 2);
      const revoked = await openDictation(boot, 'dict-revoked', chatId);
      expect(revoked.first).toMatchObject({ type: 'audio.error', code: 'voice_key_missing' });
      revoked.close();

      // And the log never carried it either.
      expect(lines.join('')).not.toContain(FAKE_GEMINI);
      expect(lines.join('')).toContain('shared settings: snapshot applied');
    } finally {
      await boot.cleanup();
    }
  });
});

describe('handleVoiceNoteTranscribe', () => {
  it('whisper not ready (undefined) -> internal', async () => {
    const { sender, sent } = captureSender();
    await handleVoiceNoteTranscribe(
      {
        type: 'patch.voice_note.transcribe_request',
        requestId: 'v1',
        surfaceKind: 'mobile',
        format: 'wav',
        audioBase64: Buffer.from('x').toString('base64'),
      },
      undefined,
      'local',
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'internal' } });
  });

  it('empty audio clip -> transcription_failed', async () => {
    const { sender, sent } = captureSender();
    await handleVoiceNoteTranscribe(
      {
        type: 'patch.voice_note.transcribe_request',
        requestId: 'v2',
        surfaceKind: 'mobile',
        format: 'wav',
        audioBase64: '',
      },
      { local: fakeWhisper() },
      'local',
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'transcription_failed' } });
  });

  it('success -> ok + transcript', async () => {
    const { sender, sent } = captureSender();
    await handleVoiceNoteTranscribe(
      {
        type: 'patch.voice_note.transcribe_request',
        requestId: 'v3',
        surfaceKind: 'mobile',
        format: 'wav',
        audioBase64: Buffer.from('real clip').toString('base64'),
      },
      { local: fakeWhisper() },
      'local',
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: true, transcript: 'transcribed text' });
  });

  it('UnsupportedClipFormatError -> unsupported_format', async () => {
    const { sender, sent } = captureSender();
    await handleVoiceNoteTranscribe(
      {
        type: 'patch.voice_note.transcribe_request',
        requestId: 'v4',
        surfaceKind: 'mobile',
        format: 'm4a',
        audioBase64: Buffer.from('real clip').toString('base64'),
      },
      {
        local: fakeWhisper({
          transcribeClip: async () => {
            throw new UnsupportedClipFormatError('m4a not supported by local backend');
          },
        }),
      },
      'local',
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'unsupported_format' } });
  });

  it('a generic transcription failure -> transcription_failed', async () => {
    const { sender, sent } = captureSender();
    await handleVoiceNoteTranscribe(
      {
        type: 'patch.voice_note.transcribe_request',
        requestId: 'v5',
        surfaceKind: 'mobile',
        format: 'wav',
        audioBase64: Buffer.from('real clip').toString('base64'),
      },
      {
        local: fakeWhisper({
          transcribeClip: async () => {
            throw new Error('sidecar 500');
          },
        }),
      },
      'local',
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'transcription_failed' } });
  });

  it('dictation on a hosted backend transcribes with THAT backend, not Whisper', async () => {
    const { sender, sent } = captureSender();
    const local = vi.fn(async () => 'whisper words');
    const gemini = vi.fn(async () => 'gemini words');
    await handleVoiceNoteTranscribe(
      {
        type: 'patch.voice_note.transcribe_request',
        requestId: 'v6',
        surfaceKind: 'mobile',
        format: 'm4a',
        audioBase64: Buffer.from('real clip').toString('base64'),
      },
      {
        local: fakeWhisper({ transcribeClip: local }),
        gemini: fakeWhisper({ transcribeClip: gemini }),
      },
      'gemini',
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: true, transcript: 'gemini words' });
    expect(local).not.toHaveBeenCalled();
    expect(gemini).toHaveBeenCalledWith(expect.any(Buffer), 'm4a');
  });

  it('dictation on a hosted backend with no key on this host is refused, never Whisper', async () => {
    const { sender, sent } = captureSender();
    const local = vi.fn(async () => 'whisper words');
    await handleVoiceNoteTranscribe(
      {
        type: 'patch.voice_note.transcribe_request',
        requestId: 'v7',
        surfaceKind: 'mobile',
        format: 'wav',
        audioBase64: Buffer.from('real clip').toString('base64'),
      },
      { local: fakeWhisper({ transcribeClip: local }) },
      'openai',
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({
      ok: false,
      error: {
        code: 'voice_key_missing',
        message:
          'Dictation is set to openai, but OPENAI_REALTIME_API_KEY is not set on this host. ' +
          'Switch Dictation to another backend in Settings → Voice.',
      },
    });
    expect(local).not.toHaveBeenCalled();
  });
});

describe('handleSecretsMutation', () => {
  function makeStore(): ReturnType<typeof createSecretsStore> {
    const home = mkdtempSync(join(tmpdir(), 'patch-secrets-handler-'));
    return createSecretsStore(home);
  }

  it('set success -> ok + secrets.updated', () => {
    const store = makeStore();
    const { sender, sent } = captureSender();
    handleSecretsMutation(
      { type: 'patch.secrets.set_request', requestId: 's1', key: 'FOO', value: 'bar' },
      store,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ type: 'patch.secrets.response', ok: true });
    expect(sent[1]).toMatchObject({ type: 'secrets.updated' });
  });

  it('set with an invalid key -> invalid_key (no secrets.updated)', () => {
    const store = makeStore();
    const { sender, sent } = captureSender();
    handleSecretsMutation(
      { type: 'patch.secrets.set_request', requestId: 's2', key: '1-bad-key', value: 'x' },
      store,
      sender,
      silent,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'invalid_key' } });
  });

  it('delete success -> ok + secrets.updated', () => {
    const store = makeStore();
    store.set('FOO', 'bar');
    const { sender, sent } = captureSender();
    handleSecretsMutation(
      { type: 'patch.secrets.delete_request', requestId: 's3', key: 'FOO' },
      store,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ type: 'patch.secrets.response', ok: true });
    expect(sent[1]).toMatchObject({ type: 'secrets.updated' });
  });

  it('delete of an absent key -> not_found', () => {
    const store = makeStore();
    const { sender, sent } = captureSender();
    handleSecretsMutation(
      { type: 'patch.secrets.delete_request', requestId: 's4', key: 'NOPE' },
      store,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('an unexpected store failure -> internal', () => {
    const store = makeStore();
    vi.spyOn(store, 'set').mockImplementation(() => {
      throw new Error('disk full');
    });
    const { sender, sent } = captureSender();
    handleSecretsMutation(
      { type: 'patch.secrets.set_request', requestId: 's5', key: 'FOO', value: 'x' },
      store,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'internal' } });
  });
});

describe('handleFilesRequest', () => {
  it('unknown chat -> chat_not_found', async () => {
    const { daemon } = makeDaemon();
    const { sender, sent } = captureSender();
    await handleFilesRequest(
      { type: 'patch.files.request', requestId: 'f1', chatId: 'no-such-chat', path: '' },
      daemon,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'chat_not_found' } });
  });

  it("a request with no `path` field at all falls back to the folder root (`?? ''`)", async () => {
    // `path` is required by the real wire schema (PatchFilesRequestEvent),
    // so this defensive `?? ''` can never see undefined via the live WS
    // path — exercised directly here since handleFilesRequest is exported
    // for exactly this kind of internal-branch test.
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    writeFileSync(join(folder, 'a.txt'), '');
    const chatId = await daemon.spawnChat({ folder });
    const { sender, sent } = captureSender();
    await handleFilesRequest(
      { type: 'patch.files.request', requestId: 'f1b', chatId } as unknown as Parameters<
        typeof handleFilesRequest
      >[0],
      daemon,
      sender,
      silent,
    );
    const res = sent[0] as { ok: boolean; entries: { name: string }[] };
    expect(res.ok).toBe(true);
    expect(res.entries.map((e) => e.name)).toContain('a.txt');
  });

  it('path escaping the chat folder -> path_escape', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    const chatId = await daemon.spawnChat({ folder });
    const { sender, sent } = captureSender();
    await handleFilesRequest(
      { type: 'patch.files.request', requestId: 'f2', chatId, path: '../../../etc' },
      daemon,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'path_escape' } });
  });

  it('default listing: entries (files + dirs), dirty via git-dirty', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    execFileSync('git', ['init', '-q'], { cwd: folder });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: folder });
    execFileSync('git', ['config', 'user.name', 'a'], { cwd: folder });
    writeFileSync(join(folder, 'committed.txt'), 'v1');
    writeFileSync(join(folder, 'clean.txt'), 'unchanged since commit');
    execFileSync('git', ['add', '.'], { cwd: folder });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: folder });
    writeFileSync(join(folder, 'committed.txt'), 'v2 (dirty)');
    mkdirSync(join(folder, 'subdir'));
    const chatId = await daemon.spawnChat({ folder });
    const { sender, sent } = captureSender();
    await handleFilesRequest(
      { type: 'patch.files.request', requestId: 'f3', chatId, path: '' },
      daemon,
      sender,
      silent,
    );
    const res = sent[0] as {
      ok: boolean;
      entries: { name: string; type: string; dirty?: boolean }[];
    };
    expect(res.ok).toBe(true);
    const committed = res.entries.find((e) => e.name === 'committed.txt');
    expect(committed?.dirty).toBe(true);
    // A committed, unmodified FILE takes the `{}` (not dirty) side of the
    // spread — distinct from the `subdir` case below, which is a directory
    // and never even reaches the dirty check.
    const clean = res.entries.find((e) => e.name === 'clean.txt');
    expect(clean?.dirty).toBeUndefined();
    const sub = res.entries.find((e) => e.name === 'subdir');
    expect(sub?.type).toBe('dir');
    expect(sub?.dirty).toBeUndefined();
  });

  it('default listing includes dotfiles (e.g. .env.local) — the browser is for the whole repo, not just non-hidden files', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    writeFileSync(join(folder, '.env.local'), 'SECRET=1');
    writeFileSync(join(folder, 'a.txt'), 'hi');
    mkdirSync(join(folder, '.config'));
    const chatId = await daemon.spawnChat({ folder });
    const { sender, sent } = captureSender();
    await handleFilesRequest(
      { type: 'patch.files.request', requestId: 'f3b', chatId, path: '' },
      daemon,
      sender,
      silent,
    );
    const res = sent[0] as { ok: boolean; entries: { name: string; type: string }[] };
    expect(res.ok).toBe(true);
    const names = res.entries.map((e) => e.name).sort();
    expect(names).toEqual(['.config', '.env.local', 'a.txt']);
    expect(res.entries.find((e) => e.name === '.env.local')?.type).toBe('file');
    expect(res.entries.find((e) => e.name === '.config')?.type).toBe('dir');
  });

  it('default listing: readdir ENOENT -> not_found; other errors -> internal', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    const chatId = await daemon.spawnChat({ folder });
    rmSync(folder, { recursive: true, force: true });
    const { sender, sent } = captureSender();
    await handleFilesRequest(
      { type: 'patch.files.request', requestId: 'f4', chatId, path: '' },
      daemon,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('default listing: a permission error -> internal', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    const chatId = await daemon.spawnChat({ folder });
    chmodSync(folder, 0o000);
    const { sender, sent } = captureSender();
    try {
      await handleFilesRequest(
        { type: 'patch.files.request', requestId: 'f4b', chatId, path: '' },
        daemon,
        sender,
        silent,
      );
      expect(sent[0]).toMatchObject({ ok: false, error: { code: 'internal' } });
    } finally {
      chmodSync(folder, 0o700);
    }
  });

  it('content:true on a directory -> not_a_file', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    mkdirSync(join(folder, 'subdir'));
    const chatId = await daemon.spawnChat({ folder });
    const { sender, sent } = captureSender();
    await handleFilesRequest(
      { type: 'patch.files.request', requestId: 'f5', chatId, path: 'subdir', content: true },
      daemon,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'not_a_file' } });
  });

  it('content:true on a missing file -> not_found', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    const chatId = await daemon.spawnChat({ folder });
    const { sender, sent } = captureSender();
    await handleFilesRequest(
      {
        type: 'patch.files.request',
        requestId: 'f6',
        chatId,
        path: 'no-such-file.txt',
        content: true,
      },
      daemon,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('content:true success -> content + size', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    writeFileSync(join(folder, 'a.txt'), 'hello world');
    const chatId = await daemon.spawnChat({ folder });
    const { sender, sent } = captureSender();
    await handleFilesRequest(
      { type: 'patch.files.request', requestId: 'f7', chatId, path: 'a.txt', content: true },
      daemon,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: true, content: 'hello world', size: 11 });
  });

  it('content:true + a read error other than ENOENT/ENOTDIR -> internal', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    writeFileSync(join(folder, 'a.txt'), 'hello world');
    chmodSync(join(folder, 'a.txt'), 0o000);
    const chatId = await daemon.spawnChat({ folder });
    const { sender, sent } = captureSender();
    try {
      await handleFilesRequest(
        { type: 'patch.files.request', requestId: 'f7b', chatId, path: 'a.txt', content: true },
        daemon,
        sender,
        silent,
      );
      expect(sent[0]).toMatchObject({ ok: false, error: { code: 'internal' } });
    } finally {
      chmodSync(join(folder, 'a.txt'), 0o600);
    }
  });

  it("ref:'head' with no git work-tree -> no_head_baseline", async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    writeFileSync(join(folder, 'a.txt'), 'hi');
    const chatId = await daemon.spawnChat({ folder });
    const { sender, sent } = captureSender();
    await handleFilesRequest(
      {
        type: 'patch.files.request',
        requestId: 'f8',
        chatId,
        path: 'a.txt',
        content: true,
        ref: 'head',
      },
      daemon,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'no_head_baseline' } });
  });

  it("ref:'head' on an untracked file (HEAD exists) -> empty baseline content", async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    execFileSync('git', ['init', '-q'], { cwd: folder });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: folder });
    execFileSync('git', ['config', 'user.name', 'a'], { cwd: folder });
    writeFileSync(join(folder, 'committed.txt'), 'v1');
    execFileSync('git', ['add', '.'], { cwd: folder });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: folder });
    writeFileSync(join(folder, 'untracked.txt'), 'new file');
    const chatId = await daemon.spawnChat({ folder });
    const { sender, sent } = captureSender();
    await handleFilesRequest(
      {
        type: 'patch.files.request',
        requestId: 'f9',
        chatId,
        path: 'untracked.txt',
        content: true,
        ref: 'head',
      },
      daemon,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: true, content: '', size: 0 });
  });

  it("ref:'head' on a committed file -> the HEAD blob content", async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    execFileSync('git', ['init', '-q'], { cwd: folder });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: folder });
    execFileSync('git', ['config', 'user.name', 'a'], { cwd: folder });
    writeFileSync(join(folder, 'committed.txt'), 'head content');
    execFileSync('git', ['add', '.'], { cwd: folder });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: folder });
    writeFileSync(join(folder, 'committed.txt'), 'working-tree edit');
    const chatId = await daemon.spawnChat({ folder });
    const { sender, sent } = captureSender();
    await handleFilesRequest(
      {
        type: 'patch.files.request',
        requestId: 'f10',
        chatId,
        path: 'committed.txt',
        content: true,
        ref: 'head',
      },
      daemon,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: true, content: 'head content' });
  });

  it('recursive:true walks the tree (dirs AND files), skips node_modules/.git/dist/etc, includes dotfiles, respects maxEntries', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    mkdirSync(join(folder, 'src'));
    writeFileSync(join(folder, 'src', 'a.ts'), '');
    writeFileSync(join(folder, 'src', 'b.ts'), '');
    mkdirSync(join(folder, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(folder, 'node_modules', 'x', 'index.js'), '');
    mkdirSync(join(folder, '.git'));
    writeFileSync(join(folder, '.git', 'HEAD'), '');
    writeFileSync(join(folder, '.hidden'), '');
    // An unreadable subdirectory encountered mid-walk (e.g. permission-denied)
    // is skipped, not fatal to the whole listing — the recursive walk()'s own
    // `catch { return; }` around readdirSync.
    const unreadableDir = join(folder, 'src', 'no-access');
    mkdirSync(unreadableDir);
    writeFileSync(join(unreadableDir, 'secret.txt'), '');
    chmodSync(unreadableDir, 0o000);
    const chatId = await daemon.spawnChat({ folder });
    const { sender, sent } = captureSender();
    try {
      await handleFilesRequest(
        { type: 'patch.files.request', requestId: 'f11', chatId, path: '', recursive: true },
        daemon,
        sender,
        silent,
      );
    } finally {
      chmodSync(unreadableDir, 0o700);
    }
    const res = sent[0] as { ok: boolean; entries: { name: string; type: string }[] };
    expect(res.ok).toBe(true);
    const names = res.entries.map((e) => e.name);
    // Editor overhaul: directories are now listed too (the web tree is built
    // from this flat list), not just files.
    expect(res.entries.find((e) => e.name === 'src')?.type).toBe('dir');
    expect(names).toContain(join('src', 'a.ts'));
    expect(names).toContain(join('src', 'b.ts'));
    expect(names.some((n) => n.includes('node_modules'))).toBe(false);
    expect(names.some((n) => n.includes('.git'))).toBe(false);
    // Editor overhaul: dotfiles are no longer skipped — this walk backs the
    // visible tree now, not only the ⌘P search index, and a hidden config
    // file is exactly what someone opens the browser to find.
    expect(res.entries.find((e) => e.name === '.hidden')?.type).toBe('file');
    expect(names.some((n) => n.includes('secret.txt'))).toBe(false);

    const { sender: sender2, sent: sent2 } = captureSender();
    await handleFilesRequest(
      {
        type: 'patch.files.request',
        requestId: 'f12',
        chatId,
        path: '',
        recursive: true,
        maxEntries: 1,
      },
      daemon,
      sender2,
      silent,
    );
    const res2 = sent2[0] as { ok: boolean; entries: unknown[] };
    expect(res2.entries.length).toBeLessThanOrEqual(1);

    // maxEntries:0 -> walk()'s TOP-of-function cap check (`flat.length >= cap`)
    // is true on its very FIRST call (`walk(root)`, flat still empty) — the
    // maxEntries:1 case above only ever exercises the loop-internal check
    // (before each dirent), never this one.
    const { sender: sender3, sent: sent3 } = captureSender();
    await handleFilesRequest(
      {
        type: 'patch.files.request',
        requestId: 'f13',
        chatId,
        path: '',
        recursive: true,
        maxEntries: 0,
      },
      daemon,
      sender3,
      silent,
    );
    const res3 = sent3[0] as { ok: boolean; entries: unknown[] };
    expect(res3.entries).toEqual([]);
  });

  // Editor overhaul: the recursive walk now computes `dirty` too (same git
  // status + in-flight-permission sources as the non-recursive listing),
  // since it is the tree's only data source and the pending-dot marker has
  // to work at any depth, not only inside a single "current" directory.
  it('recursive:true marks a git-dirty nested file, and leaves an unmodified one alone', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    execFileSync('git', ['init', '-q'], { cwd: folder });
    execFileSync('git', ['config', 'user.email', 'a@b.c'], { cwd: folder });
    execFileSync('git', ['config', 'user.name', 'a'], { cwd: folder });
    mkdirSync(join(folder, 'src'));
    writeFileSync(join(folder, 'src', 'committed.ts'), 'v1');
    writeFileSync(join(folder, 'src', 'clean.ts'), 'unchanged since commit');
    execFileSync('git', ['add', '.'], { cwd: folder });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: folder });
    writeFileSync(join(folder, 'src', 'committed.ts'), 'v2 (dirty)');
    const chatId = await daemon.spawnChat({ folder });
    const { sender, sent } = captureSender();
    await handleFilesRequest(
      { type: 'patch.files.request', requestId: 'f14', chatId, path: '', recursive: true },
      daemon,
      sender,
      silent,
    );
    const res = sent[0] as { ok: boolean; entries: { name: string; dirty?: boolean }[] };
    expect(res.ok).toBe(true);
    expect(res.entries.find((e) => e.name === join('src', 'committed.ts'))?.dirty).toBe(true);
    expect(res.entries.find((e) => e.name === join('src', 'clean.ts'))?.dirty).toBeUndefined();
  });

  // Editor overhaul (binary preview): `encoding: 'base64'` reads the file as
  // raw bytes instead of decoding as UTF-8 — proven with real (non-UTF-8-safe)
  // PNG-header bytes that would mangle if decoded as text first.
  it("content:true with encoding:'base64' returns the raw bytes, base64-encoded", async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    writeFileSync(join(folder, 'pic.png'), bytes);
    const chatId = await daemon.spawnChat({ folder });
    const { sender, sent } = captureSender();
    await handleFilesRequest(
      {
        type: 'patch.files.request',
        requestId: 'f15',
        chatId,
        path: 'pic.png',
        content: true,
        encoding: 'base64',
      },
      daemon,
      sender,
      silent,
    );
    const res = sent[0] as { ok: boolean; content: string; size: number };
    expect(res.ok).toBe(true);
    expect(Buffer.from(res.content, 'base64').equals(bytes)).toBe(true);
    expect(res.size).toBe(bytes.length);
  });
});

describe('handleChatHistoryRequest', () => {
  it('success -> events + optional nextFromSeq', () => {
    const { daemon } = makeDaemon();
    vi.spyOn(daemon, 'readHistory').mockReturnValue({
      events: [{ type: 'chat.message', chatId: 'c1', role: 'user', content: 'hi', seq: 0 }],
      nextFromSeq: 5,
    } as ReturnType<Daemon['readHistory']>);
    const { sender, sent } = captureSender();
    handleChatHistoryRequest(
      { type: 'patch.chat_history.request', requestId: 'h1', chatId: 'c1' },
      daemon,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: true, nextFromSeq: 5 });
  });

  it('ChatNotFoundError -> chat_not_found', () => {
    const { daemon } = makeDaemon();
    vi.spyOn(daemon, 'readHistory').mockImplementation(() => {
      throw new ChatNotFoundError('no-such-chat');
    });
    const { sender, sent } = captureSender();
    handleChatHistoryRequest(
      { type: 'patch.chat_history.request', requestId: 'h2', chatId: 'no-such-chat' },
      daemon,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'chat_not_found' } });
  });

  it('a generic failure -> internal', () => {
    const { daemon } = makeDaemon();
    vi.spyOn(daemon, 'readHistory').mockImplementation(() => {
      throw new Error('disk error');
    });
    const { sender, sent } = captureSender();
    handleChatHistoryRequest(
      { type: 'patch.chat_history.request', requestId: 'h3', chatId: 'c1' },
      daemon,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({ ok: false, error: { code: 'internal' } });
  });

  // spec/14 § Side threads panel — pulls a side thread's content through this
  // REST-backed RPC rather than the live WS stream (a side branch's content
  // is not broadcast live — spec/04 § Parallel branches).
  it("passes branchId through to readHistory, reading that branch's own track", () => {
    const { daemon } = makeDaemon();
    const spy = vi.spyOn(daemon, 'readHistory').mockReturnValue({ events: [] });
    const { sender } = captureSender();
    handleChatHistoryRequest(
      { type: 'patch.chat_history.request', requestId: 'h4', chatId: 'c1', branchId: 'c1-b1' },
      daemon,
      sender,
      silent,
    );
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'c1', branchId: 'c1-b1' }));
  });
});

describe('handleServerEvent', () => {
  // spec/04 ## Message queueing § Promote — the surface→host hop.
  it('chat.promote_request is routed to daemon.promoteInput', async () => {
    const { daemon } = makeDaemon();
    const spy = vi.spyOn(daemon, 'promoteInput').mockResolvedValue(undefined);
    const { sender, sent } = captureSender();
    await handleServerEvent(
      { type: 'chat.promote_request', chatId: 'c-promote', localId: 'L7' },
      daemon,
      sender,
      silent,
    );
    expect(spy).toHaveBeenCalledWith('c-promote', 'L7');
    expect(sent).toHaveLength(0);
  });

  // spec/04 ## Message queueing § Edit — replace a queued turn's typed text.
  it('chat.edit_queued_request is routed to daemon.editQueuedInput', async () => {
    const { daemon } = makeDaemon();
    const spy = vi.spyOn(daemon, 'editQueuedInput').mockReturnValue(undefined);
    const { sender, sent } = captureSender();
    await handleServerEvent(
      { type: 'chat.edit_queued_request', chatId: 'c-edit', localId: 'L8', message: 'meant' },
      daemon,
      sender,
      silent,
    );
    expect(spy).toHaveBeenCalledWith('c-edit', 'L8', 'meant');
    expect(sent).toHaveLength(0);
  });

  // spec/14 § Side threads panel — "Send back to chat" button, the
  // surface-triggered counterpart of the agent's own `patch_send_back` tool.
  it('chat.send_back_request is routed to daemon.sendBackToParent', async () => {
    const { daemon } = makeDaemon();
    const spy = vi.spyOn(daemon, 'sendBackToParent').mockResolvedValue({ ok: true });
    const { sender, sent } = captureSender();
    await handleServerEvent(
      { type: 'chat.send_back_request', chatId: 'c-sb', branchId: 'c-sb-b1' },
      daemon,
      sender,
      silent,
    );
    expect(spy).toHaveBeenCalledWith('c-sb', 'c-sb-b1');
    expect(sent).toHaveLength(0);
  });

  it('chat.send_back_request emits chat.error on refusal, naming why', async () => {
    const { daemon } = makeDaemon();
    vi.spyOn(daemon, 'sendBackToParent').mockResolvedValue({
      ok: false,
      error: 'this branch has already sent back to its parent',
    });
    const { sender, sent } = captureSender();
    await handleServerEvent(
      { type: 'chat.send_back_request', chatId: 'c-sb2', branchId: 'c-sb2-b1' },
      daemon,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({
      type: 'chat.error',
      chatId: 'c-sb2',
      error: {
        code: 'send_back_failed',
        message: 'this branch has already sent back to its parent',
      },
    });
  });

  // spec/02 § Self-wake — a surface (not the agent) arming/cancelling a loop
  // reaches the SAME scheduler as patch_loop/patch_cancel_wake.
  it('chat.loop_request with a loop object arms a recurring wake via daemon.scheduleWake', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    const chatId = await daemon.spawnChat({ folder });
    const spy = vi.spyOn(daemon, 'scheduleWake');
    const { sender, sent } = captureSender();
    await handleServerEvent(
      {
        type: 'chat.loop_request',
        chatId,
        loop: { message: 'check on the build', every: '5m' },
      },
      daemon,
      sender,
      silent,
    );
    expect(spy).toHaveBeenCalledWith(chatId, { message: 'check on the build', every: '5m' });
    expect(daemon.peekWake(chatId)?.every).toBe(5 * 60_000);
    expect(sent).toHaveLength(0);
  });

  it('chat.loop_request with `loop: null` cancels the pending wake via daemon.cancelWake', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    const chatId = await daemon.spawnChat({ folder });
    daemon.scheduleWake(chatId, { every: '5m', message: 'looping' });
    expect(daemon.peekWake(chatId)).not.toBeNull();
    const spy = vi.spyOn(daemon, 'cancelWake');
    const { sender, sent } = captureSender();
    await handleServerEvent(
      { type: 'chat.loop_request', chatId, loop: null },
      daemon,
      sender,
      silent,
    );
    expect(spy).toHaveBeenCalledWith(chatId);
    expect(daemon.peekWake(chatId)).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('chat.loop_request for an unknown chat surfaces chat_not_found, not a thrown exception', async () => {
    const { daemon } = makeDaemon();
    const { sender, sent } = captureSender();
    await handleServerEvent(
      { type: 'chat.loop_request', chatId: 'no-such-chat', loop: { message: 'x', every: '1m' } },
      daemon,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({
      type: 'chat.error',
      chatId: 'no-such-chat',
      error: { code: 'chat_not_found' },
    });
  });

  it('chat.spawn_request with every optional field omitted -> the FALSE side of every `!== undefined` spread', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    const spy = vi.spyOn(daemon, 'spawnChat');
    const { sender, sent } = captureSender();
    // Every OTHER chat.spawn_request in this file sets localId (and usually
    // name/chatId/prompt/archived/model/permissionMode too) — this is the
    // only one that omits them all, covering the `{}` side of each spread.
    await handleServerEvent(
      { type: 'chat.spawn_request', daemonId: 'd1', folder },
      daemon,
      sender,
      silent,
    );
    expect(sent).toHaveLength(0);
    expect(spy).toHaveBeenCalledWith({ folder });
  });

  it('chat.spawn_request carrying goal sets it on the newly spawned chat (spec/04 § Goals, spec/08 ## Action)', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    const { sender, sent } = captureSender();
    await handleServerEvent(
      {
        type: 'chat.spawn_request',
        daemonId: 'd1',
        folder,
        chatId: 'chat-goal-1',
        goal: 'Clear the backlog',
      },
      daemon,
      sender,
      silent,
    );
    expect(sent).toHaveLength(0);
    expect(daemon.chatState.get('chat-goal-1')?.goal).toBe('Clear the backlog');
  });

  it('chat.spawn_request with no goal leaves the new chat without one', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    const { sender } = captureSender();
    await handleServerEvent(
      { type: 'chat.spawn_request', daemonId: 'd1', folder, chatId: 'chat-nogoal-1' },
      daemon,
      sender,
      silent,
    );
    expect(daemon.chatState.get('chat-nogoal-1')?.goal).toBeNull();
  });

  it('a non-Error thrown value falls back to String(err) in the catch mapping', async () => {
    const { daemon } = makeDaemon();
    vi.spyOn(daemon, 'unqueueInput').mockImplementation(() => {
      throw 'a raw string, not an Error instance';
    });
    const { sender, sent } = captureSender();
    await handleServerEvent(
      { type: 'chat.unqueue_request', chatId: 'c-does-not-matter', localId: 'l1' },
      daemon,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({
      type: 'chat.error',
      chatId: 'c-does-not-matter',
      error: { code: 'sdk_error', message: 'a raw string, not an Error instance' },
    });
  });

  it('chat.resume_request success -> no error emitted (the happy-path return)', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    const chatId = await daemon.spawnChat({ folder });
    const { sender, sent } = captureSender();
    await handleServerEvent({ type: 'chat.resume_request', chatId }, daemon, sender, silent);
    expect(sent).toHaveLength(0);
  });

  it('chat.permission_response with no `decision` field falls back to approve/deny from `approve`', async () => {
    const { daemon } = makeDaemon();
    const spy = vi.spyOn(daemon, 'submitPermissionResponse');
    const { sender } = captureSender();
    await handleServerEvent(
      { type: 'chat.permission_response', requestId: 'req-deny', approve: false },
      daemon,
      sender,
      silent,
    );
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-deny', decision: 'deny' }),
    );
  });

  it('chat.permission_response with editedNewString sets it on the submitted decision', async () => {
    const { daemon } = makeDaemon();
    const spy = vi.spyOn(daemon, 'submitPermissionResponse');
    const { sender } = captureSender();
    await handleServerEvent(
      {
        type: 'chat.permission_response',
        requestId: 'req-1',
        approve: true,
        decision: 'approve_with_edits',
        editedNewString: 'the user-edited content',
      },
      daemon,
      sender,
      silent,
    );
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-1', editedNewString: 'the user-edited content' }),
    );
  });

  it('FolderNotFoundError -> folder_not_found, chatId falls back to pending-spawn', async () => {
    const { daemon } = makeDaemon();
    const { sender, sent } = captureSender();
    await handleServerEvent(
      { type: 'chat.spawn_request', daemonId: 'd1', folder: '/no/such/folder-xyz', localId: 'l1' },
      daemon,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({
      type: 'chat.error',
      chatId: 'pending-spawn',
      error: { code: 'folder_not_found' },
    });
  });

  it('ChatNotFoundError -> chat_not_found, chatId taken from the event', async () => {
    const { daemon } = makeDaemon();
    const { sender, sent } = captureSender();
    // stopChat() itself is a silent no-op for an unknown chat (nothing to
    // abort) — resumeChat() is the switch case that actually throws
    // ChatNotFoundError for one.
    await handleServerEvent(
      { type: 'chat.resume_request', chatId: 'no-such-chat' },
      daemon,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({
      type: 'chat.error',
      chatId: 'no-such-chat',
      error: { code: 'chat_not_found' },
    });
  });

  it('any other thrown error -> sdk_error, chatId taken from the event when present', async () => {
    const { daemon } = makeDaemon();
    vi.spyOn(daemon, 'unqueueInput').mockImplementation(() => {
      throw new Error('boom');
    });
    const { sender, sent } = captureSender();
    await handleServerEvent(
      { type: 'chat.unqueue_request', chatId: 'c-does-not-matter', localId: 'l1' },
      daemon,
      sender,
      silent,
    );
    expect(sent[0]).toMatchObject({
      type: 'chat.error',
      chatId: 'c-does-not-matter',
      error: { code: 'sdk_error' },
    });
  });

  it('an event with no chatId at all, of a type other than chat.spawn_request, emits no chat.error (it would draw a ghost chat)', async () => {
    const { daemon } = makeDaemon();
    vi.spyOn(daemon, 'unqueueInput').mockImplementation(() => {
      throw new Error('boom');
    });
    const { sender, sent } = captureSender();
    // No real WireEvent type both lacks `chatId` AND reaches a throwing
    // host call other than chat.spawn_request (every switch case that can
    // throw carries one) — handleServerEvent is exported specifically to
    // make this kind of internal-branch test practical without contriving
    // an otherwise-impossible real wire event.
    await handleServerEvent(
      { type: 'chat.unqueue_request', localId: 'l1' } as unknown as Parameters<
        typeof handleServerEvent
      >[0],
      daemon,
      sender,
      silent,
    );
    expect(sent).toEqual([]);
  });

  it('a failed manager sweep reports a manager.sweep_result error, not a chat.error for a chat that does not exist', async () => {
    const { daemon } = makeDaemon();
    vi.spyOn(daemon, 'runManagerSweep').mockRejectedValue(
      new Error('Claude Code process aborted by user'),
    );
    const { sender, sent } = captureSender();
    await handleServerEvent(
      { type: 'manager.sweep_run', runId: 'r1' } as unknown as Parameters<
        typeof handleServerEvent
      >[0],
      daemon,
      sender,
      silent,
    );
    expect(sent).toEqual([
      {
        type: 'manager.sweep_result',
        runId: 'r1',
        actions: [],
        tokensUsed: 0,
        error: 'Claude Code process aborted by user',
      },
    ]);
  });

  it('an event type outside the switch is a debug no-op', async () => {
    const { daemon } = makeDaemon();
    const { sender, sent } = captureSender();
    await handleServerEvent({ type: 'surface.heartbeat' }, daemon, sender, silent);
    expect(sent).toHaveLength(0);
  });

  it('chat.replay wraps every replayed event with forSurfaceId', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    const chatId = await daemon.spawnChat({ folder });
    // A freshly-spawned chat with no turns has nothing in its replay ring —
    // send one so there's at least one event to wrap.
    await daemon.sendInput({ chatId, message: 'hi', localId: 'l1' });
    const { sender, sent } = captureSender();
    await handleServerEvent(
      { type: 'chat.replay', chatId, fromSeq: -1, forSurfaceId: 'surface-9' },
      daemon,
      sender,
      silent,
    );
    expect(sent.length).toBeGreaterThan(0);
    for (const e of sent) {
      expect((e as { forSurfaceId?: string }).forSurfaceId).toBe('surface-9');
    }
  });

  it('chat.replay with no forSurfaceId does not wrap', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'hi', localId: 'l1' });
    const { sender, sent } = captureSender();
    await handleServerEvent({ type: 'chat.replay', chatId, fromSeq: -1 }, daemon, sender, silent);
    expect(sent.length).toBeGreaterThan(0);
    for (const e of sent) {
      expect('forSurfaceId' in e).toBe(false);
    }
  });

  // spec/12 § Sequence-based replay — batching. A 2,000-event chat was 2,000
  // separate frames across host -> server -> surface, drawn as each landed.
  // That trickle is what a reader saw as the transcript scrolling past one
  // message at a time.
  it('chat.replay { batch: true } answers in batch frames carrying the same events, in order', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'hi', localId: 'l1' });

    const plain = captureSender();
    await handleServerEvent(
      { type: 'chat.replay', chatId, fromSeq: -1 },
      daemon,
      plain.sender,
      silent,
    );

    const batched = captureSender();
    await handleServerEvent(
      { type: 'chat.replay', chatId, fromSeq: -1, batch: true },
      daemon,
      batched.sender,
      silent,
    );

    // Every frame is a batch, and the last one says the transcript is whole.
    expect(batched.sent.length).toBeGreaterThan(0);
    for (const e of batched.sent) expect(e.type).toBe('chat.replay_batch');
    const frames = batched.sent as Array<{ events: unknown[]; done: boolean; chatId: string }>;
    expect(frames.at(-1)!.done).toBe(true);
    expect(frames.every((f) => f.chatId === chatId)).toBe(true);
    // Fewer frames than events — the whole point — carrying exactly what the
    // unbatched answer carried, in the same order.
    const flat = frames.flatMap((f) => f.events);
    expect(batched.sent.length).toBeLessThan(flat.length);
    expect(flat).toEqual(plain.sent);
  });

  it('a batched replay is still addressed to the one surface that asked', async () => {
    const { daemon } = makeDaemon();
    const folder = makeFolder();
    const chatId = await daemon.spawnChat({ folder });
    await daemon.sendInput({ chatId, message: 'hi', localId: 'l1' });
    const { sender, sent } = captureSender();
    await handleServerEvent(
      { type: 'chat.replay', chatId, fromSeq: -1, batch: true, forSurfaceId: 'surface-9' },
      daemon,
      sender,
      silent,
    );
    expect(sent.length).toBeGreaterThan(0);
    for (const e of sent) {
      expect(e.type).toBe('chat.replay_batch');
      expect((e as { forSurfaceId?: string }).forSurfaceId).toBe('surface-9');
    }
  });
});
