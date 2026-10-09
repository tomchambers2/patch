// Fastify app factory — exported separately from the listener so tests can
// `await build()` and call `app.inject()` without binding a port.

import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as resolvePath, sep } from 'node:path';
import { existsSync, readFileSync, createReadStream, statSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import multipartPlugin from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import rateLimitPlugin from '@fastify/rate-limit';
import helmetPlugin from '@fastify/helmet';
import { ulid } from 'ulid';
import type { Logger } from 'pino';
import {
  DEFAULT_SHARED_SETTINGS,
  type ChatInputEvent,
  type HealthzResponse,
  type WireEvent,
} from '@patch/wire';
import { verifySurfaceCredential, verifyDaemonKey } from '@patch/auth';
import { GIT_SHA, SERVER_SHA, VERSION } from './version.js';
import { buildVersionReport, readPublishedArtifact, readWebLayer } from './version-report.js';
import { Registry } from './registry.js';
import { PresenceTracker } from './presence.js';
import { createActivityReader } from './activity.js';
import { DEFAULT_SETTINGS } from './settings.js';
import { SharedSettingsService } from './shared-settings.js';
import { registerSettingsRoutes } from './settings-routes.js';
import { ComposerDraftStore } from './composer-drafts.js';
import { NewChatDraftStore } from './new-chat-drafts.js';
import { ManagerSweeper, type SweepRunStore } from './manager-sweep.js';
import { ChatLogStore } from './chat-log-store.js';
import { CommitAcks } from './commit-acks.js';
import { LogSync } from './log-sync.js';
import { ManagerFailover } from './manager-failover.js';
import { HeldInputStore } from './held-input-store.js';
import { QueueTracker } from './queue-tracker.js';
import { ServerQueue } from './server-queue.js';
import { createSweepRunStore } from './sweep-run-store.js';
import { registerManagerSweepRoutes } from './manager-sweep-routes.js';
import { ThreadRotator } from './thread-rotation.js';
import { type DaemonLink, InboundDaemonLink } from './daemon-link.js';
import { WsHub } from './ws-hub.js';
import { registerAuthRoutes } from './auth-routes.js';
import type { RelayService } from './relay-service.js';
import { ChatRegistry } from './chat-registry.js';
import { registerCrossHostBridge } from './cross-host.js';
import { registerBrowserTunnelBridge } from './browser-tunnel-bridge.js';
import { registerChatRoutes } from './chat-routes.js';
import { BatchStore } from './batch/store.js';
import { registerBatchRoutes } from './batch/routes.js';
import { BatchNotifier } from './notifications/batch.js';
import { FolderRegistry } from './folder-registry.js';
import { registerFolderRoutes, requireAuth } from './folder-routes.js';
import { registerHostFilesRoutes } from './host-files-routes.js';
import { registerChatMoveRoutes } from './chat-move-routes.js';
import { ChatMirror } from './chat-mirror.js';
import { registerChatSearchRoutes } from './chat-search-routes.js';

/**
 * How often the Manager sweep checks whether it's due (spec/06 § Sweep —
 * Gate). Well under the shortest realistic interval setting, so a due sweep
 * goes out promptly; the gate itself (interval + event-wake) is what
 * actually decides, this is just the clock resolution.
 */
const MANAGER_SWEEP_TICK_MS = 10_000;
// Minute-granularity (spec/06 § Session rotation compares HH:MM), so a much
// less frequent tick than the watch loop's is enough.
const THREAD_ROTATION_TICK_MS = 30_000;
import { registerLinkPreviewRoutes } from './link-preview-routes.js';
import { SecretsRegistry } from './secrets-registry.js';
import { registerSecretsRoutes } from './secrets-routes.js';
import { registerWebBotAuthRoutes } from './web-bot-auth-routes.js';
import { AccountConflictError } from './registry.js';
import { FilterError } from './jobs/filter.js';
import { InvalidJobIdError, isJobRunFailure } from './jobs/logs.js';
import { JobStore } from './jobs/store.js';
import { JobDispatcher } from './jobs/dispatcher.js';
import { JobChatLinks } from './jobs/chat-links.js';
import { JobLogs } from './jobs/logs.js';
import { CronScheduler } from './jobs/cron.js';
import { RecurrenceScheduler } from './jobs/recurrence.js';
import { registerWebhookRoutes } from './jobs/webhooks.js';
import { registerTodoistRoutes } from './jobs/todoist.js';
import { registerJobRoutes } from './jobs/routes.js';
import { attachJobsRpcBridge } from './jobs/rpc-bridge.js';
import type { Job, JobsInterface } from './jobs/types.js';
import { HookStore } from './hooks/store.js';
import { HookRunner } from './hooks/runner.js';
import { registerHookRoutes } from './hooks/routes.js';
import type { HooksInterface } from './hooks/types.js';
import { NotificationRouter, type PushBackend } from './notifications/router.js';
import { CallOrchestrator } from './notifications/call-orchestrator.js';
import { ChatCompletionNotifier } from './notifications/chat-complete.js';
import { AwaitingPermissionNotifier } from './notifications/awaiting-permission.js';
import { ReplyRouter } from './notifications/reply-router.js';
import { registerNotificationRoutes } from './notifications/routes.js';
import { NotificationLog } from './notifications/log.js';
import { registerNotificationLogRoutes } from './notifications/log-routes.js';
import { registerVoiceTokenRoute } from './voice/token.js';
import { AudioSessionRouter, registerAudioRelayRoute } from './audio-relay.js';
import { registerVoiceNoteRoute } from './voice/note.js';
import { registerAttachmentRoutes } from './attachments.js';
import { registerArtifactRoutes } from './artifacts.js';
import { registerPadRoutes } from './pads/routes.js';
import { registerBlobRoutes } from './blob-routes.js';
import {
  registerDevDiagRoutes,
  registerJobsDiagRoutes,
  InMemorySpeakersRecorder,
} from './dev-diag.js';
import { ExpoPushBackend } from './notifications/expo.js';

/** The surface id settings frames to hosts are sent under. */
const SETTINGS_SURFACE = 'shared-settings';

export interface BuildOptions {
  logger?: boolean | object;
  webDistDir?: string;
  /** Required for WS auth + pairing — file-backed registry is loaded from this dir. */
  dataDir?: string;
  /** How long the home host must be offline before another takes over (tests shorten it). */
  managerFailoverGraceMs?: number;
  /** How long a mismatch between a host's log and the server's must last before it is acted on (tests shorten it). */
  logSyncDelayMs?: number;
  /** Inject a registry directly (tests); otherwise loaded from dataDir. */
  registry?: Registry;
  /** Inject the host link (tests). Production uses InboundDaemonLink. */
  daemonLink?: DaemonLink;
  /**
   * Shared HMAC secret for voice session tokens (spec/13). Surfaces present
   * the minted token to the host's audio WSS where the same secret verifies.
   * No longer used by the host link (the host authenticates with its
   * EdDSA-JWT daemonKey on /ws — see spec/10).
   */
  internalToken?: string;
  /** The server's reachability through a relay, when it has one (`relay-service.ts`). */
  relay?: RelayService;
  /** Override clock for tests. */
  nowMs?: () => number;
  helloTimeoutMs?: number;
  /** Test hook: deterministic ULID generator. */
  idGenerator?: () => string;
  /** Override InboundDaemonLink's unknown-chat-host wait window (default 3000ms). */
  unknownChatHostWaitMs?: number;
  /** Override InboundDaemonLink's unknown-chat-host poll interval (default 200ms). */
  unknownChatHostPollMs?: number;
  /** Override the POST /api/chats spawn-error wait window (default 5000ms). */
  spawnErrorWaitMs?: number;
  /** Override POST /api/jobs/recurrence/translate's daemon-wait window (tests). */
  recurrenceTranslateTimeoutMs?: number;
  /** Base64 PKCS#8 Ed25519 key for the Web Bot Auth directory; defaults to PATCH_WEB_BOT_AUTH_KEY. */
  webBotAuthKey?: string;
  /** Inject a jobs store (tests); otherwise constructed from dataDir. */
  jobsStore?: JobsInterface;
  /** Inject a composer-draft store (tests); otherwise constructed from dataDir. */
  composerDrafts?: ComposerDraftStore;
  /** Inject a new-chat-draft store (tests); otherwise constructed from dataDir. */
  newChatDrafts?: NewChatDraftStore;
  /** Disable the chokidar watcher in tests. */
  jobsWatch?: boolean;
  /** Inject a hooks store (tests); otherwise constructed from dataDir. */
  hooksStore?: HooksInterface;
  /** Disable the hooks store's chokidar watcher in tests. */
  hooksWatch?: boolean;
  /** Group 11 — inject mock push backend in tests; production uses Expo's push API. */
  pushBackend?: PushBackend;
  /** Group 11 — call timeout (default 30000). */
  callTimeoutMs?: number;
  /** Inject a pairing-nonce store (tests); otherwise an in-memory store. */
  pairingNonceStore?: import('@patch/auth').PairingNonceStore;
  /** Inject the Claude token check (tests). */
  validateClaudeToken?: (token: string) => Promise<import('@patch/auth').ClaudeTokenValidation>;
  /** Inject the OpenAI key check (tests). */
  validateOpenAIKey?: import('./shared-settings.js').ValidateOpenAIKey;
}

export interface BuiltApp {
  app: FastifyInstance;
  registry: Registry;
  presence: PresenceTracker;
  daemonLink: DaemonLink;
  wsHub: WsHub;
  chatRegistry: ChatRegistry;
  composerDrafts: ComposerDraftStore;
  newChatDrafts: NewChatDraftStore;
  folderRegistry: FolderRegistry;
  jobs: JobsInterface;
  jobDispatcher: JobDispatcher;
  hooks: HooksInterface;
  hookRunner: HookRunner;
  cronScheduler: CronScheduler;
  recurrenceScheduler: RecurrenceScheduler;
  notificationRouter: NotificationRouter;
  notificationLog: NotificationLog;
  callOrchestrator: CallOrchestrator;
  replyRouter: ReplyRouter;
  batchStore: BatchStore;
  batchNotifier: BatchNotifier;
  managerSweeper: ManagerSweeper;
  sweepRuns: SweepRunStore;
  /** The server's log of each chat's transcript. */
  chatLogStore: ChatLogStore;
}

export async function build(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const built = await buildAll(opts);
  return built.app;
}

export const PINO_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-patch-internal-token"]',
  'internalToken',
  '*.internalToken',
  'localKey',
  '*.localKey',
  'oauthAccessToken',
  '*.oauthAccessToken',
  'credential',
  'auth',
  'token',
  '*.token',
  // Group 10 polish (security M2): defense-in-depth — never log raw bodies
  // or webhook event data even if a future code path tries to.
  'req.body',
  '*.payload',
  '*.event.data',
  // Group 12 (LOW-1): explicit notification-channel secrets. The generic
  // `*.token` rule already catches the Expo push `token` field; these are
  // future-proofing in case the field is renamed (`pushToken`) or nested
  // alongside an unrelated `token`.
  'pushToken',
  '*.pushToken',
];

export async function buildAll(opts: BuildOptions = {}): Promise<BuiltApp> {
  // Default logger config — when caller passes a boolean true or omits, attach
  // pino redaction so credentials don't escape into log lines.
  const loggerOption: BuildOptions['logger'] | { redact: { paths: string[]; remove: boolean } } =
    typeof opts.logger === 'object' && opts.logger !== null
      ? { ...(opts.logger as object), redact: { paths: PINO_REDACT_PATHS, remove: true } }
      : opts.logger === true
        ? { redact: { paths: PINO_REDACT_PATHS, remove: true } }
        : (opts.logger ?? false);
  const app = Fastify({ logger: loggerOption, trustProxy: true });
  // Group 10 MAJOR (DX-M6): unified error envelope.
  // Existing routes already handle their own typed errors with explicit
  // statusCode + structured body. This handler is the safety net for cases
  // where a thrown error escaped without being mapped — it preserves the
  // existing 401/409/400 shapes while preventing internal-state leaks (no
  // stack traces, no full error.toString()) for everything else.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    // Fastify's own validation errors (e.g. body too large, content-type
    // mismatch) carry .statusCode and a sane message — keep them.
    if (err.validation) {
      reply.code(400).send({ error: 'invalid body', issues: err.validation });
      return;
    }
    if (err instanceof AccountConflictError) {
      reply.code(409).send({ error: 'account_conflict', message: err.message });
      return;
    }
    if (err instanceof FilterError) {
      reply.code(400).send({ error: 'filter_error', message: err.message });
      return;
    }
    if (err instanceof InvalidJobIdError) {
      reply.code(400).send({ error: 'invalid jobId' });
      return;
    }
    // Auth-style 401 raised via { statusCode: 401 } → preserve.
    if (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
      reply.code(err.statusCode).send({ error: err.message ?? 'request error' });
      return;
    }
    req.log.error({ err: err.message, stack: err.stack }, 'unhandled-server-error');
    reply.code(500).send({ error: 'internal' });
  });
  // Group 10 MAJOR (DX-M6): unknown route / wrong-method 404s must use the same
  // unified error envelope (`{ error: "<message>" }`) every mapped route uses.
  // Fastify's default not-found body is `{ message, error: "Not Found",
  // statusCode }`, where `.error` is the generic string "Not Found" — divergent
  // from the descriptive `.error` clients depend on. Map it here.
  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: `route not found: ${req.method} ${req.url}` });
  });
  // permessage-deflate, which `ws` leaves OFF unless the server opts in
  // (spec/03 § Transport). A chat transcript is JSON and compresses several
  // times over; without this every replay crossed the link raw. Thresholded
  // so a one-line live frame is not worth a deflate round-trip, and
  // concurrency-limited so a burst cannot pin the event loop. `zlib` contexts
  // are the memory risk here, hence the modest window and the client-side
  // no-context-takeover: this box has 4 GB and runs everything else too.
  await app.register(websocketPlugin, {
    options: {
      perMessageDeflate: {
        threshold: 8 * 1024,
        concurrencyLimit: 10,
        zlibDeflateOptions: { level: 6, memLevel: 7, windowBits: 14 },
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
      },
    },
  });
  // spec/07 § End-to-end voice transport — the mobile voice-note upload
  // (`POST /api/voice/note`) is multipart/form-data (chatId + audio m4a).
  await app.register(multipartPlugin, {
    limits: {
      files: 1,
      // A voice note is short; 25 MB is a generous ceiling (the route also
      // re-checks the assembled clip size). Keeps a runaway upload bounded.
      fileSize: 25 * 1024 * 1024,
    },
  });
  await app.register(rateLimitPlugin, {
    global: false,
    // X-Forwarded-For is honoured because trustProxy is on.
  });

  const log: Logger = app.log as unknown as Logger;

  const registry = opts.registry ?? (opts.dataDir ? Registry.load(opts.dataDir) : null);
  if (!registry) {
    throw new Error('build(): either registry or dataDir is required');
  }

  const presence = new PresenceTracker();
  // spec/01 + spec/05: surfaces heartbeat every 10s, timeout at 30s. Nothing
  // else calls sweep(), so /api/presence would report connected-but-silent
  // surfaces as `online` forever without this server-owned ticker. Sweeping
  // every 5s ages a silent surface to `stale` within 30–35s of its last beat.
  const PRESENCE_SWEEP_INTERVAL_MS = 5_000;
  const presenceSweepTimer = setInterval(() => {
    presence.sweep(opts.nowMs ? opts.nowMs() : Date.now());
  }, PRESENCE_SWEEP_INTERVAL_MS);
  // Don't let the sweeper keep the process (or test runner) alive.
  presenceSweepTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(presenceSweepTimer);
  });

  // The host connects INTO the server's /ws and authenticates with its
  // EdDSA-JWT daemonKey (spec/10). The InboundDaemonLink owns the single live
  // host socket once the WS hello gate hands it over via `attachDaemon`.
  // Forward-declared: the link routes a chat-scoped frame to the machine that
  // chat lives on, and the mirror that knows is built just below.
  let chatRegistryRef: ChatRegistry | undefined;
  const daemonLink: DaemonLink =
    opts.daemonLink ??
    new InboundDaemonLink({
      logger: log.child({ component: 'daemon-link' }),
      heldInputs: new HeldInputStore({
        ...((opts.dataDir ?? registry.dataDir)
          ? { dataDir: opts.dataDir ?? registry.dataDir }
          : {}),
        logger: log.child({ component: 'held-input' }),
      }),
      resolveChatHost: (chatId: string) => chatRegistryRef?.get(chatId)?.daemonId ?? null,
      homeDaemonId: () => registry.homeDaemonId(),
      registeredDaemonIds: () => registry.registeredDaemonIds(),
      specialThreadHost: () => managerFailover.specialThreadHost(),
      ...(opts.unknownChatHostWaitMs !== undefined
        ? { unknownChatHostWaitMs: opts.unknownChatHostWaitMs }
        : {}),
      ...(opts.unknownChatHostPollMs !== undefined
        ? { unknownChatHostPollMs: opts.unknownChatHostPollMs }
        : {}),
    });

  const idGenerator = opts.idGenerator ?? ((): string => ulid());

  // Server-only chatId → jobId links (spec/08 § Action, spec/14 § Sidebar —
  // Automations). Same dataDir resolution as the jobs subsystem below; absent
  // there is no dataDir (tests that inject a bare registry), so automations
  // tagging is simply unavailable rather than forced with a fallback path.
  const jobChatLinksDataDir = opts.dataDir ?? registry.dataDir;
  const jobChatLinks = jobChatLinksDataDir
    ? new JobChatLinks({
        dataDir: jobChatLinksDataDir,
        logger: log.child({ component: 'job-chat-links' }),
      })
    : undefined;

  const chatRegistry = new ChatRegistry({
    logger: log.child({ component: 'chat-registry' }),
    jobChatLinks,
    // The server owns what it last knew about each chat, so a restart begins
    // from that instead of from an empty mirror.
    ...(jobChatLinksDataDir
      ? { persistPath: join(jobChatLinksDataDir, 'chat-registry.json') }
      : {}),
  });
  app.addHook('onClose', async () => chatRegistry.flush());
  chatRegistryRef = chatRegistry;
  // Tap the host link so every event the host emits keeps our cache fresh.
  daemonLink.onEvent((event) => chatRegistry.observe(event));
  const queueTracker = new QueueTracker(chatRegistry);
  daemonLink.onEvent((event) => queueTracker.observe(event));

  // The server-run message queue (spec/04 § Message queueing). It only takes a
  // message for a host that reports it can take queued messages from the
  // server, so an older host keeps its own queue.
  const serverQueue: ServerQueue = new ServerQueue({
    chats: chatRegistry,
    sendTo: (daemonId, surfaceId, event) => daemonLink.sendTo(daemonId, surfaceId, event),
    isOnline: (daemonId) => daemonLink.isOnline(daemonId),
    hostSupports: (daemonId: string): boolean => wsHub.hostServerQueue(daemonId),
    inject: (event) => daemonLink.injectDaemonEvent(event),
    ...(jobChatLinksDataDir ? { dataDir: jobChatLinksDataDir } : {}),
    logger: log.child({ component: 'server-queue' }),
  });
  daemonLink.setEventGate?.((event, from) => serverQueue.gate(event, from));
  // Tell each host, as it attaches, that the server is running its queues.
  daemonLink.onHostStatus((daemonId, status) => {
    if (status === 'online') {
      daemonLink.sendTo(daemonId, '_server', { type: 'server.queue_mode', enabled: true });
    }
  });
  // A host asks at a tool boundary what is waiting.
  daemonLink.onEvent((event, from) => {
    if (event.type !== 'patch.queue_pull.request' || from === null) return;
    daemonLink.sendTo(from, '_server', {
      type: 'patch.queue_pull.response',
      requestId: event.requestId,
      items: serverQueue.pull(event.chatId),
    });
  });
  serverQueue.restore();
  const chatLogStore = new ChatLogStore({
    ...(jobChatLinksDataDir ? { dataDir: jobChatLinksDataDir } : {}),
    logger: log.child({ component: 'chat-log-store' }),
  });

  // How far the server's log of each chat reaches, sent back to the chat's host.
  const commitAcks = new CommitAcks({
    sendTo: (daemonId, surfaceId, event) => daemonLink.sendTo(daemonId, surfaceId, event),
    isOnline: (daemonId) => daemonLink.isOnline(daemonId),
  });
  app.addHook('onClose', async () => commitAcks.stop());

  // Keeps the server's log of each chat and its host's log in step.
  const logSync = new LogSync({
    store: chatLogStore,
    chats: chatRegistry,
    sendTo: (daemonId, surfaceId, event) => daemonLink.sendTo(daemonId, surfaceId, event),
    isOnline: (daemonId) => daemonLink.isOnline(daemonId),
    inject: (event) => daemonLink.injectDaemonEvent(event),
    logger: log.child({ component: 'log-sync' }),
    ...(opts.logSyncDelayMs !== undefined ? { delayMs: opts.logSyncDelayMs } : {}),
  });
  daemonLink.onEvent((event) => logSync.observe(event));
  app.addHook('onClose', async () => logSync.stop());

  // Manager failover (spec/06 § Manager failover).
  const managerFailover = new ManagerFailover({
    homeDaemonId: () => registry.homeDaemonId(),
    registeredDaemonIds: () => registry.registeredDaemonIds(),
    isOnline: (daemonId) => daemonLink.isOnline(daemonId),
    onHostStatus: (handler) => daemonLink.onHostStatus(handler),
    sendTo: (daemonId, surfaceId, event) => daemonLink.sendTo(daemonId, surfaceId, event),
    log: chatLogStore,
    contextWindow: () => DEFAULT_SHARED_SETTINGS.managerContextWindow,
    ...(jobChatLinksDataDir ? { dataDir: jobChatLinksDataDir } : {}),
    logger: log.child({ component: 'manager-failover' }),
    ...(opts.managerFailoverGraceMs !== undefined ? { graceMs: opts.managerFailoverGraceMs } : {}),
  });
  managerFailover.start();
  app.addHook('onClose', async () => managerFailover.stop());
  const specialThreadHost = (): string | null =>
    managerFailover.specialThreadHost() ?? registry.homeDaemonId();

  // Durable copy of message text so an offline host's chats stay searchable.
  const chatMirror = registry.dataDir
    ? new ChatMirror({
        dataDir: registry.dataDir,
        logger: log.child({ component: 'chat-mirror' }),
      })
    : undefined;
  if (chatMirror) daemonLink.onEvent((event) => chatMirror.observe(event));

  // The user's own messages (`patch_activity`, spec/06 § Cross-chat toolset),
  // read through every machine's chat logs.
  const activity = createActivityReader({ daemonLink, chatRegistry });
  app.addHook('onClose', async () => activity.close());

  // Server-owned composer drafts (spec/14 § Composer, spec/15 § Composer).
  // Same dataDir resolution as the jobs subsystem: absent one (a bare-registry
  // test), the store still works, in memory only, for the life of the process.
  const composerDrafts =
    opts.composerDrafts ??
    new ComposerDraftStore({
      ...(jobChatLinksDataDir ? { dataDir: jobChatLinksDataDir } : {}),
      logger: log.child({ component: 'composer-drafts' }),
      ...(opts.nowMs ? { nowMs: opts.nowMs } : {}),
    });

  const newChatDrafts =
    opts.newChatDrafts ??
    new NewChatDraftStore({
      ...(jobChatLinksDataDir ? { dataDir: jobChatLinksDataDir } : {}),
      logger: log.child({ component: 'new-chat-drafts' }),
      ...(opts.nowMs ? { nowMs: opts.nowMs } : {}),
    });

  // ---- shared settings (spec/01 § Settings) + the Manager sweep ----
  // Same dataDir resolution as the jobs subsystem: absent one (a test that
  // injects a bare registry with no disk), there is nowhere to persist
  // settings, so there is no store and the defaults stand.
  let broadcastSettings: (event: WireEvent) => void = () => undefined;
  const accountSettings = jobChatLinksDataDir
    ? new SharedSettingsService({
        dataDir: jobChatLinksDataDir,
        sendToDaemon: (daemonId, event) => daemonLink.sendTo(daemonId, SETTINGS_SURFACE, event),
        onlineDaemonIds: () => daemonLink.onlineDaemonIds(),
        broadcast: (event) => broadcastSettings(event),
        hostName: (daemonId) => registry.hostName(daemonId),
        ...(opts.validateClaudeToken ? { validateClaude: opts.validateClaudeToken } : {}),
        ...(opts.validateOpenAIKey ? { validateOpenAIKey: opts.validateOpenAIKey } : {}),
        logger: log.child({ component: 'shared-settings' }),
      })
    : undefined;
  if (accountSettings) {
    accountSettings.startCredentialRefresh();
    app.addHook('onClose', async () => accountSettings.close());
    daemonLink.onEvent((event: WireEvent) => accountSettings.handleDaemonEvent(event));
    daemonLink.onHostStatus((daemonId, status) => {
      if (status === 'online') accountSettings.hostOnline(daemonId);
      else accountSettings.hostOffline(daemonId);
    });
    // A host already attached before this subscription (an in-process link in
    // tests) is greeted too.
    for (const daemonId of daemonLink.onlineDaemonIds()) accountSettings.hostOnline(daemonId);
  }

  const sweepRuns = createSweepRunStore(opts.dataDir ?? registry.dataDir);
  const managerSweeper = new ManagerSweeper({
    chats: chatRegistry,
    settings: () => accountSettings?.current() ?? DEFAULT_SETTINGS,
    homeDaemonId: () => {
      const id = specialThreadHost();
      return id && daemonLink.onlineDaemonIds().includes(id) ? id : undefined;
    },
    runSweep: (req) => {
      const id = specialThreadHost();
      if (!id) return;
      daemonLink.sendTo(id, 'manager-sweep', { type: 'manager.sweep_run', ...req });
    },
    runs: sweepRuns,
    logger: log.child({ component: 'manager-sweep' }),
    idGenerator,
    ...(opts.nowMs ? { now: opts.nowMs } : {}),
  });
  // Observe AFTER the chat registry, so a sweep candidate built on this tick
  // reads the state the same event just wrote rather than the previous one.
  daemonLink.onEvent((event) => {
    managerSweeper.observe(event);
    if (event.type === 'manager.sweep_result') managerSweeper.onResult(event);
  });
  const managerSweepTimer = setInterval(() => managerSweeper.tick(), MANAGER_SWEEP_TICK_MS);
  managerSweepTimer.unref();
  registerManagerSweepRoutes(app, { registry, sweeper: managerSweeper, runs: sweepRuns });

  const threadRotator = new ThreadRotator({
    chats: chatRegistry,
    settings: () => accountSettings?.current() ?? DEFAULT_SETTINGS,
    rotate: (chatId) => daemonLink.send('thread-rotation', { type: 'chat.rotate_request', chatId }),
    logger: log.child({ component: 'thread-rotation' }),
  });
  const threadRotationTimer = setInterval(() => threadRotator.tick(), THREAD_ROTATION_TICK_MS);
  threadRotationTimer.unref();

  // spec/04 § Folders: mirror the host-owned folder list (published via
  // `folders.list` / `folders.updated`) so `GET /api/folders` can serve
  // cold-start surfaces. Live updates still fan out over the WS unchanged.
  const folderRegistry = new FolderRegistry();
  daemonLink.onEvent((event) => folderRegistry.observe(event));
  // Server-side mirror of the host-owned secret store (spec/15 § Secrets).
  const secretsRegistry = new SecretsRegistry();
  daemonLink.onEvent((event) => secretsRegistry.observe(event));

  // ---- group 11: notification + call infrastructure ----
  // Push backend: prefer injected (tests). Production always builds an
  // ExpoPushBackend — nothing to configure, nothing that can be missing, so a
  // server with no push set up (there is no such thing any more) still starts.
  const pushBackend: PushBackend = opts.pushBackend ?? new ExpoPushBackend();

  // DEV/TEST seam: record speakers-channel notifies so D1-6 (Speakers reply
  // auto-routes TTS to the originating device) is assertable even when no real
  // voice-device surface is connected. HARD-GATED off in production.
  const speakersMockEnabled =
    process.env.NODE_ENV !== 'production' && process.env['PATCH_SPEAKERS_MOCK'] === '1';
  let speakersRecorder: InMemorySpeakersRecorder | undefined;
  if (speakersMockEnabled) {
    speakersRecorder = new InMemorySpeakersRecorder();
    log.warn({}, 'PATCH_SPEAKERS_MOCK=1 — recording speakers TTS notifies (DEV/TEST ONLY)');
  }

  const notificationsDataDir = registry.dataDir;
  const notificationRouter = new NotificationRouter({
    logger: log.child({ component: 'notification-router' }),
    registry,
    presence,
    wsHub: undefined as unknown as WsHub, // backfilled below
    dataDir: notificationsDataDir,
    pushBackend,
    ...(speakersRecorder ? { speakersRecorder } : {}),
    ...(opts.nowMs ? { nowMs: opts.nowMs } : {}),
  });

  // spec/09 § bell — what agents sent, with read state. `wsHub` is backfilled
  // below, so the change broadcast reads it lazily.
  let broadcastNotifications: (unread: number) => void = () => undefined;
  const notificationLog = new NotificationLog({
    ...(notificationsDataDir ? { dataDir: notificationsDataDir } : {}),
    logger: log.child({ component: 'notification-log' }),
    ...(opts.nowMs ? { nowMs: opts.nowMs } : {}),
    onChange: (snap) => broadcastNotifications(snap.unread),
  });

  // spec/14 § Batch mode — one account-wide batch, persisted at
  // `<dataDir>/batch.json`. Built here (after the chat registry + notification
  // router, before the chat-completion notifier below, which reads its
  // suppression gate) rather than down with the jobs subsystem: unlike jobs it
  // needs no deployment credential gate, and the completion notifier needs it
  // now, not backfilled.
  const batchDataDir = opts.dataDir ?? registry.dataDir;
  const batchStore = new BatchStore({
    ...(batchDataDir ? { dataDir: batchDataDir } : {}),
    logger: log.child({ component: 'batch-store' }),
    ...(opts.nowMs ? { nowMs: opts.nowMs } : {}),
  });
  const batchNotifier = new BatchNotifier({
    store: batchStore,
    chats: chatRegistry,
    router: notificationRouter,
    logger: log.child({ component: 'batch-notifier' }),
    ...(opts.nowMs ? { now: opts.nowMs } : {}),
  });
  daemonLink.onEvent((event) => batchNotifier.observe(event));
  batchNotifier.start();

  const replyRouter = new ReplyRouter({
    logger: log.child({ component: 'reply-router' }),
    registry,
    router: notificationRouter,
  });

  const callOrchestrator = new CallOrchestrator({
    logger: log.child({ component: 'call-orchestrator' }),
    wsHub: undefined as unknown as WsHub, // backfilled below
    router: notificationRouter,
    ...(opts.callTimeoutMs !== undefined ? { timeoutMs: opts.callTimeoutMs } : {}),
    ...(opts.nowMs ? { nowMs: opts.nowMs } : {}),
    idGenerator,
    reach: () => (accountSettings?.current() ?? DEFAULT_SETTINGS).reach,
  });

  // Content hash of the served web bundle, filled in once the SPA is mounted
  // below. Sent on auth.ok so surfaces live-reload after a deploy (spec/14 §
  // Live updates). A holder because the SPA is read after WsHub is built.
  let appBundleVersion: string | undefined;
  // Where the mounted SPA lives, filled at mount time. `GET /api/version` re-reads
  // this dir on every request rather than caching at boot: a web deploy rsyncs
  // into the mounted dir, so a cached-at-boot answer would keep reporting the
  // PREVIOUS bundle — precisely the class of stale reporting this endpoint exists
  // to eliminate.
  let webRootPath: string | null = null;
  // When this process came up. Compared against the SPA's deployedAt to expose a
  // server that was redeployed while the UI was left behind.
  const serverStartedAt = new Date().toISOString();
  // Where the published host artifacts, their manifest and the APKs live —
  // served below, and read by the hub to bring connecting hosts in step.
  const downloadsDir = process.env.PATCH_DOWNLOADS_DIR ?? '/app/downloads';
  const wsHub = new WsHub({
    logger: log.child({ component: 'ws-hub' }),
    ...(accountSettings ? { sharedSettings: () => accountSettings.changedEvent() } : {}),
    registry,
    presence,
    daemonLink,
    chatRegistry,
    queueTracker,
    serverQueue,
    chatLogStore,
    commitAcks,
    managerFailover,
    composerDrafts,
    newChatDrafts,
    idGenerator,
    getAppVersion: () => appBundleVersion,
    serverVersion: VERSION,
    // Read per connect, not cached: a deploy publishes the host and restarts
    // this server in one run, but a hand-published host must count too. A
    // missing or unreadable manifest is null — "nothing published", which the
    // hub reports as an error for a host that is behind.
    publishedDaemon: () => {
      try {
        const manifest = JSON.parse(
          readFileSync(join(downloadsDir, 'daemon-latest.json'), 'utf8'),
        ) as { version?: unknown; artifacts?: { target?: unknown }[] };
        if (typeof manifest.version !== 'string') return null;
        const targets = (manifest.artifacts ?? [])
          .map((a) => a.target)
          .filter((t): t is string => typeof t === 'string');
        return { version: manifest.version, targets };
      } catch {
        return null;
      }
    },
    // Only an InboundDaemonLink can accept a live host socket. When tests
    // inject the InProcessDaemonLink there is no socket to attach, so host
    // hellos are rejected by the gate (no attachDaemon wired).
    ...(daemonLink instanceof InboundDaemonLink
      ? { attachDaemon: (socket, daemonId) => daemonLink.attach(socket, daemonId) }
      : {}),
    ...(opts.helloTimeoutMs !== undefined ? { helloTimeoutMs: opts.helloTimeoutMs } : {}),
    onCallResponse: (surfaceId, event) => callOrchestrator.handleResponse(surfaceId, event),
  });
  broadcastSettings = (event) => void wsHub.sendToAll(event);
  broadcastNotifications = (unread) =>
    void wsHub.sendToAll({ type: 'notifications.changed', unread });
  // Catch the host build being published after this server started — see
  // WsHub.recheckDaemonVersions. Cheap: one small file read per tick.
  const daemonRecheck = setInterval(() => wsHub.recheckDaemonVersions(), 30_000);
  daemonRecheck.unref();
  app.addHook('onClose', async () => {
    clearInterval(daemonRecheck);
  });

  // spec/03 § Cross-chat tools: relay an agent's `patch.spawn` to the machine
  // it names, answer `patch.list_chats.request` from the account-wide chat
  // mirror and `patch.activity.request` by reading every machine's chat logs
  // (only the server sees every machine's chats).
  registerCrossHostBridge({
    logger: log.child({ component: 'cross-host' }),
    daemonLink,
    chatRegistry,
    registry,
    activity,
  });

  // spec/02 § Browser — Route through: relay a browsing host's SOCKS stream
  // to the routing host it names, and every later frame of that stream back
  // and forth, for as long as it stays open.
  registerBrowserTunnelBridge({
    logger: log.child({ component: 'browser-tunnel' }),
    daemonLink,
    registry,
  });

  // Backfill the wsHub references on the router + orchestrator (cycle).
  (notificationRouter as unknown as { deps: { wsHub: WsHub } }).deps.wsHub = wsHub;
  (callOrchestrator as unknown as { deps: { wsHub: WsHub } }).deps.wsHub = wsHub;

  // spec/09 § Chat completion. Subscribed after the chat registry (line ~317),
  // so the mirror it reads the chat's name and status summary from has already
  // applied the very `chat.state` being handled.
  // Backfilled below for the same reason the wsHub references above are: the
  // jobs store is built much later in this function, while this notifier must
  // subscribe to the host link HERE, after the chat registry. Read through a
  // holder rather than captured, so the notifier always consults the live store.
  let jobsForCompletionGate: JobsInterface | undefined;
  const chatCompletionNotifier = new ChatCompletionNotifier({
    chats: chatRegistry,
    router: notificationRouter,
    logger: log.child({ component: 'chat-complete' }),
    ...(opts.nowMs ? { now: opts.nowMs } : {}),
    // spec/08 § Action — a job's `notifyOnComplete: false` silences the
    // doorbell for the chats that job creates. Both halves are server-only
    // state: the chatId → jobId link the dispatcher records, and the stored
    // job. `jobChatLinks` is the same persisted map the sidebar's Automations
    // group reads, so a chat spawned before the last restart is still linked.
    jobs: {
      jobIdForChat: (chatId: string): string | null => jobChatLinks?.get(chatId) ?? null,
      job: (jobId: string): Job | null => jobsForCompletionGate?.get(jobId) ?? null,
    },
    // spec/09 § Chat completion — a running batch's member is silent (spec/14
    // § Batch mode); the batch's own check-in notification stands in.
    batch: {
      isSuppressedMember: (chatId: string): boolean => batchStore.isSuppressedMember(chatId),
    },
  });
  daemonLink.onEvent((event) => chatCompletionNotifier.observe(event));

  // spec/09 § Waiting on you. The other half of the same doorbell: a turn that
  // stops on a permission decision or a question never reaches `idle`, so the
  // completion notifier above never sees it. Same subscription point, same
  // reason — the chat mirror is already up to date when this runs.
  const awaitingPermissionNotifier = new AwaitingPermissionNotifier({
    chats: chatRegistry,
    router: notificationRouter,
    logger: log.child({ component: 'awaiting-permission' }),
    ...(opts.nowMs ? { now: opts.nowMs } : {}),
  });
  daemonLink.onEvent((event) => awaitingPermissionNotifier.observe(event));

  // Wire the daemon-link → notification + reply routing.
  daemonLink.onEvent((event) => {
    if (event.type === 'notify') {
      // Agent-sent only: a call ring is not a message (spec/09 § bell).
      if (event.kind !== 'call') {
        notificationLog.add({
          chatId: event.chatId,
          message: event.message,
          importance: event.priority ?? 'normal',
          ...(event.deepLink ? { deepLink: event.deepLink } : {}),
        });
      }
      void notificationRouter.route(event).catch((err: unknown) => {
        log.warn({ err: (err as Error).message }, 'notify route failed');
      });
      return;
    }
    if (event.type === 'patch.call') {
      void callOrchestrator.startCall(event).catch((err: unknown) => {
        log.warn({ err: (err as Error).message }, 'patch.call start failed');
      });
      return;
    }
    void replyRouter.observeOutbound(event).catch(() => undefined);
  });

  // Tap surface→host `chat.input` to capture source metadata for replies.
  // We piggy-back on the daemonLink.send path by wrapping it.
  const originalSend = daemonLink.send.bind(daemonLink);
  daemonLink.send = (surfaceId: string, event: unknown): void => {
    if ((event as { type?: string }).type === 'chat.input') {
      replyRouter.observeInput(event as ChatInputEvent);
    }
    originalSend(surfaceId, event as never);
  };

  // Tear everything down on Fastify close so port-0 tests don't leak handles.
  app.addHook('onClose', async () => {
    wsHub.shutdown();
    await daemonLink.close();
  });

  // ---- core endpoints ----

  app.get(
    '/api/healthz',
    {
      // Group 10 polish (DX m3): silence the per-request info log on
      // healthchecks — at 1Hz they overwhelm structured-log search.
      logLevel: 'warn',
    },
    async (): Promise<HealthzResponse> => {
      return { ok: true, version: VERSION, gitSha: GIT_SHA };
    },
  );

  // Public Android APK download. The phone can't be paired until the app is
  // installed, so this MUST be unauthenticated (like /api/healthz). The APK is
  // published to a mounted downloads dir by the APK build + delivery step; the
  // phone just opens https://<host>/api/download/patch.apk in its browser and
  // installs. NO FALLBACK: 404 (not an empty 200) when nothing is published.
  // Versioned filename in the path (patch-<sha>.apk) so each build is a NEW URL
  // AND a new download filename — otherwise the phone's browser sees the same
  // `patch.apk` and refuses to re-download / install over the cached file.
  // `patch.apk` (unversioned) is still accepted for the latest. Whitelisted to
  // `patch*.apk` so `:name` can't traverse out of the downloads dir.
  //
  // `android-latest.json` (the APK sidecar, {version,gitSha,builtAt,file}) is
  // also served here — unauthenticated, symmetric with how the desktop feed
  // exposes `desktop-latest.json`. Two reasons: (1) `/api/version` already builds
  // an `/api/download/android-latest.json` link for the published APK, which used
  // to 404 because this route only allowed `patch*.apk`; (2) it gives the delivery
  // step a PUBLIC way to read back what APK the box is actually publishing and
  // assert it equals HEAD — the phone equivalent of the web/desktop drift check,
  // which is the gap that let a stale APK look current.
  app.get<{ Params: { name: string } }>(
    '/api/download/:name',
    { logLevel: 'warn' },
    async (req, reply) => {
      const name = req.params.name;
      const isApk = /^patch[A-Za-z0-9._-]*\.apk$/.test(name);
      const isSidecar = name === 'android-latest.json';
      if (!isApk && !isSidecar) {
        return reply.code(404).send({ error: 'not found' });
      }
      const artifact = join(downloadsDir, name);
      if (!existsSync(artifact)) {
        return reply
          .code(404)
          .send({ error: isApk ? 'no such APK published' : 'no APK published' });
      }
      const reply200 = reply.code(200).header('content-length', String(statSync(artifact).size));
      if (isSidecar) {
        return reply200.header('content-type', 'application/json').send(createReadStream(artifact));
      }
      return reply200
        .header('content-type', 'application/vnd.android.package-archive')
        .header('content-disposition', `attachment; filename="${name}"`)
        .send(createReadStream(artifact));
    },
  );

  // Public desktop-shell update feed (spec/11 § Version reporting). This is what
  // electron-updater's `generic` provider polls: it fetches `latest-mac.yml`,
  // compares its `version` against the running app's, and if newer pulls the
  // matching `.zip` (using the `.blockmap` for a delta). It MUST be
  // unauthenticated — the updater runs in the Electron main process, before and
  // independently of any surface credential.
  //
  // Whitelisted to the exact artifact shapes electron-builder emits, so `:name`
  // can't traverse out of the downloads dir. NO FALLBACK: 404 when nothing is
  // published, so a misconfigured feed fails visibly instead of looking "current".
  app.get<{ Params: { name: string } }>(
    '/api/desktop/:name',
    { logLevel: 'warn' },
    async (req, reply) => {
      const name = req.params.name;
      const allowed =
        name === 'latest-mac.yml' ||
        name === 'desktop-latest.json' ||
        /^Patch-[A-Za-z0-9._-]+\.(zip|dmg)(\.blockmap)?$/.test(name);
      if (!allowed) {
        return reply.code(404).send({ error: 'not found' });
      }
      const artifact = join(downloadsDir, name);
      if (!existsSync(artifact)) {
        return reply.code(404).send({ error: 'no such desktop artifact published' });
      }
      const contentType = name.endsWith('.yml')
        ? 'text/yaml'
        : name.endsWith('.json')
          ? 'application/json'
          : 'application/octet-stream';
      return reply
        .code(200)
        .header('content-type', contentType)
        .header('content-length', String(statSync(artifact).size))
        .send(createReadStream(artifact));
    },
  );

  // Public host install + artifact channel (spec/11 § Deploy guide: "The
  // host artifacts are published to the server, which serves them with a
  // version manifest: that one channel feeds both a new host's install command
  // and every existing host's self-update").
  //
  // Unauthenticated on purpose: install route 1 is a shell command pasted into
  // a machine that has nothing on it — no credential, no patch install, often
  // no account of its own yet. The pairing code is what gates joining the
  // account, and that is redeemed later, against an authenticated route.
  //
  // `install.sh` is served with the server's own public URL substituted in, so
  // the pasted one-liner needs no arguments. Everything else is whitelisted to
  // the exact shapes `pnpm build:daemon` emits, so `:name` cannot traverse out
  // of the downloads dir.
  app.get<{ Params: { name: string } }>(
    '/api/daemon/:name',
    { logLevel: 'warn' },
    async (req, reply) => {
      const name = req.params.name;
      const isScript = name === 'install.sh';
      const isManifest = name === 'daemon-latest.json';
      const isArtifact = /^patch-daemon-[A-Za-z0-9._-]+\.tar\.gz(\.sig)?$/.test(name);
      if (!isScript && !isManifest && !isArtifact) {
        return reply.code(404).send({ error: 'not found' });
      }
      const artifact = join(downloadsDir, name);
      if (!existsSync(artifact)) {
        return reply.code(404).send({ error: 'no such host artifact published' });
      }
      if (isScript) {
        // NO FALLBACK: without a public URL the pasted one-liner would fetch
        // from a placeholder, so the script keeps the placeholder and refuses
        // itself rather than the server inventing an address.
        const publicUrl = process.env['PATCH_PUBLIC_URL'] ?? process.env['PATCH_SERVER_URL'] ?? '';
        const script = readFileSync(artifact, 'utf8').replace(
          /@@PATCH_SERVER_URL@@/g,
          publicUrl.replace(/\/+$/, ''),
        );
        return reply
          .code(200)
          .header('content-type', 'text/x-shellscript; charset=utf-8')
          .send(script);
      }
      return reply
        .code(200)
        .header('content-type', isManifest ? 'application/json' : 'application/gzip')
        .header('content-length', String(statSync(artifact).size))
        .send(createReadStream(artifact));
    },
  );

  // Public server install channel (spec/11 § Server installation): what
  // `curl <url>/install.sh | sudo sh` fetches — the installer, the release tarball
  // under a stable name, and its checksum. Unauthenticated: the box running it has
  // nothing yet. `pnpm run deploy` publishes them into downloads/server-release/.
  // Whitelisted to those three names so `:name` cannot leave the directory.
  app.get<{ Params: { name: string } }>(
    '/api/server-release/:name',
    { logLevel: 'warn' },
    async (req, reply) => {
      const name = req.params.name;
      const types: Record<string, string> = {
        'install.sh': 'text/x-shellscript; charset=utf-8',
        'patch-server.tar.gz': 'application/gzip',
        'patch-server.tar.gz.sha256': 'text/plain; charset=utf-8',
      };
      const contentType = Object.hasOwn(types, name) ? types[name] : undefined;
      if (!contentType) return reply.code(404).send({ error: 'not found' });
      const artifact = join(downloadsDir, 'server-release', name);
      if (!existsSync(artifact)) {
        return reply.code(404).send({ error: 'no such server release published' });
      }
      return reply
        .code(200)
        .header('content-type', contentType)
        .header('content-length', String(statSync(artifact).size))
        .send(createReadStream(artifact));
    },
  );

  // Host liveness — after the host↔server link inversion (spec/10) the
  // host connects INTO the server's /ws; the server can no longer dial it.
  // Liveness is therefore read directly from the host WS connection state.
  //
  // Authed (E1-d5): unlike `GET /api/healthz` (public server liveness for the
  // load balancer's own probe), the daemon-link status is account-internal
  // operational state. We require the same surface Bearer JWT as the sibling
  // `/api/jobs` / `/api/auth/me` routes — no unauthenticated daemon-status
  // leak. NO FALLBACK: missing/invalid/revoked → 401.
  app.get(
    '/api/daemon/healthz',
    {
      // Same as /api/healthz: don't spam structured logs at probe frequency.
      logLevel: 'warn',
    },
    async (req, reply) => {
      const account = registry.getAccount();
      if (!account) {
        return reply.code(401).send({ error: 'unauthenticated' });
      }
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'unauthenticated' });
      }
      const jwt = authHeader.slice('Bearer '.length).trim();
      try {
        const claims = await verifySurfaceCredential(jwt, {
          userPublicKey: account.userPublicKey,
        });
        if (registry.isRevoked(claims.surface_id)) {
          return reply.code(401).send({ error: 'unauthenticated' });
        }
      } catch {
        return reply.code(401).send({ error: 'unauthenticated' });
      }
      if (daemonLink.status() === 'online') {
        return reply.code(200).send({ ok: true });
      }
      return reply.code(503).send({ ok: false, reason: 'host offline' });
    },
  );

  // The one-line install command for a target OS (spec/11 § Host
  // installation). The SERVER is its single source: a surface renders what it
  // is given and never composes the command from its own idea of the server's
  // address or of how a build is named — otherwise the command a phone shows
  // and the command the desktop shows drift apart, and both can be wrong.
  app.get<{ Querystring: { os?: string } }>('/api/daemon/install-command', async (req, reply) => {
    const account = registry.getAccount();
    if (!account) return reply.code(401).send({ error: 'unauthenticated' });
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    try {
      const claims = await verifySurfaceCredential(authHeader.slice('Bearer '.length).trim(), {
        userPublicKey: account.userPublicKey,
      });
      if (registry.isRevoked(claims.surface_id)) {
        return reply.code(401).send({ error: 'unauthenticated' });
      }
    } catch {
      return reply.code(401).send({ error: 'unauthenticated' });
    }

    const os = req.query.os;
    if (os !== 'macos' && os !== 'linux') {
      return reply.code(400).send({
        error: 'unknown_os',
        message: `os must be "macos" or "linux" (got: ${os ?? 'none'})`,
      });
    }
    // Read the manifest the artifacts are actually served from — the same one
    // feeding a self-update — so the command can never name a build that isn't
    // published.
    const manifestPath = join(downloadsDir, 'daemon-latest.json');
    if (!existsSync(manifestPath)) {
      return reply.code(409).send({
        error: 'nothing_published',
        message: 'no host build has been published yet, so there is no install command to give',
      });
    }
    let manifest: { version: string; artifacts: { target: string }[] };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest;
    } catch {
      return reply.code(409).send({
        error: 'manifest_unreadable',
        message: 'the published manifest could not be read',
      });
    }
    const wanted = os === 'macos' ? 'darwin-' : 'linux-';
    const targets = (manifest.artifacts ?? []).filter((a) => a.target.startsWith(wanted));
    if (targets.length === 0) {
      return reply.code(409).send({
        error: 'no_build_for_os',
        message: `the published build ${manifest.version} has no artifact for ${os}`,
      });
    }
    const publicUrl = (
      process.env['PATCH_PUBLIC_URL'] ??
      process.env['PATCH_SERVER_URL'] ??
      ''
    ).replace(/\/+$/, '');
    if (publicUrl.length === 0) {
      // NO FALLBACK: a command pointing at a placeholder would fail on the
      // machine being added, with nothing to say why.
      return reply.code(409).send({
        error: 'no_public_url',
        message:
          'this server has no public URL configured, so it cannot state where a new machine should fetch from',
      });
    }
    return {
      os,
      version: manifest.version,
      targets: targets.map((t) => t.target),
      command: `curl -fsSL ${publicUrl}/api/daemon/install.sh | sh`,
    };
  });

  // The host registry (spec/01 § Endpoints): every registered machine with its
  // presence and what the server knows about it — the SAME roster the `auth.ok`
  // greeting carries, so REST and the wire can never disagree about which
  // machines exist.
  //
  // Authed by a daemonKey AS WELL AS a surface credential, because a host
  // reads this to answer `patch_list_hosts` for its own chats (spec/06
  // § Cross-chat toolset) and has no surface credential to present.
  // Accepts EITHER a surface credential (a surface reading for itself) OR a
  // daemonKey (a host reading on behalf of a tool call that has no surface
  // credential to present — `patch_list_hosts`/`patch_activity`).
  const authSurfaceOrDaemon = async (authHeader: string | undefined): Promise<boolean> => {
    const account = registry.getAccount();
    if (!account) return false;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
    const credential = authHeader.slice('Bearer '.length).trim();
    try {
      const claims = await verifySurfaceCredential(credential, {
        userPublicKey: account.userPublicKey,
      });
      return !registry.isRevoked(claims.surface_id);
    } catch {
      // Not a surface credential — try the host's own key before refusing.
      try {
        const claims = await verifyDaemonKey(credential, {
          userPublicKey: account.userPublicKey,
        });
        // A revoked machine's key must not read either.
        return registry.registeredDaemonIds().includes(claims.daemon_id);
      } catch {
        return false;
      }
    }
  };

  app.get('/api/hosts', async (req, reply) => {
    if (!(await authSurfaceOrDaemon(req.headers.authorization))) {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    return {
      hosts: wsHub.hosts().map((h) => ({
        daemonId: h.daemonId,
        // A machine that has never spoken has no self-description; report what
        // is known and do not invent a name for it.
        hostName: h.host?.hostName ?? null,
        online: h.online,
        isHomeHost: h.host?.isHomeHost ?? false,
        ...(h.host?.defaultModel !== undefined ? { defaultModel: h.host.defaultModel } : {}),
      })),
    };
  });

  // The user's own messages (`patch_activity`, spec/06 § Cross-chat toolset) —
  // the REST counterpart surfaces and the CLI call directly; a host asks the
  // same way for the ACCOUNT-WIDE case (no chat-specific routing, so no
  // cross-host relay needed). Dual-authed like `/api/hosts` above.
  app.get('/api/activity', async (req, reply) => {
    if (!(await authSurfaceOrDaemon(req.headers.authorization))) {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    const q = req.query as Record<string, string | undefined>;
    const now = Date.now();
    const until = q.until !== undefined ? Number(q.until) : now;
    const since = q.since !== undefined ? Number(q.since) : until - 24 * 60 * 60 * 1000;
    const messagesCursor = q.messagesCursor !== undefined ? Number(q.messagesCursor) : undefined;
    const limit = q.limit !== undefined ? Number(q.limit) : undefined;
    if (
      !Number.isFinite(since) ||
      !Number.isFinite(until) ||
      (messagesCursor !== undefined && !Number.isFinite(messagesCursor)) ||
      (limit !== undefined && !Number.isFinite(limit))
    ) {
      return reply.code(400).send({
        error: 'invalid_input',
        message: 'since/until/messagesCursor/limit must be numbers',
      });
    }
    try {
      return await activity.query({
        since,
        until,
        ...(messagesCursor !== undefined ? { messagesCursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    } catch (err) {
      return reply.code(502).send({
        error: 'activity_unavailable',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Remove a machine from the account (Settings → Hosts → "Remove this host").
  //
  //   DELETE /api/hosts/:daemonId   → 200 {ok, hosts}   | 404 unknown_host
  //
  // Surface-authenticated like the other host routes. In order: the registry
  // revokes the machine's credential (so its next hello is answered
  // `auth.revoked` and it wipes its key), its live link is closed and its
  // buffered frames dropped, the hub forgets every cached report about it and
  // tells every surface `host.removed {daemonId}`. If it was the home machine,
  // home passes to the next registered one and every machine and surface is
  // told, exactly as a `set-home` would. Chats that ran on it are left as they
  // are: their history is the account's, not the machine's.
  app.delete<{ Params: { daemonId: string } }>('/api/hosts/:daemonId', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const { daemonId } = req.params;
    if (!registry.isRegisteredDaemon(daemonId)) {
      return reply.code(404).send({
        error: 'unknown_host',
        message: `no machine registered with daemonId: ${daemonId}`,
        daemonId,
        knownHosts: registry.registeredDaemonIds(),
      });
    }
    const homeBefore = registry.homeDaemonId();
    registry.removeDaemon(daemonId);
    const linkClosed = daemonLink.forget(daemonId);
    const told = wsHub.removeHost(daemonId);
    const homeAfter = registry.homeDaemonId();
    if (homeBefore === daemonId && homeAfter !== null) {
      for (const id of registry.registeredDaemonIds()) {
        daemonLink.sendTo(id, 'server', { type: 'host.set_home', daemonId: homeAfter });
      }
      wsHub.sendToAll({ type: 'host.set_home', daemonId: homeAfter });
      wsHub.republishAllHosts();
    }
    log.info(
      { daemonId, removedBy: auth.surfaceId, linkClosed, surfacesTold: told, homeAfter },
      'host removed from the account',
    );
    return { ok: true, hosts: wsHub.hosts() };
  });

  // Renaming a machine and marking one the account home are SERVER-owned, even
  // when the CLI naming them runs on that very machine (spec/17 § Hosts and the
  // CLI). The registry holds both, so they must be written here and pushed to
  // every surface — a daemon-local write would leave other surfaces stale.
  for (const [route, kind] of [
    ['/api/hosts/rename', 'rename'] as const,
    ['/api/hosts/set-home', 'set-home'] as const,
  ]) {
    app.post<{ Body: { daemonId?: string; hostName?: string } }>(route, async (req, reply) => {
      const account = registry.getAccount();
      if (!account) return reply.code(401).send({ error: 'unauthenticated' });
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return reply.code(401).send({ error: 'unauthenticated' });
      }
      try {
        const claims = await verifySurfaceCredential(authHeader.slice('Bearer '.length).trim(), {
          userPublicKey: account.userPublicKey,
        });
        if (registry.isRevoked(claims.surface_id)) {
          return reply.code(401).send({ error: 'unauthenticated' });
        }
      } catch {
        return reply.code(401).send({ error: 'unauthenticated' });
      }

      const daemonId = req.body?.daemonId;
      if (typeof daemonId !== 'string' || daemonId.length === 0) {
        return reply
          .code(400)
          .send({ error: 'daemonId_required', message: 'name the machine this applies to' });
      }
      if (!registry.registeredDaemonIds().includes(daemonId)) {
        // Named, not swallowed — acting on an unregistered machine is the
        // failure the host-addressing gate exists to prevent.
        return reply.code(404).send({
          error: 'unknown_host',
          message: `no machine registered with daemonId: ${daemonId}`,
          daemonId,
          knownHosts: registry.registeredDaemonIds(),
        });
      }

      if (kind === 'rename') {
        const hostName = req.body?.hostName;
        if (typeof hostName !== 'string' || hostName.trim().length === 0) {
          // A machine must always have a name; an empty rename is refused.
          return reply
            .code(400)
            .send({ error: 'invalid_name', message: 'a machine name cannot be empty' });
        }
        registry.setHostName(daemonId, hostName.trim());
        // The machine keeps its own self-description in step (and persists the
        // rename so a restart does not revert it); every surface is told too.
        daemonLink.sendTo(daemonId, 'server', {
          type: 'host.rename',
          daemonId,
          hostName: hostName.trim(),
        });
        wsHub.sendToAll({ type: 'host.rename', daemonId, hostName: hostName.trim() });
      } else {
        registry.setHomeDaemonId(daemonId);
        // Broadcast to EVERY machine: the named one becomes home and the rest
        // lose it, so exactly one machine reports the flag.
        for (const id of registry.registeredDaemonIds()) {
          daemonLink.sendTo(id, 'server', { type: 'host.set_home', daemonId });
        }
        wsHub.sendToAll({ type: 'host.set_home', daemonId });
      }
      return { ok: true, hosts: wsHub.hosts() };
    });
  }

  // Authed: what every layer of Patch is running, and where they disagree
  // (spec/11 § Version reporting). Backs the desktop/web "Version & updates"
  // panel. Authed rather than public because it enumerates the account's linked
  // devices and the builds they're on — `/api/healthz` stays the public probe.
  //
  // Deliberately re-reads the mounted web-dist and the downloads dir on EVERY
  // request, so the panel's "Check now" reflects the box as it is right now.
  app.get('/api/version', async (req, reply) => {
    const account = registry.getAccount();
    if (!account) return reply.code(401).send({ error: 'unauthenticated' });
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'unauthenticated' });
    }
    try {
      const claims = await verifySurfaceCredential(authHeader.slice('Bearer '.length).trim(), {
        userPublicKey: account.userPublicKey,
      });
      if (registry.isRevoked(claims.surface_id)) {
        return reply.code(401).send({ error: 'unauthenticated' });
      }
    } catch {
      return reply.code(401).send({ error: 'unauthenticated' });
    }

    const daemonBuild = wsHub.getDaemonBuild();
    const report = buildVersionReport({
      now: new Date(),
      server: {
        version: VERSION,
        gitSha: GIT_SHA,
        // The server image is stamped at build time by the Docker build; when it
        // isn't (dev), report null rather than inventing an instant.
        builtAt: process.env['PATCH_BUILT_AT'] ?? null,
        startedAt: serverStartedAt,
        serverSha: SERVER_SHA,
      },
      web: webRootPath ? readWebLayer(webRootPath) : null,
      daemon: daemonBuild
        ? {
            version: daemonBuild.version,
            gitSha: daemonBuild.gitSha ?? null,
            builtAt: daemonBuild.builtAt ?? null,
            online: daemonLink.status() === 'online',
          }
        : null,
      // Per machine, from each one's own `daemon.host` report — so drift
      // BETWEEN machines is visible instead of collapsing into one number.
      hosts: wsHub.hosts().map((h) => ({
        daemonId: h.daemonId,
        hostName: h.host?.hostName ?? null,
        online: h.online,
        version: h.host?.daemonVersion ?? null,
        gitSha: h.host?.gitSha ?? null,
        builtAt: h.host?.builtAt ?? null,
      })),
      desktop: readPublishedArtifact(
        downloadsDir,
        'desktop-latest.json',
        (file) => `/api/desktop/${file}`,
      ),
      android: readPublishedArtifact(
        downloadsDir,
        'android-latest.json',
        (file) => `/api/download/${file}`,
      ),
      clients: presence.snapshot().map((p) => ({
        surfaceId: p.surfaceId,
        surfaceKind: p.surfaceKind,
        online: p.online,
        lastSeenAt: new Date(p.lastHeartbeat).toISOString(),
        version: p.build?.version ?? 'unknown',
        gitSha: p.build?.gitSha ?? null,
        builtAt: p.build?.builtAt ?? null,
      })),
    });
    return reply.code(200).send(report);
  });

  // ---- WebSocket hub ----
  wsHub.register(app);

  // ---- cross-host audio relay (spec/07 § Voice is a per-host capability) ----
  // `/audio/:sessionId` used to be reverse-proxied straight past the server to
  // the co-located host's own port — fine for a single host, but a chat on
  // any OTHER registered host was unreachable through it (its host only
  // dials out; it is never the target of an inbound connection). Every
  // session now routes through here, resolved by whichever host the token
  // mint recorded it for.
  const audioSessionRouter = new AudioSessionRouter();
  app.addHook('onClose', async () => {
    audioSessionRouter.clear();
  });
  registerAudioRelayRoute(app, {
    logger: log.child({ component: 'audio-relay' }),
    router: audioSessionRouter,
    daemonLink,
    audioRelayHostFor: (daemonId) => wsHub.audioRelayHost(daemonId),
  });

  // ---- chat REST routes ----
  registerChatRoutes(app, {
    logger: log.child({ component: 'chat-routes' }),
    registry,
    daemonLink,
    chatRegistry,
    composerDrafts,
    chatLogStore,
    idGenerator,
    // The account's default model, applied to any spawn that names none. Read
    // per request so a change in Settings reaches the next spawn.
    ...(accountSettings
      ? {
          defaultModel: (): string =>
            accountSettings.current().defaultModel ?? DEFAULT_SETTINGS.defaultModel,
        }
      : {}),
    ...(opts.spawnErrorWaitMs !== undefined ? { spawnErrorWaitMs: opts.spawnErrorWaitMs } : {}),
  });

  // ---- batch REST routes (spec/14 § Batch mode) ----
  registerBatchRoutes(app, { registry, store: batchStore, notifier: batchNotifier });

  // ---- folder registry REST route (spec/04 § Folders) ----
  registerFolderRoutes(app, {
    logger: log.child({ component: 'folder-routes' }),
    registry,
    folderRegistry,
    daemonLink,
    idGenerator,
  });

  // ---- chat search REST (spec/03 § Chat search) ----
  registerChatSearchRoutes(app, {
    logger: log.child({ component: 'chat-search-routes' }),
    registry,
    daemonLink,
    chatRegistry,
    ...(chatMirror ? { mirror: chatMirror } : {}),
    idGenerator,
  });

  // ---- host files REST (spec/03 § Host files) ----
  registerHostFilesRoutes(app, {
    logger: log.child({ component: 'host-files-routes' }),
    registry,
    daemonLink,
    idGenerator,
  });

  // ---- one blob's bytes (spec/04 § History — blobs) ----
  // The other half of replay sending references instead of tool-output
  // bodies: where a body comes from once a reader opens that row.
  registerBlobRoutes(app, {
    logger: log.child({ component: 'blob-routes' }),
    chatRegistry,
    daemonLink,
    chatLogStore,
    idGenerator,
  });

  // ---- moving a chat between hosts (spec/04 § Moving a chat to another host) ----
  registerChatMoveRoutes(app, {
    logger: log.child({ component: 'chat-move-routes' }),
    registry,
    daemonLink,
    chatRegistry,
    idGenerator,
  });

  // ---- provider keys REST, shared across every host (spec/02 § Provider keys) ----
  if (accountSettings) registerSettingsRoutes(app, { registry, shared: accountSettings });

  // ---- link preview REST route (spec/14 § Message links) ----
  registerLinkPreviewRoutes(app, {
    logger: log.child({ component: 'link-preview-routes' }),
    registry,
  });

  // ---- secrets REST routes (spec/15 § Secrets) ----
  registerWebBotAuthRoutes(app, {
    keyB64: opts.webBotAuthKey ?? process.env['PATCH_WEB_BOT_AUTH_KEY'],
  });
  registerSecretsRoutes(app, {
    logger: log.child({ component: 'secrets-routes' }),
    registry,
    secretsRegistry,
    daemonLink,
    idGenerator,
  });

  registerNotificationLogRoutes(app, { registry, log: notificationLog });

  // ---- group 11 notification REST + webhook routes ----
  registerNotificationRoutes(app, {
    logger: log.child({ component: 'notification-routes' }),
    registry,
    daemonLink,
    ...(opts.nowMs ? { nowMs: opts.nowMs } : {}),
    idGenerator,
  });

  // ---- DEV/TEST diagnostic seams for TD1 (special threads) ----
  // HARD-GATED: only mounted off-production AND when a dev seam was enabled
  // (speakers recorder). Each route also requires the internalToken header.
  // Never reachable in a production deployment.
  if (
    process.env.NODE_ENV !== 'production' &&
    speakersRecorder &&
    opts.internalToken &&
    opts.internalToken.length >= 16
  ) {
    registerDevDiagRoutes(app, {
      logger: log.child({ component: 'dev-diag' }),
      daemonLink,
      internalToken: opts.internalToken,
      speakersRecorder,
      idGenerator,
      callOrchestrator,
      wsHub,
    });
  }

  // ---- voice session token mint (group 13) ----
  // The internalToken is used as the HMAC secret; surfaces present the
  // returned token to the host's audio WSS where the same secret verifies.
  if (opts.internalToken && opts.internalToken.length >= 16) {
    registerVoiceTokenRoute(app, {
      logger: log.child({ component: 'voice-token' }),
      registry,
      chatRegistry,
      internalToken: opts.internalToken,
      recordSessionHost: (sessionId, daemonId) => audioSessionRouter.record(sessionId, daemonId),
      ...(opts.nowMs ? { nowMs: opts.nowMs } : {}),
    });
  }

  // ---- voice-note upload (spec/07 § End-to-end voice transport) ----
  // Unlike the token mint above, the note route needs no HMAC secret — it
  // round-trips the clip to the host (Whisper owner) and injects the
  // transcript as a chat.input. Always mounted.
  registerVoiceNoteRoute(app, {
    logger: log.child({ component: 'voice-note' }),
    registry,
    chatRegistry,
    daemonLink,
    idGenerator,
  });

  // ---- composer attachments (spec/14 & spec/15 § Composer) ----
  // Upload (multipart) → server stores a serving-copy + round-trips the bytes to
  // the host for Claude to read by path; GET serves the stored copy back for
  // inline rendering. Attachments live under `<dataDir>/attachments` (override
  // with PATCH_ATTACHMENTS_DIR), mirroring the jobs/registry dataDir ownership.
  registerAttachmentRoutes(app, {
    logger: log.child({ component: 'attachments' }),
    registry,
    chatRegistry,
    daemonLink,
    idGenerator,
    attachmentsDir:
      process.env['PATCH_ATTACHMENTS_DIR'] ?? join(registry.dataDir ?? '/tmp', 'attachments'),
  });

  // ---- artifacts (spec/14 § Artifacts) ----
  // The host publishes a page over the link; the server stores it and serves
  // it from an unguessable URL in an opaque origin. Artifacts live under
  // `<dataDir>/artifacts` (override with PATCH_ARTIFACTS_DIR).
  registerArtifactRoutes(app, {
    logger: log.child({ component: 'artifacts' }),
    daemonLink,
    registry,
    artifactsDir:
      process.env['PATCH_ARTIFACTS_DIR'] ?? join(registry.dataDir ?? '/tmp', 'artifacts'),
  });

  // ---- pads (spec/14 § Pads) ----
  // Design spaces the agents start and Tom edits; `<dataDir>/pads` (override
  // with PATCH_PADS_DIR). Signed links share the artifacts' secret.
  registerPadRoutes(app, {
    logger: log.child({ component: 'pads' }),
    daemonLink,
    registry,
    chatRegistry,
    idGenerator,
    padsDir: process.env['PATCH_PADS_DIR'] ?? join(registry.dataDir ?? '/tmp', 'pads'),
    secretDir: process.env['PATCH_ARTIFACTS_DIR'] ?? join(registry.dataDir ?? '/tmp', 'artifacts'),
  });

  // ---- auth + presence REST routes ----
  registerAuthRoutes(app, {
    logger: log.child({ component: 'auth-routes' }),
    registry,
    presence,
    ...(opts.internalToken ? { internalToken: opts.internalToken } : {}),
    ...(opts.relay ? { relay: opts.relay } : {}),
    daemonLink,
    ...(accountSettings ? { accountSettings } : {}),
    // A changed default model reaches every host that is up; one that is down
    // is corrected by the `daemon.host` reconcile when it comes back.
    terminateSurface: (surfaceId: string) => wsHub.terminateSurface(surfaceId),
    ...(daemonLink instanceof InboundDaemonLink
      ? {
          terminateDaemon: (daemonId: string): boolean =>
            daemonLink.terminateDaemonSocket(daemonId),
        }
      : {}),
    ...(opts.nowMs ? { nowMs: opts.nowMs } : {}),
    ...(opts.pairingNonceStore ? { nonceStore: opts.pairingNonceStore } : {}),
  });

  // ---- relay status (spec/10 § Relay) ----
  // What Settings shows under remote access: whether devices can reach this
  // server through the relay right now, and what a new one would be told.
  app.get('/api/relay', async (req, reply) => {
    try {
      await requireAuth(req, registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    if (!opts.relay) return reply.code(200).send({ enabled: false });
    return reply.code(200).send({ enabled: true, ...opts.relay.info(), ...opts.relay.status() });
  });

  // ---- jobs system (group 9 task B) ----
  // Jobs DATA lives on the server (persisted at <dataDir>/jobs/*.json).
  // The cross-chat tools on the host (`patch_job_*`) hop through the
  // daemon-link to this same JobsInterface — see packages/server/README.md.
  let jobs: JobsInterface;
  let cronScheduler: CronScheduler;
  let recurrenceScheduler: RecurrenceScheduler;
  let jobDispatcher: JobDispatcher;
  // Jobs always use the same dataDir as the registry; if the caller
  // injects a registry directly (tests), we read it back from there.
  const jobsDataDir = opts.dataDir ?? registry.dataDir;
  if (!jobsDataDir) {
    throw new Error('build(): dataDir required for jobs (NO FALLBACKS)');
  }
  if (opts.jobsStore) {
    jobs = opts.jobsStore;
  } else {
    // Default: watch the jobs dir in production (when caller passes
    // dataDir explicitly). Tests pass a registry directly and don't need
    // the chokidar watcher; they'd accumulate fs handles otherwise.
    const watchDefault = opts.dataDir !== undefined;
    jobs = new JobStore({
      dataDir: jobsDataDir,
      logger: log.child({ component: 'job-store' }),
      watch: opts.jobsWatch ?? watchDefault,
    });
  }
  // The completion notifier's job gate (wired above, before the daemon-link
  // subscription order mattered) reads the store through here.
  jobsForCompletionGate = jobs;

  const jobLogs = new JobLogs(jobsDataDir, {
    // spec/06 § Sweep — a job run failure wakes a sweep early (debounced)
    // AND is itself a gate-changed condition, naming the chat it failed on
    // (a dispatch failure with no chat landed has nothing to flag).
    onRun: (entry) => {
      if (isJobRunFailure(entry.status)) managerSweeper.jobRunFailed(entry.action?.chatId ?? null);
    },
  });
  jobDispatcher = new JobDispatcher({
    dataDir: jobsDataDir,
    daemonLink,
    logger: log.child({ component: 'job-dispatcher' }),
    // The dispatcher writes every fire's run entry, from the outcome the host
    // reports back (spec/08 ## Execution model step 6).
    logs: jobLogs,
    // `ensure` (upsert) actions key on whether their persistent chat already
    // exists in the registry mirror to decide spawn-vs-message.
    chatExists: (chatId) => chatRegistry.get(chatId) !== undefined,
    // A `message` action's host is the host its target chat lives on — that is
    // the machine whose reachability decides send-vs-buffer.
    chatHost: (chatId) => chatRegistry.get(chatId)?.daemonId ?? null,
    // After a restart the mirror is empty until each host re-announces its
    // chats, so an `ensure` miss before that is "unknown", not "missing".
    hostReported: (daemonId) => chatRegistry.hasSynced(daemonId),
    // The concurrency gate holds a slot until its chat stops working, and
    // reconciles slots that outlived a restart against this same mirror
    // (spec/08 ## Concurrency).
    chatActivity: (chatId) => chatRegistry.get(chatId)?.activity ?? null,
    chatHasWorked: (chatId, since) => chatRegistry.hasWorkedSince(chatId, since),
    // Records the chatId→jobId link at the exact moment a `spawn` action
    // allocates a fresh chatId, so the sidebar's Automations group
    // (spec/14 § Sidebar) can tag it before the host even confirms.
    chatLinks: jobChatLinks,
    // The model every job's chat runs on unless the job names its own. Read
    // per fire, not captured once, so a change in Settings reaches the next
    // fire rather than waiting for a server restart. Only the settings store's
    // absence (a test with no dataDir) leaves it unset.
    ...(accountSettings
      ? {
          defaultModel: (): string =>
            accountSettings.current().defaultModel ?? DEFAULT_SETTINGS.defaultModel,
          // The autonomy prompt every fire carries unless its job overrides it
          // (spec/08 § Autonomy prompt). Per fire, for the same reason.
          autonomyPrompt: (): string => accountSettings.current().jobAutonomyPrompt,
        }
      : {}),
    // Retires a one-off job once one of its fires settles ok (spec/08
    // § One-off jobs). The dispatcher is where the host's own outcome lands,
    // and the store is the only writer of `expiredAt`.
    jobs,
  });
  cronScheduler = new CronScheduler({
    jobs,
    dispatcher: jobDispatcher,
    logs: jobLogs,
    logger: log.child({ component: 'cron-scheduler' }),
  });
  cronScheduler.start();
  recurrenceScheduler = new RecurrenceScheduler({
    jobs,
    dispatcher: jobDispatcher,
    logs: jobLogs,
    logger: log.child({ component: 'recurrence-scheduler' }),
  });
  recurrenceScheduler.start();

  // ---- DEV/TEST diagnostic seam for TD2 (triggers & jobs) ----
  // HARD-GATED: only mounted off-production AND when PATCH_JOBS_DIAG=1, with a
  // valid internalToken. Lets the TD2 e2e fire a cron job's action synchronously
  // (no minute-long wall-clock wait) through the real scheduler path. Webhooks
  // and offline buffering have their own real seams; this is the only one cron
  // needs. Never reachable in a production deployment.
  if (
    process.env.NODE_ENV !== 'production' &&
    process.env['PATCH_JOBS_DIAG'] === '1' &&
    opts.internalToken &&
    opts.internalToken.length >= 16
  ) {
    registerJobsDiagRoutes(app, {
      logger: log.child({ component: 'jobs-diag' }),
      cronScheduler,
      internalToken: opts.internalToken,
    });
  }

  // Bridge the host's RemoteJobsStore RPC over the daemon-link.
  const detachJobsBridge = attachJobsRpcBridge({
    link: daemonLink,
    jobs,
    logs: jobLogs,
    logger: log.child({ component: 'jobs-rpc-bridge' }),
  });

  registerJobRoutes(app, {
    logger: log.child({ component: 'jobs-routes' }),
    registry,
    jobs,
    chatRegistry,
    jobLogs,
    jobCounts: (jobId) => jobDispatcher.counts(jobId),
    dispatcher: jobDispatcher,
    daemonLink,
    idGenerator,
    ...(opts.recurrenceTranslateTimeoutMs !== undefined
      ? { recurrenceTranslateTimeoutMs: opts.recurrenceTranslateTimeoutMs }
      : {}),
  });
  registerWebhookRoutes(app, {
    jobs,
    dispatcher: jobDispatcher,
    logs: jobLogs,
    logger: log.child({ component: 'webhooks' }),
  });
  registerTodoistRoutes(app, {
    jobs,
    dispatcher: jobDispatcher,
    logs: jobLogs,
    logger: log.child({ component: 'todoist' }),
    // The Todoist app's client secret, backing the SHARED ingress
    // (spec/08 § Todoist › Shared ingress, spec/11 § Env). Absent → that route
    // refuses; it never accepts unverified posts.
    webhookSecret: process.env['TODOIST_WEBHOOK_SECRET'],
  });

  // ---- message hooks (spec/20-hooks.md) ----
  // Same dataDir split as jobs: data lives on the server, `/data/hooks/*.json`.
  let hooks: HooksInterface;
  if (opts.hooksStore) {
    hooks = opts.hooksStore;
  } else {
    hooks = new HookStore({
      dataDir: jobsDataDir,
      logger: log.child({ component: 'hook-store' }),
      watch: opts.hooksWatch ?? opts.dataDir !== undefined,
    });
  }
  const hookRunner = new HookRunner({
    hooks,
    daemonLink,
    logger: log.child({ component: 'hook-runner' }),
    idGenerator,
  });
  registerHookRoutes(app, {
    logger: log.child({ component: 'hooks-routes' }),
    registry,
    hooks,
    chatRegistry,
    runner: hookRunner,
  });

  // Tear down on close.
  app.addHook('onClose', async () => {
    cronScheduler.stop();
    recurrenceScheduler.stop();
    jobDispatcher.close();
    detachJobsBridge();
    if (jobs instanceof JobStore) await jobs.close();
    if (hooks instanceof HookStore) await hooks.close();
  });

  // ---- /app SPA mount ----
  const here = dirname(fileURLToPath(import.meta.url));
  // A configured SPA that is not there is a broken install, never "no SPA": the
  // /app routes would silently not exist and every surface would get a JSON
  // "route not found" (2026-09-30, while /api/healthz reported ok).
  const configuredWeb = process.env.PATCH_WEB_DIST;
  if (configuredWeb && !existsSync(join(configuredWeb, 'index.html'))) {
    throw new Error(
      `PATCH_WEB_DIST=${configuredWeb} has no index.html — refusing to start without the SPA`,
    );
  }
  const candidates = [
    opts.webDistDir,
    process.env.PATCH_WEB_DIST,
    join(here, '..', '..', 'web', 'dist'),
    join(here, '..', '..', '..', 'web', 'dist'),
    '/app/web/dist',
  ].filter((p): p is string => Boolean(p));
  const webRoot = candidates.find((p) => existsSync(p));
  if (webRoot) {
    webRootPath = webRoot;
    const webRootAbs = resolvePath(webRoot);
    const indexHtmlPath = join(webRoot, 'index.html');
    // Read PER REQUEST, never once at boot. `deploy/web-dist` is a live
    // bind-mount: `pnpm ship web` rsyncs a new build under a running server, so
    // a shell cached here would keep pointing surfaces at the previous build's
    // bundle — which the new dist no longer contains.
    const readIndexHtml = (): string => {
      const html = readFileSync(indexHtmlPath, 'utf8');
      // The served bundle hash — surfaces compare it on auth.ok and live-reload
      // when a deploy changed it (spec/14 § Live updates).
      appBundleVersion = /assets\/index-[A-Za-z0-9_-]+\.js/.exec(html)?.[0];
      return html;
    };
    readIndexHtml();
    // Helmet + static plugin scoped to /app/* via a Fastify child context.
    // Helmet on /api/* would CSP-block legitimate JSON tooling — we keep
    // it tightly scoped here.
    await app.register(async (scope) => {
      await scope.register(helmetPlugin, {
        contentSecurityPolicy: {
          directives: {
            defaultSrc: [`'self'`],
            scriptSrc: [`'self'`],
            styleSrc: [`'self'`, `'unsafe-inline'`],
            fontSrc: [`'self'`, 'data:'],
            connectSrc: [`'self'`, 'wss:'],
            // `blob:` is REQUIRED for composer attachment previews: a picked /
            // pasted / screenshot-captured image is shown from a
            // URL.createObjectURL(blob) before upload. Without it the CSP blocks
            // the <img> and the thumbnail renders broken (the sent image works
            // because it's served same-origin from /api/chats/:id/attachment).
            imgSrc: [`'self'`, 'data:', 'blob:'],
          },
        },
        xContentTypeOptions: true,
        // Same-origin framing only: Pads photograph a screen by loading it in an
        // off-screen frame of the app itself (spec/14 § Pads).
        frameguard: { action: 'sameorigin' },
        referrerPolicy: { policy: 'no-referrer' },
        // Don't enable COEP — would break Monaco editor (group 19).
        crossOriginEmbedderPolicy: false,
      });
      await scope.register(staticPlugin, {
        root: webRoot,
        prefix: '/app/',
        // `sendFile` on the reply is what the wildcard handler below uses to
        // serve files that appeared AFTER this plugin snapshotted its routes.
        decorateReply: true,
        wildcard: false,
        // Cache policy that makes a new deploy land on an ordinary reload
        // (spec/11 § SPA cache headers): the content-hashed build assets are
        // immutable (their name changes on rebuild, so cache them forever);
        // index.html is NEVER cached, so every load fetches the current
        // document and with it the current bundle.
        cacheControl: false,
        setHeaders: (res, servedPath) => {
          if (servedPath.endsWith('.html')) {
            res.setHeader('cache-control', 'no-store');
          } else if (servedPath.includes('/assets/')) {
            res.setHeader('cache-control', 'public, max-age=31536000, immutable');
          }
        },
      });
      scope.get('/app', async (_req, reply) => {
        return reply
          .code(200)
          .header('cache-control', 'no-store')
          .type('text/html; charset=utf-8')
          .send(readIndexHtml());
      });
      scope.get('/app/*', async (req, reply) => {
        // Unreachable: String#split always returns a non-empty array, so
        // `[0]` is never undefined for any input (including '').
        /* v8 ignore next */
        const url = req.url.split('?')[0] ?? '';
        const rel = decodeURIComponent(url.replace(/^\/app\//, ''));
        // @fastify/static runs with `wildcard: false`, so it registered one
        // route per file that existed at BOOT. A `ship web` rsync into the live
        // mount adds new content-hashed files under a running server, and those
        // reach this handler instead. Resolve against disk per request so they
        // are served, rather than being reported as a client route.
        const candidate = resolvePath(webRootAbs, rel);
        const insideRoot = candidate === webRootAbs || candidate.startsWith(webRootAbs + sep);
        if (rel && insideRoot && existsSync(candidate) && statSync(candidate).isFile()) {
          return reply.sendFile(rel);
        }
        // A build asset that is NOT on disk means a broken or half-finished
        // deploy — never a client route (the SPA router owns no path under
        // /app/assets/). Serving the shell here answers a <script> request with
        // 200 text/html: the browser silently renders nothing, and prod looks
        // healthy while the app is a blank window. Fail loudly instead.
        if (rel.startsWith('assets/')) {
          return reply
            .code(404)
            .header('cache-control', 'no-store')
            .type('text/plain; charset=utf-8')
            .send(`patch: ${rel} is not present in the deployed build\n`);
        }
        // SPA fallback → the (never-cached) index.html for any client route.
        return reply
          .code(200)
          .header('cache-control', 'no-store')
          .type('text/html; charset=utf-8')
          .send(readIndexHtml());
      });
    });
  }

  app.get('/', async (_req, reply) => {
    return reply.code(302).header('location', '/app/').send();
  });

  app.addHook('onClose', async () => {
    callOrchestrator.shutdown();
  });

  return {
    app,
    registry,
    presence,
    daemonLink,
    wsHub,
    chatRegistry,
    composerDrafts,
    newChatDrafts,
    folderRegistry,
    jobs,
    jobDispatcher,
    hooks,
    hookRunner,
    cronScheduler,
    recurrenceScheduler,
    notificationRouter,
    notificationLog,
    callOrchestrator,
    replyRouter,
    batchStore,
    batchNotifier,
    managerSweeper,
    sweepRuns,
    chatLogStore,
  };
}
