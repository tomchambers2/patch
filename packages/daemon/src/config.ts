// Host env config. NO FALLBACKS for required keys.

import { execFileSync } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `silero_vad.onnx` as SHIPPED IN THE ARTIFACT, beside the bundled host
 * (spec/11 § What ships). Unlike the Kokoro weights, VAD is small enough to
 * ride along, so a freshly installed machine already has the model on disk —
 * it just had no way to say where. Resolving it here is not a fallback: it is
 * the known location of a file the build put there. Returns undefined from a
 * source checkout, where the rig names VAD_MODEL_PATH explicitly.
 */
function bundledVadModelPath(): string | undefined {
  try {
    const candidate = join(dirname(fileURLToPath(import.meta.url)), 'silero_vad.onnx');
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a new machine is called until someone renames it (spec/02 § Host
 * identity). A Mac's network hostname is a mangled, numbered copy of its name
 * (`Toms-MacBook-Pro-7.local`), so a Mac reports the name its owner gave it in
 * Sharing settings ("Tom's MacBook Pro"). Anywhere else it is the hostname
 * without a domain.
 */
export function defaultHostName(
  platform: NodeJS.Platform = process.platform,
  computerName: () => string = () =>
    execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }),
  host: string = hostname(),
): string {
  if (platform === 'darwin') {
    const name = computerName().trim();
    if (name.length > 0) return name;
  }
  return host.replace(/\.local$/, '').split('.')[0] || host;
}

/** True for the handful of hostnames that only ever mean "this machine" to itself. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export interface DaemonConfig {
  /**
   * This machine's user-editable label (spec/02 § Host identity). Defaults to
   * the name a person recognises the box by (`defaultHostName`);
   * `PATCH_HOST_NAME` overrides it, and a rename from a surface persists
   * through the server registry.
   */
  hostName: string;
  /**
   * Whether this host is the account's home host — the one running the special
   * threads (spec/06). The server owns the flag; the host reports what it has
   * been told. Defaults false: claiming to be home when the server disagrees
   * would give an account two Manager threads.
   */
  isHomeHost: boolean;
  /** Home directory for ~/.patch state. PATCH_HOME override, otherwise ~/.patch. */
  patchHome: string;
  /** Unix domain socket path the local control HTTP listens on. */
  socketPath: string;
  /** TCP port for /healthz (compose healthcheck). */
  healthzPort: number;
  healthzHost: string;
  /**
   * WebSocket URL the host dials INTO on the patch-server, e.g.
   * `ws://server:3000/ws` (compose) or `wss://<host>/ws` (prod). Required.
   */
  serverWsUrl: string;
  /**
   * HTTP base URL of the patch-server used for host QR registration, e.g.
   * `http://server:3000`. Required.
   */
  serverUrl: string;
  /**
   * Shared HMAC secret for voice-token verification (group 13 audio). The
   * patch-server mints per-session voice tokens with this secret; the host's
   * audio WSS verifies them. Required. (No longer used for any WS control
   * handshake — that link is now EdDSA-JWT via daemon.key.)
   */
  internalToken: string;
  /** SDK backend selector: 'mock' (deterministic, default) | 'real'. */
  sdkBackend: 'mock' | 'real';
  /**
   * Override path for the Claude Code OAuth *credentials* file
   * (`~/.claude/.credentials.json` by default — the file holding
   * `claudeAiOauth.accessToken`). Set via CLAUDE_CREDENTIALS_PATH. Test/headless
   * hook; on a normal Mac the token comes from the Keychain so this stays unset.
   */
  claudeCredentialsPath?: string;
  /**
   * Root mirroring Claude Code's `~/.claude/projects` transcript layout.
   * Read by the host's HistoryReader (backing patch_history / replay) and,
   * under SDK_BACKEND=mock, WRITTEN by the mock backend so the two stay in
   * lockstep. With the REAL SDK this MUST be the operator's `~/.claude/projects`
   * (the SDK writes there); with the MOCK SDK it defaults to an isolated
   * `<patchHome>/claude-projects` so the local-dev stack persists genuine,
   * paginable transcripts without polluting the operator's real ~/.claude.
   * Override either with PATCH_CLAUDE_PROJECTS_ROOT.
   */
  claudeProjectsRoot: string;
  /** Group 13: voice infrastructure. */
  audio: {
    /** TCP port for the audio WSS endpoint. Default 3003. */
    port: number;
    host: string;
    /** `daemon.host.audioRelayHost` — see `loadConfig`'s comment above. */
    relayHost: string | undefined;
    whisperBackend: 'off' | 'groq' | 'local' | 'mock';
    /**
     * GROQ_API_KEY from the environment (required for whisperBackend='groq'
     * unless one is set from Settings → Hosts → Keys, which wins).
     */
    groqApiKey: string | undefined;
    whisperLocalSidecarUrl: string | undefined;
    /** faster-whisper model dir (medium.en) — used to spawn the local sidecar. */
    whisperModelPath: string | undefined;
    kokoroBackend: 'off' | 'real' | 'mock';
    kokoroSidecarUrl: string | undefined;
    /**
     * Where the Kokoro weights are. KOKORO_MODEL_PATH when an operator names one
     * (the deployed box mounts them); otherwise this machine's own optional-
     * components directory, which the host resolves itself (spec/11 § Env,
     * spec/02 § Optional components) and which is empty until the ~340 MB
     * component is downloaded on demand.
     */
    kokoroModelPath: string;
    /**
     * True when an operator set KOKORO_MODEL_PATH. An operator-named path that
     * isn't there is a boot abort; the host-local component simply not being
     * downloaded yet is not — that is the ordinary state of a fresh install.
     */
    kokoroModelPathFromEnv: boolean;
    /**
     * VAD backend for end-of-utterance + barge-in detection.
     *   - 'silero' : real Silero VAD via onnxruntime-node (VAD_MODEL_PATH).
     *   - 'mock'   : deterministic energy-threshold VAD (tests + docker-compose).
     */
    vadBackend: 'silero' | 'mock';
    /** Path to silero_vad.onnx (required for vadBackend='silero'). */
    vadModelPath: string | undefined;
    /** Hard cap on concurrent voice sessions. Default 4 (Groq) / 3 (local). */
    maxConcurrentSessions: number;
    /**
     * GEMINI_API_KEY — required only when the account's per-surface
     * `voiceConfig` (a LIVE setting, mirrored down over `host.settings`, not
     * a boot-time toggle) selects `backend: 'gemini'` for a surface. Unlike
     * the other audio credentials this is not gated by its own `*_BACKEND`
     * env var: the backend is chosen per-surface, so the key is simply
     * present or not, and the per-session check in `audio/server.ts` is what
     * refuses a `gemini` session with none (NO SILENT FALLBACK — never a
     * quiet downgrade to the local tier). This is only the ENVIRONMENT's
     * value: a key set from Settings → Hosts → Keys (providerKeys.ts) wins
     * over it, and every consumer reads the store, not this field.
     */
    geminiApiKey: string | undefined;
    /** Overrides `DEFAULT_GEMINI_LIVE_MODEL` (gemini-live.ts). GEMINI_LIVE_MODEL env. */
    geminiLiveModel: string | undefined;
    /** Overrides `DEFAULT_GEMINI_LIVE_HEAVY_MODEL` — the `layer: heavy` model. GEMINI_LIVE_MODEL_HEAVY env. */
    geminiLiveModelHeavy: string | undefined;
    /** Overrides `DEFAULT_GEMINI_TRANSCRIBE_MODEL` (hosted-stt.ts, dictation). GEMINI_TRANSCRIBE_MODEL env. */
    geminiTranscribeModel: string | undefined;
    /**
     * OPENAI_REALTIME_API_KEY — the OpenAI key voice uses (Realtime sessions for
     * hands-free/call, the transcription endpoint for dictation), required only
     * when a `voiceConfig` surface selects `backend: 'openai'`. Deliberately NOT
     * `OPENAI_API_KEY`: that name is what the Codex agent backend and any tool a
     * chat runs would pick up and bill against, and this key is voice's alone.
     * The environment's value; a UI-set key wins (providerKeys.ts).
     */
    openaiApiKey: string | undefined;
    /** Overrides `DEFAULT_OPENAI_REALTIME_MODELS.light`. OPENAI_REALTIME_MODEL_LIGHT env. */
    openaiRealtimeModelLight: string | undefined;
    /** Overrides `DEFAULT_OPENAI_REALTIME_MODELS.heavy`. OPENAI_REALTIME_MODEL_HEAVY env. */
    openaiRealtimeModelHeavy: string | undefined;
    /** Overrides `DEFAULT_OPENAI_TRANSCRIBE_MODEL` (hosted-stt.ts). OPENAI_TRANSCRIBE_MODEL env. */
    openaiTranscribeModel: string | undefined;
  };
}

function intRequired(name: string, raw: string | undefined, fallback: number): number {
  const v = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(v) || v <= 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return v;
}

function strRequired(name: string, env: NodeJS.ProcessEnv): string {
  const v = env[name];
  if (v === undefined || v === '') {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
}

export function loadConfig(opts: LoadConfigOptions = {}): DaemonConfig {
  const env = opts.env ?? process.env;

  const patchHome = env['PATCH_HOME'] ?? join(homedir(), '.patch');
  const socketPath = env['PATCH_DAEMON_SOCKET'] ?? join(patchHome, 'daemon.sock');

  const healthzPort = intRequired(
    'PATCH_DAEMON_HEALTHZ_PORT',
    env['PATCH_DAEMON_HEALTHZ_PORT'],
    3001,
  );
  const healthzHost = env['PATCH_DAEMON_HEALTHZ_HOST'] ?? '0.0.0.0';

  const serverWsUrl = strRequired('PATCH_SERVER_WS_URL', env);
  const serverUrl = strRequired('PATCH_SERVER_URL', env);
  const internalToken = strRequired('PATCH_INTERNAL_TOKEN', env);

  // NO SILENT DEFAULT: SDK_BACKEND must be chosen explicitly — 'mock' for unit
  // tests / normal build rounds, 'real' for dev and the integration round. An
  // unset boot fails loudly here rather than silently shipping the echo bot.
  const sdkBackendRaw = env['SDK_BACKEND'];
  if (sdkBackendRaw !== 'mock' && sdkBackendRaw !== 'real') {
    throw new Error(
      `SDK_BACKEND must be set explicitly to 'mock' or 'real' (got ${JSON.stringify(sdkBackendRaw)}) — no silent default.`,
    );
  }

  const audioPort = intRequired('PATCH_DAEMON_AUDIO_PORT', env['PATCH_DAEMON_AUDIO_PORT'], 3003);
  const audioHost = env['PATCH_DAEMON_AUDIO_HOST'] ?? '0.0.0.0';
  // Where the SERVER (not a surface) can reach THIS machine's audio WSS
  // DIRECTLY, as an optimisation over relaying it through the host's own
  // outbound link (`daemon.host.audioRelayHost` — spec/07 § Voice is a per-host
  // capability, spec/03 § Audio relay over the host link). Declaring nothing
  // is always safe — the server falls back to tunnelling the session over the
  // link this host already holds, which needs no address and works through
  // NAT with nothing configured. Loopback is only a correct direct address
  // when THIS host is co-located with the server, which is knowable without
  // asking: it is exactly the case where `PATCH_SERVER_WS_URL` itself names
  // loopback (the compose/single-host deployment dials its own server at
  // `ws://127.0.0.1:.../ws`). Anywhere else — including a host reached only
  // over a private network like Tailscale — this still defaults to undefined;
  // `PATCH_DAEMON_AUDIO_RELAY_HOST` remains available to declare a direct
  // address explicitly (e.g. a Tailscale name) as a latency optimisation, but
  // nothing requires it any more.
  const audioRelayHost =
    env['PATCH_DAEMON_AUDIO_RELAY_HOST'] ??
    (isLoopbackHost(new URL(serverWsUrl).hostname) ? `127.0.0.1:${audioPort}` : undefined);
  // Voice is an OPTIONAL COMPONENT (spec/02 § Optional components), and the
  // artifact ships no STT credential and no TTS weights. Defaulting these to a
  // real backend made a freshly installed machine abort at boot on a missing
  // GROQ_API_KEY / KOKORO_MODEL_PATH, contradicting spec/11's "installs and
  // runs on a machine carrying only an OS". Unset therefore means 'off' — the
  // component is not installed — NOT a quiet downgrade to a stub. Naming a
  // backend without its credential still aborts loudly below.
  const whisperBackendRaw = env['WHISPER_BACKEND'] ?? 'off';
  if (
    whisperBackendRaw !== 'off' &&
    whisperBackendRaw !== 'groq' &&
    whisperBackendRaw !== 'local' &&
    whisperBackendRaw !== 'mock'
  ) {
    throw new Error(
      `Invalid WHISPER_BACKEND: ${whisperBackendRaw} (expected 'off' | 'groq' | 'local' | 'mock')`,
    );
  }
  const kokoroBackendRaw = env['KOKORO_BACKEND'] ?? 'off';
  if (kokoroBackendRaw !== 'off' && kokoroBackendRaw !== 'real' && kokoroBackendRaw !== 'mock') {
    throw new Error(
      `Invalid KOKORO_BACKEND: ${kokoroBackendRaw} (expected 'off' | 'real' | 'mock')`,
    );
  }
  // VAD is internal/free/on-box — default to the real Silero backend; mock is
  // unit-test-only and must be selected explicitly. mock-check:allow lists the
  // 'mock' literal here only as the validity check, not a default.
  const vadBackendRaw = env['VAD_BACKEND'] ?? 'silero';
  if (vadBackendRaw !== 'silero' && vadBackendRaw !== 'mock') {
    throw new Error(`Invalid VAD_BACKEND: ${vadBackendRaw} (expected 'silero' | 'mock')`);
  }
  const defaultCap = whisperBackendRaw === 'local' ? 3 : 4;
  const maxConcurrentSessions = intRequired(
    'PATCH_VOICE_MAX_SESSIONS',
    env['PATCH_VOICE_MAX_SESSIONS'],
    defaultCap,
  );

  return {
    hostName:
      env['PATCH_HOST_NAME'] !== undefined && env['PATCH_HOST_NAME'] !== ''
        ? env['PATCH_HOST_NAME']
        : defaultHostName(),
    isHomeHost: env['PATCH_IS_HOME_HOST'] === '1',
    patchHome,
    socketPath,
    healthzPort,
    healthzHost,
    serverWsUrl,
    serverUrl,
    internalToken,
    sdkBackend: sdkBackendRaw,
    claudeCredentialsPath: env['CLAUDE_CREDENTIALS_PATH'],
    // Real SDK persists under ~/.claude/projects; mock persists under an
    // isolated per-home dir so local-dev transcripts are genuine yet sandboxed.
    claudeProjectsRoot:
      env['PATCH_CLAUDE_PROJECTS_ROOT'] ??
      (sdkBackendRaw === 'real'
        ? join(homedir(), '.claude', 'projects')
        : join(patchHome, 'claude-projects')),
    audio: {
      port: audioPort,
      host: audioHost,
      relayHost: audioRelayHost,
      whisperBackend: whisperBackendRaw,
      groqApiKey: env['GROQ_API_KEY'],
      whisperLocalSidecarUrl: env['WHISPER_LOCAL_SIDECAR_URL'],
      whisperModelPath: env['WHISPER_MODEL_PATH'],
      kokoroBackend: kokoroBackendRaw,
      kokoroSidecarUrl: env['KOKORO_SIDECAR_URL'],
      kokoroModelPath:
        env['KOKORO_MODEL_PATH'] !== undefined && env['KOKORO_MODEL_PATH'] !== ''
          ? env['KOKORO_MODEL_PATH']
          : join(patchHome, 'components', 'kokoro'),
      kokoroModelPathFromEnv:
        env['KOKORO_MODEL_PATH'] !== undefined && env['KOKORO_MODEL_PATH'] !== '',
      vadBackend: vadBackendRaw,
      vadModelPath:
        env['VAD_MODEL_PATH'] !== undefined && env['VAD_MODEL_PATH'] !== ''
          ? env['VAD_MODEL_PATH']
          : bundledVadModelPath(),
      maxConcurrentSessions,
      geminiApiKey: env['GEMINI_API_KEY'],
      geminiLiveModel: env['GEMINI_LIVE_MODEL'],
      geminiLiveModelHeavy: env['GEMINI_LIVE_MODEL_HEAVY'],
      geminiTranscribeModel: env['GEMINI_TRANSCRIBE_MODEL'],
      openaiApiKey: env['OPENAI_REALTIME_API_KEY'],
      openaiRealtimeModelLight: env['OPENAI_REALTIME_MODEL_LIGHT'],
      openaiRealtimeModelHeavy: env['OPENAI_REALTIME_MODEL_HEAVY'],
      openaiTranscribeModel: env['OPENAI_TRANSCRIBE_MODEL'],
    },
  };
}
