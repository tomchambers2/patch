import { CodexAccounts, CODEX_BACKEND_ID, isCodexModel } from './codexAccounts.js';
import { CodexBackend } from './codexBackend.js';
import { CodexHistory } from './codexHistory.js';
import { ChatSearchIndex, handleChatSearchRequest } from './chatSearch.js';
// Entry point for the patch-daemon process.
//
// Wires together: chat_state map, ChatRunner/Daemon, loopback HTTP control
// (UDS), TCP /healthz, and the OUTBOUND server-daemon WebSocket link (the
// host dials into the patch-server's /ws and authenticates with its
// EdDSA-JWT daemonKey from ~/.patch/daemon.key).

import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, existsSync, unlinkSync, statSync, chmodSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import pino from 'pino';
import {
  Daemon,
  chatInputToSendOptions,
  FolderNotFoundError,
  NoModelCatalogueError,
  ChatNotFoundError,
  AttachmentChatNotFoundError,
} from './chatRunner.js';
import { ChatMoveError } from './chatMove.js';
import { expandHome } from './expandHome.js';
import { gitDirtyPaths } from './git-dirty.js';
import { listFilesRecursive } from './files-recursive.js';
import { createHistoryReader } from './history.js';
import type {
  ChatErrorCode,
  McpServerConfig,
  WireEvent,
  RateLimitWindow,
  PatchActivityResponseEvent,
} from '@patch/wire';
import {
  DEFAULT_SHARED_SETTINGS,
  isHostAddressedSurfaceEvent,
  isReservedSpecialThread,
  OUT_OF_BAND_SEQ,
  ProviderKeyId,
  type SettingsAdoptRequestEvent,
  type SettingsAdoptResponseEvent,
  type SettingsSnapshotEvent,
  type SharedSecrets,
  type SharedSettings,
  type SharedSettingsPatch,
  DEFAULT_GOAL_EVAL_PROMPT,
  DEFAULT_GOAL_MODEL,
  DEFAULT_GOAL_REFUSAL_LIMIT,
  QUESTION_EXPIRY_SECONDS_DEFAULT,
  refusingRateLimitScope,
} from '@patch/wire';
import type { Logger } from 'pino';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { buildControl } from './control.js';
import {
  createRemoteSpawnCoordinator,
  describeSpawnFailure,
  type RemoteSpawnRequest,
} from './remote-spawn.js';
import { createRemoteRelayCoordinator } from './remote-relay.js';
import { buildPeekResult } from './peek.js';
import { ArtifactPublisher } from './artifacts.js';
import { PadClient } from './pads.js';
import { RemoteJobsStore } from './jobs-interface.js';
import { QueuePullClient } from './queuePull.js';
import type { ChatInputEvent } from '@patch/wire';
import { createMetaStore } from './meta.js';
import { readUserMessages } from './userMessages.js';
import {
  bootstrapClaudeOAuth,
  makeResolveOAuth,
  readDaemonKey,
  registerDaemon,
  writeDaemonKey,
  type ClaudeTokenValidator,
} from './registration.js';
import {
  loadLegacyClaudeOAuth,
  seedPatchStore,
  readPatchStore,
  writePatchStore,
  setAccountOrganization,
  type LoadClaudeOAuthOptions,
} from '@patch/auth';
import type { DaemonAccountEvent, ChatReplayBatchEvent } from '@patch/wire';
import { REPLAY_BATCH_BYTES } from '@patch/wire';
import { createMockSdkBackend, createRealSdkBackend, type SdkBackend } from './sdkBackend.js';
import { makeTitleGenerator } from './titleGen.js';
import { makeStatusGenerator } from './statusGen.js';
import { MeetingManager } from './meeting.js';
import { makeMeetingAnalyser } from './meetingGen.js';
import { makeSweepDecider } from './managerSweepGen.js';
import { makeGoalEvaluator } from './goalEval.js';
import { makeToolRunSummarizer } from './toolRunGen.js';
import { makeBranchSendBackSummarizer } from './branchSendBackGen.js';
import { makeDigestGenerator } from './rotationDigest.js';
import { makeRecurrenceTranslator } from './recurrenceTranslate.js';
import {
  ensureSpecialThreads,
  appendBroadcast,
  isBroadcastSelfLoop,
  readPendingBroadcasts,
  flushBroadcasts,
  buildBroadcastSystemReminder,
  threadForChannel,
  BROADCAST_SIDECAR_THREADS,
  SPECIAL_THREAD_IDS,
  type SpecialThreadId,
} from './specialThreads.js';
import { BUILD_TARGET, BUILT_AT, GIT_SHA, VERSION } from './version.js';
import {
  applyUpdate,
  checkForUpdate,
  createArtifactWait,
  describeUpdateRefusal,
  createUpdateGate,
  requestUpdate,
  waitUntilNoRunningTurns,
} from './selfUpdate.js';
import { updateClaudeCli } from './claudeCliUpdate.js';
import {
  AccountRotation,
  isAccountExhaustedError,
  parseLimitResetsAt,
  type FailoverAccount,
  type RouteOptions,
  type RunOnAccountWithCredit,
} from './accountFailover.js';
import { AccountUsageTracker } from './accountUsage.js';
import { CreditResume } from './creditResume.js';
import { resolveClaudeExecutable } from './claudeExecutable.js';
import { DeviceAdoption } from './devices/adoption.js';
import { localKeyPath, mintLocalKey } from './localKey.js';
import {
  CLAUDE_BACKEND_ID,
  claudeBackendEntry,
  describeHost as buildHostDescription,
} from './host.js';
import { createServerLink } from './serverLink.js';
import { handleJobExec } from './jobExec.js';
import { handleHookCheck } from './hookCheck.js';
import { FolderRegistry } from './folders.js';
import { ModelCatalog } from './modelCatalog.js';
import { handleBackgroundTaskStatsRequest } from './backgroundTaskStats.js';
import { handleWatchListRequest, handleWatchStopRequest } from './watchRequests.js';
import { HostStateStore } from './hostState.js';
import { BrowserTunnelClient, BrowserTunnelRelay } from './browser-tunnel.js';
import { AudioRelayBridge } from './audio-relay-bridge.js';
import {
  browserToolsEnabledOf,
  enabledMcpServers,
  seedMcpServers,
  withBrowserToolsEnabled,
} from './mcpServers.js';
import { getPatchToolsPrompt, toolsPromptOverride } from './toolsPrompt.js';
import { ComponentManager, ComponentNotOfferedError, componentRuntimeDir } from './components.js';
import { provisionSidecarRuntime, resolveUv } from './audio/sidecarRuntime.js';
import { bundledSidecarDir } from './installPaths.js';
import { TerminalSessions } from './terminal.js';
import { handleHostFilesRequest } from './hostFiles.js';
import { handleBlobRequest } from './blobFetch.js';
import { ProviderKeyError, ProviderKeyStore, providerKeysPath } from './providerKeys.js';
import { ClaudeSettingsFile, claudeSettingsFor, settingsOs } from './sharedSettings.js';
import { createSecretsStore, InvalidSecretKeyError, type SecretsStore } from './secrets.js';
import {
  claudeHomeFromProjectsRoot,
  deleteClaudeMemory,
  setClaudeMemory,
  InvalidMemoryRefError,
  listClaudeMemories,
  MemoryNotFoundError,
} from './claudeSettings.js';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startAudioServer, type AudioServerHandle } from './audio/server.js';
import { createVoiceReplyBridge } from './audio/replyBridge.js';
import { createChatVoice } from './audio/chatVoice.js';
import { createVoiceLedger } from './audio/voiceLedger.js';
import {
  createWhisper,
  validateWhisperCredentials,
  UnsupportedClipFormatError,
  type WhisperBackend,
} from './audio/whisper.js';
import { createKokoro, validateKokoroModel } from './audio/kokoro.js';
import {
  createDictationTranscribers,
  pickDictationTranscriber,
  type DictationTranscribers,
} from './audio/hosted-stt.js';
import { createSileroVadFactory, validateVadModel, MockVad, type Vad } from './audio/vad.js';
import { DeviceRegistry } from './devices/registry.js';
import { PresenceRegistry } from './devices/presence.js';
import { DeviceControlServer, mountDeviceControlUpgrade } from './devices/control-ws.js';
import type { DeviceRingFrame } from '@patch/wire/device-control';
import {
  DEFAULT_VOICE_CONFIG,
  voiceKeyMissingMessage,
  voiceSurfacesMissingKey,
  type VoiceBackend,
  type VoiceConfig,
  type VoiceKeys,
} from '@patch/wire/audio';
import { WebSocketServer } from 'ws';
import type { FastifyInstance } from 'fastify';

/**
 * How often to re-warm Kokoro while the host is idle (spec/07 § Latency —
 * "Kokoro pre-warm at boot"). Well inside the window over which an idle model
 * gets paged out on a busy box.
 */
const KOKORO_KEEP_WARM_MS = 8 * 60_000;

/**
 * How much of a chat's recent conversation a fast voice is seeded with
 * (spec/07 § Keeping voice and text as one conversation — about 8,000
 * tokens), counted in characters at roughly four to a token.
 */
const VOICE_CONTEXT_MAX_CHARS = 32_000;

/**
 * Test-only boot hook (mirrors the `enableTestHooks` convention in
 * serverLink.ts). Never populated by the real CLI entry at the bottom of this
 * file — `main()` is called there with no arguments, so `testHooks` is always
 * `undefined` in production and every line below that reads it is a no-op.
 * Exists solely so an in-process integration test can (a) obtain the real
 * `shutdown()` closure to tear the host down cleanly instead of going
 * through the `process.exit`-calling control-IPC path, and (b) obtain the
 * live `daemon`/`folderRegistry`/`secretsStore` graph to assert against.
 */
export interface MainTestHooks {
  onReady?: (handle: {
    shutdown: () => Promise<void>;
    daemon: Daemon;
    folderRegistry: FolderRegistry;
    secretsStore: SecretsStore;
    /** The control-IPC Fastify app — lets a test `app.inject(...)` directly. */
    app: FastifyInstance;
    /** The host-owned voice-device pairing registry (spec/16 § F2). */
    deviceRegistry: DeviceRegistry;
    /**
     * The SDK backend this host is running against — under `SDK_BACKEND=mock`
     * (every test boot) this is a `MockSdkBackend`, letting a test `enqueue()`
     * a scripted envelope (e.g. a `rateLimit` report) ahead of a chat turn.
     */
    sdkBackend: SdkBackend;
  }) => void;
  /**
   * Replaces the Anthropic call that checks a submitted token (spec/10 §
   * Validating a pasted token). Present ONLY so a test can drive both outcomes
   * without a network — a test must never reach the real API with a real
   * credential. Undefined in production, where the real check runs.
   */
  validateClaudeToken?: ClaudeTokenValidator;
  /** Where the host's log lines go instead of stdout — lets a test read what boot logged. */
  logStream?: import('pino').DestinationStream;
}

/**
 * Run a command to completion, capturing its output. Backs the on-demand
 * provisioning of a voice sidecar's Python runtime (§ ComponentManager below).
 * Never throws on a non-zero exit — the caller decides what a failure means and
 * reports it with what the command printed.
 */
function runProcess(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Where `uv` might already be on this machine, before one is installed for it:
 * a previous provision's copy, the user's own install, the usual system paths.
 */
function uvCandidates(patchHome: string): string[] {
  return [
    join(patchHome, 'tools', 'uv'),
    join(homedir(), '.local', 'bin', 'uv'),
    '/usr/local/bin/uv',
    '/opt/homebrew/bin/uv',
    '/usr/bin/uv',
  ];
}

export async function main(testHooks?: MainTestHooks): Promise<void> {
  const config = loadConfig();
  // spec/02 § Claude Code settings: settings.json sits one level above the
  // transcript-history root the host already resolves; reusing that root
  // means PATCH_CLAUDE_PROJECTS_ROOT sandboxes this too (see claudeSettings.ts).
  const claudeHome = claudeHomeFromProjectsRoot(config.claudeProjectsRoot);
  // Written from the shared settings, except when changed on this machine
  // (spec/02 § Claude Code settings): that is reported as drift instead.
  const claudeSettingsFile = new ClaudeSettingsFile(claudeHome, config.patchHome);
  const claudeSettingsSnapshot = (): {
    drift?: string;
    memories: ReturnType<typeof listClaudeMemories>;
  } => {
    const drift = claudeSettingsFile.drift();
    return {
      ...(drift !== undefined ? { drift } : {}),
      memories: listClaudeMemories(config.claudeProjectsRoot),
    };
  };

  // 0. Deployment credential gate (group H1, spec/11-deployment.md § Env): the
  // whisper backend's credential is validated EAGERLY, before OAuth, before the
  // healthz listener, before the /ws dial — "Validation must happen before any
  // attempt to serve requests. No silent fallback to a degraded mode." A `groq`
  // host with no GROQ_API_KEY would otherwise present a green audio WSS that
  // 500s the first real utterance — exactly the degraded mode the deployment
  // contract forbids. (This supersedes the earlier group-14 lazy-fail affordance.)
  //
  // The key itself may come from this host's provider-key store (spec/02
  // § Provider keys) — set from Settings → Hosts → Keys — which wins over the
  // environment. The store refuses to revoke the one Groq key a `groq` host has,
  // since the host would then not start to be given another.
  const providerKeys = new ProviderKeyStore({
    path: providerKeysPath(config.patchHome),
    env: {
      gemini: config.audio.geminiApiKey,
      openai: config.audio.openaiApiKey,
      groq: config.audio.groqApiKey,
    },
    ...(config.audio.whisperBackend === 'groq'
      ? { requiredToStart: { groq: 'This host transcribes with Groq (WHISPER_BACKEND=groq)' } }
      : {}),
  });
  validateWhisperCredentials({ ...config.audio, groqApiKey: providerKeys.get('groq') });
  // spec/07 § Python sidecar lifecycle: KOKORO_MODEL_PATH must be validated at
  // startup — a missing model file aborts boot with a clear error rather than
  // silently 500ing the first TTS turn. Same fail-loud contract as Whisper.
  validateKokoroModel(config.audio);
  // spec/18 § Host + spec/07 Barge-in: when VAD_BACKEND=silero, the Silero
  // ONNX model must exist at startup — a missing model aborts boot rather than
  // silently disabling barge-in/end-of-utterance detection (NO SILENT FALLBACK).
  validateVadModel(config.audio);

  const loggerOptions: import('pino').LoggerOptions = {
    level: process.env['LOG_LEVEL'] ?? 'info',
    redact: {
      paths: [
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
        // Group 12 (LOW-1): notification secrets.
        'fcmToken',
        '*.fcmToken',
      ],
      remove: true,
    },
  };
  const logger = testHooks?.logStream
    ? pino(loggerOptions, testHooks.logStream)
    : pino(loggerOptions);

  // 1. Resolve OAuth — log loudly on miss, but don't fail the host process:
  //    /healthz still has to come up so compose/healthcheck reports a green
  //    host and the surface can drive `claude login` via the
  //    daemon.unauthenticated event.
  // The credential store sits in the host's own state dir, beside daemon.key.
  // Deriving it from patchHome (PATCH_HOME) rather than hardcoding ~/.patch is what
  // keeps tests off the developer's real home — a disconnect driven through boot
  // wrote ~/.patch/claude-oauth.json on this machine before it did.
  const oauthOpts: LoadClaudeOAuthOptions = {
    storePath: join(config.patchHome, 'claude-oauth.json'),
    ...(config.claudeCredentialsPath !== undefined ? { path: config.claudeCredentialsPath } : {}),
  };
  // First boot only: adopt whatever Claude Code left on this host into patch's own
  // store (`~/.patch/claude-oauth.json`), so the credential becomes something patch
  // can actually revoke from Settings. A no-op once the store exists — including
  // when it is deliberately empty, which is what makes a disconnect survive a
  // process or container restart (spec/10-auth.md § Claude subscription).
  try {
    const seeded = seedPatchStore(oauthOpts);
    if (seeded) logger.info({}, 'patch-daemon: seeded credential store from host credential');
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'patch-daemon: credential store seed failed');
  }
  const oauth = bootstrapClaudeOAuth(oauthOpts);
  if (oauth.error) {
    logger.error({ err: oauth.error }, 'patch-daemon: Claude OAuth not ready');
  } else {
    logger.info({ source: oauth.credentials?.sourcePath }, 'patch-daemon: Claude OAuth loaded');
  }

  // 2. SDK backend selection. The mock writes a real JSONL transcript into the
  // SAME projects root the host's HistoryReader reads, so patch_history /
  // chat.replay paginate genuine persisted older events on the live stack.
  const sdkBackend: SdkBackend =
    config.sdkBackend === 'real'
      ? createRealSdkBackend()
      : createMockSdkBackend({
          claudeProjectsRoot: config.claudeProjectsRoot,
          // Hold a genuine working window per turn so stop-a-running-query is
          // exercisable against the live stack. Abortable: patch_stop unwinds
          // it immediately. Override with PATCH_MOCK_TURN_DELAY_MS.
          turnDelayMs:
            process.env['PATCH_MOCK_TURN_DELAY_MS'] !== undefined &&
            process.env['PATCH_MOCK_TURN_DELAY_MS'] !== ''
              ? Number(process.env['PATCH_MOCK_TURN_DELAY_MS'])
              : 2_500,
        });
  logger.info({ backend: config.sdkBackend }, 'patch-daemon: SDK backend selected');

  // 3. Host registration: dial-in needs an EdDSA-JWT daemonKey. If absent,
  //    run the QR pairing flow (spec/10-auth.md "Host registration") and
  //    persist the surface-signed key to ~/.patch/daemon.key before connecting.
  let daemonKey = readDaemonKey(config.patchHome);
  if (daemonKey === undefined) {
    logger.warn('patch-daemon: no daemon.key found — starting QR registration');
    // `patch host start --pair <code>` (or PATCH_PAIR_NONCE) carries a nonce
    // pre-issued by the linked web Settings "add-daemon QR" — await it directly.
    const prePairedNonce = process.env['PATCH_PAIR_NONCE'];
    const reg = await registerDaemon({
      serverUrl: config.serverUrl,
      patchHome: config.patchHome,
      logger,
      ...(prePairedNonce !== undefined && prePairedNonce.length > 0 ? { prePairedNonce } : {}),
    });
    writeDaemonKey(config.patchHome, reg.daemonKey);
    daemonKey = reg.daemonKey;
    logger.info({ daemonId: reg.daemonId }, 'patch-daemon: registered, daemon.key written');
  }

  // The daemon.key is an EdDSA-JWT whose `sub` is the account public key (the
  // singleton accountId — server keys the account on the user public key). The
  // device control plane (F2) verifies device surface JWTs against this same
  // account key, since the device is paired under the same account. Read it
  // from the JWT payload (no signature check needed — we only need the claimed
  // subject; the device JWT itself IS signature-verified against it).
  // spec/02 § Control IPC: the host is the only party that mints the local
  // key. Generated fresh on every start and written beside the socket at
  // ~/.patch/local.key (0600), so a key from a previous run stops working the
  // moment the host it belonged to is gone.
  const localKey = mintLocalKey(config.patchHome);
  logger.info({ path: localKeyPath(config.patchHome) }, 'patch-daemon: local control key minted');

  const daemonKeyClaims = ((): { sub: string; daemon_id: string } => {
    const seg = daemonKey.split('.')[1];
    if (seg === undefined) throw new Error('daemon.key: malformed JWT (no payload segment)');
    const payload = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')) as {
      sub?: unknown;
      daemon_id?: unknown;
    };
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new Error('daemon.key: payload has no `sub` (account public key)');
    }
    // Every frame this host emits names the machine it is about, so a host
    // that cannot state its own id must not start — an unaddressed frame would
    // be attributed to whichever host the surface guessed. NO FALLBACK.
    if (typeof payload.daemon_id !== 'string' || payload.daemon_id.length === 0) {
      throw new Error("daemon.key: payload has no `daemon_id` (this host's identity)");
    }
    return { sub: payload.sub, daemon_id: payload.daemon_id };
  })();
  const accountPublicKey = daemonKeyClaims.sub;
  /** This host's id. Stamped on every frame this host emits. */
  const selfDaemonId = daemonKeyClaims.daemon_id;
  const codexAccounts = new CodexAccounts({
    root: join(config.patchHome, 'openai'),
    daemonId: selfDaemonId,
    logger,
    onChange: () => {
      link.send(codexAccounts.report());
      publishHost();
    },
    // A ChatGPT sign-in run here is the account's, not this machine's: it goes
    // to the server, which sends it back to every host (spec/01 § Settings).
    onSignedIn: (requestId, account) =>
      link.send({ type: 'settings.account_signed_in', daemonId: selfDaemonId, requestId, account }),
  });
  const codexHistory = new CodexHistory(join(config.patchHome, 'openai-history'));
  // spec/02 § Chat search — an in-memory index derived from the backends' own
  // transcripts (never persisted). Built in the background once the chats are
  // hydrated (below), then kept current by every search.
  const chatSearch = new ChatSearchIndex(
    {
      claudeProjectsRoot: config.claudeProjectsRoot,
      codexHistoryRoot: join(config.patchHome, 'openai-history'),
      seqIndexPath: (chatId) => join(dirname(metaStore.pathFor(chatId)), 'seqindex.jsonl'),
      now: () => Date.now(),
      onCorruptLine: ({ path, message }) =>
        logger.warn({ path, err: message }, 'chat search: skipping unreadable JSONL line'),
    },
    selfDaemonId,
  );
  // Settles once the chats are hydrated AND the index is built; a search that
  // arrives earlier waits for it rather than answering from nothing.
  let chatSearchBuilt: () => void = () => {};
  const chatSearchReady = new Promise<void>((resolve) => {
    chatSearchBuilt = resolve;
  });
  const codexBackend = new CodexBackend(codexAccounts, codexHistory);
  const routedBackend: SdkBackend = {
    run: (opts) => (isCodexModel(opts.model) ? codexBackend.run(opts) : sdkBackend.run(opts)),
  };

  /**
   * Reject a host-scoped frame that names a different machine. Reaching this
   * host at all means the server mis-routed it; acting on it would apply the
   * user's change to the wrong machine, which is strictly worse than dropping
   * it with a warning that names both ids.
   */
  const isForThisHost = (daemonId: string, frameType: string): boolean => {
    if (daemonId === selfDaemonId) return true;
    logger.warn(
      { frameType, addressedTo: daemonId, selfDaemonId },
      'host-scoped frame addressed to another host; dropping',
    );
    return false;
  };

  /**
   * Everything a surface can CHANGE about this machine, persisted so the change
   * outlives the process (spec/02 § Host identity). A rename that reverts on
   * restart is indistinguishable from an edit that never saved.
   */
  const hostStateStore = new HostStateStore(config.patchHome, logger);
  const persistedHostState = hostStateStore.get();
  /** This machine's user-editable label (`host.rename`). */
  let hostName = persistedHostState.hostName ?? config.hostName;
  /** Is this the account's home machine (`host.set_home`)? */
  let isHomeHost = persistedHostState.isHomeHost ?? config.isHomeHost;
  /** Currently selected Kokoro TTS voice (`host.settings` → `kokoroVoice`). */
  let kokoroVoice: string | undefined = persistedHostState.kokoroVoice;
  /**
   * Account's per-surface voice config (`host.settings` → `voiceConfig`,
   * spec/07 § Voice — a config matrix). Independently selects the STT/TTS/
   * agent engine and, for the three conversational surfaces, the front-layer
   * shape, for each of dictation / device / hands-free / call.
   */
  let voiceConfig: VoiceConfig = persistedHostState.voiceConfig ?? DEFAULT_VOICE_CONFIG;
  // Which provider keys this host holds. A surface configured onto a provider
  // whose key is missing does NOT stop the host — voice is one setting, and
  // every chat on this host would go down with it. Instead its sessions are
  // refused with `voice_key_missing` (audio/server.ts, the voice-note RPC),
  // Settings → Voice marks the cell not configured here (`daemon.host.voiceKeys`),
  // and this logs it now, on every config change and on every key change.
  // Read live from the provider-key store, so a key set or revoked in
  // Settings → Hosts → Keys shows here at once.
  const voiceKeys = (): VoiceKeys => ({
    gemini: providerKeys.has('gemini'),
    openai: providerKeys.has('openai'),
  });
  logVoiceKeysMissing(logger, voiceConfig, voiceKeys());
  // spec/07 § Call cost — every costed call, and this host's totals.
  const voiceLedger = createVoiceLedger(join(config.patchHome, 'voice-usage.jsonl'));
  /**
   * How many user messages between auto-regen of the chat name.
   * 0 = disabled (title only from first message).
   */
  let chatNameInterval: number = persistedHostState.chatNameInterval ?? 0;
  /**
   * The Manager's bounded context window (spec/06 § Manager conversation).
   * A generous built-in default so a host that hasn't yet heard the
   * account's own setting from the server doesn't truncate aggressively.
   */
  let managerContextWindow: number = persistedHostState.managerContextWindow ?? 200;
  // Settings → Goals (spec/04 § Goals): how the goal judge is asked, and when a goal gives up on a refusing agent.
  let goalEvalPrompt: string = persistedHostState.goalEvalPrompt ?? DEFAULT_GOAL_EVAL_PROMPT;
  let goalModel: string = persistedHostState.goalModel ?? DEFAULT_GOAL_MODEL;
  let goalRefusalLimit: number = persistedHostState.goalRefusalLimit ?? DEFAULT_GOAL_REFUSAL_LIMIT;
  /**
   * spec/02 § Browser — Route through: the daemonId of another of the user's
   * hosts this host's `patch_browser_*` traffic egresses through. Undefined
   * means direct, the default.
   */
  let browserRouteThrough: string | undefined = persistedHostState.browserRouteThrough;
  /**
   * Whether this host auto-resumes turns blocked by a Claude API usage/rate
   * limit (spec/10 § Usage limits). Persisted in host.json; ON unless the user
   * has explicitly turned it off.
   *
   * It used to default off, on the reasoning that auto-resuming would surprise
   * a first-time user. In practice the surprise runs the other way: a chat
   * that hits the 5-hour limit is silently abandoned mid-task, and unattended
   * work (jobs, crons) is lost with no label, no comment and no retry. Waiting
   * for a known reset time is the unsurprising behaviour; dropping the turn is
   * not.
   */
  let autoResumeRateLimit = persistedHostState.autoResumeRateLimit ?? true;

  /**
   * Whether an unanswered question on this host expires, and the window it is
   * given (spec/02 § Questions are not approvals). Persisted in host.json; ON
   * by default, because a question nobody answers parks the whole chat and the
   * agent has no way to notice.
   */
  let questionExpiry = persistedHostState.questionExpiry ?? true;
  let questionExpirySeconds =
    persistedHostState.questionExpirySeconds ?? QUESTION_EXPIRY_SECONDS_DEFAULT;

  /** Per-host Claude harness config (Task 3). Persisted in host.json. */
  let harnessSystemPrompt: string | undefined = persistedHostState.harnessSystemPrompt;
  // Absent means the built-in default; an empty string means the user turned it
  // off. `effectiveToolsPrompt` collapses the two into what the SDK receives.
  let harnessToolsPrompt: string | undefined = persistedHostState.harnessToolsPrompt;
  const effectiveToolsPrompt = (): string =>
    harnessToolsPrompt === undefined ? getPatchToolsPrompt() : harnessToolsPrompt;
  let harnessSkills: string[] | 'all' | undefined = persistedHostState.harnessSkills;
  // The three "layer" toggles (spec/14 § Agent behavior). Unlike the fields
  // above, these always resolve to a concrete boolean — there is no "SDK
  // default" reading for them to fall back to, only a stated default per
  // toggle.
  let harnessMemoryEnabled = persistedHostState.harnessMemoryEnabled ?? false;
  // The MCP servers this host adds to every chat (Settings → MCP). A host
  // that predates the list is seeded ONCE with the pair the old Browser tools
  // toggle wired, enabled as that toggle was, and the seed is persisted so the
  // list is the only authority from here on.
  let harnessMcpServers: McpServerConfig[] =
    persistedHostState.harnessMcpServers ??
    seedMcpServers(persistedHostState.harnessBrowserToolsEnabled ?? false);
  if (persistedHostState.harnessMcpServers === undefined) {
    hostStateStore.update({ harnessMcpServers });
    logger.info(
      { harnessMcpServers: harnessMcpServers.map((s) => ({ name: s.name, enabled: s.enabled })) },
      'MCP server list seeded from the Browser tools toggle',
    );
  }
  // The shipped Manager/Speakers CLAUDE.md ALWAYS loads: its toggle
  // was dropped from Settings ("pick it up automatically"). A `false` left in
  // host.json, or sent by a surface that still shows the toggle, is ignored —
  // said once in the log, so a host that "had it off" is not a mystery.
  let claudeMdOffIgnoredLogged = false;
  const ignoreClaudeMdOff = (source: 'host.json' | 'host.settings'): void => {
    if (claudeMdOffIgnoredLogged) return;
    claudeMdOffIgnoredLogged = true;
    logger.warn(
      { source },
      'harnessClaudeMdEnabled: false ignored — the shipped special-thread CLAUDE.md always loads now',
    );
  };
  if (persistedHostState.harnessClaudeMdEnabled === false) ignoreClaudeMdOff('host.json');
  /**
   * Rebuild the host's harness config from the current in-memory settings
   * and push it in. Called on boot and after ANY of the harness fields
   * changes, so a change to one never leaves another stale on the object the
   * SDK actually reads.
   */
  const applyHarnessConfig = (): void => {
    daemon.setHarnessConfig({
      systemPrompt: harnessSystemPrompt,
      toolsPrompt: effectiveToolsPrompt(),
      skills: harnessSkills,
      memoryEnabled: harnessMemoryEnabled,
      mcpServers: enabledMcpServers(harnessMcpServers),
    });
  };

  /**
   * Whether the server has published a build newer than the one running here
   * (spec/02 § Optional components / spec/11 § Host installation). Starts
   * false and becomes true only when a check has actually found one — a machine
   * must never claim an update it has not seen.
   */
  let updateAvailable = false;

  // See `createUpdateGate` — joins every caller (the `host.update` wire event
  // and `patch hosts update`'s local control command) onto one in-flight
  // attempt rather than letting a second click race the installer.
  const applyUpdateGated = createUpdateGate();
  // Never restart under a running turn: the installer waits for the machine to
  // go idle, and a request made mid-turn is answered as deferred at once.
  const runningChats = (): string[] => daemon.runningChatIds();
  // A deploy publishes this machine's artifact a minute or two after the
  // version bump (ship.mjs daemonMac). Wait that out quietly; only a build that
  // is STILL missing after the window is shown to the user.
  const artifactWait = createArtifactWait({
    onGiveUp: (message) => {
      logger.warn({ reason: message }, 'host.update refused (artifact never appeared)');
      emit({
        type: 'chat.error',
        chatId: 'pending-spawn',
        error: {
          code: 'invalid_frame',
          message: describeUpdateRefusal(message),
        },
        seq: OUT_OF_BAND_SEQ,
      });
      emit(describeHost());
    },
  });
  const applyUpdateOnce = (): ReturnType<typeof applyUpdate> =>
    requestUpdate({
      runningChats,
      logger,
      artifactWait,
      check: () =>
        checkForUpdate({
          serverUrl: config.serverUrl,
          currentVersion: VERSION,
          target: BUILD_TARGET,
        }),
      apply: () =>
        applyUpdateGated({
          serverUrl: config.serverUrl,
          internalToken: config.internalToken,
          currentVersion: VERSION,
          target: BUILD_TARGET,
          patchHome: config.patchHome,
          untilIdle: () => waitUntilNoRunningTurns({ runningChats, logger }),
          logger,
        }),
    });

  /**
   * Whether this machine's backend credential actually WORKS — not merely
   * whether a token file exists. Seeded from the boot check, then corrected by
   * a real resolve. Reporting the boot snapshot meant an expired token still
   * read as "Connected" on every surface until someone tried to send, which is
   * why nothing warned and the whole app looked fine while being unusable.
   */
  let credentialOk = oauth.error === undefined;

  /**
   * Last-reported Claude usage per STORED ACCOUNT, keyed by `accountId` then
   * by window (spec/10 § Surface in Settings — Usage — "usage is reported per
   * host per account"). Empty for an account until the SDK's first
   * `rate_limit_event` for a chat pinned to it; each window updates
   * independently since the SDK reports one window per event.
   */
  let accountUsage: AccountUsageTracker | undefined;

  /**
   * Build the full `daemon.account` report for the Claude backend: every
   * stored account (spec/10 § Backend credentials — multiple accounts) plus
   * the top-level `connected`/`accountEmail`/`usage` fields mirroring the
   * ACTIVE one, for a surface that predates multi-account support.
   *
   * `activeOverride` lets a connect/disconnect/add report the `connected` state
   * it just produced immediately, rather than waiting for the next periodic
   * `refreshCredentialState` pass to catch up — the same "say what is true
   * NOW" reasoning the single-account code always had. Every OTHER account's
   * `connected` is read straight off the store (credential present or not),
   * not a live SDK re-check — re-validating every stored account's token on
   * every report would mean a network refresh call per account per emission,
   * which the single active-account gate already avoids by only running on
   * a real turn / a periodic hour tick.
   *
   * The account EMAIL is never overridden: it is read out of the store on every
   * emission, for every row including the active one. It used to come from
   * `oauth.credentials`, a snapshot taken once at boot, so any report built
   * without an explicit override — the hourly credential check, the reconnect
   * greeting, an add-account, a spawn failure — reverted the displayed name to
   * the credential in use when the host STARTED. Since the server caches the
   * last report and replays it in `auth.ok`, a surface opened after that showed
   * the account the user had switched away from. Reading the store makes the
   * top-level fields and the `accounts` rows agree by construction.
   */
  /**
   * One account's usage as the wire carries it, or undefined when nothing has
   * been read yet.
   *
   * "Nothing yet" is deliberately absent rather than an empty object: a surface
   * must be able to say "not reported" instead of drawing an empty gauge that
   * reads as zero usage.
   */
  const usageFor = (
    accountId: string,
  ):
    | {
        session?: RateLimitWindow;
        week?: RateLimitWindow;
        overage?: RateLimitWindow;
        at?: number;
      }
    | undefined => {
    const entry = accountUsage?.get(accountId);
    if (!entry) return undefined;
    const { session, week, overage } = entry.reading.windows;
    if (session === undefined && week === undefined && overage === undefined) return undefined;
    return {
      ...(session ? { session } : {}),
      ...(week ? { week } : {}),
      ...(overage ? { overage } : {}),
      at: entry.reading.at,
    };
  };

  const buildAccountReport = (
    activeOverride?: { connected: boolean },
    credentialError?: NonNullable<DaemonAccountEvent['credentialError']>,
  ): DaemonAccountEvent => {
    const store = readPatchStore(oauthOpts) ?? { accounts: [], activeAccountId: null };
    const activeId = store.activeAccountId ?? undefined;
    const topConnected = activeOverride?.connected ?? credentialOk;
    const activeAccount = activeId ? store.accounts.find((a) => a.id === activeId) : undefined;
    const activeUsage = activeId ? usageFor(activeId) : undefined;
    return {
      type: 'daemon.account',
      daemonId: selfDaemonId,
      backendId: CLAUDE_BACKEND_ID,
      connected: topConnected,
      accountEmail: activeAccount?.credential?.email ?? null,
      ...(activeUsage && Object.keys(activeUsage).length > 0 ? { usage: activeUsage } : {}),
      accounts: store.accounts.map((a) => {
        const usage = usageFor(a.id);
        return {
          id: a.id,
          label: a.label,
          connected: a.id === activeId ? topConnected : a.credential !== null,
          accountEmail: a.credential?.email ?? null,
          ...(a.credential?.organizationId !== undefined
            ? { organizationId: a.credential.organizationId }
            : {}),
          ...(usage ? { usage } : {}),
        };
      }),
      ...(activeId !== undefined ? { activeAccountId: activeId } : {}),
      ...(credentialError ? { credentialError } : {}),
    };
  };

  /**
   * This host's `daemon.host` self-description, rebuilt from live state each
   * time so a surface never renders a stale backend or component list. Emitted
   * on connect and after anything it reports changes.
   */
  const describeHost = (): import('@patch/wire').DaemonHostEvent =>
    buildHostDescription({
      daemonId: selfDaemonId,
      hostName,
      daemonVersion: VERSION,
      // spec/11 § Version reporting: all THREE stamps travel, not just the
      // version — without the commit and build instant a surface cannot tell
      // two machines on the same version number apart, which is exactly the
      // drift the version report exists to show.
      gitSha: GIT_SHA,
      builtAt: BUILT_AT,
      // Whether the server has published a NEWER build for this machine's
      // os/arch. Refreshed by the periodic check below; false until the first
      // check completes, which is the honest reading of "this machine knows of
      // no newer build" rather than a claim that none exists.
      updateAvailable,
      permissionModeDefault: daemon.permissionModeDefault(),
      permissionOverrides: daemon.permissionOverrideCount(),
      ...(defaultModel !== undefined ? { defaultModel } : {}),
      isHomeHost,
      // This host can take its queued messages from the server (spec/04).
      serverQueue: true,
      audioRelayHost: config.audio.relayHost,
      backends: [
        {
          id: CODEX_BACKEND_ID,
          label: 'OpenAI Codex',
          version: codexAccounts.runtime.version,
          state: !codexAccounts.runtime.version
            ? 'absent'
            : codexAccounts.report().connected
              ? 'present'
              : 'logged-out',
        },
        claudeBackendEntry({
          executableResolved: true,
          version: null,
          credentialOk,
          ...(oauth.error ? { error: oauth.error.message } : {}),
        }),
      ],
      components: components.describe(),
      ...(kokoroVoice !== undefined ? { kokoroVoice } : {}),
      voiceKeys: voiceKeys(),
      voiceUsage: voiceLedger.totals(Date.now()),
      providerKeys: providerKeys.describe(),
      chatNameInterval,
      autoResumeRateLimit: autoResumeRateLimit || undefined,
      // Both stated UNCONDITIONALLY. `|| undefined` would erase a deliberate
      // `false`, and Settings reads the absence of these two as "this host
      // is too old to have the setting" rather than as "off".
      questionExpiry,
      questionExpirySeconds,
      ...(harnessSystemPrompt !== undefined ? { harnessSystemPrompt } : {}),
      ...(harnessToolsPrompt !== undefined ? { harnessToolsPrompt } : {}),
      harnessToolsPromptDefault: getPatchToolsPrompt(),
      ...(harnessSkills !== undefined ? { harnessSkills } : {}),
      harnessMemoryEnabled,
      harnessBrowserToolsEnabled: browserToolsEnabledOf(harnessMcpServers),
      harnessMcpServers,
      // Always true: kept on the report so a surface that still reads it
      // shows the (only) state rather than "unsupported".
      harnessClaudeMdEnabled: true,
      browserRouteThrough: browserRouteThrough ?? null,
    });

  /**
   * Refuse a credential frame naming a backend this machine does not have
   * (spec/03 § Host events — "a credential operation naming a backend that
   * machine does not have" is rejected with the offending value named).
   *
   * Returns true when the frame was refused, so the caller stops. A silent
   * drop here is the failure mode this exists to prevent: the surface's
   * Connect button would appear to work and the machine would stay logged out,
   * which is indistinguishable from a credential that did not take.
   */
  const refuseUnknownBackend = (
    frameType:
      | 'host.backend_connect'
      | 'host.backend_disconnect'
      | 'host.backend_add_account'
      | 'host.backend_usage_refresh'
      | 'host.backend_reorder_accounts',
    backendId: string,
    send: (event: import('@patch/wire').WireEvent) => void,
  ): boolean => {
    const offered = describeHost().backends.map((b) => b.id);
    if (offered.includes(backendId)) return false;
    const message = `${frameType}: this machine has no backend with id: ${backendId} (has: ${offered.join(', ')})`;
    logger.warn({ backendId, offered }, message);
    send({
      type: 'chat.error',
      chatId: 'pending-spawn',
      error: { code: 'backend_not_found', message },
      seq: OUT_OF_BAND_SEQ,
    });
    return true;
  };

  /**
   * This host's last-used model (spec/02 § Agent backends). ABSENT until the
   * host reads a catalogue successfully — a host that has never read one has
   * none, and a spawn there naming no model must fail saying so rather than
   * inherit a guess.
   */
  /**
   * The model this machine's model-less spawns run on: the ACCOUNT's
   * `defaultModel`, mirrored down by the server over `host.settings`.
   *
   * Persisted, so a host restarting before the server's first push still has
   * it. Nothing on this machine derives it — that is the whole change. It used
   * to be `lastUsedModel`, seeded from the newest entry of the first catalogue
   * read and then overwritten by every spawn that named a model, which meant
   * the machine's default was the trailing edge of whatever anyone last ran.
   * One throwaway cheap-model chat moved every unattended job onto it.
   */
  let defaultModel: string | undefined = persistedHostState.defaultModel;

  /** Take the account default the server just sent, and tell the surfaces. */
  const setDefaultModel = (model: string): void => {
    if (model === defaultModel) return;
    defaultModel = model;
    hostStateStore.update({ defaultModel: model });
    logger.info({ defaultModel: model }, 'account default model changed');
    publishHost();
  };

  /** Re-publish this machine's self-description to every surface. */
  const publishHost = (): void => {
    link.send(describeHost());
  };
  // A provider key set or revoked from Settings: every surface's Keys block and
  // Settings → Voice's "not configured" line follow from the fresh report, and
  // the log says which configured surfaces are now without a key.
  providerKeys.onChange(() => {
    logVoiceKeysMissing(logger, voiceConfig, voiceKeys());
    publishHost();
  });

  /**
   * Optional components (spec/02 § Optional components) — real downloads onto
   * this machine's disk, with live progress.
   */
  const components = new ComponentManager({
    root: join(config.patchHome, 'components'),
    daemonId: selfDaemonId,
    emit: (event) => link.send(event),
    logger: logger.child({ component: 'components' }),
    onSettled: () => publishHost(),
    // spec/02 § Optional components: a voice component's weights are useless
    // without the Python sidecar that reads them, and the artifact carries that
    // sidecar's source and none of its wheels. Installing the component is where
    // the runtime gets built — on demand, per machine, never in the host
    // install itself.
    provisionRuntime: async (spec, onProgress) => {
      const runtime = spec.runtime;
      /* v8 ignore next -- only called for a spec that declares a runtime. */
      if (runtime === undefined) return;
      const sourceDir = bundledSidecarDir(runtime.sidecar);
      await provisionSidecarRuntime({
        sourceDir,
        venvDir: componentRuntimeDir(join(config.patchHome, 'components'), spec.id),
        run: runProcess,
        resolveUv: () =>
          resolveUv({
            candidates: uvCandidates(config.patchHome),
            installDir: join(config.patchHome, 'tools'),
            run: runProcess,
            onProgress,
          }),
        onProgress,
        ...(runtime.extraWheels ? { extraWheels: runtime.extraWheels } : {}),
      });
    },
  });

  // Whether the server link is authed (used by RemoteJobsStore to gate RPC).
  let linkOnline = false;
  /**
   * Which OTHER machines are linked right now. The server pushes presence to
   * every machine, because a cross-chat call naming a machine that is down has
   * to fail INSIDE the turn rather than buffer (spec/03 § Cross-chat tools).
   */
  const onlineHosts = new Set<string>();
  /**
   * Display names for other known hosts, from the greeting's roster
   * (spec/02 § Browser — Route through). Only used for a human-readable
   * name on the RoutingHostOfflineError / the `routedVia` indicator — the
   * daemonId itself, which is always correct, is the fallback.
   */
  const hostNames = new Map<string, string>();
  /**
   * In-flight `patch.list_chats.request` calls, keyed by the chat that asked.
   * The server owns the account-wide chat list: only it sees every machine's
   * chats, and each entry it returns names the machine that chat lives on.
   */
  const listChatsWaiters = new Map<
    string,
    Array<(chats: Array<{ chatId: string; daemonId: string }>) => void>
  >();
  const resolveListChats = (event: {
    sourceChatId: string;
    chats: Array<{ chatId: string; daemonId: string }>;
  }): void => {
    const waiters = listChatsWaiters.get(event.sourceChatId);
    if (!waiters || waiters.length === 0) return;
    const next = waiters.shift();
    if (waiters.length === 0) listChatsWaiters.delete(event.sourceChatId);
    next?.(event.chats);
  };
  const LIST_CHATS_TIMEOUT_MS = 10_000;
  /**
   * Ask the server for every chat on the account with the machine each lives
   * on. NO FALLBACK to this machine's own chats: a list that silently omits the
   * other machines' chats is worse than an error saying the link is down.
   */
  const requestAccountChats = async (
    sourceChatId: string,
    archived?: 'only' | 'include',
  ): Promise<Array<{ chatId: string; daemonId: string }>> => {
    if (!linkOnline) {
      throw new Error('patch_list_chats: the server link is offline; cannot list other machines');
    }
    return await new Promise((resolve, reject) => {
      const waiters = listChatsWaiters.get(sourceChatId) ?? [];
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(onResolve);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error('patch_list_chats: the server did not answer within 10s'));
      }, LIST_CHATS_TIMEOUT_MS);
      timer.unref();
      function onResolve(chats: Array<{ chatId: string; daemonId: string }>): void {
        clearTimeout(timer);
        resolve(chats);
      }
      waiters.push(onResolve);
      listChatsWaiters.set(sourceChatId, waiters);
      link.send({
        type: 'patch.list_chats.request',
        sourceChatId,
        ...(archived !== undefined ? { archived } : {}),
      });
    });
  };
  /**
   * `patch_activity` (spec/06 § Cross-chat toolset): the user's own messages
   * are read through every machine's chat logs, which only the server can
   * gather, so this is a plain account-wide ask — same waiter-map shape as `requestAccountChats`, no
   * per-chat host resolution needed.
   */
  const activityWaiters = new Map<string, Array<(event: PatchActivityResponseEvent) => void>>();
  const resolveActivity = (event: PatchActivityResponseEvent): void => {
    const waiters = activityWaiters.get(event.sourceChatId);
    if (!waiters || waiters.length === 0) return;
    const next = waiters.shift();
    if (waiters.length === 0) activityWaiters.delete(event.sourceChatId);
    next?.(event);
  };
  const ACTIVITY_TIMEOUT_MS = 10_000;
  const requestActivity = async (
    sourceChatId: string,
    since: number,
    until: number,
    messagesCursor?: number,
    limit?: number,
  ): Promise<PatchActivityResponseEvent> => {
    if (!linkOnline) {
      throw new Error('patch_activity: the server link is offline; cannot read activity');
    }
    return await new Promise((resolve, reject) => {
      const waiters = activityWaiters.get(sourceChatId) ?? [];
      const timer = setTimeout(() => {
        const idx = waiters.indexOf(onResolve);
        if (idx >= 0) waiters.splice(idx, 1);
        reject(new Error('patch_activity: the server did not answer within 10s'));
      }, ACTIVITY_TIMEOUT_MS);
      timer.unref();
      function onResolve(event: PatchActivityResponseEvent): void {
        clearTimeout(timer);
        resolve(event);
      }
      waiters.push(onResolve);
      activityWaiters.set(sourceChatId, waiters);
      link.send({
        type: 'patch.activity.request',
        sourceChatId,
        since,
        until,
        ...(messagesCursor !== undefined ? { messagesCursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    });
  };
  /**
   * Cross-machine `patch_spawn`: emits the request and waits for the NAMED
   * machine's own `patch.spawn.response` (see remote-spawn.ts for why a
   * fire-and-forget spawn was a silent-failure hole).
   */
  const remoteSpawns = createRemoteSpawnCoordinator({
    emit: (event) => emit(event),
    onUnknownResponse: (requestId) =>
      logger.warn({ requestId }, 'patch.spawn.response for an unknown request; dropping'),
  });
  const spawnOnRemoteHost = (req: RemoteSpawnRequest): Promise<{ chatId?: string }> =>
    remoteSpawns.spawn(req);

  /**
   * Cross-host `patch_peek` / `patch_history` / `patch_send_to` (spec/03
   * § Cross-chat tools): one coordinator per tool, sharing the requestId →
   * waiter shape `remote-spawn.ts` established. Each mints ids under its own
   * prefix so the three can share the server's single relay-route map with no
   * risk of collision (`cross-host.ts`).
   */
  const remotePeeks = createRemoteRelayCoordinator<{
    chat_state: unknown;
    events: unknown[];
    truncated: boolean;
  }>({
    emit: (event) => emit(event),
    idPrefix: 'rpeek',
    onUnknownResponse: (requestId) =>
      logger.warn({ requestId }, 'patch.peek.response for an unknown request; dropping'),
  });
  const remoteHistories = createRemoteRelayCoordinator<{
    events: WireEvent[];
    nextFromSeq?: number;
  }>({
    emit: (event) => emit(event),
    idPrefix: 'rhist',
    onUnknownResponse: (requestId) =>
      logger.warn({ requestId }, 'patch.history.response for an unknown request; dropping'),
  });
  const remoteSendTos = createRemoteRelayCoordinator<undefined>({
    emit: (event) => emit(event),
    idPrefix: 'rsend',
    onUnknownResponse: (requestId) =>
      logger.warn({ requestId }, 'patch.send_to.response for an unknown request; dropping'),
  });

  // spec/02 § Browser — Route through. This host's two independent roles:
  // the BROWSING half (its own `patch_browser_*` traffic egressing via
  // another host, when `browserRouteThrough` names one) and the ROUTING
  // half (answering another host's `open` for ITS browser, whenever one
  // names THIS host — both can be true of the same machine at once).
  const browserTunnelClient = new BrowserTunnelClient({
    logger: logger.child({ component: 'browser-tunnel-client' }),
    sender: (_daemonId, event) => emit(event),
  });
  const browserTunnelRelay = new BrowserTunnelRelay({
    logger: logger.child({ component: 'browser-tunnel-relay' }),
    sender: (event) => emit(event),
  });
  // spec/07 § Voice is a per-host capability, spec/03 § Audio relay over the
  // host link: this host's half of the cross-host audio relay, bridging a
  // session the server has tunnelled over THIS link to this host's own local
  // audio WSS — loopback, always reachable, regardless of what `audio.host`
  // is bound to for a surface dialling in directly.
  const audioRelayBridge = new AudioRelayBridge({
    logger: logger.child({ component: 'audio-relay-bridge' }),
    localAudioUrl: `ws://127.0.0.1:${config.audio.port}`,
    sender: (event) => emit(event),
  });
  const peekRemoteChat = (req: {
    sourceChatId: string;
    targetChatId: string;
    limit?: number;
  }): Promise<{ chat_state: unknown; events: unknown[]; truncated: boolean }> =>
    remotePeeks.call(
      (requestId) => ({
        type: 'patch.peek.request',
        sourceChatId: req.sourceChatId,
        targetChatId: req.targetChatId,
        requestId,
        ...(req.limit !== undefined ? { limit: req.limit } : {}),
      }),
      () => `patch_peek: chat ${req.targetChatId}'s host did not answer in time`,
    );
  const historyRemoteChat = (req: {
    sourceChatId: string;
    targetChatId: string;
    fromSeq?: number;
    limit?: number;
  }): Promise<{ events: WireEvent[]; nextFromSeq?: number }> =>
    remoteHistories.call(
      (requestId) => ({
        type: 'patch.history.request',
        sourceChatId: req.sourceChatId,
        targetChatId: req.targetChatId,
        requestId,
        ...(req.fromSeq !== undefined ? { fromSeq: req.fromSeq } : {}),
        ...(req.limit !== undefined ? { limit: req.limit } : {}),
      }),
      () => `patch_history: chat ${req.targetChatId}'s host did not answer in time`,
    );
  const sendToRemoteChat = (req: {
    sourceChatId: string;
    targetChatId: string;
    message: string;
    voicePrefix?: string;
  }): Promise<void> =>
    remoteSendTos
      .call(
        (requestId) => ({
          type: 'patch.send_to',
          sourceChatId: req.sourceChatId,
          targetChatId: req.targetChatId,
          message: req.message,
          requestId,
          ...(req.voicePrefix !== undefined ? { voicePrefix: req.voicePrefix } : {}),
        }),
        () => `patch_send_to: chat ${req.targetChatId}'s host did not answer in time`,
      )
      .then(() => undefined);

  // Forward-declared so the onFrame closure (constructed below, before the
  // audio server boots) can route `chat.focus_change` into the surface's open
  // voice session for focus-follow (spec/07 ## Focus-follow). Assigned once the
  // audio WSS is up at step 8.
  let audioServer: AudioServerHandle | undefined;
  // Forward-declared so the onFrame closure (constructed below, before the
  // whisper backend is built at step 8) can service the server's
  // `patch.voice_note.transcribe_request` RPC (spec/07 § End-to-end voice
  // transport — the mobile voice-note upload path). Assigned once the whisper
  // backend is created at step 8.
  let whisper: WhisperBackend | undefined;
  // The dictation surface's transcribers, one per backend this host has a key
  // for (hosted-stt.ts). Assigned alongside `whisper` at step 8; the
  // transcribe RPC below picks from them by `voiceConfig.dictation.backend`.
  let dictationTranscribers: DictationTranscribers | undefined;
  // Meeting mode (meeting.ts). Built once the Daemon exists; the link handler and
  // the preprocessInput hook below only run after full wiring.
  let meetings: MeetingManager | undefined;
  // Host-owned folder registry (spec/04 § Folders). Assigned once the host
  // graph is built (below); referenced by the onAuthed / emit closures, which
  // only run after full wiring. Publishes `folders.list` on connect and
  // `folders.updated` on change.
  let folderRegistry: FolderRegistry;
  // Host-owned secret store (spec/15 § Secrets). The host owns the store
  // (it injects secrets into chats); it publishes `secrets.list` on connect and
  // `secrets.updated` after every mutation so every surface's editor reflects
  // the current set. Loaded eagerly from `<patchHome>/secrets.json`.
  const secretsStore: SecretsStore = createSecretsStore(config.patchHome);
  // Terminal sessions (spec/02 § Terminal sessions). Shells on the host,
  // driven from a surface's terminal drawer — the route by which a folder that
  // isn't on the host yet (a repo to clone) gets there. Its `emit` is bound to
  // the live link sender inside the onFrame handler, which is the only place a
  // sender is in scope; sessions are only ever created from a surface frame, so
  // there is nothing to emit before then.
  let terminalSend: ((event: WireEvent) => void) | undefined;
  const terminals = new TerminalSessions({
    // A session opened with no folder (the new-chat drawer) starts in the first
    // published project root that actually exists — where a clone is going. The
    // container's $HOME is /root while the project dirs are mounted elsewhere,
    // so homing there would land the user somewhere they'd only have to cd out
    // of. `ready.cwd` still reports whatever it resolved to.
    defaultCwd: () =>
      folderRegistry.list().find((f) => {
        try {
          return statSync(f).isDirectory();
        } catch {
          return false;
        }
      }),
    emit: (event) => {
      // Unreachable in practice: every emit is downstream of a frame we just
      // received, so the sender is always bound by then.
      /* v8 ignore next */
      if (!terminalSend) return;
      terminalSend(event);
    },
    logger,
  });
  // The outbound server link owns its own offline buffer (cap 10k, drop-oldest;
  // spec/12). `emit` always routes through it — buffered while offline, sent
  // live once authed.
  /**
   * Run on the shared settings (spec/01 § Settings): every setting the snapshot
   * carries replaces this host's, so the machine does what Settings says rather
   * than what it was last told locally.
   */
  /**
   * How each backend picks the account a turn starts on (spec/10 § Backend
   * credentials — account strategy). Priority until the first snapshot says.
   */
  let accountStrategy: SharedSettings['accountStrategy'] = DEFAULT_SHARED_SETTINGS.accountStrategy;

  const applySharedHostSettings = (shared: SharedSettings): void => {
    if (shared.permissionModeDefault !== daemon.permissionModeDefault()) {
      daemon.setPermissionModeDefault(shared.permissionModeDefault);
      hostStateStore.update({ permissionModeDefault: shared.permissionModeDefault });
      logger.info(
        { permissionModeDefault: shared.permissionModeDefault },
        'default permission mode changed',
      );
    }
    setDefaultModel(shared.defaultModel);
    if (JSON.stringify(shared.voiceConfig) !== JSON.stringify(voiceConfig)) {
      voiceConfig = shared.voiceConfig;
      hostStateStore.update({ voiceConfig });
      logger.info({ voiceConfig }, 'voice config changed');
      logVoiceKeysMissing(logger, voiceConfig, voiceKeys());
    }
    if (shared.kokoroVoice !== undefined && shared.kokoroVoice !== kokoroVoice) {
      kokoroVoice = shared.kokoroVoice;
      hostStateStore.update({ kokoroVoice });
      logger.info({ kokoroVoice }, 'kokoro voice changed');
    }
    if (shared.managerContextWindow !== managerContextWindow) {
      managerContextWindow = shared.managerContextWindow;
      daemon.setManagerContextWindow(managerContextWindow);
      hostStateStore.update({ managerContextWindow });
      logger.info({ managerContextWindow }, 'manager context window changed');
    }
    if (
      shared.goalEvalPrompt !== goalEvalPrompt ||
      shared.goalModel !== goalModel ||
      shared.goalRefusalLimit !== goalRefusalLimit
    ) {
      goalEvalPrompt = shared.goalEvalPrompt;
      goalModel = shared.goalModel;
      goalRefusalLimit = shared.goalRefusalLimit;
      daemon.setGoalRefusalLimit(goalRefusalLimit);
      hostStateStore.update({ goalEvalPrompt, goalModel, goalRefusalLimit });
      logger.info({ goalModel, goalRefusalLimit }, 'goal settings changed');
    }
    if (shared.chatNameInterval !== chatNameInterval) {
      chatNameInterval = shared.chatNameInterval;
      daemon.setChatNameInterval(chatNameInterval);
      hostStateStore.update({ chatNameInterval });
    }
    if (shared.autoResumeRateLimit !== autoResumeRateLimit) {
      autoResumeRateLimit = shared.autoResumeRateLimit;
      daemon.setAutoResumeRateLimit(autoResumeRateLimit);
      hostStateStore.update({ autoResumeRateLimit });
    }
    if (
      shared.questionExpiry !== questionExpiry ||
      shared.questionExpirySeconds !== questionExpirySeconds
    ) {
      questionExpiry = shared.questionExpiry;
      questionExpirySeconds = shared.questionExpirySeconds;
      daemon.setQuestionExpiry({ enabled: questionExpiry, seconds: questionExpirySeconds });
      hostStateStore.update({ questionExpiry, questionExpirySeconds });
    }
    const systemPrompt = shared.harnessSystemPrompt || undefined;
    const toolsPrompt = toolsPromptOverride(shared.harnessToolsPrompt);
    const skills = shared.harnessSkills ?? undefined;
    if (
      systemPrompt !== harnessSystemPrompt ||
      toolsPrompt !== harnessToolsPrompt ||
      JSON.stringify(skills) !== JSON.stringify(harnessSkills) ||
      shared.harnessMemoryEnabled !== harnessMemoryEnabled
    ) {
      harnessSystemPrompt = systemPrompt;
      harnessToolsPrompt = toolsPrompt;
      harnessSkills = skills;
      harnessMemoryEnabled = shared.harnessMemoryEnabled;
      hostStateStore.update({
        harnessSystemPrompt,
        harnessToolsPrompt,
        harnessSkills,
        harnessMemoryEnabled,
      });
      applyHarnessConfig();
      logger.info('agent behaviour layers changed');
    }
    accountStrategy = shared.accountStrategy;
  };

  /** The last snapshot's Claude accounts, to tell a refresh on this host from the server's. */
  let sharedClaude: SharedSecrets['claude'] = [];

  /**
   * Apply one `settings.snapshot`. Each part is applied on its own: a part that
   * cannot be applied is named in the returned error, and the rest still take
   * effect, so one refused key does not leave every other setting stale.
   */
  const applySnapshot = async (snapshot: SettingsSnapshotEvent): Promise<string | undefined> => {
    const errors: string[] = [];
    const part = async (name: string, run: () => void | Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (err) {
        errors.push(`${name}: ${(err as Error).message}`);
        logger.error(
          { part: name, err: (err as Error).message },
          'shared settings: part not applied',
        );
      }
    };
    await part('settings', () => applySharedHostSettings(snapshot.settings));
    await part('Claude accounts', () => {
      const before = JSON.stringify(readPatchStore(oauthOpts)?.accounts ?? []);
      writePatchStore(
        {
          accounts: snapshot.secrets.claude,
          activeAccountId: snapshot.secrets.claude[0]?.id ?? null,
        },
        oauthOpts,
      );
      sharedClaude = snapshot.secrets.claude;
      if (JSON.stringify(snapshot.secrets.claude) !== before) {
        // The keys changed: every out-of-credit reading is about keys that may
        // no longer be the ones held, so it is dropped and read afresh.
        accountRotation.clearAll();
        void accountUsage?.refreshAll(true);
        creditResume.credentialChanged('shared accounts changed');
        void refreshCredentialState();
      }
    });
    await part('OpenAI accounts', () => codexAccounts.applyShared(snapshot.secrets.codex));
    await part('provider keys', () => {
      try {
        providerKeys.replaceAll(snapshot.secrets.providerKeys);
      } catch (err) {
        if (err instanceof ProviderKeyError) throw new Error(err.message);
        throw err;
      }
    });
    await part('Claude Code settings.json', () => {
      claudeSettingsFile.apply(claudeSettingsFor(snapshot.settings.claudeSettings, settingsOs()));
      link.send({
        type: 'claude_settings.updated',
        daemonId: selfDaemonId,
        ...claudeSettingsSnapshot(),
      });
    });
    link.send(buildAccountReport());
    publishHost();
    logger.info({ version: snapshot.version, errors }, 'shared settings: snapshot applied');
    return errors.length ? errors.join('; ') : undefined;
  };

  /**
   * Send a value this machine holds up to the server (spec/01 § Settings —
   * values that start on a host). `import` is everything held before settings
   * were shared, asked once per host.
   */
  const answerAdopt = async (
    request: SettingsAdoptRequestEvent,
  ): Promise<SettingsAdoptResponseEvent> => {
    const base = {
      type: 'settings.adopt.response' as const,
      requestId: request.requestId,
      daemonId: selfDaemonId,
    };
    try {
      switch (request.kind) {
        case 'import': {
          const state = hostStateStore.get();
          const settings: SharedSettingsPatch = {
            ...(state.permissionModeDefault
              ? { permissionModeDefault: state.permissionModeDefault }
              : {}),
            ...(state.voiceConfig ? { voiceConfig: state.voiceConfig } : {}),
            ...(state.kokoroVoice ? { kokoroVoice: state.kokoroVoice } : {}),
            chatNameInterval,
            autoResumeRateLimit,
            questionExpiry,
            questionExpirySeconds,
            harnessSystemPrompt: harnessSystemPrompt ?? '',
            harnessToolsPrompt: harnessToolsPrompt ?? null,
            harnessSkills: harnessSkills ?? null,
            harnessMemoryEnabled,
            claudeSettings: { shared: claudeSettingsFile.text(), darwin: '', linux: '' },
          };
          const store = readPatchStore(oauthOpts);
          return {
            ...base,
            ok: true,
            result: {
              kind: 'import',
              import: {
                settings,
                secrets: {
                  claude: (store?.accounts ?? []).map((a) => ({
                    id: a.id,
                    label: a.label,
                    credential: a.credential
                      ? {
                          accessToken: a.credential.accessToken,
                          ...(a.credential.refreshToken
                            ? { refreshToken: a.credential.refreshToken }
                            : {}),
                          ...(a.credential.expiresAt !== undefined
                            ? { expiresAt: a.credential.expiresAt }
                            : {}),
                          ...(a.credential.email ? { email: a.credential.email } : {}),
                          ...(a.credential.organizationId
                            ? { organizationId: a.credential.organizationId }
                            : {}),
                        }
                      : null,
                  })),
                  codex: codexAccounts.exportAll(),
                  providerKeys: providerKeys.settingsKeys(),
                },
              },
            },
          };
        }
        case 'claude-login': {
          const legacy = loadLegacyClaudeOAuth(
            config.claudeCredentialsPath !== undefined
              ? { path: config.claudeCredentialsPath }
              : {},
          );
          return {
            ...base,
            ok: true,
            result: {
              kind: 'claude-login',
              account: {
                id: randomUUID(),
                label: legacy.email ?? `Claude (${hostName})`,
                credential: {
                  accessToken: legacy.accessToken,
                  ...(legacy.refreshToken ? { refreshToken: legacy.refreshToken } : {}),
                  ...(legacy.expiresAt !== undefined ? { expiresAt: legacy.expiresAt } : {}),
                  ...(legacy.email ? { email: legacy.email } : {}),
                },
              },
            },
          };
        }
        case 'codex-login':
          return {
            ...base,
            ok: true,
            result: { kind: 'codex-login', account: await codexAccounts.exportMachineLogin() },
          };
        case 'provider-key': {
          const parsed = ProviderKeyId.safeParse(request.id);
          if (!parsed.success) throw new Error(`no provider key ${request.id ?? '(none)'}`);
          const value = providerKeys.envValue(parsed.data);
          if (!value) throw new Error(`${hostName} has no ${parsed.data} key in its environment`);
          return { ...base, ok: true, result: { kind: 'provider-key', id: parsed.data, value } };
        }
        case 'claude-settings':
          return {
            ...base,
            ok: true,
            result: { kind: 'claude-settings', text: claudeSettingsFile.text() },
          };
        case 'codex-signin':
          throw new Error('a ChatGPT sign-in is started with host.backend_add_account');
      }
    } catch (err) {
      logger.warn(
        { kind: request.kind, err: (err as Error).message },
        'shared settings: nothing to send up',
      );
      return { ...base, ok: false, error: (err as Error).message };
    }
  };

  /**
   * Credentials refreshed on this host while running turns go to the server,
   * which stores them and sends them to every other host (spec/01 § Settings).
   * Checked on a timer rather than hooked into each refresh path, so a refresh
   * done by Claude Code or Codex themselves is caught as well as patch's own.
   */
  const reportRefreshedCredentials = (): void => {
    if (sharedClaude.length > 0) {
      for (const account of readPatchStore(oauthOpts)?.accounts ?? []) {
        const shared = sharedClaude.find((a) => a.id === account.id);
        if (!shared?.credential || !account.credential) continue;
        if (account.credential.accessToken === shared.credential.accessToken) continue;
        const credential = {
          ...shared.credential,
          accessToken: account.credential.accessToken,
          ...(account.credential.refreshToken
            ? { refreshToken: account.credential.refreshToken }
            : {}),
          ...(account.credential.expiresAt !== undefined
            ? { expiresAt: account.credential.expiresAt }
            : {}),
        };
        shared.credential = credential;
        link.send({
          type: 'settings.secret_update',
          daemonId: selfDaemonId,
          update: { backendId: 'claude-code', accountId: account.id, credential },
        });
      }
    }
    for (const refreshed of codexAccounts.refreshedLogins()) {
      link.send({
        type: 'settings.secret_update',
        daemonId: selfDaemonId,
        update: { backendId: 'codex', ...refreshed },
      });
    }
  };
  const credentialReportTimer = setInterval(reportRefreshedCredentials, 60_000);
  credentialReportTimer.unref();

  const link = createServerLink({
    url: config.serverWsUrl,
    daemonKey,
    clientVersion: VERSION,
    clientGitSha: GIT_SHA,
    clientBuiltAt: BUILT_AT,
    logger,
    // The server speaks a protocol this build cannot read, so the matching
    // build is (or is about to be) published — go and get it. The update gate
    // joins repeat calls from each reconnect and waits out running turns.
    onGreetingUnreadable: () => {
      void applyUpdateOnce().then(
        (result) =>
          logger.warn(
            { applied: result.applied, deferred: result.deferred, result: result.message },
            'self-update: requested because the server greeting was unreadable',
          ),
        (err: unknown) =>
          logger.error({ err }, 'self-update: failed after an unreadable server greeting'),
      );
    },
    onAuthed: (sender, greeting) => {
      linkOnline = true;
      // Adopt the account's machine roster from the greeting, so a cross-chat
      // call naming another machine knows whether that machine is up.
      onlineHosts.clear();
      for (const host of greeting.hosts) {
        if (host.online && host.daemonId !== selfDaemonId) onlineHosts.add(host.daemonId);
        if (host.host?.hostName) hostNames.set(host.daemonId, host.host.hostName);
      }
      // Group 8 fix (DX-M1): the server's ChatRegistry is purely in-memory and
      // gated to admit `chat.state` only for chatIds it has previously seen
      // `chat.spawned` for. After a server restart the gate would suppress
      // every chat-state we re-emit. Replay the currently-known chats so the
      // server seeds its registry. (`daemon.online` is now server-emitted.)
      if (oauth.error) {
        sender({
          type: 'daemon.unauthenticated',
          daemonId: selfDaemonId,
          backendId: CLAUDE_BACKEND_ID,
          reason: oauth.error.message,
        });
      }
      // spec/02 § Host identity — this host's self-description, so a surface
      // can render the Hosts list from the link alone. The server caches it and
      // replays it in every later surface's auth.ok greeting.
      sender(describeHost());
      // spec/10 § Backend credentials — per (host, backend) credential state,
      // so Settings can say which backend on which machine needs a login.
      sender(buildAccountReport());
      sender(codexAccounts.report());
      for (const state of daemon.list()) announceChat(state);
      // spec/04 § Folders: publish the host-owned folder list so every
      // surface's new-chat / schedule-editor picker is populated from the same
      // source. `snapshot()` records the baseline so a later identical
      // `refresh()` won't fire a redundant `folders.updated`.
      // AFTER every chat above: the server reads this host's folders.list as the
      // end of its chat re-announcement, and only then answers a chat it does
      // not know as not found (packages/server/src/unknown-chat.ts).
      sender({ type: 'folders.list', daemonId: selfDaemonId, ...folderRegistry.snapshot() });
      // spec/02 § Claude Code settings: publish this host's settings.json and
      // memory entries on (re)connect, same snapshot-on-connect contract as
      // folders and secrets below.
      sender({ type: 'claude_settings.list', daemonId: selfDaemonId, ...claudeSettingsSnapshot() });
      // spec/02 § Agent backends — warm the catalogue on connect so a picker
      // opens on a real list rather than an empty one. It no longer SEEDS
      // anything: the model a model-less spawn takes is the account default the
      // server pushes, not the newest entry of whatever catalogue this machine
      // happened to read first.
      void modelCatalog.get().catch((err: unknown) => {
        logger.warn(
          { err: (err as Error).message },
          'model catalogue read failed on connect; pickers open empty until it succeeds',
        );
      });
      // spec/15 § Secrets: publish the host-owned secret set so every
      // surface's editor is populated from the same source on (re)connect.
      sender({ type: 'secrets.list', secrets: secretsStore.list() });
    },
    onFrame: async (event, sender) => {
      // Host addressing, checked once for the whole inbound stream: ANY frame
      // carrying a `daemonId` names one machine, and this host acts on it only
      // when that machine is this one. Reaching here otherwise means the server
      // mis-routed, and obeying it would spawn a chat / edit a registry / open a
      // shell on the wrong machine — strictly worse than refusing with both ids
      // named. NO FALLBACK.
      const addressed = isHostAddressedSurfaceEvent(event.type)
        ? (event as { daemonId?: unknown }).daemonId
        : undefined;
      if (typeof addressed === 'string' && !isForThisHost(addressed, event.type)) {
        // A spawn is the one case a surface is synchronously waiting on, so it
        // gets the refusal as a frame rather than only a log line.
        if (event.type === 'chat.spawn_request') {
          sender({
            type: 'chat.error',
            chatId: event.chatId ?? 'pending-spawn',
            error: {
              code: 'host_not_registered',
              message: `chat.spawn_request addressed to ${addressed}, but this machine is ${selfDaemonId}`,
            },
            seq: OUT_OF_BAND_SEQ,
          });
        }
        return;
      }
      // Jobs RPC responses route directly into the RemoteJobsStore's
      // pending-request map; everything else flows through the surface
      // event handler.
      if (event.type === 'patch.jobs.response') {
        jobs.handleResponse(event);
        return;
      }
      if (event.type === 'patch.artifact.publish_response') {
        artifactPublisher.handleResponse(event);
        return;
      }
      if (event.type === 'patch.log_sync.request') {
        // The server's log of this chat is behind ours (spec/01 § Message log):
        // send what it lacks, from our own log, in order.
        let events: WireEvent[] = [];
        try {
          events = daemon.eventsAfter(event.chatId, event.afterSeq);
        } catch (err) {
          logger.warn({ chatId: event.chatId, err }, 'log sync: could not read the chat');
        }
        // Chunked by size as well as count, so one chat's big results never make
        // a frame the link refuses.
        const chunks: WireEvent[][] = [[]];
        let bytes = 0;
        for (const e of events) {
          const size = JSON.stringify(e).length;
          const open = chunks[chunks.length - 1]!;
          if (open.length > 0 && (open.length >= 200 || bytes + size > REPLAY_BATCH_BYTES)) {
            chunks.push([]);
            bytes = 0;
          }
          chunks[chunks.length - 1]!.push(e);
          bytes += size;
        }
        chunks.forEach((chunk, i) => {
          emit({
            type: 'patch.log_sync.batch',
            chatId: event.chatId,
            events: chunk,
            done: i === chunks.length - 1,
          });
        });
        return;
      }
      if (event.type === 'patch.log_restore') {
        // Our log of this chat is behind the server's: write what it lacks.
        try {
          const written = daemon.restoreEvents(event.chatId, event.events as WireEvent[]);
          if (written > 0)
            logger.info({ chatId: event.chatId, written }, 'log restored from the server');
        } catch (err) {
          logger.warn({ chatId: event.chatId, err }, 'log restore: could not write the chat');
        }
        return;
      }
      if (event.type === 'chat.committed') {
        daemon.noteCommitted(event.chatId, event.through);
        return;
      }
      if (event.type === 'server.queue_mode') {
        queuePull.setEnabled(event.enabled);
        return;
      }
      if (event.type === 'patch.queue_pull.response') {
        queuePull.handleResponse(event);
        return;
      }
      if (event.type === 'patch.pad.response') {
        padClient.handleResponse(event);
        return;
      }
      if (event.type === 'patch.files.request') {
        void handleFilesRequest(event, daemon, sender, logger);
        return;
      }
      if (event.type === 'patch.file_op.request') {
        handleFileOpRequest(event, daemon, sender);
        return;
      }
      if (event.type === 'patch.doc.request') {
        handleDocRequest(event, daemon, sender);
        return;
      }
      if (event.type === 'patch.doc_action.request') {
        handleDocActionRequest(event, daemon, sender);
        return;
      }
      if (event.type === 'patch.doc_convert.request') {
        void handleDocConvertRequest(event, daemon, sender);
        return;
      }
      if (event.type === 'patch.doc_export.request') {
        void handleDocExportRequest(event, daemon, sender);
        return;
      }
      if (event.type === 'patch.background_task_stats.request') {
        // The measurement shells out to `lsof`/`ps`, so it is deliberately not
        // awaited here: a slow process-table scan must not stall the frames
        // queued behind it. The surface's request has its own timeout.
        void handleBackgroundTaskStatsRequest(
          event,
          (chatId) => daemon.chatState.get(chatId) !== undefined,
          sender,
          logger,
        );
        return;
      }
      if (event.type === 'patch.watch_list.request') {
        handleWatchListRequest(
          event,
          {
            hasChat: (chatId) => daemon.chatState.get(chatId) !== undefined,
            listWatch: (chatId) => daemon.listWatch(chatId),
            stopWatch: (chatId, taskId) => daemon.stopWatch(chatId, taskId),
          },
          sender,
          logger,
        );
        return;
      }
      if (event.type === 'patch.watch_stop.request') {
        handleWatchStopRequest(
          event,
          {
            hasChat: (chatId) => daemon.chatState.get(chatId) !== undefined,
            listWatch: (chatId) => daemon.listWatch(chatId),
            stopWatch: (chatId, taskId) => daemon.stopWatch(chatId, taskId),
          },
          sender,
          logger,
        );
        return;
      }
      if (event.type === 'patch.chat_history.request') {
        handleChatHistoryRequest(event, daemon, sender, logger);
        return;
      }
      if (event.type === 'patch.skills.request') {
        void handleSkillsRequest(event, sender, logger);
        return;
      }
      if (event.type === 'patch.chat_search.request') {
        void handleChatSearchRequest(
          event,
          {
            index: chatSearch,
            ready: chatSearchReady,
            // A patch_delegate subagent never reaches the server to be indexed
            // any other way, but filter it out here too rather than rely on
            // that alone (spec/02 § Native subagent dispatch).
            listChats: () => daemon.list().filter((c) => !c.subagent),
            daemonId: selfDaemonId,
            logger,
          },
          sender,
        );
        return;
      }
      if (event.type === 'patch.models.request') {
        void handleModelsRequest(event, modelCatalog, sender, logger, selfDaemonId, codexAccounts);
        return;
      }
      if (event.type === 'patch.recurrence.translate.request') {
        void handleRecurrenceTranslateRequest(
          event,
          translateRecurrenceRule,
          sender,
          logger,
          selfDaemonId,
          config.patchHome,
        );
        return;
      }
      if (event.type === 'patch.folders.browse.request') {
        void handleFoldersBrowseRequest(event, folderRegistry, sender, logger, selfDaemonId);
        return;
      }
      if (event.type === 'settings.snapshot') {
        if (!isForThisHost(event.daemonId, event.type)) return;
        const error = await applySnapshot(event);
        sender({
          type: 'settings.applied',
          daemonId: selfDaemonId,
          version: event.version,
          ...(error ? { error } : {}),
        });
        return;
      }
      if (event.type === 'settings.adopt.request') {
        if (!isForThisHost(event.daemonId, event.type)) return;
        sender(await answerAdopt(event));
        return;
      }
      if (event.type === 'host.claude_settings_discard') {
        if (!isForThisHost(event.daemonId, event.type)) return;
        claudeSettingsFile.discard();
        logger.info('Claude Code settings.json: the change made on this machine was discarded');
        sender({
          type: 'claude_settings.updated',
          daemonId: selfDaemonId,
          ...claudeSettingsSnapshot(),
        });
        return;
      }
      if (event.type === 'patch.chat_move.request') {
        // spec/04 § Moving a chat to another host — one step of a move the
        // server is driving: export / import / retire / release.
        handleChatMoveRequest(event, daemon, sender, logger, selfDaemonId);
        return;
      }
      if (event.type === 'patch.host_files.request') {
        // spec/03 § Host files — the phone's Files screen: read / list / write
        // by absolute path on this machine, with no chat in between.
        void handleHostFilesRequest(event, sender, logger, selfDaemonId, {
          onWritten: (absPath) => daemon.noteHostFileWritten(absPath),
        });
        return;
      }
      if (event.type === 'patch.blob.request') {
        // spec/04 § History — blobs: a tool-output or image body replay
        // deliberately left behind, fetched now that someone is looking at it.
        handleBlobRequest(event, daemon, sender, logger, selfDaemonId);
        return;
      }
      if (
        event.type === 'patch.terminal.open' ||
        event.type === 'patch.terminal.input' ||
        event.type === 'patch.terminal.signal' ||
        event.type === 'patch.terminal.close' ||
        event.type === 'patch.terminal.resize'
      ) {
        // spec/02 § Terminal sessions. The hub stamped `forSurfaceId`; the
        // session manager echoes it onto every frame it emits so the output
        // stream lands on the one surface driving the shell.
        terminalSend = sender;
        terminals.handle(event);
        return;
      }
      if (event.type === 'job.exec_request') {
        // spec/08 § Action — `script`. A job that runs a command on this host
        // instead of starting a chat; the result frame is what settles its run.
        handleJobExec(event, sender, logger);
        return;
      }
      if (event.type === 'hook.check_request') {
        // spec/20-hooks.md — a user-message hook's check. `routedBackend` and
        // the model-aware OAuth resolution below mirror the real chat-turn
        // path (`resolveOAuth` in the host deps further down this file) so a
        // prompt hook runs on whichever backend its model belongs to, on the
        // same credential gate a real turn uses — never a separate paid call.
        void handleHookCheck(event, sender, {
          sdkBackend: routedBackend,
          resolveOAuth: resolveModelOAuth,
          logger,
        });
        return;
      }
      if (event.type === 'patch.voice_note.transcribe_request') {
        // spec/07 § End-to-end voice transport — the mobile voice-note upload
        // path. The server owns the HTTP route + chat.input injection; the
        // host owns Whisper, so it just transcribes the uploaded clip and
        // replies. `whisper` is assigned at step 8 (below); a request arriving
        // before the audio stack is up is reported, not silently dropped.
        void handleVoiceNoteTranscribe(
          event,
          dictationTranscribers,
          voiceConfig.dictation.backend,
          sender,
          logger,
        );
        return;
      }
      if (event.type === 'patch.attachment.store_request') {
        // spec/14 & spec/15 § Composer — the server round-trips an uploaded
        // attachment's bytes here so the host writes a copy under the chat's
        // dir; a later `chat.input` carrying the ref is then fed into the turn
        // by path. The server owns the HTTP route + serving-copy.
        handleAttachmentStore(event, daemon, sender, logger);
        return;
      }
      if (
        event.type === 'patch.secrets.set_request' ||
        event.type === 'patch.secrets.delete_request'
      ) {
        handleSecretsMutation(event, secretsStore, sender, logger);
        return;
      }
      if (event.type === 'chat.focus_change') {
        // A voice call stays on the chat it was started on (spec/07): which chat the
        // surface is looking at does not re-target it.
        // spec/02 § Questions are not approvals: give a pending question's
        // countdown a fresh window on the edge that touches its chat, either
        // way. The hub stamps `forSurfaceId`.
        const forSurfaceId = (event as { forSurfaceId?: string }).forSurfaceId;
        if (forSurfaceId !== undefined) {
          daemon.noteChatFocus(forSurfaceId, event.chatId);
        }
        return;
      }
      if (event.type === 'patch.diag.inject_permission') {
        // DEV/TEST (spec/07 ## Permission prompts during voice): synthesise a
        // permission request so the mid-voice banner + spoken yes/no path is
        // exercisable on the dev stack (tools are auto-approved otherwise).
        daemon.injectPermissionRequest(event.chatId, event.tool, event.description);
        return;
      }
      if (event.type === 'patch.diag.voice_inject') {
        // DEV/TEST (spec/07): feed a transcribed utterance into the open voice
        // session for this surface, routed to its current focus chat. Proves
        // focus-follow re-routing, drives TTS for barge-in, and resolves a
        // pending permission when the word is yes/no.
        audioServer?.injectUtterance(event.surfaceId, event.text);
        return;
      }
      if (
        (event.type === 'host.backend_add_account' ||
          event.type === 'host.backend_usage_refresh') &&
        event.backendId === CODEX_BACKEND_ID
      ) {
        if (!isForThisHost(event.daemonId, event.type)) return;
        try {
          if (event.type === 'host.backend_add_account') await codexAccounts.add(event);
          else await codexAccounts.refresh();
        } catch (error) {
          sender({
            ...codexAccounts.report(),
            credentialError: { kind: 'rejected', message: (error as Error).message },
          });
        }
        return;
      }
      if (event.type === 'host.backend_usage_refresh') {
        if (!isForThisHost(event.daemonId, event.type)) return;
        if (refuseUnknownBackend(event.type, event.backendId, sender)) return;
        // `force` past the per-account floor: a person is watching for this
        // number to change, and a silently-skipped refresh reads as a broken
        // button.
        await accountUsage?.refreshAll(true);
        // The usual reason to press Refresh while chats are parked is that
        // money has just gone in. So a reading that comes back spendable on an
        // account this host had recorded as spent is acted on here and now:
        // `force`, because a person asking is an assertion that the situation
        // changed — the same standing as adding a key — and waiting out the
        // probe's own "believe a turn over a reading" gap would make the button
        // look broken in exactly the moment it matters.
        creditResume.resumeIfCreditReturned({ force: true });
        sender(buildAccountReport());
        return;
      }
      if (event.type === 'host.backend_add_account') {
        if (!isForThisHost(event.daemonId, event.type)) return;
        // Only a ChatGPT sign-in runs on a machine. A Claude account is added
        // through the server, which holds the accounts (spec/01 § Settings).
        const message = `host.backend_add_account: ${event.backendId} accounts are added in Settings → Credit sources, not on a host`;
        logger.warn({ backendId: event.backendId }, message);
        sender({
          type: 'chat.error',
          chatId: 'pending-spawn',
          error: { code: 'invalid_frame', message },
          seq: OUT_OF_BAND_SEQ,
        });
        return;
      }
      if (event.type === 'host.rename') {
        // The SERVER owns the registry entry and has already recorded the new
        // name; this keeps the machine's own self-description and CLI in step,
        // and persists it so a restart does not revert the rename.
        if (!isForThisHost(event.daemonId, event.type)) return;
        hostName = event.hostName;
        hostStateStore.update({ hostName: event.hostName });
        logger.info({ hostName }, 'host renamed');
        sender(describeHost());
        return;
      }
      if (event.type === 'host.manager_adopt') {
        // spec/06 § Manager failover — this host runs the Manager for now, or is
        // told what was said while it was away. Acted on once per takeover.
        if (!isForThisHost(event.daemonId, event.type)) return;
        if (event.epoch <= (hostStateStore.get().managerEpoch ?? -1)) return;
        createSpecialThreads();
        for (const state of daemon.list()) {
          if (isReservedSpecialThread(state.chatId)) announceChat(state);
        }
        daemon.adoptThread('thread_manager', {
          nextSeq: event.nextSeq,
          handoff: event.handoff,
        });
        hostStateStore.update({ managerEpoch: event.epoch, managerHandoff: event.handoff });
        logger.info({ epoch: event.epoch, nextSeq: event.nextSeq }, 'manager: adopted');
        return;
      }
      if (event.type === 'host.manager_release') {
        if (!isForThisHost(event.daemonId, event.type)) return;
        if (event.epoch <= (hostStateStore.get().managerEpoch ?? -1)) return;
        daemon.dropThreadHandoff('thread_manager');
        hostStateStore.update({ managerEpoch: event.epoch, managerHandoff: undefined });
        logger.info({ epoch: event.epoch }, 'manager: released');
        return;
      }
      if (event.type === 'host.set_home') {
        // Broadcast to every machine: the named one becomes home, the rest lose
        // it, so exactly one machine reports the flag.
        const nowHome = event.daemonId === selfDaemonId;
        if (nowHome !== isHomeHost) {
          isHomeHost = nowHome;
          hostStateStore.update({ isHomeHost: nowHome });
          logger.info({ isHomeHost }, 'home-machine flag changed');
          if (nowHome) {
            createSpecialThreads();
            for (const state of daemon.list()) {
              if (isReservedSpecialThread(state.chatId)) announceChat(state);
            }
          }
        }
        sender(describeHost());
        return;
      }
      if (event.type === 'host.settings') {
        if (!isForThisHost(event.daemonId, event.type)) return;
        // Only what stays with this machine (spec/01 § Settings): its MCP
        // servers name commands and paths on this machine. Everything else
        // arrives in the shared settings snapshot.
        if (event.harnessMcpServers !== undefined) {
          // Already validated against `McpServerList` by the wire decode (the
          // server's and this link's): names well-formed and unique, `patch`
          // reserved. A frame that fails it never reaches here — it is refused
          // at decode, naming the offending value.
          harnessMcpServers = event.harnessMcpServers;
          hostStateStore.update({ harnessMcpServers });
          applyHarnessConfig();
          logger.info(
            {
              harnessMcpServers: harnessMcpServers.map((s) => ({
                name: s.name,
                enabled: s.enabled,
              })),
            },
            'MCP server list changed',
          );
        } else if (event.harnessBrowserToolsEnabled !== undefined) {
          // LEGACY toggle from a surface that predates the list: flip the two
          // browser servers it stood for, wherever they still are in the list.
          // Ignored when the same frame carries the list, which is the
          // newer, whole statement of what the user wants.
          harnessMcpServers = withBrowserToolsEnabled(
            harnessMcpServers,
            event.harnessBrowserToolsEnabled,
          );
          hostStateStore.update({ harnessMcpServers });
          applyHarnessConfig();
          logger.info(
            { harnessBrowserToolsEnabled: event.harnessBrowserToolsEnabled },
            'browser MCP servers toggled (legacy harnessBrowserToolsEnabled)',
          );
        }
        if (event.harnessClaudeMdEnabled === false) ignoreClaudeMdOff('host.settings');
        if (event.browserRouteThrough !== undefined) {
          // null clears it (direct again). A value naming THIS host is not a
          // valid "another of the user's hosts" (spec/02 § Browser — Route
          // through) — the Settings picker never offers it, so this is a
          // stale/bad write rather than something to honour silently.
          if (event.browserRouteThrough === selfDaemonId) {
            logger.warn(
              { daemonId: event.browserRouteThrough },
              'host.settings: browserRouteThrough named this host itself; ignored',
            );
          } else {
            browserRouteThrough = event.browserRouteThrough ?? undefined;
            hostStateStore.update({ browserRouteThrough });
            logger.info({ browserRouteThrough }, 'browser route-through changed');
          }
        }
        sender(describeHost());
        return;
      }
      if (event.type === 'host.component_install' || event.type === 'host.component_remove') {
        if (!isForThisHost(event.daemonId, event.type)) return;
        try {
          if (event.type === 'host.component_install') components.install(event.componentId);
          else components.remove(event.componentId);
        } catch (err) {
          if (err instanceof ComponentNotOfferedError) {
            logger.warn({ componentId: event.componentId }, err.message);
            sender({
              type: 'chat.error',
              chatId: 'pending-spawn',
              error: { code: 'component_not_offered', message: err.message },
              seq: OUT_OF_BAND_SEQ,
            });
            return;
          }
          throw err;
        }
        return;
      }
      if (event.type === 'host.update') {
        if (!isForThisHost(event.daemonId, event.type)) return;
        // Apply the published build. A successful apply ends with the service
        // manager restarting this process, so the frames below are only ever
        // reached on refusal — which is exactly when the surface needs words.
        const result = await applyUpdateOnce();
        if (result.deferred) {
          // The surface's button reads "Updating…" until the host reconnects,
          // which is when the held install finally restarts it.
          logger.info({ result: result.message }, 'host.update deferred');
          sender(describeHost());
          return;
        }
        if (!result.applied) {
          logger.warn({ reason: result.message }, 'host.update refused');
          sender({
            type: 'chat.error',
            chatId: 'pending-spawn',
            error: {
              code: 'invalid_frame',
              message: describeUpdateRefusal(result.message),
            },
            seq: OUT_OF_BAND_SEQ,
          });
          return;
        }
        logger.info({ result: result.message }, 'host.update applied');
        sender(describeHost());
        return;
      }
      if (event.type === 'host.folder_add' || event.type === 'host.folder_remove') {
        if (!isForThisHost(event.daemonId, event.type)) return;
        const path = expandHome(event.path);
        const refuse = (message: string): void => {
          logger.warn({ path, frameType: event.type }, message);
          sender({
            type: 'chat.error',
            chatId: 'pending-spawn',
            error: { code: 'folder_invalid', message },
            seq: OUT_OF_BAND_SEQ,
          });
        };
        if (event.type === 'host.folder_add') {
          // A designated project root has to BE a directory on this machine —
          // a path that does not exist would publish a picker entry whose every
          // spawn fails with folder_not_found. NO FALLBACK.
          let isDir = false;
          try {
            isDir = statSync(path).isDirectory();
          } catch {
            isDir = false;
          }
          if (!isDir) {
            refuse(`host.folder_add: no such directory on ${selfDaemonId}: ${path}`);
            return;
          }
          folderRegistry.register(path);
          logger.info({ path }, 'project root added');
        } else {
          if (!folderRegistry.unregister(path)) {
            refuse(`host.folder_remove: ${selfDaemonId} has no project root: ${path}`);
            return;
          }
          logger.info({ path }, 'project root removed');
        }
        hostStateStore.update({ folderRoots: folderRegistry.roots() });
        // The registry is a host-owned list: every edit republishes the
        // COMPLETE list to every surface (spec/03 § Host events).
        sender({ type: 'folders.updated', daemonId: selfDaemonId, ...folderRegistry.snapshot() });
        return;
      }
      if (event.type === 'host.claude_memory_delete' || event.type === 'host.claude_memory_set') {
        if (!isForThisHost(event.daemonId, event.type)) return;
        const refuse = (message: string): void => {
          logger.warn({ frameType: event.type }, message);
          sender({
            type: 'chat.error',
            chatId: 'pending-spawn',
            error: { code: 'claude_settings_invalid', message },
            seq: OUT_OF_BAND_SEQ,
          });
        };
        if (event.type === 'host.claude_memory_set') {
          try {
            setClaudeMemory(config.claudeProjectsRoot, event.project, event.file, event.body);
          } catch (err) {
            if (err instanceof InvalidMemoryRefError || err instanceof MemoryNotFoundError) {
              refuse(`host.claude_memory_set: ${selfDaemonId} — ${err.message}`);
              return;
            }
            throw err;
          }
          logger.info(
            { project: event.project, file: event.file },
            'Claude Code memory entry edited',
          );
        } else {
          try {
            deleteClaudeMemory(config.claudeProjectsRoot, event.project, event.file);
          } catch (err) {
            if (err instanceof InvalidMemoryRefError || err instanceof MemoryNotFoundError) {
              refuse(`host.claude_memory_delete: ${selfDaemonId} — ${err.message}`);
              return;
            }
            throw err;
          }
          logger.info(
            { project: event.project, file: event.file },
            'Claude Code memory entry deleted',
          );
        }
        sender({
          type: 'claude_settings.updated',
          daemonId: selfDaemonId,
          ...claudeSettingsSnapshot(),
        });
        return;
      }
      if (event.type === 'patch.spawn') {
        // A cross-host spawn relayed by the server (spec/03 § Cross-chat
        // tools): another machine's agent asked for a chat on THIS machine.
        if (!isForThisHost(event.daemonId, event.type)) return;
        // The outcome goes BACK to the calling machine. NO FALLBACK: a refusal
        // that only reaches this machine's log leaves the calling agent
        // believing it spawned a chat that does not exist (spec/03 § Cross-chat
        // tools — the call resolves inside the turn, success or failure).
        const spawnRequestId = event.requestId;
        void daemon
          .spawnChat({
            folder: event.folder,
            ...(event.model !== undefined ? { model: event.model } : {}),
            ...(event.prompt !== '' ? { prompt: event.prompt } : {}),
          })
          .then((chatId) => {
            logger.info(
              { chatId, sourceChatId: event.sourceChatId, folder: event.folder },
              'cross-host patch.spawn created a chat here',
            );
            if (spawnRequestId !== undefined) {
              sender({
                type: 'patch.spawn.response',
                requestId: spawnRequestId,
                sourceChatId: event.sourceChatId,
                daemonId: selfDaemonId,
                folder: event.folder,
                ok: true,
                chatId,
              });
            }
          })
          .catch((err: unknown) => {
            const failure = describeSpawnFailure(err);
            logger.error(
              { err: failure.message, sourceChatId: event.sourceChatId },
              'cross-host patch.spawn failed',
            );
            if (spawnRequestId !== undefined) {
              sender({
                type: 'patch.spawn.response',
                requestId: spawnRequestId,
                sourceChatId: event.sourceChatId,
                daemonId: selfDaemonId,
                folder: event.folder,
                ok: false,
                error: failure,
              });
            }
          });
        return;
      }
      if (event.type === 'patch.spawn.response') {
        // Another machine answered THIS machine's cross-host `patch_spawn`.
        remoteSpawns.resolve(event);
        return;
      }
      if (event.type === 'patch.list_chats.response') {
        // The server answered this machine's account-wide chat listing (only
        // the server sees every machine's chats).
        resolveListChats(event);
        return;
      }
      if (event.type === 'patch.activity.response') {
        // The server answered this machine's `patch_activity` ask.
        resolveActivity(event);
        return;
      }
      if (event.type === 'patch.activity.read.request') {
        // The server is assembling a `patch_activity` answer and wants this
        // machine's share: the user messages in its own chat logs.
        sender({
          type: 'patch.activity.read.response',
          requestId: event.requestId,
          messages: readUserMessages(
            join(config.patchHome, 'chats'),
            event.since,
            event.until,
            event.limit,
          ),
        });
        return;
      }
      if (event.type === 'patch.peek.request') {
        // A cross-host `patch_peek` relayed by the server (spec/03 § Cross-chat
        // tools): another machine's agent asked about a chat that lives HERE.
        // No requestId means the frame is a same-host audit record, which the
        // server never relays (cross-host.ts) — unreachable in practice.
        const requestId = event.requestId;
        /* v8 ignore next */
        if (requestId === undefined) return;
        const result = buildPeekResult(daemon, event.targetChatId, event.limit ?? 50);
        sender(
          result
            ? {
                type: 'patch.peek.response',
                requestId,
                sourceChatId: event.sourceChatId,
                targetChatId: event.targetChatId,
                ok: true,
                result,
              }
            : {
                type: 'patch.peek.response',
                requestId,
                sourceChatId: event.sourceChatId,
                targetChatId: event.targetChatId,
                ok: false,
                error: { code: 'chat_not_found', message: `chat not found: ${event.targetChatId}` },
              },
        );
        return;
      }
      if (event.type === 'patch.peek.response') {
        // Another machine answered THIS machine's cross-host `patch_peek`. No
        // requestId is a stray frame this machine never sent a request for.
        if (event.requestId !== undefined)
          remotePeeks.resolve({ ...event, requestId: event.requestId });
        return;
      }
      if (event.type === 'patch.history.request') {
        // Cross-host `patch_history`'s sibling to `patch.peek.request` above.
        const requestId = event.requestId;
        /* v8 ignore next */
        if (requestId === undefined) return;
        try {
          const slice = daemon.readHistory({
            chatId: event.targetChatId,
            ...(event.fromSeq !== undefined ? { fromSeq: event.fromSeq } : {}),
            ...(event.limit !== undefined ? { limit: event.limit } : {}),
          });
          const result: { events: WireEvent[]; nextFromSeq?: number } = { events: slice.events };
          if (slice.nextFromSeq !== undefined) result.nextFromSeq = slice.nextFromSeq;
          sender({
            type: 'patch.history.response',
            requestId,
            sourceChatId: event.sourceChatId,
            targetChatId: event.targetChatId,
            ok: true,
            result,
          });
        } catch (err) {
          const code = err instanceof ChatNotFoundError ? 'chat_not_found' : 'sdk_error';
          sender({
            type: 'patch.history.response',
            requestId,
            sourceChatId: event.sourceChatId,
            targetChatId: event.targetChatId,
            ok: false,
            error: { code, message: err instanceof Error ? err.message : String(err) },
          });
        }
        return;
      }
      if (event.type === 'patch.history.response') {
        // No requestId is a stray frame this machine never sent a request for.
        if (event.requestId !== undefined)
          remoteHistories.resolve({ ...event, requestId: event.requestId });
        return;
      }
      if (event.type === 'patch.send_to') {
        // Cross-host `patch_send_to`: no requestId is a same-host audit record
        // (never relayed — see cross-host.ts), so nothing to deliver or answer.
        const requestId = event.requestId;
        if (requestId === undefined) return;
        void daemon
          .submitInput({
            chatId: event.targetChatId,
            message: event.message,
            // The requestId is already a unique key for this call; reusing it
            // as the dedupe localId needs no separate id generator.
            localId: requestId,
            ...(event.voicePrefix !== undefined ? { voicePrefix: event.voicePrefix } : {}),
            origin: 'machine',
            // The Manager's sweep reaches a remote chat through this same relay.
            ...(event.sourceChatId === 'thread_manager' ? { nudge: true } : { fromAgent: true }),
          })
          .then(() => {
            sender({
              type: 'patch.send_to.response',
              requestId,
              sourceChatId: event.sourceChatId,
              targetChatId: event.targetChatId,
              ok: true,
            });
          })
          .catch((err: unknown) => {
            const code = err instanceof ChatNotFoundError ? 'chat_not_found' : 'sdk_error';
            sender({
              type: 'patch.send_to.response',
              requestId,
              sourceChatId: event.sourceChatId,
              targetChatId: event.targetChatId,
              ok: false,
              error: { code, message: err instanceof Error ? err.message : String(err) },
            });
          });
        return;
      }
      if (event.type === 'patch.send_to.response') {
        remoteSendTos.resolve(event);
        return;
      }
      if (event.type === 'daemon.online' || event.type === 'daemon.offline') {
        // Roster upkeep: a cross-chat call naming a machine that is down has to
        // fail INSIDE the turn, which means knowing it is down without asking.
        if (event.type === 'daemon.online') onlineHosts.add(event.daemonId);
        else onlineHosts.delete(event.daemonId);
        return;
      }
      if (event.type === 'patch.browser_tunnel.open') {
        // spec/02 § Browser — Route through: another host's browser asked
        // THIS host to make a real outbound connection on its behalf.
        browserTunnelRelay.handleOpen(event);
        return;
      }
      if (
        event.type === 'patch.browser_tunnel.ready' ||
        event.type === 'patch.browser_tunnel.error'
      ) {
        // These only ever travel routing → browsing, so only the browsing
        // half (the client) ever receives one.
        browserTunnelClient.handleEvent(event);
        return;
      }
      if (
        event.type === 'patch.browser_tunnel.data' ||
        event.type === 'patch.browser_tunnel.close'
      ) {
        // Travels in BOTH directions, so this host could be EITHER half for
        // it — exactly one of the two will actually be tracking the stream
        // (a host is never both the browsing and routing end of the same
        // one), so whichever recognises the streamId owns the frame.
        if (browserTunnelRelay.hasStream(event.streamId)) {
          if (event.type === 'patch.browser_tunnel.data') browserTunnelRelay.handleData(event);
          else browserTunnelRelay.handleClose(event);
        } else if (browserTunnelClient.hasStream(event.streamId)) {
          browserTunnelClient.handleEvent(event);
        } else {
          logger.warn(
            { streamId: event.streamId },
            'browser tunnel frame for an unknown stream; dropping',
          );
        }
        return;
      }
      if (event.type === 'patch.audio_relay.open') {
        // spec/07 § Voice is a per-host capability: the server has a voice
        // session for a chat on THIS host and no direct address for it, so
        // it is tunnelling the session over this link instead. Bridge it to
        // this host's own local audio WSS.
        audioRelayBridge.handleOpen(event);
        return;
      }
      if (event.type === 'patch.audio_relay.frame' || event.type === 'patch.audio_relay.close') {
        if (event.type === 'patch.audio_relay.frame') audioRelayBridge.handleFrame(event);
        else audioRelayBridge.handleClose(event);
        return;
      }
      if (event.type === 'chat.settings') {
        // spec/03 § `chat.settings` — sets the chat's permission mode. The field
        // is the only thing the frame can say, so a frame without it has nothing
        // to do: refuse it out loud rather than reading it as "return this chat
        // to the host default", which is no longer a thing a chat can do
        // (spec/02 § Permission mode).
        if (event.permissionMode === undefined) {
          logger.warn({ chatId: event.chatId }, 'chat.settings: no permissionMode');
          sender({
            type: 'chat.error',
            chatId: event.chatId,
            error: {
              code: 'invalid_frame',
              message: 'chat.settings carries no permissionMode; there is nothing to set',
            },
            seq: OUT_OF_BAND_SEQ,
          });
          return;
        }
        try {
          daemon.setChatPermissionMode(event.chatId, event.permissionMode);
        } catch (err) {
          logger.warn(
            { chatId: event.chatId, err: (err as Error).message },
            'chat.settings: unknown chat',
          );
          sender({
            type: 'chat.error',
            chatId: event.chatId,
            error: { code: 'chat_not_found', message: (err as Error).message },
            seq: OUT_OF_BAND_SEQ,
          });
          return;
        }
        logger.info(
          { chatId: event.chatId, permissionMode: event.permissionMode },
          'chat permission mode set',
        );
        // The off-default COUNT is part of this machine's self-description.
        sender(describeHost());
        return;
      }
      if (event.type === 'chat.model_request') {
        // spec/04 § Model — run this chat on another model from its NEXT turn.
        // Unlike `chat.settings` there is no "clear" reading: a chat is always
        // on some model, so the field is required and always means "switch".
        const { chatId, model } = event;
        void daemon.setChatModel(chatId, model).then(
          () => {
            // The acknowledgement is the `chat.state` setChatModel emits, which
            // carries the new model — that is also what makes every OTHER
            // surface holding this chat converge on it.
            logger.info({ chatId, model }, 'chat model changed');
          },
          (err: unknown) => {
            // NO FALLBACK: a refused change leaves the chat on the model it was
            // already running, and says so, rather than rounding to a near
            // match or dropping to this machine's last-used model.
            const code = (err as { code?: string }).code ?? 'chat_not_found';
            logger.warn(
              { chatId, model, err: (err as Error).message },
              'chat model change refused',
            );
            sender({
              type: 'chat.error',
              chatId,
              error: { code: code as ChatErrorCode, message: (err as Error).message },
              seq: OUT_OF_BAND_SEQ,
            });
          },
        );
        return;
      }
      void handleServerEvent(event, daemon, sender, logger, {
        buildAccountReport,
        heldAccounts: (model) =>
          isCodexModel(model)
            ? (codexAccounts.report().accounts?.map((a) => a.id) ?? [])
            : (readPatchStore(oauthOpts)?.accounts.map((a) => a.id) ?? []),
        meetings,
      });
    },
    onDisconnected: () => {
      linkOnline = false;
    },
  });

  // Group 13: the voice reply bridge — reads a voice turn's streaming +
  // final assistant text off this host's own outbound event stream. See
  // audio/replyBridge.ts for why a waiter must be ARMED (chat observed
  // `running`) before it may settle: resolving on any idle `chat.state`
  // resolved instantly with an empty reply and dropped every delta, which is
  // what left voice sessions with zero `audio.tts_chunk` frames.
  const voiceReplies = createVoiceReplyBridge();

  // spec/07 § Keeping voice and text as one conversation / § Call cost.
  // `daemon` and `audioServer` are read lazily: both exist by the time a
  // voice session or a chat message reaches this.
  const chatVoice = createChatVoice({
    daemon: {
      recordVoiceMessage: (r) => daemon.recordVoiceMessage(r),
      reserveVoiceSeq: (chatId) => daemon.reserveVoiceSeq(chatId),
      emitVoiceDelta: (chatId, seq, delta) => daemon.emitVoiceDelta(chatId, seq, delta),
      recordCallSummary: (chatId, line) => daemon.recordCallSummary(chatId, line),
    },
    sessionsOnChat: (chatId) => audioServer?.sessionsOnChat(chatId) ?? [],
    ledger: voiceLedger,
    logger,
    onCosted: () => publishHost(),
  });
  function emit(event: import('@patch/wire').WireEvent): void {
    // spec/02 § Native subagent dispatch — a `patch_delegate` subagent is never
    // on the wire. `Daemon.emit` withholds its own frames, but title, status,
    // permission and notify frames reach here by other routes, so gate every
    // chat-addressed frame. `chat.delegate_update` carries the PARENT's id.
    const addressed = (event as { chatId?: unknown }).chatId;
    if (typeof addressed === 'string' && daemon.isSubagent(addressed)) return;
    voiceReplies.observe(event);
    chatVoice.observe(event);
    link.send(event);
    // spec/04 § Folders: a freshly-spawned chat may sit in a folder the
    // published list doesn't have yet. Recompute; `refresh` emits a
    // `folders.updated` only when the set actually changed.
    if (event.type === 'chat.spawned') folderRegistry.refresh();
  }
  /**
   * A chat's SDK query reported the session/week usage of THE KEY THAT TURN IS
   * RUNNING ON (spec/10 § Surface in Settings — Usage — "usage is reported per
   * host per account").
   *
   * Attributed to the account the host handed that turn, which is the only
   * account involved: a chat has none of its own. A turn whose credential
   * carried no account id (no store wiring at all — the mock backend in tests)
   * drops the reading rather than guessing an id.
   */
  const reportUsage = (
    chatId: string,
    scope: 'session' | 'week',
    window: RateLimitWindow,
  ): void => {
    const accountId = daemon.accountRunningOn(chatId);
    if (accountId === undefined) return;
    accountUsage?.observeFromTurn(accountId, scope, window);
  };

  // 4. Host (chat_state owner).
  const metaStore = createMetaStore(config.patchHome);
  // Voice-device registries — persistent pairing records + live presence.
  // Back `patch_list_devices` and (in later voice groups) outbound routing.
  // `presence` starts empty on boot: a device only shows `online: true` once
  // its control WSS connects, which is correct — presence cannot outlive the
  // socket that proves it (see devices/presence.ts).
  const deviceRegistry = DeviceRegistry.load(config.patchHome);
  const presence = new PresenceRegistry();
  // Voice-device control plane (F2, spec/16). Owns device presence + outbound
  // ring + the phone>device>idle concurrency arbiter. The firmware/mock dial
  // `wss://<host>/device/control` on the SAME host:port as the audio WSS, so
  // the control upgrade (mounted at step 8) shares the audio HTTP listener.
  // Constructed here so the speakers cascade (buildControl, below) can route
  // its ring frames through it; `isPhoneCallActive` reads the live audio server
  // lazily (forward-declared `audioServer`, assigned by the time a frame lands).
  // The five-minute voice-device adoption window this machine's command line
  // opens on it (spec/16 § F2). In-memory by design: a window is a live,
  // attended act and must not survive a restart.
  const deviceAdoption = new DeviceAdoption();

  const deviceControl = new DeviceControlServer({
    registry: deviceRegistry,
    // The window the CLI opens is what admits an unknown device. Without this
    // it was opened and never consulted, so no device could ever be adopted.
    adoption: deviceAdoption,
    presence,
    accountPublicKey,
    accountId: accountPublicKey,
    internalToken: config.internalToken,
    // Wake-word conversations route to the Speakers thread (spec/06 ## Speakers
    // thread). 'thread_speakers' is the canonical id (specialThreads.ts /
    // wire SPECIAL_THREAD_IDS.speakers).
    voiceDeviceChatId: 'thread_speakers',
    // DeviceControlServer calls `isPhoneCallActive` only while routing a ring
    // to a PAIRED, CONNECTED voice device, to decide whether an in-progress
    // phone call should suppress it (spec/16 § Concurrency). Driving it for
    // real needs a live device-control WS session (its own JWT-authenticated
    // pairing handshake — devices/control-ws.ts's own 100%-covered domain,
    // exercised end-to-end in test/device-control-ws.test.ts) concurrently
    // with an open phone-call-role audio session. Replicating that whole
    // cross-subsystem harness here just to tick this one-line delegation is
    // out of proportion to what it could realistically catch — a real bug in
    // `phoneCallActive()` itself is caught by audio/server.ts's own 100%
    // coverage; a real bug in the ring-routing decision is caught by
    // devices/control-ws.ts's own 100% coverage.
    isPhoneCallActive: /* v8 ignore next */ () => audioServer?.phoneCallActive() ?? false,
    // Device sessions run concurrently up to the same whisper concurrency cap
    // the audio server enforces (spec/07 §Concurrency on the host).
    maxConcurrentSessions: config.audio.maxConcurrentSessions,
    logger: logger.child({ component: 'device-control' }),
  });
  /**
   * The stdio MCP server every SDK query launches (spec/02 § MCP server). It
   * sits beside this module — as `.js` in a built host, as `.ts` when the
   * host itself is running from source under a TypeScript loader. Resolving
   * the wrong one silently costs every chat its patch_* toolset (the SDK just
   * reports "no such tools"), so the file is resolved HERE and its absence is a
   * boot failure rather than a mystery at turn time. NO FALLBACK.
   */
  const mcpBin = ((): { command: string; args: string[] } => {
    const here = dirname(fileURLToPath(import.meta.url));
    const built = resolve(here, 'bin', 'patch-tools-server.js');
    if (existsSync(built)) return { command: process.execPath, args: [built] };
    const source = resolve(here, 'bin', 'patch-tools-server.ts');
    if (existsSync(source)) {
      // Running from source: launch the child through the same TypeScript
      // loader this process was started with.
      //
      // The loader MUST be an absolute file: URL, not the bare specifier
      // `tsx`. The SDK spawns this child with the CHAT FOLDER as its cwd, and
      // a bare specifier resolves from there — any folder outside this repo
      // (i.e. every real chat folder) fails with ERR_MODULE_NOT_FOUND and the
      // chat silently loses its whole patch_* toolset. Resolve it here, from
      // this module, so the path is the host's own tsx. NO FALLBACK.
      const tsxLoader = createRequire(import.meta.url).resolve('tsx');
      return {
        command: process.execPath,
        args: ['--import', pathToFileURL(tsxLoader).href, source],
      };
    }
    throw new Error(
      `patch-daemon: MCP server not found at ${built} or ${source} — every chat would lose its patch_* tools`,
    );
  })();
  // Prove the resolved MCP child actually STARTS from an arbitrary cwd — the
  // SDK launches it with the chat folder as its working directory, and a child
  // that dies on startup costs every chat its patch_* tools with no error
  // anywhere (the model simply reports "no such tools"). `--probe` builds the
  // server in-memory, prints its tool list and exits 0, so this is a real
  // end-to-end check of the command, not a file-exists test. NO FALLBACK: a
  // failure here is a boot failure.
  {
    const probeCwd = homedir();
    const probe = spawnSync(mcpBin.command, [...mcpBin.args, '--probe'], {
      cwd: probeCwd,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (probe.status !== 0) {
      throw new Error(
        `patch-daemon: MCP server child failed to start (${mcpBin.command} ${mcpBin.args.join(' ')} --probe, cwd ${probeCwd}) — every chat would lose its patch_* tools. exit=${String(probe.status)} signal=${String(probe.signal)} stderr=${(probe.stderr ?? '').trim()}`,
      );
    }
    logger.info({ command: mcpBin.command, args: mcpBin.args }, 'MCP tools child verified');
  }
  // spec/02 § Stack: the special threads' working folders live under the host
  // user's own ~/.patch, resolved from HOME and nothing else — never from the
  // working directory, which the service unit does not set.
  const daemonCwd = config.patchHome;
  // OAuth gate (spec/10-auth.md): re-read ~/.claude.json on EVERY query so a
  // credential that expired or was deleted after boot is caught. NO FALLBACK to
  // an API key. Shared by the turn path AND the title summariser so both
  // self-refresh from the same source. Under SDK_BACKEND=mock it is a no-op.
  /**
   * Which accounts are out of credit, and what a failing chat moves to next
   * (spec/10-auth.md § Backend credentials — multiple accounts).
   *
   * Priority is the order of the accounts array: failover walks forward from the
   * account that just failed. In memory — a restart re-probes and re-learns
   * within one turn, and a stale "exhausted" surviving a top-up is worse than
   * one extra refused turn.
   */
  const accountRotation = new AccountRotation();
  /**
   * The one sequence that picks stalled work back up, and the timer that waits
   * for a stated reset (`creditResume.ts`).
   *
   * Declared here, above everything that fires it, because the events that can
   * reveal credit are scattered — a turn failing over, a wire frame, a usage
   * probe — and each of them used to do its own partial version of this.
   */
  const creditResume = new CreditResume({
    rotation: accountRotation,
    resumeParked: () => daemon.resumeAllRateLimited(),
    resumeErrored: () => daemon.resumeErroredOnExhaustedAccount(),
    refreshUsage: () => void accountUsage?.refreshAll(true),
    report: () => emit(buildAccountReport()),
    readings: () =>
      (readPatchStore(oauthOpts)?.accounts ?? []).flatMap((a) => {
        const entry = accountUsage?.get(a.id);
        return entry === undefined
          ? []
          : [{ accountId: a.id, blocked: entry.reading.blocked, at: entry.reading.at }];
      }),
    logger,
  });
  /**
   * The shared Claude keys as failover sees them, and the route that orders
   * them for one question (spec/10 § Backend credentials — account strategy).
   * `preferredAccountId` is the chat's, when the question is about a chat that
   * named one.
   */
  const claudeRoute = (
    store: NonNullable<ReturnType<typeof readPatchStore>>,
    preferredAccountId?: string,
  ): { accounts: FailoverAccount[]; route: RouteOptions } => ({
    accounts: store.accounts.map((a) => ({
      id: a.id,
      connected: a.credential !== null,
      ...(a.credential?.organizationId !== undefined
        ? { organizationId: a.credential.organizationId }
        : {}),
    })),
    route: {
      strategy: accountStrategy.claude,
      ...(preferredAccountId !== undefined ? { preferred: preferredAccountId } : {}),
      weekResetsAt: (id) => accountUsage?.get(id)?.reading.windows.week?.resetsAt,
      utilization: (id) => {
        const w = accountUsage?.get(id)?.reading.windows;
        const values = [w?.session?.utilization, w?.week?.utilization].filter(
          (v): v is number => v !== undefined,
        );
        return values.length ? Math.max(...values) : undefined;
      },
    },
  });
  const failoverAccount = (
    chatId: string,
    spentAccountId: string | undefined,
    message: string,
    limit?: { resetsAt?: number },
  ): string | undefined => {
    const store = readPatchStore(oauthOpts);
    if (!store) return undefined;
    // The key the failing turn actually ran on, as the host handed it out —
    // never the chat's preference, which is only where its walk starts.
    const failed = spentAccountId;
    const { accounts, route } = claudeRoute(
      store,
      daemon.list().find((c) => c.chatId === chatId)?.preferredAccountId,
    );
    if (failed !== undefined) {
      // Siblings sharing this account's organisation are marked with it. They
      // share its pool, so they have nothing of their own left to try, and
      // walking onto one is how a single spent account came to be reported as
      // two.
      // The failure's OWN reset instant first — `quotaLimits.resetsAt`, an
      // exact epoch on the same message — and the prose parse only for a
      // provider that states a reset in words and carries no structured field.
      // Reading the sentence first is lossy and one wording change from
      // sidelining an account with no reset at all, which arms nothing.
      const until = limit?.resetsAt ?? parseLimitResetsAt(message, Date.now());
      const marked = accountRotation.markExhaustedWithSiblings(
        accounts,
        failed,
        message.slice(0, 200),
        until,
      );
      if (marked.length > 1) {
        logger.warn(
          { failed, alsoSidelined: marked.slice(1) },
          'account failover: the key that ran out shares a Claude account with others — they are the same pool, not a fallback',
        );
      }
      // The reset is a known instant, so arm for it here — at the one moment we
      // learn of it — rather than discovering it later by polling. An
      // exhaustion that stated NO reset arms nothing: the usage probe seeing it
      // spendable again is that account's event (`creditResume.ts`).
      creditResume.arm();
      // Ask Anthropic what this account actually has left. The turn's own error
      // says only that it was refused; the probe says by which window and until
      // when, and it works on an account too spent to run anything.
      void accountUsage?.refresh(failed, true);
    }
    // A key that actually HAS credit, or nothing. `effectiveAccount` would
    // always name one — that is its job, so a turn can fail with the provider's
    // own message — and reading it here as "there is somewhere to move to" is
    // exactly how a host with every key spent re-ran the same turn for hours.
    // Peeked with the chat's own route, so it names where the re-run will
    // actually start — the re-run's resolution is what moves a round-robin on.
    const next = accountRotation.usableAccount(accounts, route);
    if (next === undefined) {
      logger.warn(
        {
          chatId,
          failed: failed ?? null,
          accounts: accounts.map((a) => a.id),
          sidelined: accountRotation.snapshot(),
        },
        'account failover: every account is out of credit',
      );
      // The host's credential state has changed in a way a person may need to
      // act on (add or top up an account), so surfaces are told.
      emit(buildAccountReport());
      return undefined;
    }
    emit(buildAccountReport());
    return next;
  };

  const resolveOAuth = makeResolveOAuth(
    config.claudeCredentialsPath !== undefined
      ? {
          sdkBackend: config.sdkBackend,
          claudeCredentialsPath: config.claudeCredentialsPath,
          logger,
        }
      : { sdkBackend: config.sdkBackend, logger },
  );
  // spec/02 § Model catalogue — live model list for the new-chat picker, read
  // from Anthropic with the same OAuth gate the turn path uses.
  /**
   * The OAuth gate every turn goes through: the host's stored keys, in order,
   * first one with credit (spec/10-auth.md § Backend credentials).
   *
   * A chat does not choose, and cannot: the sequence is the host's, and the same
   * question is asked afresh for every turn. So a key running out is not
   * something each chat discovers by failing on it — one turn learns key 1 is
   * spent, and every turn after that simply runs on key 2, until key 1's limit
   * resets and everything is back on it because it is first in the order.
   *
   * The account it settled on rides back on the result: the turn has to be able
   * to say which key it spent when it fails, and that is the only place that
   * fact exists.
   */
  const resolveOAuthWithCredit = async (turn?: {
    chatId: string;
    preferredAccountId?: string;
  }): Promise<
    { ok: true; accessToken: string; accountId?: string } | { ok: false; reason: string }
  > => {
    const store = readPatchStore(oauthOpts);
    if (!store || store.accounts.length === 0) {
      // No store wiring at all (the mock backend in tests): there is no key to
      // name, and inventing one would put a fiction in the usage report.
      return resolveOAuth();
    }
    const { accounts, route } = claudeRoute(store, turn?.preferredAccountId);
    // Read before `startTurn`, which moves a round-robin on.
    const first = accountRotation.order(accounts, route)[0]?.id;
    // Only a starting turn moves the rotation; a credential check peeks.
    const effective = turn
      ? accountRotation.startTurn(accounts, route)
      : accountRotation.effectiveAccount(accounts, route);
    if (effective !== undefined && effective !== first) {
      logger.info(
        {
          first: first ?? null,
          effective,
          strategy: route.strategy,
          sidelined: accountRotation.snapshot(),
        },
        'account routing: the first key has no credit — running this turn on the next one',
      );
    }
    const result = await resolveOAuth(effective);
    return result.ok && effective !== undefined ? { ...result, accountId: effective } : result;
  };

  /**
   * Model-aware credential gate (spec/10-auth.md § Backend credentials): a
   * Codex-prefixed model resolves against the Codex account store, everything
   * else against `resolveOAuthWithCredit`'s rotation — the same split the
   * real chat-turn path and `hook.check_request`'s prompt-hook check use, so a
   * one-shot (a goal evaluation, a prompt hook) never borrows a different
   * provider's credential than the chat it is judging actually runs on.
   */
  const resolveModelOAuth = async (
    model?: string,
    turn?: { chatId: string; preferredAccountId?: string },
  ): Promise<
    { ok: true; accessToken: string; accountId?: string } | { ok: false; reason: string }
  > => {
    if (!isCodexModel(model)) return resolveOAuthWithCredit(turn);
    try {
      const account = await codexAccounts.resolve(
        {
          strategy: accountStrategy.codex,
          ...(turn?.preferredAccountId ? { preferred: turn.preferredAccountId } : {}),
          ...(turn ? { starting: true } : {}),
        },
        true,
        model?.startsWith('openai/api/') ? 'apiKey' : 'chatgpt',
      );
      return { ok: true, accessToken: '', accountId: account.accountId };
    } catch (error) {
      return { ok: false, reason: (error as Error).message };
    }
  };

  /**
   * The gate EVERY one-shot AI call goes through (spec/10-auth.md § Backend
   * credentials — multiple accounts): walk the stored keys in priority order
   * and run on the first that actually completes the call.
   *
   * A turn learns an account is spent by failing on it, and the next turn is
   * routed elsewhere by `resolveOAuthWithCredit`. A one-shot has no next turn.
   * Resolving once and giving up left title and status generation pinned to a
   * spent account for a whole night — 76 chats came out of it with no status at
   * all — while chats either side of them ran normally on the second account.
   * So a one-shot walks the list itself, and marks what it learns on the way so
   * the calls behind it skip the spent key rather than each rediscovering it.
   *
   * Only an ACCOUNT-EXHAUSTED failure moves to the next key. Anything else —
   * a timeout, a malformed reply, the SDK falling over — would fail the same
   * way on every account, and retrying it across all of them turns one failed
   * call into N.
   */
  const runOnAccountWithCredit: RunOnAccountWithCredit = async <T>(
    label: string,
    run: (accessToken: string) => Promise<T>,
  ): Promise<T | null> => {
    const store = readPatchStore(oauthOpts);
    if (!store || store.accounts.length === 0) {
      // No store wiring at all (the mock backend in tests): resolve the way
      // everything else does when there is no account list to walk.
      const resolved = await resolveOAuth();
      if (!resolved.ok) {
        logger.warn({ label, reason: resolved.reason }, 'ai call: OAuth unavailable');
        return null;
      }
      return await run(resolved.accessToken);
    }
    const { accounts, route } = claudeRoute(store);
    const order = accountRotation.usableAccounts(accounts, route);
    if (order.length === 0) {
      logger.warn(
        { label, sidelined: accountRotation.snapshot() },
        'ai call: every account is out of credit',
      );
      return null;
    }
    for (const accountId of order) {
      const resolved = await resolveOAuth(accountId);
      if (!resolved.ok) {
        logger.warn(
          { label, accountId, reason: resolved.reason },
          'ai call: account has no usable credential — trying the next',
        );
        continue;
      }
      try {
        return await run(resolved.accessToken);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!isAccountExhaustedError(message)) {
          // Not an account problem, so no other account would answer
          // differently. Rethrown rather than folded into the same `null` an
          // exhausted host returns: the caller's own handler gets the
          // provider's words, and a real failure never disguises itself as an
          // empty answer.
          logger.warn({ label, accountId, err }, 'ai call: failed');
          throw err;
        }
        const marked = accountRotation.markExhaustedWithSiblings(
          accounts,
          accountId,
          message.slice(0, 200),
          parseLimitResetsAt(message, Date.now()),
        );
        logger.info(
          { label, accountId, alsoSidelined: marked.slice(1) },
          'ai call: account out of credit — trying the next',
        );
        emit(buildAccountReport());
      }
    }
    logger.warn(
      { label, tried: order, sidelined: accountRotation.snapshot() },
      'ai call: every account is out of credit',
    );
    return null;
  };

  /**
   * Every stored account's usage, kept current whether or not it can run a
   * turn (spec/10 § Surface in Settings — Usage).
   *
   * Started here rather than at boot because it needs `resolveOAuth` to get a
   * token per account and `emit` to publish what it finds.
   */
  accountUsage = new AccountUsageTracker({
    accounts: () => readPatchStore(oauthOpts)?.accounts ?? [],
    tokenFor: async (accountId) => {
      const resolved = await resolveOAuth(accountId);
      return resolved.ok ? resolved.accessToken : undefined;
    },
    onChange: () => emit(buildAccountReport()),
    // A reading is one of the three events that can restart work stalled on
    // credit — and the only one that covers an account sidelined with no stated
    // reset, which arms no timer. `observedUsable` does the deciding: it
    // resumes nothing for an account nobody was waiting on, and it will not
    // take a reading over a turn that was refused seconds ago.
    onReading: (accountId, reading) => {
      if (reading.blocked) return;
      creditResume.observedUsable(accountId, reading.at);
    },
    rememberOrganization: (accountId, organizationId) => {
      if (!setAccountOrganization(accountId, organizationId, oauthOpts)) return;
      logger.info(
        { accountId, organizationId },
        'recorded which Claude account this key belongs to',
      );
      // The answer to "is there anywhere to fail over to" may have just
      // changed — two rows can now be seen to be one account.
      emit(buildAccountReport());
    },
    logger,
  });
  // The mock backend has no real credential to probe and no Anthropic to ask;
  // polling it would spend a request per account per ten minutes to learn
  // nothing, and would make every test that boots a host hit the network.
  if (config.sdkBackend === 'real') accountUsage.start();

  const modelCatalog = new ModelCatalog({ runOnAccountWithCredit });
  // spec/08 § Recurrence — the job editor's natural-language schedule input.
  // Cheap one-shot Haiku, same gate as the title/status/digest generators.
  const translateRecurrenceRule = makeRecurrenceTranslator({
    sdkBackend,
    runOnAccountWithCredit,
    logger,
  });
  let pullQueuedFromServer: ((chatId: string) => Promise<ChatInputEvent[]>) | undefined;
  const daemon: Daemon = new Daemon({
    pullQueued: (chatId) => pullQueuedFromServer?.(chatId) ?? Promise.resolve([]),
    onHandoffConsumed: () => hostStateStore.update({ managerHandoff: undefined }),
    daemonId: selfDaemonId,
    // spec/04 § Spawn — a spawn naming no model takes THIS machine's last-used
    // model, and every spawn that names one sets it.
    defaultModel: () => defaultModel,
    // spec/04 § Model — a mid-chat model change is checked against the model
    // list THIS machine actually offers, so an id it cannot run is refused
    // naming it rather than handed to the backend to fail obscurely later. The
    // catalogue is cached (6h TTL), so this is a memory read in the normal case.
    knownModelIds: async () => {
      const results = await Promise.allSettled([
        modelCatalog.get().then((r) => r.models),
        codexAccounts.models(),
      ]);
      const models = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      if (!models.length)
        throw new Error(
          results.map((r) => (r.status === 'rejected' ? String(r.reason) : '')).join('; '),
        );
      return new Set(models.map((m) => m.id));
    },
    // This machine's DEFAULT permission mode, as last set from a surface
    // (`host.settings`). Persisted, so the setting is not silently undone by a
    // restart.
    ...(persistedHostState.permissionModeDefault !== undefined
      ? { permissionModeDefault: persistedHostState.permissionModeDefault }
      : {}),
    metaStore,
    sdkBackend: routedBackend,
    sdkBackendKind: config.sdkBackend,
    // Reader for Claude Code transcripts. Points at the SAME root the SDK
    // backend writes to (real: ~/.claude/projects; mock: isolated per-home dir),
    // so persisted history is genuinely paginable on the live stack.
    historyReader: (() => {
      const claudeHistory = createHistoryReader({
        claudeProjectsRoot: config.claudeProjectsRoot,
        onCorruptLine: ({ path, lineNumber, message }) =>
          logger.warn(
            { path, lineNumber, err: message },
            'history: skipping unreadable JSONL line',
          ),
      });
      return {
        hasSession: (o) =>
          (o.sessionId.startsWith('codex-') ? codexHistory : claudeHistory).hasSession(o),
        read: (o) => (o.sessionId.startsWith('codex-') ? codexHistory : claudeHistory).read(o),
        forkPoint: (o) =>
          (o.sessionId.startsWith('codex-') ? codexHistory : claudeHistory).forkPoint(o),
        sidePoint: (o) =>
          (o.sessionId.startsWith('codex-') ? codexHistory : claudeHistory).sidePoint(o),
      };
    })(),
    // OAuth gate (spec/10-auth.md): the gate protects the real SDK path only;
    // under SDK_BACKEND=mock it is a no-op so local-dev / the test stack can
    // exercise agent behaviour without a real `claude login`.
    // Routed through the account that has credit, so a spent account is not
    // something every chat has to discover by failing on it.
    resolveOAuth: resolveModelOAuth,
    // The ONE turn that discovers the exhaustion still has to be re-run; from
    // then on `resolveOAuthWithCredit` routes the rest without any of them
    // failing (spec/10-auth.md § Backend credentials).
    accountLabel: (model, accountId) =>
      isCodexModel(model)
        ? codexAccounts.report().accounts?.find((a) => a.id === accountId)?.label
        : readPatchStore(oauthOpts)?.accounts.find((a) => a.id === accountId)?.label,
    accountSpent: (model, fromAccountId) => {
      if (isCodexModel(model)) {
        const info = codexAccounts.limitInfo(fromAccountId);
        const spent = info?.scope !== undefined;
        return {
          spent,
          ...(spent && info?.resetsAt !== undefined ? { until: info.resetsAt } : {}),
        };
      }
      if (!accountRotation.isExhausted(fromAccountId)) return { spent: false };
      const until = accountRotation.exhaustedUntil(fromAccountId);
      return { spent: true, ...(until !== undefined ? { until } : {}) };
    },
    nextAccountAfterExhausted: (chatId, id, message, limit) =>
      isCodexModel(daemon.list().find((c) => c.chatId === chatId)?.model)
        ? codexAccounts.markExhausted(id)
        : failoverAccount(chatId, id, message, limit),
    /**
     * Has this host nowhere to run a turn — every stored key recorded spent?
     *
     * The same question `failoverAccount` asks when it has a failure in hand
     * (`usableAccount` naming nobody), asked without one. A host with no store
     * at all cannot tell, and answers `false`: there is no account for anything
     * to be out of credit ON, so nothing should behave as though there were.
     */
    hostOutOfCredit: () => {
      const store = readPatchStore(oauthOpts);
      if (!store) return false;
      const { accounts, route } = claudeRoute(store);
      return accountRotation.usableAccount(accounts, route) === undefined;
    },
    // The strategy and how many held keys are out, so a blocked chat says
    // "Round robin — all 3 accounts out" and not just one account's countdown.
    accountRouting: (model) => {
      if (isCodexModel(model)) return undefined;
      const store = readPatchStore(oauthOpts);
      if (!store) return undefined;
      const out = store.accounts.filter((a) => accountRotation.isExhausted(a.id));
      const returns = out
        .map((a) => ({ label: a.label, at: accountRotation.exhaustedUntil(a.id) }))
        .filter((r): r is { label: string; at: number } => r.at !== undefined)
        .sort((x, y) => x.at - y.at);
      const next = returns[0];
      return {
        strategy: accountStrategy.claude,
        accounts: store.accounts.length,
        exhausted: out.length,
        ...(next !== undefined
          ? { nextResetsAt: next.at, ...(next.label ? { nextLabel: next.label } : {}) }
          : {}),
      };
    },
    /**
     * What is actually true of the account a blocked turn ran on, so the chat
     * can say which pool refused rather than replaying Anthropic's sentence.
     *
     * Reads the probe first and the store second. Both can be absent — a host
     * with no store, a probe that has not landed — and absent is reported as
     * absent: `scope: 'unknown'` is a truthful thing for a surface to render,
     * an invented "session" is not.
     */
    accountLimitInfo: (accountId) => {
      if (accountId === undefined) return undefined;
      const codexLimit = codexAccounts.limitInfo(accountId);
      if (codexLimit) return codexLimit;
      const store = readPatchStore(oauthOpts);
      const account = store?.accounts.find((a) => a.id === accountId);
      const entry = accountUsage?.get(accountId);
      const windows = entry?.reading.windows;
      // The pool that RAN OUT — one a person actually spends. Overage is
      // deliberately not a candidate: it is the overflow that covers for these
      // two, so naming it as the limit hit produces a headline nobody can act
      // on. "Extra usage limit on Default" was that headline. Its state
      // travels separately, because it has a different remedy: the session
      // limit resets on its own, extra usage being off does not.
      const refusing = refusingRateLimitScope(windows);
      const window = refusing ? windows?.[refusing] : undefined;
      const overage = windows?.overage;
      return {
        ...(account?.label !== undefined ? { label: account.label } : {}),
        ...(refusing !== undefined ? { scope: refusing } : {}),
        ...(window?.utilization !== undefined ? { utilization: window.utilization } : {}),
        ...(window?.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
        ...(overage?.status === 'rejected' ? { overageBlocked: true } : {}),
        ...(overage?.disabledReason !== undefined ? { overageReason: overage.disabledReason } : {}),
      };
    },
    // spec/04 § Name: summarise each chat's opening exchange into a short title
    // once, after the first response — a cheap one-shot Haiku call. Fired async
    // + non-blocking inside the host; a failure leaves the chat unnamed.
    generateTitle: makeTitleGenerator({
      sdkBackend,
      runOnAccountWithCredit,
      // A Codex chat is titled on its own model, like its goal check (below).
      codex: { sdkBackend: routedBackend, resolveOAuth: resolveModelOAuth },
      logger,
    }),
    // patch/todo.md § Features to add — "Current status": after each turn
    // settles, summarise the thread's current status + whether it's paused on a
    // user question or merely complete. Cheap one-shot Haiku, fired async +
    // non-blocking; a failure leaves the previous status unchanged.
    generateStatus: makeStatusGenerator({ sdkBackend, runOnAccountWithCredit, logger }),
    // spec/04 § Goals: after each turn settles on a chat with an active goal,
    // judge the condition against the transcript so far. `routedBackend` +
    // `resolveModelOAuth` (same pair `hook.check_request`'s prompt check uses)
    // so a Codex chat's goal is judged on ITS OWN model, not borrowed Haiku.
    evaluateGoal: makeGoalEvaluator({
      sdkBackend: routedBackend,
      resolveOAuth: resolveModelOAuth,
      settings: () => ({ prompt: goalEvalPrompt, model: goalModel }),
      logger,
    }),
    // spec/14 § Tool runs: label each closed run of tool calls with what it was
    // for ("Set up the project locally"). Cheap one-shot Haiku, async; a
    // failure is stamped on the run rather than hidden.
    summarizeToolRun: makeToolRunSummarizer({ sdkBackend, runOnAccountWithCredit, logger }),
    // spec/04 § Send back — the one-line summary a side branch's conclusion
    // carries into its parent track. Cheap one-shot Haiku, async.
    summarizeBranchSendBack: makeBranchSendBackSummarizer({
      sdkBackend,
      runOnAccountWithCredit,
      logger,
    }),
    // spec/06 § Session rotation — the handoff digest a scheduled rotation
    // asks the outgoing special-thread session to write for itself before
    // it's retired.
    generateDigest: makeDigestGenerator({ sdkBackend, runOnAccountWithCredit, logger }),
    // spec/06 § Sweep — the sweep's one decision call, plus the cross-host
    // relays it uses to read a non-local candidate's recent messages and to
    // nudge/wake one (same relays `patch_history`/`patch_send_to` use).
    decideSweep: makeSweepDecider({ sdkBackend, runOnAccountWithCredit, logger }),
    historyRemoteChat,
    sendToRemoteChat,
    emit,
    logger,
    mcpServer: {
      command: mcpBin.command,
      args: mcpBin.args,
      env: {
        PATCH_DAEMON_SOCKET: config.socketPath,
        // The child presents this as a Bearer on every socket call (spec/02
        // § MCP server). It is handed over in the environment the host sets,
        // which is also how the host knows the child is one it started —
        // identity is plumbing, not the key.
        PATCH_DAEMON_LOCAL_KEY: localKey,
        // PATCH_CHAT_ID is injected per-query in chatRunner.runQuery —
        // the MCP child needs the *current* chatId, not a static one.
        // See group 10 BLOCKER A.2.
      },
    },
    // Group 11: prepend the broadcast `<system-reminder>` for special threads.
    preprocessInput: (req) => {
      // Meeting mode: the panel and any transcript the model has not seen ride in
      // front of the user's turn, never as chat messages of their own.
      const meetingBlock = meetings?.contextFor(req.chatId);
      if (meetingBlock !== undefined) {
        return meetingBlock + (req.voicePrefix ? `${req.voicePrefix}${req.message}` : req.message);
      }
      if (!(SPECIAL_THREAD_IDS as readonly string[]).includes(req.chatId)) return undefined;
      const threadId = req.chatId as SpecialThreadId;
      if (!BROADCAST_SIDECAR_THREADS.has(threadId)) return undefined;
      const entries = readPendingBroadcasts(daemonCwd, threadId);
      const now = Date.now();
      const block = buildBroadcastSystemReminder(entries, now);
      if (!block) return undefined;
      return block + (req.voicePrefix ? `${req.voicePrefix}${req.message}` : req.message);
    },
    onTurnCommitted: (chatId) => {
      if (!(SPECIAL_THREAD_IDS as readonly string[]).includes(chatId)) return;
      const threadId = chatId as SpecialThreadId;
      if (!BROADCAST_SIDECAR_THREADS.has(threadId)) return;
      flushBroadcasts(daemonCwd, threadId);
    },
    // patch/todo.md § Features to add — "todo list": mirror each chat's native
    // TodoWrite list onto chat state and, when a turn settles with items still
    // pending, fire the next one back as a fresh `[todo]` turn so the agent works
    // its list one focused item at a time instead of getting distracted.
    autoAdvanceTodos: true,
    // spec/20-hooks.md § On the agent's response — check `agent_response`
    // hooks after every turn settles.
    checkAgentResponseHooks: true,
    // "chat names should update every N messages": persisted global preference.
    chatNameInterval,
    // spec/06 § Manager conversation — persisted global preference.
    managerContextWindow,
    onRateLimit: reportUsage,
    // spec/02 § Browser — Route through.
    browserRouting: {
      target: () => browserRouteThrough,
      isOnline: (daemonId) => onlineHosts.has(daemonId),
      hostName: (daemonId) => hostNames.get(daemonId) ?? daemonId,
      proxyServerFor: (daemonId) => browserTunnelClient.proxyServerFor(daemonId),
    },
    // Initialized from persisted state; toggled by `host.settings`.
    // Not passed here — `setAutoResumeRateLimit` is called after construction.
    // spec/10 § Backend credentials — multiple accounts: validates/resolves a
    // spawn's `accountId` against what this host actually has stored. Reads
    // the store fresh each call (not cached) so an account added/removed
    // between spawns is reflected immediately.
  });
  // Meeting mode (meeting.ts). Local Whisper only: a meeting is hours of audio,
  // so a paid STT backend is never an option here, configured or not.
  meetings = new MeetingManager({
    dir: join(config.patchHome, 'meetings'),
    transcribe: async (wav) => {
      if (!dictationTranscribers)
        throw new Error('host audio stack not ready — whisper unavailable');
      return dictationTranscribers.local.transcribeClip(wav, 'wav');
    },
    analyse: makeMeetingAnalyser({ sdkBackend, runOnAccountWithCredit, cwd: daemonCwd }),
    emit,
    runAction: async (chatId, message) => {
      await daemon.sendInput({ chatId, message, localId: randomUUID(), fromUser: true });
    },
    logger: logger.child({ component: 'meeting' }),
  });
  // Apply persisted auto-resume setting before hydrate so any in-flight chats
  // restored from disk get the right setting immediately.
  daemon.setAutoResumeRateLimit(autoResumeRateLimit);
  daemon.setQuestionExpiry({ enabled: questionExpiry, seconds: questionExpirySeconds });
  daemon.setGoalRefusalLimit(goalRefusalLimit);
  // Apply persisted harness config (Task 3; spec/14 § Agent behavior) before hydrate.
  applyHarnessConfig();
  daemon.hydrate();
  {
    const started = Date.now();
    // A failed build is logged and still releases waiting searches: each
    // search refreshes every chat itself, so it reports its own failure.
    void chatSearch
      .warm(daemon.list())
      .then(
        () =>
          logger.info(
            { tookMs: Date.now() - started, transcripts: chatSearch.size() },
            'chat search index built',
          ),
        (err: unknown) =>
          logger.error({ err: (err as Error).message }, 'chat search index build failed'),
      )
      .then(() => chatSearchBuilt());
  }
  // spec/04 § Folders: the host owns the folder registry. Its list is the
  // registered project roots first, then folders seen in recent chats. It
  // publishes `folders.list` on connect (onAuthed, above) and `folders.updated`
  // whenever the set changes (via `emit` on chat.spawned) over the server link.
  folderRegistry = new FolderRegistry({
    // Designated project roots survive a restart (`host.folder_add` is a user
    // designation, not a cache).
    registered: persistedHostState.folderRoots ?? [],
    source: {
      listChats: () =>
        daemon.list().map((c) => ({
          chatId: c.chatId,
          folder: c.folder,
          lastUpdated: c.lastUpdated,
        })),
    },
    onChange: (registry) =>
      link.send({ type: 'folders.updated', daemonId: selfDaemonId, ...registry }),
  });
  // The Manager and Speakers are the account's and live on the home machine
  // (spec/06 § Where special threads run), so only that machine creates them.
  function createSpecialThreads(): void {
    ensureSpecialThreads({
      patchHome: daemonCwd,
      metaStore,
      chatState: daemon.chatState,
      now: () => Date.now(),
      logger,
      permissionModeDefault: daemon.permissionModeDefault(),
    });
  }
  if (isHomeHost) createSpecialThreads();
  // A Manager handoff that was waiting when this host last stopped.
  const waitingHandoff = hostStateStore.get().managerHandoff;
  if (waitingHandoff !== undefined && daemon.chatState.has('thread_manager')) {
    daemon.restoreThreadHandoff('thread_manager', waitingHandoff);
  }

  /** Tell the server about one chat: that it exists, and its current state. */
  function announceChat(state: ReturnType<typeof daemon.list>[number]): void {
    emit({
      type: 'chat.spawned',
      chatId: state.chatId,
      daemonId: selfDaemonId,
      folder: state.folder,
    });
    emit({
      type: 'chat.state',
      chatId: state.chatId,
      daemonId: selfDaemonId,
      activity: state.activity,
      permissionMode: daemon.chatPermissionMode(state.chatId),
      lastUpdated: state.lastUpdated,
      lastUserActivity: state.lastUserActivity,
      pinned: state.pinned,
      pinnedAt: state.pinnedAt,
      status: state.status,
      // The server's registry is rebuilt from this replay after a restart:
      // a field left out here defaults there to "not hidden / not snoozed",
      // which puts every hidden chat back in the active list.
      snoozedUntil: state.snoozedUntil,
      hidden: state.hidden,
      name: state.name,
      preview: state.preview,
      folder: state.folder,
    });
  }

  // 5. UDS control HTTP.
  // Group 10 BLOCKER B.8: jobs DATA lives on the SERVER. The host's
  // patch_job_* MCP tools relay through this RemoteJobsStore which
  // round-trips `patch.jobs.request`/`patch.jobs.response` events over the
  // server-daemon WS.
  const jobs = new RemoteJobsStore({
    emit,
    isLinkOnline: () => linkOnline,
  });

  // patch_artifact (spec/14 § Artifacts): the host owns the file, the server
  // owns the public origin — the page round-trips over
  // `patch.artifact.publish_request`/`_response` on the same link.
  const artifactPublisher = new ArtifactPublisher({
    emit,
    isLinkOnline: () => linkOnline,
  });
  // patch_pad_* (spec/14 § Pads): the same round trip, for design spaces.
  const padClient = new PadClient({ emit, isLinkOnline: () => linkOnline });
  // spec/04 § Message queueing — the server-run queue's tool-boundary pull.
  const queuePull = new QueuePullClient({ emit, isLinkOnline: () => linkOnline });
  pullQueuedFromServer = (chatId) => queuePull.pull(chatId);

  // Dial OUT to the patch-server WebSocket AS EARLY as boot allows (spec/12
  // ## Surface connection state model: "the host should dial the server as
  // early as startup allows"). Everything the link genuinely needs is now
  // wired: the daemonKey (step 3), config (serverWsUrl), and the graph the
  // onAuthed/onFrame closures touch — `daemon`, `folderRegistry`,
  // `secretsStore`, `jobs`. The remaining startup work (UDS control listen,
  // /healthz, and the heavy voice stack in step 8) is NOT a prerequisite for a
  // healthy link, so we dial before it rather than after — a surface no longer
  // sits in `connecting`/daemon-unknown while the audio models load. Emits
  // raised during the rest of boot buffer in the link's offline buffer and
  // flush the instant `auth.ok` lands. Auto-reconnects with a short first
  // backoff (serverLink BACKOFF_SCHEDULE_MS).
  link.start();
  logger.info({ url: config.serverWsUrl }, 'patch-daemon: dialing patch-server WS');

  // POST /stop (control IPC) calls this; assigned once the graceful-shutdown
  // closure is defined below. Until then the endpoint 503s.
  let shutdownHook: (() => void) | undefined;
  // Is a newer build published for this machine? Checked on boot and hourly,
  // so `daemon.host.updateAvailable` reflects the channel rather than a
  // hard-coded false. A failed check leaves the flag alone and logs why — an
  // unreachable update channel is not evidence that no update exists.
  const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
  /**
   * Actually try the credential and report what happened. A token that exists
   * but cannot be refreshed is NOT a working credential, and saying otherwise
   * is what let the app look healthy while every turn would fail. Runs on boot
   * and hourly; the spawn gate corrects it immediately on a real failure.
   */
  const refreshCredentialState = async (): Promise<void> => {
    const result = await resolveOAuth();
    if (result.ok === credentialOk) return;
    credentialOk = result.ok;
    logger.info({ credentialOk }, 'backend credential state changed');
    emit(buildAccountReport());
    emit(describeHost());
  };
  void refreshCredentialState().catch((err: unknown) => {
    logger.warn({ err }, 'credential check failed');
  });
  const credentialTimer = setInterval(
    () => {
      void refreshCredentialState().catch((err: unknown) => {
        logger.warn({ err }, 'credential check failed');
      });
    },
    60 * 60 * 1000,
  );
  credentialTimer.unref?.();

  const refreshUpdateAvailable = async (): Promise<void> => {
    const check = await checkForUpdate({
      serverUrl: config.serverUrl,
      currentVersion: VERSION,
      target: BUILD_TARGET,
    });
    if (check.available !== updateAvailable) {
      updateAvailable = check.available;
      logger.info(
        { updateAvailable, published: check.version, reason: check.reason },
        'self-update: availability changed',
      );
      // The surface's Hosts list reads this off the self-description.
      emit(describeHost());
    }
    // spec/02 § Installation — "checks the server for a newer build on boot
    // and on a schedule, downloads it, and restarts itself". Reporting
    // `updateAvailable` above is NOT that: without this, a published build
    // sits advertised-but-never-pulled until a human clicks Update in
    // Settings → Hosts, which a host running unattended jobs never gets
    // (2026-09-30 — this host ran over 30h behind a published build with
    // nothing to show for the "schedule" but the Hosts badge). `applyUpdateOnce`
    // already knows how to do this safely: nothing happens with no update
    // published, and a busy machine defers until idle rather than killing a
    // running turn.
    if (check.available) {
      const result = await applyUpdateOnce();
      if (!result.applied && !result.deferred) {
        logger.warn({ reason: result.message }, 'self-update: scheduled apply refused');
      }
    }
  };
  void refreshUpdateAvailable().catch((err: unknown) => {
    logger.warn({ err }, 'self-update: initial availability check failed');
  });
  const updateCheckTimer = setInterval(() => {
    void refreshUpdateAvailable().catch((err: unknown) => {
      logger.warn({ err }, 'self-update: availability check failed');
    });
  }, UPDATE_CHECK_INTERVAL_MS);
  // Never hold the process open for a version check.
  updateCheckTimer.unref?.();

  // The machine's Claude Code, on the same cadence as the host's own version
  // check (spec/02 § Agent backends). The CLI only self-updates from an
  // INTERACTIVE session, and a host that exists to run jobs never has one — so
  // it silently stops moving, and an old enough build starts substituting
  // working-looking alternatives for features it is gated out of (a stale CLI is
  // how `--permission-mode auto` became `default` on every unattended job).
  // Nothing here fails the host: a host with no `claude` at all reports its
  // backend absent through the existing gate, and a failed update is logged
  // with the CLI's own stderr.
  const refreshClaudeCli = async (): Promise<void> => {
    const executable = resolveClaudeExecutable({
      home: homedir(),
      pathEnv: process.env['PATH'] ?? '',
      override: process.env['CLAUDE_CODE_PATH'],
    });
    if (executable === undefined) {
      logger.debug('claude-cli-update: this machine has no Claude Code to update');
      return;
    }
    await updateClaudeCli({ executable, logger });
  };
  void refreshClaudeCli().catch((err: unknown) => {
    logger.warn({ err }, 'claude-cli-update: initial update failed');
  });
  // Work stalled on a spent account, restarted the MOMENT credit returns
  // (spec/10-auth.md § Backend credentials). The sequence itself lives in
  // `creditResume.ts`; what is here is the boot re-arm.
  //
  // Event-driven, not polled. The limit message states when it resets
  // ("resets 8pm (UTC)"), so the reset is a known instant and deserves a timer
  // armed for exactly it — not a clock that wakes every few minutes to ask
  // whether anything has changed. There are three events that can make stalled
  // work runnable again, and every one of them restarts BOTH the parked chats
  // and the errored ones:
  //
  //   1. a limit reaching its stated reset  → `creditResume`'s own timer, armed
  //      when the exhaustion is recorded and re-armed after it fires;
  //   2. a person adding or reconnecting a key → handled at those frames;
  //   3. a usage reading showing an account that was spent is spendable again
  //      → `onReading` below, off the probe the tracker already takes on its
  //      own 10-minute refresh and when a person presses Refresh.
  //
  // (3) exists because an account exhausted with NO stated reset time arms no
  // timer — there is no instant to arm for — and before it, such an account
  // stayed sidelined until someone touched a credential.
  /**
   * Re-arm after a restart, from what is on disk.
   *
   * Exhaustion is in-memory, so a restart forgets which accounts are out and
   * arms nothing — and an event-driven retry with no armed event never fires.
   * The reset time is recoverable though: every chat that failed this way holds
   * the provider's own message in its persisted `lastError`, reset time and all.
   * So the boot re-derives the earliest reset still ahead and arms for it.
   *
   * Without this, a host restart is the one thing that could leave a failed
   * chat waiting forever — exactly the behaviour being fixed.
   */
  const armCreditRetryFromDisk = (): void => {
    const now = Date.now();
    let soonest: number | undefined;
    for (const state of daemon.chatState.list()) {
      // Off META, and with no filter on the lifecycle status. This read used to
      // be `state.status === 'errored'` and then `state.lastError`, and neither
      // is what a limit leaves: a credit park keeps the status `active` (the
      // chat has work owed, it is not dead), and the hydrator only rehydrates a
      // persisted `lastError` for a chat whose stored status says errored. So
      // the one thing that re-arms the retry after a restart — the restart being
      // the only way a park can be lost — was reading a field that was always
      // null by the time it looked.
      const last = metaStore.read(state.chatId)?.lastError ?? state.lastError;
      if (!last || !isAccountExhaustedError(last.message)) continue;
      const at = parseLimitResetsAt(last.message, last.at);
      if (at === undefined || at <= now) continue;
      if (soonest === undefined || at < soonest) soonest = at;
    }
    if (soonest === undefined) return;
    // WHICH key that chat spent is not on disk and is not worth inventing: a
    // chat has no account, and the turn that failed is long gone. What matters
    // is the instant to retry at, so the first stored key carries the record —
    // it is the one every turn resolves to first, so it is the one that has to
    // be seen as spent for the others to be tried at all.
    const first = readPatchStore(oauthOpts)?.accounts[0]?.id;
    if (first === undefined) return;
    accountRotation.markExhausted(first, 'restored from a failed chat after restart', soonest);
    logger.info({ at: soonest }, 'credit retry: re-armed after restart from a failed chat on disk');
    creditResume.arm();
  };

  // Boot: an event-driven retry needs its event armed, and a restart forgot it.
  armCreditRetryFromDisk();

  const claudeCliTimer = setInterval(() => {
    void refreshClaudeCli().catch((err: unknown) => {
      logger.warn({ err }, 'claude-cli-update: update failed');
    });
  }, UPDATE_CHECK_INTERVAL_MS);
  claudeCliTimer.unref?.();

  const app = await buildControl({
    logger: true,
    daemon,
    localKey,
    jobs,
    // spec/02 § Control IPC — every host-scoped control this host owns, over
    // the local socket, driving the SAME operations as the `host.*` wire frames
    // so `patch` on the machine itself needs no round trip through the server.
    host: {
      describe: () => describeHost(),
      folders: {
        snapshot: () => folderRegistry.split(),
        add: (path) => {
          folderRegistry.register(path);
          emit({ type: 'folders.updated', daemonId: selfDaemonId, ...folderRegistry.snapshot() });
        },
        remove: (path) => {
          const removed = folderRegistry.unregister(path);
          if (removed) {
            emit({ type: 'folders.updated', daemonId: selfDaemonId, ...folderRegistry.snapshot() });
          }
          return removed;
        },
      },
      claudeSettings: {
        snapshot: claudeSettingsSnapshot,
        discard: () => {
          claudeSettingsFile.discard();
          emit({
            type: 'claude_settings.updated',
            daemonId: selfDaemonId,
            ...claudeSettingsSnapshot(),
          });
        },
        deleteMemory: (project, file) => {
          deleteClaudeMemory(config.claudeProjectsRoot, project, file);
          emit({
            type: 'claude_settings.updated',
            daemonId: selfDaemonId,
            ...claudeSettingsSnapshot(),
          });
        },
      },
      backends: {
        list: () => describeHost().backends,
      },
      models: async () => {
        const outcomes = await Promise.allSettled([
          modelCatalog.get().then((r) => r.models),
          codexAccounts.models(),
        ]);
        return {
          models: outcomes.flatMap((r, i) =>
            r.status === 'fulfilled'
              ? r.value.map((m) => ({
                  ...m,
                  backend: i === 0 ? CLAUDE_BACKEND_ID : CODEX_BACKEND_ID,
                }))
              : [],
          ),
          errors: outcomes.flatMap((r, i) =>
            r.status === 'rejected'
              ? [
                  {
                    backend: i === 0 ? CLAUDE_BACKEND_ID : CODEX_BACKEND_ID,
                    message: String(r.reason),
                  },
                ]
              : [],
          ),
        };
      },
      components: {
        install: (componentId) => {
          components.install(componentId);
          emit(describeHost());
        },
        remove: (componentId) => {
          components.remove(componentId);
          emit(describeHost());
        },
      },
      pairDevice: () => deviceAdoption.open(),
      update: async () => {
        const result = await applyUpdateOnce();
        // A refused apply (nothing newer, bad digest, bad signature) is
        // reported as refused with the reason — never as a quiet success.
        if (!result.applied && !result.deferred) {
          logger.warn({ reason: result.message }, 'host.update refused');
        }
        return result;
      },
    },
    // spec/03 § Cross-chat tools — the machine roster the server pushes, so an
    // agent's `patch_spawn` naming a machine that is down fails inside the turn
    // instead of buffering.
    isHostOnline: (daemonId: string) => daemonId === selfDaemonId || onlineHosts.has(daemonId),
    // spec/03 § Cross-chat tools — a spawn on ANOTHER machine resolves on that
    // machine's own answer, so a refusal there fails the tool call here.
    spawnOnRemoteHost,
    // The account-wide chat list (every machine's chats, each naming its own).
    listAccountChats: (sourceChatId, archived) => requestAccountChats(sourceChatId, archived),
    // `patch_activity` — the user's own messages, gathered by the server from every machine's chat logs.
    getActivity: (sourceChatId, since, until, messagesCursor, limit) =>
      requestActivity(sourceChatId, since, until, messagesCursor, limit),
    // spec/03 § Cross-chat tools — a chat not found among THIS machine's own
    // resolves on the OWNING machine's own answer, exactly like a cross-host
    // spawn, once the server's chat mirror says where it actually lives.
    peekRemoteChat,
    historyRemoteChat,
    sendToRemoteChat,
    listDevices: () => presence.enumerate(deviceRegistry.list()),
    // Speakers-channel device-resolution cascade (spec/09 § `### speakers`).
    // Composes the live presence registry; step-4 exhaustion re-routes the
    // text through the `push` notify path (server delivers it or logs to
    // undelivered.jsonl). The ring frame the cascade emits is consumed by the
    // device's control WSS handler (firmware specifics: F2).
    // spec/07 § Agent-initiated voice — an app call already open takes the
    // message as speech instead of a ring. Late-bound: the audio server starts
    // after buildControl, and is up long before any tool call lands.
    interruptOpenCall: (text: string) => audioServer?.interruptOpenCall(text) ?? false,
    speakers: {
      presence: {
        enumerate: () => presence.enumerate(deviceRegistry.list()),
        isOnline: (id) => presence.isOnline(id),
        // speakers-cascade.ts's `reachable()` short-circuits on `isOnline(id)`
        // first; this host-side `isMuted` closure (and `send` below) is
        // only reached for a device that IS online, which — like
        // `isPhoneCallActive` above — needs a real, paired, connected
        // device-control WS session to produce (its own 100%-covered domain
        // in devices/control-ws.ts + presence.ts, exercised end-to-end in
        // test/device-control-ws.test.ts). The boot test here proves the
        // explicit-deviceId path's `reachable()` call for an OFFLINE
        // registered device (isOnline=false, hence these closures
        // short-circuited away) and the cascade's fallthrough to pushFallback.
        isMuted: /* v8 ignore next */ (id) => presence.isMuted(id),
        // Route the ring through the control plane (F2) rather than the raw
        // presence socket, so the device's eventual `ring_accepted` resolves
        // to the right chat (`deviceControl` records the pending ring). The
        // frame the cascade builds IS a DeviceRingFrame (type:'ring', chatId,
        // message, conversational:false, [lowVolume]). Returns false when the
        // device is not connected → cascade falls to the next candidate.
        /* v8 ignore next */
        send: (id, frame) => deviceControl.ring(id, frame as unknown as DeviceRingFrame),
      },
      pushFallback: ({ chatId, message }) => {
        emit({ type: 'notify', chatId, channel: 'push', message });
      },
    },
    emitWire: emit,
    publishArtifact: artifactPublisher.publish,
    padRequest: padClient.request,
    // Live link diagnostics + spec/12 link-drop control on the control UDS.
    serverLink: {
      diagnostics: () => link.diagnostics(),
      dropLink: () => link.dropLink(),
      floodBuffer: (chatId, count) => link.floodBuffer(chatId, count),
    },
    onShutdown: () => shutdownHook?.(),
    toolLogger: (entry) => logger.info(entry, 'cross-chat tool call'),
    onBroadcast: ({ channel, message, sourceChatId }) => {
      const threadId = threadForChannel(channel);
      if (!threadId) return;
      // Group 12 (DX-1): a thread firing patch_notify on its OWN channel
      // (e.g. thread_speakers → speakers) would otherwise self-loop —
      // appending to its own broadcasts.jsonl, then reading the entry back
      // as a <system-reminder> on its next user turn. Suppress same-channel
      // self-loops; any other chat broadcasting on speakers still appends
      // normally.
      if (isBroadcastSelfLoop(channel, sourceChatId)) {
        logger.info(
          { channel, sourceChatId },
          'broadcast self-loop suppressed (thread fired on its own channel)',
        );
        return;
      }
      const sourceState = daemon.chatState.get(sourceChatId);
      const sourceChatName = sourceState?.name ?? sourceChatId;
      appendBroadcast(daemonCwd, threadId, {
        ts: Date.now(),
        sourceChatName,
        message,
      });
    },
  });
  const socketDir = dirname(config.socketPath);
  if (!existsSync(socketDir)) {
    mkdirSync(socketDir, { recursive: true });
  }
  if (existsSync(config.socketPath)) {
    const stat = statSync(config.socketPath);
    if (!stat.isSocket()) {
      throw new Error(
        `Refusing to remove non-socket file at ${config.socketPath}; resolve manually.`,
      );
    }
    unlinkSync(config.socketPath);
  }
  await app.listen({ path: config.socketPath });
  // Lock down the UDS — Fastify's listen({path}) doesn't expose mode.
  chmodSync(config.socketPath, 0o600);
  logger.info({ socket: config.socketPath }, 'patch-daemon control listening on UDS');

  // 6. TCP /healthz.
  const tcp = createHttpServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // spec/11 § Version reporting: an installed host reports its version,
      // the commit it was built from and the instant it was built.
      res.end(
        JSON.stringify({
          ok: true,
          version: VERSION,
          gitSha: GIT_SHA,
          builtAt: BUILT_AT,
          ...(BUILD_TARGET !== undefined ? { target: BUILD_TARGET } : {}),
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve_, reject) => {
    tcp.once('error', reject);
    tcp.listen(config.healthzPort, config.healthzHost, () => resolve_());
  });
  logger.info(
    { host: config.healthzHost, port: config.healthzPort },
    'patch-daemon healthz listening on TCP',
  );

  // 8. Voice infrastructure (group 13): audio WSS at :3003/audio/<sessionId>.
  //    (The server-link dial happens earlier — right after the host graph is
  //    wired — so surfaces connect promptly rather than waiting on this stack.)
  whisper = createWhisper({
    backend: config.audio.whisperBackend,
    logger: logger.child({ component: 'whisper' }),
    groqApiKey: () => providerKeys.get('groq'),
    ...(config.audio.whisperLocalSidecarUrl !== undefined
      ? { localSidecarUrl: config.audio.whisperLocalSidecarUrl }
      : {}),
    ...(config.audio.whisperModelPath !== undefined
      ? { localModelPath: config.audio.whisperModelPath }
      : {}),
    // Spawn the faster-whisper sidecar from its package dir when local mode is
    // self-hosted (no external URL). WHISPER_SIDECAR_CWD overrides for docker.
    ...(config.audio.whisperBackend === 'local' && config.audio.whisperLocalSidecarUrl === undefined
      ? {
          localSidecarCwd:
            process.env['WHISPER_SIDECAR_CWD'] ??
            resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'whisper-sidecar'),
        }
      : {}),
  });
  dictationTranscribers = createDictationTranscribers({
    logger: logger.child({ component: 'hosted-stt' }),
    local: whisper,
    geminiApiKey: () => providerKeys.get('gemini'),
    geminiModel: config.audio.geminiTranscribeModel,
    openaiApiKey: () => providerKeys.get('openai'),
    openaiModel: config.audio.openaiTranscribeModel,
  });
  // spec/02 § Optional components: voice is a component the user installs on a
  // machine, and installing it is what turns it ON. A machine that has installed
  // Kokoro — weights verified AND its Python runtime built — can speak, whether
  // or not anything set KOKORO_BACKEND, because the install IS the explicit
  // choice the env var otherwise stands for. (An env var still wins: `mock` for
  // tests, `off` to hold a machine quiet.) This is what the docker image gets
  // from baking the venv at build time; an artifact-installed host now gets it
  // from having been asked for it.
  // `installed` already requires the runtime stamp (components.ts settledState).
  const kokoroInstalled =
    components.describe().find((c) => c.id === 'kokoro')?.state === 'installed';
  const kokoroBackend =
    process.env['KOKORO_BACKEND'] === undefined && kokoroInstalled
      ? ('real' as const)
      : config.audio.kokoroBackend;
  if (kokoroBackend !== config.audio.kokoroBackend) {
    logger.info(
      { component: 'kokoro' },
      'TTS enabled: the Kokoro component is installed on this machine',
    );
  }
  const kokoro = createKokoro({
    backend: kokoroBackend,
    logger: logger.child({ component: 'kokoro' }),
    ...(config.audio.kokoroSidecarUrl !== undefined
      ? { sidecarUrl: config.audio.kokoroSidecarUrl }
      : {}),
    ...(config.audio.kokoroModelPath !== undefined
      ? { modelPath: config.audio.kokoroModelPath }
      : {}),
    // When no external KOKORO_SIDECAR_URL is set, the host spawns the
    // `patch_kokoro_sidecar` itself; run `uv run` in the sidecar package dir
    // so the module resolves. KOKORO_SIDECAR_CWD overrides for non-standard
    // layouts (e.g. docker images that vendor the sidecar elsewhere).
    //
    // The `??` fallback below is deliberately never exercised: the boot test
    // for this branch (KOKORO_BACKEND=real with no sidecar URL) always sets
    // KOKORO_SIDECAR_CWD to a throwaway temp path, on purpose. Falling
    // through to this default resolves to the REAL `packages/kokoro-sidecar`
    // directory in this repo, and the kokoro prewarm that immediately
    // follows would `uv run` a genuine subprocess there (real venv, real
    // `patch_kokoro_sidecar` module) — the same class of "test accidentally
    // does something real" risk this session already hit once for real (see
    // the `~/.claude.json` CLAUDE_CONFIG_PATH comment in bootMain). The
    // expression itself is a trivial two-segment `resolve()` path join with
    // no branching of its own.
    ...(kokoroBackend === 'real' && config.audio.kokoroSidecarUrl === undefined
      ? {
          /* v8 ignore next 3 */
          sidecarCwd: process.env['KOKORO_SIDECAR_CWD'] ?? bundledSidecarDir('kokoro'),
          // The venv the component install built for this machine. `uv run
          // --no-sync` uses it as-is; without it, `uv` would resolve a fresh
          // environment inside the artifact — read-only on some installs, and
          // several GB of wheels the machine already has.
          sidecarEnv: {
            UV_PROJECT_ENVIRONMENT: components.runtimeDir('kokoro'),
            // Import the sidecar from THIS host version's source. The venv's
            // own install is an editable link to whichever version folder built
            // it, and an update prunes that folder: on 2026-09-25 every spawn
            // died with "No module named patch_kokoro_sidecar" after 0.1.1064
            // was removed, while the venv still counted as provisioned.
            /* v8 ignore next */
            PYTHONPATH: join(
              process.env['KOKORO_SIDECAR_CWD'] ?? bundledSidecarDir('kokoro'),
              'src',
            ),
          },
          // A machine that had no `uv` got one during the install, in the patch
          // home rather than on PATH — so name it rather than hoping.
          uvPath: uvCandidates(config.patchHome).find((p) => existsSync(p)) ?? 'uv',
        }
      : {}),
  });
  // Pre-warm the Kokoro sidecar at boot (real backend only) so the model load
  // (~327 MB weights + spaCy, several seconds) happens off the FIRST voice
  // call's critical path. Fire-and-forget: never blocks host readiness, and a
  // warm failure is non-fatal (the lazy spawn on first real synth still works).
  /**
   * Synthesise a throwaway phrase and discard it, so the model is resident and
   * hot when a real reply needs speaking. Drains the iterator — the point is
   * the work, not the audio.
   */
  const warmKokoro = async (): Promise<void> => {
    const warm = await kokoro.synthesize('Ready.');
    for await (const chunk of warm.iterator) {
      void chunk; // drain + discard — we only want the model resident in the sidecar.
    }
  };
  if (kokoroBackend === 'real') {
    void (async () => {
      try {
        await warmKokoro();
        logger.info({ component: 'kokoro' }, 'kokoro sidecar pre-warmed');
        /* v8 ignore start -- RealKokoroBackend's synthesize()/iterator
         * contract (src/audio/kokoro.ts) deliberately converts every
         * mid-stream sidecar failure into a `requestPromise.catch()` that
         * logs a warn and ends the iterator gracefully (empty), rather than
         * rejecting — verified by reading that implementation and confirmed
         * empirically in test/index-main.test.ts's "no sidecar listening"
         * prewarm case, which still resolves cleanly. The only way to reach
         * THIS catch is `kokoro.synthesize()` itself throwing synchronously
         * (e.g. `ensureProcess()`'s missing-modelPath guard), which can't
         * happen here: `validateKokoroModel` already refuses to boot at all
         * without a real KOKORO_MODEL_PATH. Kept as a genuine NO FALLBACK
         * safety net against a future kokoro.ts contract change, not gamed
         * away. */
      } catch (err) {
        logger.warn(
          { component: 'kokoro', err: (err as Error).message },
          'kokoro pre-warm failed (non-fatal)',
        );
      }
      /* v8 ignore stop */
    })();
    // KEEP it warm, don't just start it warm. The boot pre-warm alone left the
    // first call after a quiet hour paying the whole model load again —
    // measured at 19s to first audio, against a ~200ms budget — because the
    // weights get paged out while the box does something else. By then the user
    // has hung up, which reads as "the call doesn't speak". A short synthesis on
    // a slow timer keeps the weights resident for the cost of a few hundred ms
    // of CPU an interval.
    const keepWarm = setInterval(() => {
      void warmKokoro().catch((err: Error) => {
        logger.warn({ component: 'kokoro', err: err.message }, 'kokoro keep-warm failed');
      });
    }, KOKORO_KEEP_WARM_MS);
    keepWarm.unref();
  }
  // VAD factory: with VAD_BACKEND=silero load the real onnxruntime session once
  // (validated at boot above) and build a fresh per-session Vad reusing it; the
  // mock backend stays the docker-compose/test default. NO silent fallback —
  // a silero load failure throws and aborts boot.
  const makeVad =
    config.audio.vadBackend === 'silero' && config.audio.vadModelPath !== undefined
      ? await createSileroVadFactory({ modelPath: config.audio.vadModelPath })
      : (): Vad => new MockVad();

  const deviceControlWss = new WebSocketServer({ noServer: true });
  audioServer = await startAudioServer({
    host: config.audio.host,
    port: config.audio.port,
    logger: logger.child({ component: 'audio' }),
    internalToken: config.internalToken,
    whisper,
    kokoro,
    makeVad,
    maxConcurrentSessions: config.audio.maxConcurrentSessions,
    // E1-d3: a voice session must bind to a chat that exists. Check live
    // chat state first, then fall back to the on-disk meta store (a chat
    // resumable from disk still exists, even if not currently hydrated).
    chatExists: (chatId: string): boolean =>
      daemon.chatState.has(chatId) || metaStore.read(chatId) !== undefined,
    // spec/14 ## Sidebar + spec/16 — a physical voice-device session opening
    // or closing drives the "mid-session" pill on the Speakers row across all
    // surfaces. Resolve the user-given device name from the registry so the
    // pill reads e.g. "🎙 kitchen". `device.session` is account-scoped (no
    // chatId) so the server fans it out to every connected surface.
    onDeviceSession: (deviceId, active) => {
      const record = deviceRegistry.get(deviceId);
      const name = record?.name ?? deviceId;
      emit({ type: 'device.session', deviceId, name, active });
    },
    // F2: when a phone Manager call ends, release any device events the
    // concurrency arbiter queued behind it (spec/16 §Concurrency).
    onSessionClosed: ({ wasPhoneCall }) => {
      if (wasPhoneCall) deviceControl.onPhoneCallEnded();
    },
    // F2: share the audio HTTP listener for the persistent device control WSS.
    deviceControlUpgrade: mountDeviceControlUpgrade({
      server: deviceControl,
      wss: deviceControlWss,
      logger: logger.child({ component: 'device-control' }),
    }),
    submitUserTurn: async ({ chatId, message, source, onReplyText, handoff }) => {
      // Tag the turn by its ingress. Physical voice devices get
      // `[voice • device:<deviceId>]` (spec/06 ## Speakers thread) so the
      // agent knows which room it's hearing; app surfaces get
      // `[voice • <surfaceKind>]`. The same audio WSS streams the reply's TTS
      // back to the originating session, which IS the originating device.
      // A fast voice's hand-off (spec/07 § The fast voice and the chat's agent)
      // is tagged as one: the user's own words are already in the timeline.
      const voicePrefix =
        source.kind === 'voice-device'
          ? `[voice${handoff === true ? ' hand-off' : ''} • device:${source.deviceId}] `
          : `[voice${handoff === true ? ' hand-off' : ''} • ${source.surfaceKind}] `;
      // This path is only ever reached from a live audio-WSS session, which
      // always carries a `sessionId`; the `?? surfaceKind` keeps the localId
      // well-formed now that `sessionId` is optional on the source type (the
      // uploaded-note path omits it, but that path never calls submitUserTurn).
      /* v8 ignore start -- defensive fallback only: this closure is wired exclusively to VoiceSession's live submitUserTurn call, which always constructs its source with a required, non-optional `sessionId` (see the comment above) */
      const localIdSuffix =
        source.kind === 'voice-device'
          ? `device:${source.deviceId}`
          : (source.sessionId ?? source.surfaceKind);
      /* v8 ignore stop */
      // Unique per turn: the reply bridge recognises this turn's own message by it.
      const localId = `voice-${localIdSuffix}-${Date.now()}-${randomUUID().slice(0, 8)}`;
      // Register BEFORE the input is sent, so the bridge sees this turn's very
      // first message and every delta after it. Armed by that message only: the chat
      // may be running some other turn right now, with this one queued behind it.
      const replyPromise = voiceReplies.awaitReply(chatId, onReplyText, localId);
      // `sendInput` awaits the whole turn (and any turns that queue behind it),
      // so by the time it returns the bridge has normally already settled. If
      // it THROWS, the turn never ran — fail the waiter loudly instead of
      // leaving the session waiting on a promise nothing will ever resolve.
      try {
        await daemon.sendInput({
          chatId,
          message,
          localId,
          voicePrefix,
          fromUser: true,
        });
      } catch (err) {
        voiceReplies.abandon(chatId, err as Error);
        throw err;
      }
      return replyPromise;
    },
    // spec/07 ## Permission prompts during voice — a spoken yes/no mid-call
    // resolves the focused chat's outstanding permission via the STT path.
    getPendingPermission: (chatId: string) => daemon.getPendingPermissionForChat(chatId),
    resolvePermission: (requestId: string, approve: boolean) =>
      daemon.submitPermissionResponse({ requestId, decision: approve ? 'approve' : 'deny' }),
    // Voice-in-settings: read the live value so a settings change takes effect
    // on the next utterance without restarting an open session.
    getKokoroVoice: () => kokoroVoice,
    // spec/07 § Voice — live read, same pattern as getKokoroVoice above.
    getVoiceConfig: () => voiceConfig,
    geminiApiKey: () => providerKeys.get('gemini'),
    ...(config.audio.geminiLiveModel ? { geminiLiveModel: config.audio.geminiLiveModel } : {}),
    ...(config.audio.geminiLiveModelHeavy
      ? { geminiLiveModelHeavy: config.audio.geminiLiveModelHeavy }
      : {}),
    openaiApiKey: () => providerKeys.get('openai'),
    ...(config.audio.openaiRealtimeModelLight
      ? { openaiRealtimeModelLight: config.audio.openaiRealtimeModelLight }
      : {}),
    ...(config.audio.openaiRealtimeModelHeavy
      ? { openaiRealtimeModelHeavy: config.audio.openaiRealtimeModelHeavy }
      : {}),
    dictationTranscribers,
    // spec/07 § Keeping voice and text as one conversation — what a fast
    // voice opens with: the chat's name and its most recent messages. A chat
    // whose history cannot be read fails the session loudly rather than
    // opening a voice that knows nothing.
    getChatContext: (chatId: string) => {
      const { name, opening, turns } = daemon.voiceContext(chatId, {
        maxChars: VOICE_CONTEXT_MAX_CHARS,
      });
      // Header lines for the call's briefing: what the chat is called and how it began.
      const header = [
        ...(name !== null
          ? [{ role: 'user' as const, text: `(This chat is titled "${name}".)` }]
          : []),
        ...(opening !== null
          ? [
              {
                role: 'user' as const,
                text: `(It began with the user saying: "${opening.replace(/\s+/g, ' ').slice(0, 400)}")`,
              },
            ]
          : []),
      ];
      return [...header, ...turns];
    },
    makeTimeline: (init) => chatVoice.makeTimeline(init),
    onCallEnded: (info) => chatVoice.callEnded(info),
  });

  if (config.sdkBackend === 'real') void codexAccounts.start();

  // 9. Graceful shutdown.
  const shutdown = async (): Promise<void> => {
    await codexAccounts.close();
    logger.info('patch-daemon: shutting down');
    // spec/04 § History — everything the history log was told is on disk
    // before the process goes (the batch fsync would otherwise lose up to 1 s).
    try {
      daemon.flushHistory();
    } catch (err) {
      logger.error({ err }, 'patch-daemon: history log flush failed on shutdown');
    }
    // Close device control sockets first so the shared audio HTTP listener can
    // close cleanly (otherwise http.close() waits on the persistent control
    // WSS connections; F2).
    deviceControl.closeAll();
    // Terminal shells die with the host (spec/02 — no reattach); surfaces are
    // told via `patch.terminal.exit { reason: 'daemon_shutdown' }`.
    await terminals.shutdown().catch(() => undefined);
    // spec/02 § Browser — Route through: close every SOCKS listener/outbound
    // socket this host holds, on either half, rather than leaking them.
    browserTunnelClient.dispose();
    browserTunnelRelay.dispose();
    audioRelayBridge.dispose();
    await audioServer.close().catch(() => undefined);
    await kokoro.close().catch(() => undefined);
    await whisper.close().catch(() => undefined);
    await link.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    tcp.close();
  };
  // Wire the control-IPC POST /stop endpoint to graceful shutdown.
  shutdownHook = () => void shutdown().then(() => process.exit(0));
  process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
  testHooks?.onReady?.({
    shutdown,
    daemon,
    folderRegistry,
    secretsStore,
    app,
    deviceRegistry,
    sdkBackend,
  });
}

/**
 * Group 19: server asked for a directory listing under a chat's pinned
 * folder. Resolve via chatState, sandbox, and reply on the same WS peer.
 */
// List the skills a chat in `folder` can actually invoke — what typing `/name`
// in the composer would reach (spec/14 § Composer — skill autocomplete). Backs
// the job-editor's Skill picker too (the host owns the project filesystem;
// the server round-trips this RPC). A folder with none is NOT an error.
//
// Two places, because a skill is either the project's or the machine's, and a
// machine-level skill applies in every folder on it — so the picker offered
// less than the agent behind it would actually run:
//
//   <folder>/.claude/skills      the project's own
//   ~/.claude/skills             the machine's, which apply in every folder
//
// SKILLS ONLY — `.claude/commands` is deliberately not read. A command is a
// different thing from a skill and the picker is not a list of everything that
// could be typed after a slash.
//
// Symlinks are followed: a skills directory is often a link to where the repo
// really keeps them, so entries are stat'd rather than read off the dirent's own
// type, which reports a symlinked skill as neither file nor directory.
export async function handleSkillsRequest(
  event: import('@patch/wire').PatchSkillsRequestEvent,
  sender: (e: WireEvent) => void,
  logger: Logger,
): Promise<void> {
  const { readdirSync, existsSync, statSync, readFileSync } = await import('node:fs');
  const { resolve: pathResolve, join } = await import('node:path');
  const { homedir } = await import('node:os');
  const { parseFrontmatterFields } = await import('./claudeSettings.js');
  const folder = pathResolve(event.folder);
  if (!existsSync(folder)) {
    sender({
      type: 'patch.skills.response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'folder_not_found', message: `folder not found: ${event.folder}` },
    });
    return;
  }
  /**
   * What one directory offers, in either shape: the skill's name paired with
   * the file that defines it. The path is kept AS JOINED (not realpath'd) so a
   * skills directory that is a symlink still reports its file under `folder` —
   * a surface resolves the path against the folder to reach it.
   */
  const skillsIn = (dir: string): Array<[name: string, file: string]> => {
    if (!existsSync(dir)) return [];
    const out: Array<[string, string]> = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      let isDir: boolean;
      try {
        // `stat`, not the dirent: a symlinked skill reports as a symlink, and
        // this layout is built out of symlinks.
        isDir = statSync(path).isDirectory();
      } catch {
        continue; // a dangling symlink offers nothing.
      }
      if (isDir) {
        if (existsSync(join(path, 'SKILL.md'))) out.push([entry.name, join(path, 'SKILL.md')]);
      } else if (entry.name.endsWith('.md')) {
        out.push([entry.name.slice(0, -'.md'.length), path]);
      }
    }
    return out;
  };
  const home = process.env['HOME'] ?? homedir();
  try {
    // The project's own skills first, so a name defined in both places resolves
    // to the project's copy — the same precedence the name list has always had.
    const paths: Record<string, string> = {};
    for (const [name, file] of [
      ...skillsIn(join(folder, '.claude', 'skills')),
      ...skillsIn(join(home, '.claude', 'skills')),
    ]) {
      paths[name] ??= file;
    }
    const names = Object.keys(paths).sort();
    // Each skill's WHOLE frontmatter block, keyed by field name
    // (`parseFrontmatterFields` in `claudeSettings.ts`) — plus `descriptions`,
    // kept alongside for a surface still on an older wire contract that only
    // reads that field. A file that fails to read, or whose frontmatter has no
    // fields at all, is left out of both maps rather than added empty — "no
    // frontmatter found" and "found, and it's empty" are different facts.
    const descriptions: Record<string, string> = {};
    const frontmatter: Record<string, Record<string, string>> = {};
    for (const name of names) {
      let text: string;
      try {
        text = readFileSync(paths[name]!, 'utf8');
      } catch {
        continue;
      }
      const fields = parseFrontmatterFields(text);
      if (Object.keys(fields).length > 0) frontmatter[name] = fields;
      if (fields.description) descriptions[name] = fields.description;
    }
    sender({
      type: 'patch.skills.response',
      requestId: event.requestId,
      ok: true,
      skills: names,
      paths,
      descriptions,
      frontmatter,
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, folder: event.folder },
      'patch.skills.request: list failed',
    );
    sender({
      type: 'patch.skills.response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'internal', message: (err as Error).message },
    });
  }
}

// spec/02 § Model catalogue — answer the surface's model-picker request from the
// host's catalogue (Anthropic's model list, read with the Claude OAuth
// credential, cached on a TTL). NO FALLBACK: a credential/upstream failure comes
// back as `ok:false` with the reason, never a hand-maintained list.
export async function handleModelsRequest(
  event: import('@patch/wire').PatchModelsRequestEvent,
  catalog: ModelCatalog,
  sender: (e: WireEvent) => void,
  logger: Logger,
  daemonId: string,
  codex?: CodexAccounts,
): Promise<void> {
  // Every entry names the backend serving it, and a backend that failed is
  // returned as an error AGAINST THAT BACKEND alongside the models that did
  // resolve — a host with an expired credential on one backend still offers the
  // other's models (spec/02 § Model catalogue). NO FALLBACK: a failure is never
  // papered over with a hand-maintained list.
  if (codex) {
    const outcomes = await Promise.allSettled([
      catalog.get().then((s) => s.models),
      codex.models(),
    ]);
    const models: { id: string; label: string; backend: string }[] = [];
    const errors: { backend: string; code: 'upstream'; message: string }[] = [];
    outcomes.forEach((result, index) => {
      const backend = index === 0 ? CLAUDE_BACKEND_ID : CODEX_BACKEND_ID;
      if (result.status === 'fulfilled')
        models.push(...result.value.map((m) => ({ ...m, backend })));
      else errors.push({ backend, code: 'upstream', message: String(result.reason) });
    });
    sender({
      type: 'patch.models.response',
      requestId: event.requestId,
      daemonId,
      models,
      errors,
      fetchedAt: new Date().toISOString(),
      ...(event.forSurfaceId ? { forSurfaceId: event.forSurfaceId } : {}),
    });
    return;
  }
  try {
    const snapshot = await catalog.get();
    sender({
      type: 'patch.models.response',
      requestId: event.requestId,
      daemonId,
      models: snapshot.models.map((m) => ({ ...m, backend: CLAUDE_BACKEND_ID })),
      errors: [],
      fetchedAt: snapshot.fetchedAt,
      ...(event.forSurfaceId !== undefined ? { forSurfaceId: event.forSurfaceId } : {}),
    });
  } catch (err) {
    const message = (err as Error).message;
    logger.warn({ err: message }, 'patch.models.request: catalogue read failed');
    sender({
      type: 'patch.models.response',
      requestId: event.requestId,
      daemonId,
      models: [],
      errors: [
        {
          backend: CLAUDE_BACKEND_ID,
          code: /oauth/i.test(message) ? 'oauth_unavailable' : 'upstream',
          message,
        },
      ],
      ...(event.forSurfaceId !== undefined ? { forSurfaceId: event.forSurfaceId } : {}),
    });
  }
}

/**
 * spec/08 § Recurrence — the job editor's natural-language schedule input.
 * Runs the one-shot translator and answers `patch.recurrence.translate.response`.
 * NO FALLBACK: a null from the translator (OAuth miss, SDK error, timeout, or
 * the model's own "UNSURE") becomes `ok:false` with a reason, never a guessed
 * RRULE — the server still re-validates and re-describes whatever comes back
 * `ok:true` before it ever reaches a client (see recurrenceTranslate.ts's header).
 */
export async function handleRecurrenceTranslateRequest(
  event: import('@patch/wire').PatchRecurrenceTranslateRequestEvent,
  translate: (input: {
    requestId: string;
    phrase: string;
    folder: string;
  }) => Promise<string | null>,
  sender: (e: WireEvent) => void,
  logger: Logger,
  daemonId: string,
  patchHome: string,
): Promise<void> {
  try {
    const rrule = await translate({
      requestId: event.requestId,
      phrase: event.phrase,
      folder: patchHome,
    });
    if (rrule === null) {
      sender({
        type: 'patch.recurrence.translate.response',
        requestId: event.requestId,
        daemonId,
        ok: false,
        error: 'could not confidently translate that phrase into a schedule',
        ...(event.forSurfaceId !== undefined ? { forSurfaceId: event.forSurfaceId } : {}),
      });
      return;
    }
    sender({
      type: 'patch.recurrence.translate.response',
      requestId: event.requestId,
      daemonId,
      ok: true,
      rrule,
      ...(event.forSurfaceId !== undefined ? { forSurfaceId: event.forSurfaceId } : {}),
    });
  } catch (err) {
    const message = (err as Error).message;
    logger.warn({ err: message }, 'patch.recurrence.translate.request: translation failed');
    sender({
      type: 'patch.recurrence.translate.response',
      requestId: event.requestId,
      daemonId,
      ok: false,
      error: message,
      ...(event.forSurfaceId !== undefined ? { forSurfaceId: event.forSurfaceId } : {}),
    });
  }
}

/**
 * spec/04 § Browsing (directory listing) — the folder BROWSER. The server asks
 * the host to list a directory's child directories (or, with no `dir`, the
 * browsable roots). The host owns the filesystem and confines listing to its
 * project roots via `FolderRegistry.browse`; a traversal escape / missing dir
 * comes back as `folder_not_found` (NO FALLBACK — never a listing of `/`).
 */
export async function handleFoldersBrowseRequest(
  event: import('@patch/wire').PatchFoldersBrowseRequestEvent,
  folderRegistry: FolderRegistry,
  sender: (e: WireEvent) => void,
  logger: Logger,
  daemonId: string,
): Promise<void> {
  try {
    const result = await folderRegistry.browse(event.dir);
    sender({
      type: 'patch.folders.browse.response',
      requestId: event.requestId,
      daemonId,
      ...(event.forSurfaceId !== undefined ? { forSurfaceId: event.forSurfaceId } : {}),
      ok: true,
      dir: result.dir,
      parent: result.parent,
      entries: result.entries,
    });
  } catch (err) {
    const code =
      (err as { code?: string }).code === 'folder_not_found' ? 'folder_not_found' : 'internal';
    if (code === 'internal') {
      logger.warn(
        { err: (err as Error).message, dir: event.dir },
        'patch.folders.browse.request: list failed',
      );
    }
    sender({
      type: 'patch.folders.browse.response',
      requestId: event.requestId,
      daemonId,
      ...(event.forSurfaceId !== undefined ? { forSurfaceId: event.forSurfaceId } : {}),
      ok: false,
      error: { code, message: (err as Error).message },
    });
  }
}

/**
 * spec/07 § End-to-end voice transport — transcribe a mobile voice-note clip.
 *
 * The server round-trips the uploaded m4a (base64) over the host link; the
 * host runs it through its Whisper backend's "uploaded clip" path (Groq
 * accepts m4a directly; the local faster-whisper backend refuses it with a
 * typed `unsupported_format`) and replies with the transcript or a typed error.
 * The server, on `ok`, injects the transcript as the chat's next user turn.
 * NO FALLBACK — every failure is reported, never swallowed into a blank note.
 */
/**
 * spec/14 & spec/15 § Composer — store an uploaded attachment under the chat's
 * dir so a later `chat.input` carrying its ref can be fed into the turn by path.
 *
 * The server owns the HTTP upload route + a serving-copy for inline rendering;
 * it round-trips the bytes here (base64) because Claude runs on the host and
 * can only read files on the host's filesystem. NO FALLBACK — an unknown chat
 * or a decode/write failure is reported as a typed error, never swallowed.
 */
export function handleAttachmentStore(
  event: import('@patch/wire').PatchAttachmentStoreRequestEvent,
  daemon: Daemon,
  sender: (e: WireEvent) => void,
  logger: Logger,
): void {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(event.dataBase64, 'base64');
    /* v8 ignore start -- Node's Buffer.from(str, 'base64') never throws for
     * garbage/malformed base64 CONTENT (verified empirically: it just decodes
     * whatever bytes it can) — it only throws when the argument isn't a
     * string at all, which `dataBase64: string` (wire-schema-enforced at the
     * real ingress) rules out. Same defensive-catch pattern already accepted
     * elsewhere in this package (see audio/token-verifier.ts's analogous
     * base64url catch). Kept as a NO FALLBACK safety net, not gamed away. */
  } catch (err) {
    sender({
      type: 'patch.attachment.store_response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'invalid_data', message: `bad base64 data: ${(err as Error).message}` },
    });
    return;
  }
  /* v8 ignore stop */
  if (bytes.byteLength === 0) {
    sender({
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
    sender({ type: 'patch.attachment.store_response', requestId: event.requestId, ok: true, path });
  } catch (err) {
    const code = err instanceof AttachmentChatNotFoundError ? 'chat_not_found' : 'internal';
    logger.warn(
      { err: (err as Error).message, chatId: event.chatId, id: event.id, code },
      'patch.attachment.store_request: store failed',
    );
    sender({
      type: 'patch.attachment.store_response',
      requestId: event.requestId,
      ok: false,
      error: { code, message: (err as Error).message },
    });
  }
}

/**
 * One error line per voice surface configured onto a backend whose key this
 * host does not hold. Logged, never thrown: the host keeps serving every
 * chat, and the surface itself is refused per session with the same sentence.
 */
export function logVoiceKeysMissing(logger: Logger, config: VoiceConfig, keys: VoiceKeys): void {
  for (const { surface, backend, env } of voiceSurfacesMissingKey(config, keys)) {
    logger.error(
      { surface, backend, missingKey: env },
      `voice: ${voiceKeyMissingMessage(surface, backend)} Its sessions will be refused.`,
    );
  }
}

export async function handleVoiceNoteTranscribe(
  event: import('@patch/wire').PatchVoiceNoteTranscribeRequestEvent,
  transcribers: DictationTranscribers | undefined,
  backend: VoiceBackend,
  sender: (e: WireEvent) => void,
  logger: Logger,
): Promise<void> {
  if (!transcribers) {
    sender({
      type: 'patch.voice_note.transcribe_response',
      requestId: event.requestId,
      ok: false,
      error: {
        code: 'internal',
        message: 'host audio stack not ready — whisper backend unavailable',
      },
    });
    return;
  }
  let audio: Buffer;
  try {
    audio = Buffer.from(event.audioBase64, 'base64');
    /* v8 ignore start -- same reasoning as handleAttachmentStore's identical
     * catch above: Buffer.from(str, 'base64') never throws for malformed
     * base64 content, only for a non-string argument, which `audioBase64:
     * string` rules out at the wire boundary. Defensive NO FALLBACK net, not
     * a coverage gap. */
  } catch (err) {
    sender({
      type: 'patch.voice_note.transcribe_response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'internal', message: `bad base64 audio: ${(err as Error).message}` },
    });
    return;
  }
  /* v8 ignore stop */
  // spec/07 § Voice — a config matrix: a note and a composer dictation are the
  // `dictation` surface, so its configured backend transcribes the clip. A
  // hosted backend with no key on this host is refused, not quietly
  // transcribed by Whisper instead (NO SILENT FALLBACK).
  const picked = pickDictationTranscriber(backend, transcribers);
  if (!picked.ok) {
    sender({
      type: 'patch.voice_note.transcribe_response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'voice_key_missing', message: picked.message },
    });
    return;
  }
  const whisper = picked.whisper;
  if (audio.byteLength === 0) {
    sender({
      type: 'patch.voice_note.transcribe_response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'transcription_failed', message: 'empty audio clip' },
    });
    return;
  }
  try {
    const transcript = await whisper.transcribeClip(audio, event.format);
    sender({
      type: 'patch.voice_note.transcribe_response',
      requestId: event.requestId,
      ok: true,
      transcript,
    });
  } catch (err) {
    const code =
      err instanceof UnsupportedClipFormatError ? 'unsupported_format' : 'transcription_failed';
    logger.warn(
      { err: (err as Error).message, format: event.format, code },
      'patch.voice_note.transcribe_request: transcription failed',
    );
    sender({
      type: 'patch.voice_note.transcribe_response',
      requestId: event.requestId,
      ok: false,
      error: { code, message: (err as Error).message },
    });
  }
}

/**
 * spec/15 § Secrets: apply a surface-originated secret write to the host-owned
 * store and ack it on the same peer. On success also publish `secrets.updated`
 * so every mirror + surface reflects the write immediately. A set with an
 * invalid key is rejected (`invalid_key`); deleting an absent key is
 * `not_found`. NO FALLBACK — an unexpected fs error is reported as `internal`,
 * never swallowed.
 */
export function handleSecretsMutation(
  event:
    | import('@patch/wire').PatchSecretsSetRequestEvent
    | import('@patch/wire').PatchSecretsDeleteRequestEvent,
  store: SecretsStore,
  sender: (e: WireEvent) => void,
  logger: Logger,
): void {
  try {
    if (event.type === 'patch.secrets.set_request') {
      store.set(event.key, event.value);
    } else {
      const removed = store.delete(event.key);
      if (!removed) {
        sender({
          type: 'patch.secrets.response',
          requestId: event.requestId,
          ok: false,
          error: { code: 'not_found', message: `secret not found: ${event.key}` },
        });
        return;
      }
    }
    sender({ type: 'patch.secrets.response', requestId: event.requestId, ok: true });
    sender({ type: 'secrets.updated', secrets: store.list() });
  } catch (err) {
    if (err instanceof InvalidSecretKeyError) {
      sender({
        type: 'patch.secrets.response',
        requestId: event.requestId,
        ok: false,
        error: { code: 'invalid_key', message: err.message },
      });
      return;
    }
    logger.warn(
      { err: (err as Error).message, key: event.key },
      `${event.type}: secret write failed`,
    );
    sender({
      type: 'patch.secrets.response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'internal', message: (err as Error).message },
    });
  }
}

export async function handleFilesRequest(
  event: import('@patch/wire').PatchFilesRequestEvent,
  daemon: Daemon,
  sender: (e: WireEvent) => void,
  logger: Logger,
): Promise<void> {
  const { readdirSync, statSync, readFileSync } = await import('node:fs');
  const { resolve: pathResolve, join, sep, relative } = await import('node:path');
  const state = daemon.chatState.get(event.chatId);
  if (!state) {
    sender({
      type: 'patch.files.response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'chat_not_found', message: `chat not found: ${event.chatId}` },
    });
    return;
  }
  const root = pathResolve(state.folder);
  const rel = (event.path ?? '').replace(/^\/+/, '');
  const target = pathResolve(join(root, rel));
  if (target !== root && !target.startsWith(root + sep)) {
    sender({
      type: 'patch.files.response',
      requestId: event.requestId,
      ok: false,
      error: { code: 'path_escape', message: 'path escapes chat folder' },
    });
    return;
  }

  // Group 20 fix #5: file content fetch.
  if (event.content === true) {
    // G3: `ref: 'head'` returns the git HEAD blob (for "view diff vs HEAD").
    // G3-d1 (NO FALLBACK): if the chat folder is not a git work-tree, or has no
    // HEAD commit, there is NO baseline to diff against. We must NOT silently
    // return an empty baseline — that masks the missing git history and makes
    // the diff editor render the whole file as a brand-new addition. Instead we
    // reject loudly with `no_head_baseline` (→ 409 at the HTTP boundary). A file
    // that IS in a git repo with a HEAD but is merely untracked still yields an
    // empty string (genuinely no prior committed content — that is the truth,
    // not a fallback).
    if (event.ref === 'head') {
      // First establish that there is a HEAD baseline at all. `git rev-parse
      // --verify HEAD` fails on a non-git folder OR a repo with no commits yet.
      let hasHead = false;
      try {
        execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
          cwd: root,
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        hasHead = true;
      } catch {
        hasHead = false;
      }
      if (!hasHead) {
        sender({
          type: 'patch.files.response',
          requestId: event.requestId,
          ok: false,
          error: {
            code: 'no_head_baseline',
            message: 'chat folder is not a git work-tree with a HEAD commit',
          },
        });
        return;
      }
      let head = '';
      try {
        head = execFileSync('git', ['show', `HEAD:${rel}`], {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
        });
      } catch {
        // Repo has a HEAD but this path is untracked / not in HEAD → genuinely
        // empty baseline (the file has no committed prior content).
        head = '';
      }
      sender({
        type: 'patch.files.response',
        requestId: event.requestId,
        ok: true,
        path: rel,
        content: head,
        size: Buffer.byteLength(head, 'utf8'),
      });
      return;
    }
    try {
      const stat = statSync(target);
      if (!stat.isFile()) {
        // G3-d3: requesting file content of a directory is a client error, not
        // a bad-gateway condition. Report `not_a_file` (→ 400).
        sender({
          type: 'patch.files.response',
          requestId: event.requestId,
          ok: false,
          error: { code: 'not_a_file', message: 'path is a directory, not a file' },
        });
        return;
      }
      // Editor overhaul (binary preview): `encoding: 'base64'` reads the file
      // as raw bytes rather than decoding as UTF-8 — the working-tree text
      // path (no `encoding`) is unchanged, this is purely additive. Backs
      // `GET /api/chats/:id/files/raw` (images/PDF), which needs the actual
      // bytes, not whatever UTF-8 decoding does to a PNG.
      const content =
        event.encoding === 'base64'
          ? readFileSync(target).toString('base64')
          : readFileSync(target, 'utf8');
      sender({
        type: 'patch.files.response',
        requestId: event.requestId,
        ok: true,
        path: rel,
        content,
        size: stat.size,
      });
      return;
    } catch (err) {
      // G3-d2: a missing path is a client-side not-found. Report it as
      // `not_found` (→ 404) with a SANITIZED message that does NOT leak the
      // absolute host filesystem path. Only the chat-relative path is echoed.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        sender({
          type: 'patch.files.response',
          requestId: event.requestId,
          ok: false,
          error: { code: 'not_found', message: `no such file: ${rel}` },
        });
        return;
      }
      sender({
        type: 'patch.files.response',
        requestId: event.requestId,
        ok: false,
        error: { code: 'internal', message: `failed to read file: ${rel}` },
      });
      return;
    }
  }

  // Group 20 fix #5: recursive walk for project-wide ⌘P. Editor overhaul
  // (hierarchical tree): this is now ALSO the single source the file browser
  // builds its whole nested tree from client-side (`buildFileTree` in
  // EditorRail.tsx), so directories are listed too, not just files — without
  // that, an empty directory (or one the user hasn't yet opened a file
  // inside) could never appear as a row to expand. Dotfiles are included for
  // the same reason the non-recursive listing below includes them: the
  // browser is for poking around the whole repo, and `.env.local` /
  // `.claude/skills/...` are exactly the kind of thing someone opens it to
  // find — the old "skip dotfiles as ⌘P search noise" behaviour no longer
  // makes sense now this walk also backs the visible tree, not only ⌘P.
  if (event.recursive === true) {
    const cap = event.maxEntries ?? 5000;
    // `listFilesRecursive` (files-recursive.ts) is now the hierarchical
    // tree's ONLY data source, not just ⌘P's — async (never blocks the
    // host's event loop), gitignore-aware via `git ls-files`, and cached.
    // It returns bare {name,type} pairs; dirty-state is layered on here,
    // exactly like the non-recursive listing below, so the pending-dot
    // marker works at any depth in the tree, not only inside whichever
    // single directory used to be "current".
    const rawEntries = await listFilesRecursive(root, cap);
    const dirtyPaths = daemon.dirtyFilePaths(event.chatId);
    const gitDirtyRel = await gitDirtyPaths(root);
    const flat: Array<{ name: string; type: 'file' | 'dir'; dirty?: boolean }> = rawEntries.map(
      (e) => {
        if (e.type !== 'file') return e;
        const abs = join(root, e.name);
        const dirty = dirtyPaths.has(abs) || gitDirtyRel.has(e.name);
        return dirty ? { ...e, dirty: true } : e;
      },
    );
    sender({
      type: 'patch.files.response',
      requestId: event.requestId,
      ok: true,
      path: rel,
      entries: flat,
    });
    return;
  }

  try {
    const dirents = readdirSync(target, { withFileTypes: true });
    // Group 20 fix #5: mark files dirty if there's an in-flight permission_request
    // proposing to edit them.
    const dirtyPaths = daemon.dirtyFilePaths(event.chatId);
    // G3-d3: the green ● must reflect an ACTUAL on-disk pending change, NOT
    // merely that the agent referenced/edited the file earlier in the chat. The
    // authoritative source is the git work-tree: a file whose working-tree
    // content differs from its committed baseline (modified or untracked) is
    // genuinely dirty; a file the agent edited but whose content now matches
    // HEAD is NOT. Compute the set of git-dirty paths (relative to the work-tree
    // root) once for this listing. A non-git folder yields an empty set (no
    // baseline to diff against → only pending permissions mark a file dirty).
    const gitDirtyRel = await gitDirtyPaths(root);
    // Dotfiles ARE listed here — the file browser is for poking around the
    // whole repo, and a hidden config file (`.env.local`, etc.) is exactly
    // the kind of thing someone opens the browser to find. (Editor overhaul:
    // this single-directory listing is no longer called by the web client at
    // all — the hierarchical tree and ⌘P both read `recursive: true` only —
    // left in place as it costs nothing dead, but don't extend it.)
    const entries = dirents.map((d) => {
      if (d.isDirectory()) return { name: d.name, type: 'dir' as const };
      const abs = join(target, d.name);
      const size = statSync(abs).size;
      const relToRoot = relative(root, abs);
      const dirty = dirtyPaths.has(abs) || gitDirtyRel.has(relToRoot);
      return {
        name: d.name,
        type: 'file' as const,
        size,
        ...(dirty ? { dirty: true } : {}),
      };
    });
    sender({
      type: 'patch.files.response',
      requestId: event.requestId,
      ok: true,
      path: rel,
      entries,
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, chatId: event.chatId, path: rel },
      'patch.files.request: list failed',
    );
    // Sanitize: do not leak the absolute host path in the wire/HTTP message.
    const code = (err as NodeJS.ErrnoException).code;
    sender({
      type: 'patch.files.response',
      requestId: event.requestId,
      ok: false,
      error:
        code === 'ENOENT' || code === 'ENOTDIR'
          ? { code: 'not_found', message: `no such directory: ${rel || '.'}` }
          : { code: 'internal', message: `failed to list directory: ${rel || '.'}` },
    });
  }
}

/**
 * Server asked to create / rename / delete one path inside a chat's folder
 * (REST `POST /api/chats/:id/files` → spec/03 § Files). The host owns the
 * filesystem, so it owns both the guard and the answer: every refusal comes
 * back as a typed code the surface shows the user, and nothing is ever
 * silently skipped.
 */
export function handleFileOpRequest(
  event: import('@patch/wire').PatchFileOpRequestEvent,
  daemon: Daemon,
  sender: (e: WireEvent) => void,
): void {
  const outcome = daemon.fileOp({
    chatId: event.chatId,
    op: event.op,
    path: event.path,
    ...(event.to !== undefined ? { to: event.to } : {}),
  });
  sender(
    outcome.ok
      ? {
          type: 'patch.file_op.response',
          requestId: event.requestId,
          ok: true,
          path: outcome.path,
        }
      : {
          type: 'patch.file_op.response',
          requestId: event.requestId,
          ok: false,
          error: { code: outcome.code, message: outcome.message },
        },
  );
}

/** spec/14 § Document editor, step 2 of 3: the doc view (mode, suggestions, threads, versions). */
export function handleDocRequest(
  event: import('@patch/wire').PatchDocRequestEvent,
  daemon: Daemon,
  sender: (e: WireEvent) => void,
): void {
  const outcome = daemon.getDocView(event.chatId, event.path);
  sender(
    outcome.ok
      ? { type: 'patch.doc.response', requestId: event.requestId, ok: true, view: outcome.value }
      : {
          type: 'patch.doc.response',
          requestId: event.requestId,
          ok: false,
          error: { code: outcome.code, message: outcome.message },
        },
  );
}

/**
 * spec/14 § Document editor, step 2 of 3: every surface-facing mutation —
 * mode switch, accept/reject (one or all), comment/reply/resolve, restore —
 * dispatched by `action.op` to the matching `Daemon` method, each already
 * shaped as `{ok:true, value}|{ok:false, code, message}`.
 */
export function handleDocActionRequest(
  event: import('@patch/wire').PatchDocActionRequestEvent,
  daemon: Daemon,
  sender: (e: WireEvent) => void,
): void {
  const { chatId, path, action } = event;
  const outcome =
    action.op === 'set_mode'
      ? daemon.setDocMode(chatId, path, action.mode)
      : action.op === 'accept_suggestion'
        ? daemon.acceptDocSuggestion(chatId, path, action.id)
        : action.op === 'reject_suggestion'
          ? daemon.rejectDocSuggestion(chatId, path, action.id)
          : action.op === 'accept_all'
            ? daemon.acceptAllDocSuggestions(chatId, path)
            : action.op === 'reject_all'
              ? daemon.rejectAllDocSuggestions(chatId, path)
              : action.op === 'add_comment'
                ? daemon.addDocComment(chatId, path, action.anchor, action.text)
                : action.op === 'reply_comment'
                  ? daemon.replyDocComment(chatId, path, action.threadId, action.text)
                  : action.op === 'resolve_comment'
                    ? daemon.resolveDocThread(chatId, path, action.threadId, action.resolved)
                    : daemon.restoreDocVersion(chatId, path, action.versionId);
  sender(
    outcome.ok
      ? {
          type: 'patch.doc_action.response',
          requestId: event.requestId,
          ok: true,
          view: outcome.value,
        }
      : {
          type: 'patch.doc_action.response',
          requestId: event.requestId,
          ok: false,
          error: { code: outcome.code, message: outcome.message },
        },
  );
}

/** spec/14 § Document editor, step 3 of 3 — opening a `.docx` converts it to the `.md` the editor actually opens. */
export async function handleDocConvertRequest(
  event: import('@patch/wire').PatchDocConvertRequestEvent,
  daemon: Daemon,
  sender: (e: WireEvent) => void,
): Promise<void> {
  const outcome = await daemon.convertDocx(event.chatId, event.path);
  sender(
    outcome.ok
      ? {
          type: 'patch.doc_convert.response',
          requestId: event.requestId,
          ok: true,
          mdPath: outcome.value.mdPath,
          warnings: outcome.value.warnings,
          reused: outcome.value.reused,
        }
      : {
          type: 'patch.doc_convert.response',
          requestId: event.requestId,
          ok: false,
          error: { code: outcome.code, message: outcome.message },
        },
  );
}

/** spec/14 § Document editor, step 3 of 3 — Download/Save as .docx/.pdf/.md from the editor's menu. */
export async function handleDocExportRequest(
  event: import('@patch/wire').PatchDocExportRequestEvent,
  daemon: Daemon,
  sender: (e: WireEvent) => void,
): Promise<void> {
  const outcome = await daemon.exportDoc(event.chatId, event.path, event.format);
  sender(
    outcome.ok
      ? {
          type: 'patch.doc_export.response',
          requestId: event.requestId,
          ok: true,
          path: outcome.value.path,
          mimeType: outcome.value.mimeType,
          dataBase64: outcome.value.buffer.toString('base64'),
          warnings: outcome.value.warnings,
        }
      : {
          type: 'patch.doc_export.response',
          requestId: event.requestId,
          ok: false,
          error: { code: outcome.code, message: outcome.message },
        },
  );
}

/**
 * One step of moving a chat between hosts (spec/04 § Moving a chat to another
 * host). Every outcome is answered — the server is waiting on it with the chat
 * frozen, so a refusal must come back as a refusal, not as silence.
 */
export function handleChatMoveRequest(
  event: import('@patch/wire').PatchChatMoveRequestEvent,
  daemon: Daemon,
  sender: (e: WireEvent) => void,
  logger: Logger,
  daemonId: string,
): void {
  const base = {
    type: 'patch.chat_move.response' as const,
    requestId: event.requestId,
    daemonId,
    chatId: event.chatId,
    op: event.op,
  };
  try {
    if (event.op === 'export') {
      const bundle = daemon.exportChatForMove(event.chatId);
      sender({ ...base, ok: true, bundle });
      return;
    }
    if (event.op === 'import') {
      if (event.bundle === undefined || event.folder === undefined) {
        throw new ChatMoveError('internal', 'an import needs a bundle and a folder');
      }
      if (event.bundle.chatId !== event.chatId) {
        throw new ChatMoveError('internal', 'the bundle is for a different chat');
      }
      daemon.importMovedChat(event.bundle, event.folder);
      sender({ ...base, ok: true });
      return;
    }
    if (event.op === 'retire') daemon.retireMovedChat(event.chatId);
    else daemon.releaseMovedChat(event.chatId);
    sender({ ...base, ok: true });
  } catch (err) {
    const code = err instanceof ChatMoveError ? err.code : 'internal';
    const message = (err as Error).message;
    logger.warn({ op: event.op, chatId: event.chatId, code, err: message }, 'chat move refused');
    sender({ ...base, ok: false, error: { code, message } });
  }
}

/**
 * Server asked for a chat's persisted history (REST `GET /api/chats/:id/
 * history?since=<seq>`). The host owns Claude Code's JSONL, so it reads the
 * slice via the same HistoryReader that backs `patch_history` and replies
 * inline. `since` maps to `fromSeq` (events with seq >= since). Only
 * user/assistant `chat.message` turns are reconstructed from the JSONL — tool
 * calls/results are live-stream only (see history.ts). `branchId`, when given,
 * reads that branch's own track (spec/04 § Branching) — this is how the
 * side threads panel pulls a tab's content (spec/14), since a side branch's
 * messages are not broadcast live over the chat's WS stream.
 */
export function handleChatHistoryRequest(
  event: import('@patch/wire').PatchChatHistoryRequestEvent,
  daemon: Daemon,
  sender: (e: WireEvent) => void,
  logger: Logger,
): void {
  try {
    if (
      event.requireParent !== undefined &&
      daemon.delegateParentOf(event.chatId) !== event.requireParent
    ) {
      sender({
        type: 'patch.chat_history.response',
        requestId: event.requestId,
        ok: false,
        error: {
          code: 'not_a_delegate',
          message: `${event.chatId} is not a delegate of ${event.requireParent}`,
        },
      });
      return;
    }
    const slice = daemon.readHistory({
      chatId: event.chatId,
      ...(event.since !== undefined ? { fromSeq: event.since } : {}),
      ...(event.limit !== undefined ? { limit: event.limit } : {}),
      ...(event.branchId !== undefined ? { branchId: event.branchId } : {}),
    });
    const events = slice.events.filter(
      (e): e is Extract<WireEvent, { type: 'chat.message' }> => e.type === 'chat.message',
    );
    sender({
      type: 'patch.chat_history.response',
      requestId: event.requestId,
      ok: true,
      events,
      ...(slice.nextFromSeq !== undefined ? { nextFromSeq: slice.nextFromSeq } : {}),
    });
  } catch (err) {
    const code = err instanceof ChatNotFoundError ? 'chat_not_found' : 'internal';
    logger.warn(
      { err: (err as Error).message, chatId: event.chatId },
      'patch.chat_history.request: read failed',
    );
    sender({
      type: 'patch.chat_history.response',
      requestId: event.requestId,
      ok: false,
      error: { code, message: (err as Error).message },
    });
  }
}

/**
 * spec/10 § Backend credentials — multiple accounts: the store-reading bits
 * `handleServerEvent` needs but cannot close over itself (it's a standalone
 * exported function, deliberately testable without the whole boot
 * scaffolding — see the module doc above). Omitted entirely by existing unit
 * tests that construct their own `Daemon` and never touch a real store; the
 * account-aware branches below degrade to "no store wiring" in that case.
 */
export interface AccountReportHelpers {
  buildAccountReport: (activeOverride?: {
    connected: boolean;
  }) => import('@patch/wire').DaemonAccountEvent;
  /** The shared account ids this host holds for a model's backend, read now. */
  heldAccounts: (model: string | undefined) => string[];
  /** Meeting mode; absent in tests that do not exercise it. */
  meetings?: MeetingManager | undefined;
}

/**
 * Translate inbound server WS frames (originally surface events) into Host
 * action calls. `sender` is bound to *this* server peer — for replay events we
 * route the streamed events back through it (per-surface) rather than the
 * fan-out `emit`.
 */
function requireMeetings(accounts: AccountReportHelpers | undefined): MeetingManager {
  if (!accounts?.meetings) throw new Error('meeting mode is not available on this host');
  return accounts.meetings;
}

export async function handleServerEvent(
  event: WireEvent,
  daemon: Daemon,
  sender: (e: WireEvent) => void,
  logger: Logger,
  accounts?: AccountReportHelpers,
): Promise<void> {
  // op label for log structure (m9): every rejection log line now carries
  // {op, chatId, errorCode}.
  const op = event.type;
  const evChatId =
    'chatId' in event && typeof (event as { chatId?: unknown }).chatId === 'string'
      ? (event as { chatId: string }).chatId
      : undefined;
  try {
    switch (event.type) {
      case 'chat.spawn_request': {
        // A machine with no usable backend credential cannot run the turn it is
        // being asked to run. Spawning anyway emitted `chat.spawned`, which the
        // server settles as a run status of `ok` — so the inbound log claimed
        // success for a turn that never happened, with a chat link to nothing.
        // spec/08 § Logs names exactly this case `dispatch-error`. Refuse here,
        // before the chat exists, so the refusal reaches the run log as one.
        // Re-read the credential rather than trusting the boot-time snapshot:
        // a `claude login` since boot must be picked up without a restart.
        // Which key answers is the host's business — the first stored one with
        // credit (spec/10 § Backend credentials); a spawn cannot name one.
        const spawnAuth = await daemon.backendCredential(event.model);
        if (!spawnAuth.ok) {
          const machine = daemon.daemonId;
          sender({
            type: 'daemon.unauthenticated',
            daemonId: machine,
            backendId: isCodexModel(event.model) ? CODEX_BACKEND_ID : CLAUDE_BACKEND_ID,
            reason: spawnAuth.reason,
          });
          // CORRECT THE SELF-REPORT. `connected` was computed once at boot, so a
          // credential that expired since left every surface believing this
          // machine was signed in — no banner, no warning, and a composer that
          // looked ready right up until the send failed. Say what is true now.
          // The refusal means the host could not produce a usable key at all —
          // it resolves them in order and takes the first that works — so it is
          // the host that is disconnected, not one row of it.
          const report: import('@patch/wire').DaemonAccountEvent =
            accounts && !isCodexModel(event.model)
              ? accounts.buildAccountReport({ connected: false })
              : {
                  type: 'daemon.account',
                  daemonId: machine,
                  backendId: isCodexModel(event.model) ? CODEX_BACKEND_ID : CLAUDE_BACKEND_ID,
                  connected: false,
                  accountEmail: null,
                };
          sender(report);
          logger.error(
            { op, folder: event.folder, reason: spawnAuth.reason },
            'chat.spawn_request refused: no backend credential on this machine',
          );
          sender({
            type: 'chat.error',
            chatId: event.chatId ?? 'pending-spawn',
            error: {
              code: 'claude_oauth_missing',
              // Short and actionable. This lands in a toast and in the chat, so
              // dumping the provider's raw OAuth JSON at a person tells them
              // nothing they can act on — the reason goes to the log instead.
              message: `${machine} isn't signed in to ${isCodexModel(event.model) ? 'OpenAI' : 'Claude'}. Sign in from Settings → Hosts.`,
            },
            seq: OUT_OF_BAND_SEQ,
          });
          return;
        }
        // spec/10 § Backend credentials — preferred account. Only an account
        // this host holds for the chat's own backend: a preference that silently
        // meant nothing would be a setting that lies.
        if (event.preferredAccountId !== undefined) {
          const held = accounts?.heldAccounts(event.model) ?? [];
          if (!held.includes(event.preferredAccountId)) {
            const problem = `preferred account ${event.preferredAccountId} is not one of ${daemon.daemonId}'s ${isCodexModel(event.model) ? 'OpenAI' : 'Claude'} accounts (holds: ${held.join(', ') || 'none'})`;
            logger.error({ op, folder: event.folder }, `chat.spawn_request refused: ${problem}`);
            sender({
              type: 'chat.error',
              chatId: event.chatId ?? 'pending-spawn',
              error: { code: 'account_not_found', message: problem },
              seq: OUT_OF_BAND_SEQ,
            });
            return;
          }
        }
        const spawnedChatId = await daemon.spawnChat({
          folder: event.folder,
          ...(event.prompt !== undefined ? { prompt: event.prompt } : {}),
          ...(event.name !== undefined ? { name: event.name } : {}),
          ...(event.chatId !== undefined ? { chatId: event.chatId } : {}),
          ...(event.localId !== undefined ? { localId: event.localId } : {}),
          // spec/04 § Hidden. `archived` is what a server predating the rename
          // sends for the same intent — keep the run out of the inbox — and a
          // spawn is never archived any more (archived means stopped).
          ...(event.hidden === true || event.archived === true ? { hidden: true } : {}),
          ...(event.model !== undefined ? { model: event.model } : {}),
          ...(event.permissionMode !== undefined ? { permissionMode: event.permissionMode } : {}),
          ...(event.preferredAccountId !== undefined
            ? { preferredAccountId: event.preferredAccountId }
            : {}),
        });
        // spec/04 § Goals, spec/08 ## Action — a job's `spawn`/`continue`
        // action can set the new chat's goal at creation, before its first
        // turn runs.
        if (event.goal !== undefined) {
          await daemon.setGoal(spawnedChatId, event.goal).catch((err: unknown) => {
            logger.warn({ op, chatId: spawnedChatId, err }, 'chat.spawn_request: setGoal failed');
          });
        }
        return;
      }
      case 'chat.input': {
        // spec/06 ## Speakers thread: each inbound audio turn from a physical
        // voice device is tagged `[voice • device]` with its deviceId so the
        // agent knows which device it's hearing from. Only the voice-device
        // ingress hook attaches a `voice-device` source on this server→host
        // path; voice-app turns carry their own tags elsewhere.
        await daemon.sendInput(chatInputToSendOptions(event));
        return;
      }
      case 'hook.agent_response_outcome': {
        // spec/20-hooks.md § On the agent's response — the server's answer
        // to this host's own `hook.agent_response_check_request`; the host
        // decides what each result means (resubmit, defer, log).
        daemon.handleHookAgentResponseOutcome(event);
        return;
      }
      case 'chat.stop_request': {
        // spec/04 § Branching — a branch-addressed stop ends just that
        // branch's turn; the plain (no branchId) form is "stop THE CHAT",
        // which ends every branch's turn.
        if (event.branchId !== undefined) daemon.stopBranch(event.chatId, event.branchId);
        else await daemon.stopAllBranches(event.chatId);
        return;
      }
      case 'chat.resume_now_request': {
        // spec/10 § Usage: stop waiting out the limit and try now. Logged
        // either way — "I pressed it and nothing happened" has to be
        // answerable from the log.
        const resumed = daemon.resumeRateLimitedNow(event.chatId);
        logger.info({ chatId: event.chatId, resumed }, 'manual resume from a usage-limit pause');
        return;
      }
      case 'chat.unqueue_request': {
        // spec/04 ## Message queueing: cancel a still-pending queued turn.
        daemon.unqueueInput(event.chatId, event.localId);
        return;
      }
      case 'chat.edit_queued_request': {
        // spec/04 ## Message queueing § Edit: replace a still-pending queued
        // turn's typed text in place.
        daemon.editQueuedInput(event.chatId, event.localId, event.message);
        return;
      }
      case 'chat.promote_request': {
        // spec/04 ## Message queueing: interrupt the running turn so the
        // queue starts draining now. Does not reorder the queue.
        await daemon.promoteInput(event.chatId, event.localId);
        return;
      }
      case 'chat.fork_request': {
        // spec/04 § Branching: edit a user turn — fork a new track from it.
        await daemon.forkChat({
          chatId: event.chatId,
          seq: event.seq,
          message: event.message,
          localId: event.localId,
        });
        return;
      }
      case 'chat.side_request': {
        // spec/04 § Side threads: a side message off this turn — its own track,
        // sharing the prefix up to and including it.
        await daemon.sideChat({
          chatId: event.chatId,
          seq: event.seq,
          message: event.message,
          localId: event.localId,
        });
        return;
      }
      case 'chat.branch_switch_request': {
        // spec/04 § Branching: make that track the active one.
        await daemon.switchBranch(event.chatId, event.branchId);
        return;
      }
      case 'chat.branch_rename_request': {
        // spec/04 § Branching — "Side branches get a name … renameable".
        daemon.renameBranch(event.chatId, event.branchId, event.name);
        return;
      }
      case 'chat.send_back_request': {
        // spec/04 § Send back; spec/14 § Side threads panel — "Send back to
        // chat" button. Same effect as the agent's own `patch_send_back`
        // tool, triggered directly by the surface instead.
        const result = await daemon.sendBackToParent(event.chatId, event.branchId);
        if (!result.ok) {
          sender({
            type: 'chat.error',
            chatId: event.chatId,
            error: { code: 'send_back_failed', message: result.error },
            seq: OUT_OF_BAND_SEQ,
          });
        }
        return;
      }
      case 'chat.resume_request': {
        await daemon.resumeChat(event.chatId);
        return;
      }
      case 'meeting.get_request': {
        accounts?.meetings?.publish(event.chatId);
        return;
      }
      case 'meeting.control_request': {
        const m = requireMeetings(accounts);
        if (event.action === 'start') m.start(event.chatId);
        else if (event.action === 'pause') m.pause(event.chatId);
        else if (event.action === 'resume') m.resume(event.chatId);
        else await m.end(event.chatId);
        return;
      }
      case 'meeting.audio': {
        await requireMeetings(accounts).ingestAudio(
          event.chatId,
          event.source,
          Buffer.from(event.audioBase64, 'base64'),
        );
        return;
      }
      case 'meeting.action_request': {
        await requireMeetings(accounts).decide(event.chatId, event.actionId, event.decision);
        return;
      }
      case 'chat.pin_request': {
        await daemon.setPinned(event.chatId, event.pinned);
        return;
      }
      case 'chat.archive_request': {
        await daemon.setArchived(event.chatId, event.archived);
        return;
      }
      case 'chat.disable_request': {
        await daemon.setDisabled(event.chatId, event.disabled);
        return;
      }
      case 'chat.rotate_request': {
        // Fire-and-forget from the server's scheduler (spec/06 § Session
        // rotation) — a refusal (mid-turn, no digest generator, digest
        // failure) is the host's own NO FALLBACK guard, logged and dropped
        // rather than propagated, since there is no request-side connection
        // waiting on an answer.
        try {
          await daemon.rotateThread(event.chatId);
        } catch (err) {
          logger.warn(
            { chatId: event.chatId, err: (err as Error).message },
            'chat.rotate_request: rotation refused',
          );
        }
        return;
      }
      case 'manager.sweep_run': {
        // Fire-and-forget from the server's gate (spec/06 § Sweep) — the
        // result goes back over the SAME link, never blocking the sender.
        const result = await daemon.runManagerSweep(event);
        sender(result);
        return;
      }
      case 'chat.snooze_request': {
        // spec/04 § Snooze — absolute wake time, or null to unsnooze.
        await daemon.setSnoozed(event.chatId, event.snoozedUntil);
        return;
      }
      case 'chat.hide_request': {
        // spec/04 § Hidden — `false` is the Hidden section's Show.
        await daemon.setHidden(event.chatId, event.hidden);
        return;
      }
      case 'chat.delete_request': {
        await daemon.setDeleted(event.chatId, event.deleted);
        return;
      }
      case 'chat.goal_request': {
        await daemon.setGoal(event.chatId, event.goal);
        return;
      }
      case 'chat.todos_request': {
        // spec/02 § Task list — a surface rewrote the list; adopt it wholesale.
        daemon.setTodos(event.chatId, event.todos);
        return;
      }
      case 'chat.rename_request': {
        // spec/04 § Name — a user-chosen name, or null to go back to derived.
        await daemon.setName(event.chatId, event.name);
        return;
      }
      case 'chat.reminder_request': {
        await daemon.setReminder(event.chatId, event.reminder);
        return;
      }
      case 'chat.loop_request': {
        // spec/02 § Self-wake — a surface arming/stopping a loop reaches the
        // SAME scheduler the agent's patch_loop/patch_cancel_wake tool calls
        // do; `loop: null` cancels (one pending wake per chat, same as the
        // agent path).
        if (event.loop === null) {
          daemon.cancelWake(event.chatId);
        } else {
          daemon.scheduleWake(event.chatId, {
            message: event.loop.message,
            every: event.loop.every,
            ...(event.loop.notAfter !== undefined ? { notAfter: event.loop.notAfter } : {}),
          });
        }
        return;
      }
      case 'chat.permission_response': {
        // Group 20 fix #3: substitute the user's edited content into the
        // SDK tool args (or deny). KNOWN-GAP: SDK runs in
        // bypassPermissions mode, so the original tool call already
        // executed; this emits a paper-trail synthetic tool_call.
        daemon.submitPermissionResponse({
          requestId: event.requestId,
          ...(event.chatId !== undefined ? { chatId: event.chatId } : {}),
          decision: event.decision ?? (event.approve ? 'approve' : 'deny'),
          ...(event.editedNewString !== undefined && event.editedNewString !== null
            ? { editedNewString: event.editedNewString }
            : {}),
        });
        return;
      }
      case 'file.write': {
        // Editor save from a surface (diff editor or file browser). Accepted
        // whatever the chat is doing; writeFile rejects with a chat.error only
        // when the path escapes the chat folder, and commits atomically
        // otherwise. See spec/14-design-web.md § Editor.
        daemon.writeFile(event.chatId, event.path, event.content);
        return;
      }
      case 'chat.replay': {
        // Per-surface replay: tag every emitted event with `forSurfaceId` so
        // the server routes it to the requesting surface only.
        const surfaceId = event.forSurfaceId;
        const wrap = (ev: WireEvent): WireEvent =>
          surfaceId ? ({ ...(ev as object), forSurfaceId: surfaceId } as WireEvent) : ev;
        if (event.batch !== true) {
          // A surface that did not ask for batches gets one frame per event,
          // exactly as before (spec/12 § Sequence-based replay).
          daemon.replayChat(event.chatId, event.fromSeq, (ev) => sender(wrap(ev)), event.branchId);
          return;
        }
        // Batched: collect the replay and send it as a few large frames
        // instead of thousands of small ones. The per-frame overhead across
        // host -> server -> surface, and drawing each event as it landed,
        // is what a reader saw as the transcript scrolling past one message
        // at a time.
        {
          const chunk: WireEvent[] = [];
          let chunkBytes = 0;
          const flush = (done: boolean): void => {
            if (chunk.length === 0 && !done) return;
            sender(
              wrap({
                type: 'chat.replay_batch',
                chatId: event.chatId,
                events: chunk.splice(0) as ChatReplayBatchEvent['events'],
                done,
              } as WireEvent),
            );
            chunkBytes = 0;
          };
          daemon.replayChat(
            event.chatId,
            event.fromSeq,
            (ev) => {
              chunk.push(ev);
              chunkBytes += JSON.stringify(ev).length;
              if (chunkBytes >= REPLAY_BATCH_BYTES) flush(false);
            },
            event.branchId,
          );
          flush(true);
        }
        return;
      }
      default:
        // Other events (ack, surface.*) are observability-only for the host
        // today. `chat.focus_change` is intercepted earlier in the onFrame
        // closure (focus-follow routing) and never reaches here.
        logger.debug({ type: event.type }, 'ws-control: ignoring frame type');
    }
  } catch (err) {
    let code: ChatErrorCode;
    if (err instanceof FolderNotFoundError) {
      code = 'folder_not_found';
    } else if (err instanceof NoModelCatalogueError) {
      code = 'no_model_catalogue';
    } else if (err instanceof ChatNotFoundError) {
      code = 'chat_not_found';
    } else {
      code = 'sdk_error';
    }
    const message = err instanceof Error ? err.message : String(err);
    // Spawn-time errors don't have a real chatId on the host yet, but the
    // server pre-allocates one and ships it on `chat.spawn_request.chatId`
    // (group 7). Use that so the server's chat-error waiter can match.
    const chatId = evChatId ?? (event.type === 'chat.spawn_request' ? 'pending-spawn' : undefined);
    logger.warn(
      { op, chatId: chatId ?? 'none', errorCode: code, err: message },
      'ws-control: op rejected',
    );
    // A manager sweep is not about any chat: its failure goes back as its own
    // result, so the server settles the run. A `chat.error` for a made-up chat
    // id is drawn by every surface as a new empty "New chat" row.
    if (event.type === 'manager.sweep_run') {
      sender({
        type: 'manager.sweep_result',
        runId: event.runId,
        actions: [],
        tokensUsed: 0,
        error: message,
      });
      return;
    }
    // Any other chat-less op has nothing to attach an error to; logged above.
    if (chatId === undefined) return;
    // F4: allocate the seq through the host's per-chat bumpSeq path when the
    // chat is known, so this error is monotonic + persisted and never collides
    // with a real stream event at seq 0. Unknown chats get OUT_OF_BAND_SEQ
    // (-1) — a marker surfaces won't treat as a replayable stream event.
    const seq = daemon.allocErrorSeq(chatId);
    sender({ type: 'chat.error', chatId, error: { code, message }, seq });
  }
}

// Only auto-boot when this module is the process's actual entry point (`node
// dist/index.js` / `tsx watch src/index.ts`) — NOT when it's imported as a
// module (e.g. by an in-process integration test importing `main` directly to
// drive it with controlled env + test hooks). `process.argv[1]` is undefined
// in that case (no script arg), so the comparison is simply false and this
// block never runs — `main()` only fires via the explicit call the test
// makes itself.
/* v8 ignore start -- CLI bootstrap glue, structurally identical to
 * src/bin/patch-tools-server.ts's own top-level execution (excluded from
 * coverage in vitest.config.ts for the same reason). This guard is only ever
 * true when `node dist/index.js` (or `tsx watch src/index.ts`) runs THIS file
 * as the OS process's actual entry point — process.argv[1] pointing back at
 * this exact module. Every test in this suite (including this file's own
 * `main()`-driving tests) imports index.ts as a module from inside the
 * vitest worker process, whose argv[1] is vitest's own entry script, so the
 * guard is provably false and the block is unreachable from any in-process
 * test. Exercising it for real would mean spawning a genuine `node` child
 * process to boot a full second host — pure process-bootstrap wiring with
 * nothing left to assert that isn't already covered by calling `main()`
 * directly (which the tests above do extensively, catching every code path
 * inside `main()` itself). */
/**
 * Is this module the script node was asked to run?
 *
 * Realpath on BOTH sides. `process.argv[1]` keeps whatever path the caller
 * typed while `import.meta.url` is already resolved through symlinks, so
 * comparing them directly is silently false whenever anything on the invoked
 * path is a link — the host would simply never call `main()`, with no error.
 * `~/.patch/current` is exactly such a symlink.
 *
 * Duplicated from `scripts/lib/is-main.mjs` rather than imported: `scripts/` is
 * not part of the host's build graph and must not become a runtime dep of the
 * shipped bundle. Keep the two in step.
 */
function isProcessEntrypoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isProcessEntrypoint(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error('[patch-daemon] fatal:', err);
    process.exit(1);
  });
}
/* v8 ignore stop */
