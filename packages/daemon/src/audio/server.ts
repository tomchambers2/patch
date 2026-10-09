// Audio WSS endpoint — `wss://daemon:3003/audio/<sessionId>` (group 13).
//
// Surfaces (web/desktop/mobile) and the voice-device firmware open this WS
// after minting a one-shot voice token from the patch server's
// `POST /api/voice/token`. The first frame MUST be `audio.session_start`
// carrying the token; the host verifies, accepts, and from there
// interleaves JSON control envelopes (encoded via `@patch/wire/audio`)
// with binary PCM16 frames.
//
// Concurrency cap (per spec/07): 4 on Groq, 3 on local Whisper. The 5th
// session is closed with an `audio.error { code: 'concurrency_cap' }`.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Logger } from 'pino';
import {
  AudioEvent,
  AudioSessionStartEvent,
  decodeAudio,
  encodeAudio,
  validateDeviceIdCoupling,
  deriveVoiceSurface,
  voiceCellFor,
  modesShareVoiceEngine,
  voiceKeyMissingMessage,
  DEFAULT_VOICE_CONFIG,
  type AudioErrorCode,
  type AudioSurfaceKind,
  type VoiceConfig,
} from '@patch/wire/audio';
import { VoiceSession, type SessionDeps, type SessionInit, type SessionState } from './session.js';
import { MockVad, type Vad } from './vad.js';
import { NlmsAec, PassThroughAec, type AecProcessor } from './aec.js';
import type { WhisperBackend } from './whisper.js';
import type { KokoroBackend } from './kokoro.js';
import { GeminiLiveSession, geminiLiveModelFor, type GeminiContextTurn } from './gemini-live.js';
import {
  OpenAIRealtimeSession,
  openaiRealtimeModelFor,
  type OpenAIWsCtor,
} from './openai-realtime.js';
import { pickDictationTranscriber, type DictationTranscribers } from './hosted-stt.js';
import type { VoiceSessionLike, VoiceTimeline } from './voice-session-like.js';
import type { EngineCosting } from './voiceCost.js';
import { verifyVoiceToken, VoiceTokenError, type VoiceTokenClaims } from './token-verifier.js';
import { DEVICE_CONTROL_PATH } from '../devices/control-ws.js';
import { readKey, type KeySource } from './keySource.js';

const AUDIO_PATH_PREFIX = '/audio/';

// Explicit WS close codes for rejected audio sessions (E1-d4), mirroring the
// /ws hub convention (4400 malformed-frame, 4401 auth). A bare `ws.close()`
// surfaces to the client as code 1005 (no status) with an empty reason, which
// hides WHY the session was rejected from anything inspecting the close frame
// (the preceding audio.error event carries the code, but the close frame must
// be explicit too). Application close codes live in the 4000–4999 range.
const CLOSE_BAD_FRAME = 4400;
const CLOSE_AUTH_FAILED = 4401;

/** Map an audio error code to its WS close code. Auth/token failures → 4401; everything else (frame/session/capacity/backend) → 4400. */
/**
 * A WS close reason is capped at 123 BYTES, not characters — a message with
 * any multi-byte character in it (the "→" in `Settings → Voice`) sliced by
 * length throws inside `ws.close()` and the refusal never closes the socket.
 * Cut on a UTF-8 character boundary instead.
 */
export function closeReason(message: string): string {
  let out = '';
  let bytes = 0;
  for (const ch of message) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > 123) break;
    out += ch;
    bytes += n;
  }
  return out;
}

function closeCodeFor(code: AudioErrorCode): number {
  switch (code) {
    case 'auth_failed':
    case 'token_expired':
    case 'token_replayed':
      return CLOSE_AUTH_FAILED;
    default:
      return CLOSE_BAD_FRAME;
  }
}

export interface AudioServerOptions {
  host: string;
  port: number;
  logger: Logger;
  /** Shared HMAC secret — same as PATCH_INTERNAL_TOKEN. */
  internalToken: string;
  whisper: WhisperBackend;
  kokoro: KokoroBackend;
  /** Build a per-session VAD (factory so each session gets a fresh state). */
  makeVad?: () => Vad;
  /** Build a per-session AEC. Default: NLMS for !surfaceHasAec, pass-through otherwise. */
  makeAec?: (surfaceHasAec: boolean) => AecProcessor;
  /**
   * Submit the user-turn to the host's chat pipeline. The audio server
   * is intentionally agnostic to the host internals — wire it up at
   * host construct time.
   */
  submitUserTurn: SessionDeps['submitUserTurn'];
  /**
   * Spec/07 ## Permission prompts during voice — wired to the host so a
   * spoken yes/no mid-call resolves a pending permission via the STT path.
   * Optional: the in-process audio smoke tests don't run a host.
   */
  getPendingPermission?: SessionDeps['getPendingPermission'];
  resolvePermission?: SessionDeps['resolvePermission'];
  /**
   * Returns the currently configured Kokoro voice name. Read on every TTS
   * synthesis call so a settings change takes effect on the next utterance
   * without restarting an open session. Optional: when absent, the sidecar
   * uses its own default voice.
   */
  getKokoroVoice?: SessionDeps['getKokoroVoice'];
  /**
   * Live read of the account's per-surface voice config (spec/07 § Voice — a
   * config matrix), same pattern as `getKokoroVoice` — read on every new
   * session so a settings change takes effect on the next call without a
   * host restart. Absent (the in-process audio smoke tests don't wire a
   * host) behaves as `DEFAULT_VOICE_CONFIG` (every surface on `local`/
   * `direct`).
   */
  getVoiceConfig?: () => VoiceConfig;
  /**
   * GEMINI_API_KEY. Required to construct a `GeminiLiveSession` — absent (or
   * empty) on a surface configured for `backend: 'gemini'` rejects the
   * connection with `audio.error {code: 'voice_key_missing'}` rather than
   * silently falling back to `local` (NO SILENT FALLBACK). Read at each
   * session's start (keySource.ts), so a key changed in Settings applies to
   * the next session without a restart.
   */
  geminiApiKey?: KeySource;
  /** Overrides gemini-live.ts's `DEFAULT_GEMINI_LIVE_MODEL` (layer light/direct). */
  geminiLiveModel?: string;
  /** Overrides gemini-live.ts's `DEFAULT_GEMINI_LIVE_HEAVY_MODEL` (layer heavy). */
  geminiLiveModelHeavy?: string;
  /**
   * OPENAI_REALTIME_API_KEY. Required to construct an `OpenAIRealtimeSession`
   * — absent on a surface configured for `backend: 'openai'` rejects the
   * connection with `audio.error {code: 'voice_key_missing'}` (NO SILENT
   * FALLBACK). Read at each session's start, like `geminiApiKey`.
   */
  openaiApiKey?: KeySource;
  /** Per-layer overrides of openai-realtime.ts's `DEFAULT_OPENAI_REALTIME_MODELS`. */
  openaiRealtimeModelLight?: string;
  openaiRealtimeModelHeavy?: string;
  /**
   * The transcribers the DICTATION surface can run on (hosted-stt.ts). A
   * dictation / voice-note session runs the ordinary `VoiceSession` pipeline
   * with the configured backend's transcriber in place of Whisper. Absent (the
   * in-process tests) means only `local` is available, and a dictation
   * configured for a hosted backend is refused with `voice_key_missing`.
   */
  dictationTranscribers?: DictationTranscribers;
  /**
   * spec/07 § Keeping voice and text as one conversation — the one-time
   * context snapshot a native session sends Gemini Live before the mic opens.
   * Optional: absent opens a native session with no prior context.
   */
  getChatContext?: (chatId: string) => Promise<GeminiContextTurn[]> | GeminiContextTurn[];
  /**
   * A hosted voice's `look_back` (spec/07 § Keeping voice and text as one conversation): the
   * messages in the chat that match a few words. Absent means the voice is not given the tool.
   */
  lookBack?: (chatId: string, query: string) => string;
  /**
   * Existence check for the chat declared in `audio.session_start` (E1-d3).
   * A voice session must be bound to a real chat BEFORE any audio is
   * accepted — otherwise the host would run the whole STT pipeline only to
   * fail late with a generic `sdk_error` when `submitUserTurn` cannot find
   * the chat. Returning false here rejects the session at session_start time
   * with a specific `session_not_found`. Checks in-memory chat state and the
   * on-disk meta store (a chat resumable from disk still exists).
   */
  chatExists: (chatId: string) => boolean;
  /**
   * Concurrency cap. Host picks based on the active Whisper backend.
   * Default 4 (matches Groq budget per spec).
   */
  maxConcurrentSessions?: number;
  /**
   * Fired when a physical voice-device session (surfaceKind === 'device')
   * opens (`active: true`) or closes (`active: false`). The host wires this
   * to emit a `device.session` wire event so surfaces can show the "mid-session"
   * pill on the Speakers row (spec/14 ## Sidebar, spec/16 voice device). Not
   * fired for app surfaces (web/desktop/mobile) — those are not Speakers devices.
   */
  onDeviceSession?: (deviceId: string, active: boolean) => void;
  /**
   * Fired when ANY voice session closes. The device control plane (F2) uses
   * this to drain its queue when a phone Manager call ends — a queued device
   * ring/wake can then proceed (spec/16 §Concurrency). `wasPhoneCall` is true
   * iff the closed session was a phone-side `voice-call` (web/desktop/mobile).
   */
  onSessionClosed?: (info: { wasPhoneCall: boolean }) => void;
  /**
   * spec/07 § Keeping voice and text as one conversation — the timeline a
   * hosted (fast-voice) session writes its exchanges into. Required to run a
   * hosted session at all.
   */
  makeTimeline?: (init: SessionInit) => VoiceTimeline;
  /** spec/07 § Call cost — a call or hands-free session started. */
  onCallStarted?: (init: SessionInit) => void;
  /**
   * spec/07 § Call cost — a call or hands-free session ended. Fired once per
   * session, after `onSessionClosed`, with what it used.
   */
  onCallEnded?: (info: {
    init: SessionInit;
    chatId: string;
    startedAt: number;
    endedAt: number;
    engine: EngineCosting;
  }) => void;
  /**
   * Optional `/device/control` WSS upgrade handler (spec/16 voice-device
   * control plane, F2). The firmware/mock dial the SAME host:port for
   * both `/audio/<sessionId>` and `/device/control`, so the control plane
   * shares this HTTP listener. When unset, `/device/control` upgrades 404 —
   * the in-process audio smoke tests don't wire a device registry.
   */
  deviceControlUpgrade?: (
    req: import('node:http').IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ) => void;
  /** Test hooks. */
  nowMs?: () => number;
  /**
   * Test hook: substitute the WebSocket constructor a native-tier session
   * uses to dial Gemini Live, so the audio-server test suite can exercise the
   * real tier-selection branch end-to-end without opening a real connection
   * (mirrors `makeVad`/`makeAec` above). Threaded straight to
   * `GeminiLiveDeps.wsCtor`.
   */
  geminiWsCtor?: new (url: string) => import('ws').WebSocket;
  /** Test hook: override the Gemini Live connect URL. Threaded to `GeminiLiveDeps.wsUrl`. */
  geminiWsUrl?: string;
  /** Test hook: substitute the WebSocket constructor for OpenAI Realtime. */
  openaiWsCtor?: OpenAIWsCtor;
  /** Test hook: override the OpenAI Realtime connect URL. */
  openaiWsUrl?: string;
}

export interface AudioServerHandle {
  address(): AddressInfo;
  /** Number of active authenticated voice sessions. */
  activeCount(): number;
  /**
   * True iff a phone-side `voice-call` session is currently active (spec/16
   * §Concurrency: phone-active-call beats every device). Excludes device
   * sessions — those are `voice-device-conv`.
   */
  phoneCallActive(): boolean;
  /** Inspect a session's state (test/diagnostics). */
  getSessionState(sessionId: string): SessionState | undefined;
  /** The open sessions currently aimed at `chatId` (live context sync). */
  sessionsOnChat(chatId: string): VoiceSessionLike[];
  /** Push a focus-change to whatever session belongs to this surface. */
  setFocusForSurface(surfaceId: string, chatId: string): void;
  /**
   * DEV/TEST seam (spec/07): inject a transcribed utterance into the open
   * session for `surfaceId`, exactly as the STT pipeline would on
   * end-of-utterance. Returns false if the surface has no active session.
   */
  injectUtterance(surfaceId: string, text: string): boolean;
  /**
   * DEV/TEST seam (spec/16 — F1-audible verification): synthesise `text` via
   * Kokoro and stream it straight to the open session for `surfaceId`, BYPASSING
   * STT and the SDK turn. This proves the device speaker audibly renders a TTS
   * reply over the proven-clean 24k→16k→device audio path, independently of
   * whether the live Claude reply completes. Returns false if the surface has
   * no active session.
   */
  speakCanned(surfaceId: string, text: string): boolean;
  /**
   * spec/07 § Which surface it reaches — speak `text` into a sustained session
   * that is ALREADY open, rather than ringing a user who is plainly already
   * connected. This is the whole outbound half of a `working` session (spec/07
   * § Session modes): its ordinary replies aren't spoken, so a deliberate
   * interrupt is the only thing that ever comes out of it. Returns false when
   * no session is open, which is the caller's cue to ring.
   */
  interruptOpenCall(text: string): boolean;
  close(): Promise<void>;
}

interface ActiveSession {
  session: VoiceSessionLike;
  socket: WebSocket;
  /**
   * When this session's surface last showed the user was at it — a mic frame,
   * an utterance, a control frame. An interrupt goes to the surface the user is
   * actually in front of (spec/07 § Which surface it reaches), and with a desk
   * session and a phone in a pocket both open, that is the one still hearing
   * something.
   */
  lastActivityAt: number;
  /** spec/07 § Call cost — set for call / hands-free sessions only. */
  call?: { init: SessionInit; startedAt: number };
  surfaceId: string;
  accountId: string;
  surfaceKind: AudioSurfaceKind;
  role: 'voice-note' | 'voice-call' | 'voice-device-conv';
  /** Set for `device` sessions only — drives the `onDeviceSession(_, false)` on close. */
  deviceId?: string;
}

/**
 * Lightweight JTI-replay set with TTL-based eviction (group 14, perf M1).
 *
 * Tokens have a 5-minute TTL: any JTI past its `exp` cannot be replayed
 * because the verifier rejects on expiry first. We therefore stash
 * (jti, exp) pairs and prune-on-write — the working set is bounded by
 * the number of tokens minted in the last 5 minutes, regardless of the
 * absolute uptime of the host. The previous size-cap eviction was both
 * unnecessary and could (in pathological steady-state) drop a JTI that
 * was still inside its TTL.
 */
class JtiReplayGuard {
  private readonly seen = new Map<string, number>();
  private readonly nowMs: () => number;

  constructor(nowMs?: () => number) {
    this.nowMs = nowMs ?? Date.now;
  }

  consume(jti: string, expMs: number): boolean {
    this.prune();
    if (this.seen.has(jti)) return false;
    this.seen.set(jti, expMs);
    return true;
  }

  private prune(): void {
    const now = this.nowMs();
    for (const [jti, exp] of this.seen) {
      if (exp <= now) this.seen.delete(jti);
    }
  }
}

export async function startAudioServer(opts: AudioServerOptions): Promise<AudioServerHandle> {
  const log = opts.logger;
  const cap = opts.maxConcurrentSessions ?? 4;
  const replay = new JtiReplayGuard(opts.nowMs);
  const sessions = new Map<string, ActiveSession>();
  // surfaceId → sessionId, for focus-follow routing.
  const surfaceIndex = new Map<string, string>();

  // Forward-declared so the HTTP request handler (defined before the handle's
  // closures) can reach the speak-canned routing. Assigned right after the
  // session map closures below.
  const speakCannedFor = (surfaceId: string, text: string): boolean => {
    const sid = surfaceIndex.get(surfaceId);
    if (!sid) return false;
    const active = sessions.get(sid);
    if (!active) return false;
    log.info(
      { surfaceId, sessionId: sid, textLen: text.length },
      'audio: speakCanned dispatching Kokoro TTS to device session',
    );
    void active.session
      .speak(text)
      .then(() => {
        log.info({ surfaceId, sessionId: sid }, 'audio: speakCanned TTS stream completed');
      })
      .catch((err: Error) => {
        log.warn({ err: err.message, surfaceId }, 'audio: speakCanned failed');
      });
    return true;
  };

  const DIAG_SPEAK_PATH = '/internal/diag/voice-device/speak';
  const http: Server = createServer((req, res) => {
    // DEV/TEST diag seam (spec/16 — F1-audible verification). POST a canned
    // phrase straight to an open device session's Kokoro→speaker path, gated by
    // the shared internal token (X-Patch-Internal-Token). This proves the device
    // speaker audibly renders TTS independently of the live Claude reply.
    // Both `??` fallbacks are unreachable: Node's http server guarantees
    // `req.url` is a populated string for any request that reaches this
    // callback (a request line with no target never parses far enough to
    // fire the 'request' event), and `String.prototype.split` always returns
    // an array with at least one (possibly empty-string) element, so `[0]`
    // is never undefined.
    const path = (req.url ?? '').split('?')[0] ?? ''; /* v8 ignore next */
    if (req.method === 'POST' && path === DIAG_SPEAK_PATH) {
      const token = req.headers['x-patch-internal-token'];
      if (token !== opts.internalToken) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString();
        if (body.length > 64 * 1024) req.destroy();
      });
      req.on('end', () => {
        let parsed: { surfaceId?: unknown; text?: unknown };
        try {
          parsed = JSON.parse(body) as { surfaceId?: unknown; text?: unknown };
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid json' }));
          return;
        }
        if (typeof parsed.surfaceId !== 'string' || typeof parsed.text !== 'string') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'surfaceId and text are required strings' }));
          return;
        }
        const ok = speakCannedFor(parsed.surfaceId, parsed.text);
        res.writeHead(ok ? 202 : 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify(ok ? { ok: true } : { error: 'no active session for surfaceId' }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });

  http.on('upgrade', (req, socket, head) => {
    // Device control plane shares this listener (spec/16, F2). Route it first;
    // the device's persistent control WSS lives at /device/control while
    // per-session audio is under /audio/<sessionId>.
    // Same unreachable-fallback reasoning as the diag-speak handler above:
    // `req.url` is always populated for a real upgrade request, and
    // `.split()` always yields >=1 element.
    const path = (req.url ?? '').split('?')[0] ?? ''; /* v8 ignore next */
    if (path === DEVICE_CONTROL_PATH) {
      if (opts.deviceControlUpgrade) {
        opts.deviceControlUpgrade(req, socket, head);
      } else {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
      }
      return;
    }
    if (!req.url || !req.url.startsWith(AUDIO_PATH_PREFIX)) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    // `.split()` always yields >=1 element, so `[0]` is never undefined.
    const expected =
      req.url.slice(AUDIO_PATH_PREFIX.length).split('?')[0] ?? ''; /* v8 ignore next */
    if (expected.length === 0) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, expected);
    });
  });

  function send(ws: WebSocket, ev: AudioEvent): void {
    try {
      ws.send(encodeAudio(ev));
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'audio: send failed');
    }
  }

  function rejectConn(ws: WebSocket, code: AudioErrorCode, message: string): void {
    send(ws, { type: 'audio.error', code, message });
    // Explicit close code + reason (E1-d4) so the close frame itself, not just
    // the preceding audio.error event, says why. WS reason is capped at 123
    // bytes by the protocol.
    ws.close(closeCodeFor(code), closeReason(message));
  }

  function handleConnection(ws: WebSocket, urlSessionId: string): void {
    let claims: VoiceTokenClaims | undefined;
    let session: VoiceSessionLike | undefined;
    /** Whether this is a sustained app session — the only kind with a mode to switch. */
    let isAppCall = false;
    let pendingBinaryMeta: { samples: number } | undefined;

    ws.on('message', (data: Buffer | string, isBinary: boolean) => {
      if (isBinary) {
        if (!session) {
          rejectConn(ws, 'invalid_frame', 'binary frame before session_start');
          return;
        }
        const expected = pendingBinaryMeta?.samples;
        const buf = data as Buffer;
        if (expected !== undefined && buf.byteLength / 2 !== expected) {
          log.debug(
            { expected, got: buf.byteLength / 2 },
            'audio: pcm sample-count mismatch; using actual',
          );
        }
        pendingBinaryMeta = undefined;
        // Zero-copy Int16Array view over the incoming Buffer. The wire is
        // little-endian PCM16 and every supported host runtime (x86-64, arm64
        // on Linux/macOS) is little-endian, so the byte interpretation
        // matches Int16Array's native order. The consumer (VoiceSession)
        // copies the frame into a session-scoped ring buffer (see M3) before
        // returning to the event loop, so the underlying Buffer's pool may
        // safely be reused on the next tick. Frames MUST be consumed
        // synchronously by `onMicFrame` w.r.t. the buffer view — do not
        // retain `pcm` past the awaited microtask boundary.
        if ((buf.byteLength & 1) !== 0) {
          rejectConn(ws, 'invalid_frame', 'pcm16 binary frame has odd byte length');
          return;
        }
        // `ws` delivers inbound frames as views into a shared pooled buffer
        // whose `byteOffset` is NOT guaranteed 2-byte aligned. A zero-copy
        // `new Int16Array(buf.buffer, byteOffset, …)` throws "start offset
        // should be a multiple of 2" on an odd offset — which would crash the
        // mic-frame handler and silently kill voice input. When the offset is
        // odd, copy the bytes into a fresh aligned buffer; the common
        // (aligned) case stays zero-copy. The consumer copies the frame into
        // its ring buffer either way, so the pooled buffer is safe to reuse.
        let pcm: Int16Array;
        // v8 ignore reason for the branch below: the TRUE (aligned) arm is
        // exercised behaviorally by the "zero-copy PCM16 view preserves
        // little-endian byte order" test. The FALSE (odd-offset) arm depends
        // on `ws`'s internal Receiver buffer-pool state at the moment a
        // frame's payload is sliced (see receiver.js `consume()`), which in
        // turn depends on how the OS/TCP stack chunks a connection's bytes
        // across 'data' events. Investigated two approaches to force it
        // deterministically from a test client: (1) interleaving odd-length
        // text frames with binary frames sent back-to-back with no
        // intervening await, and (2) hand-packing raw masked WS frames (text
        // + binary) into a single `socket.write()` so both land in one read —
        // chosen so the cumulative consumed-byte parity before the binary
        // payload would be odd. Neither reproduced an odd `byteOffset` in
        // this Node/ws version; the payload consistently arrived 0- or
        // even-offset regardless of preceding-frame parity, meaning some
        // other internal `ws` code path (not the generic `consume()` slice
        // this comment assumes) governs the single-read/no-fragmentation
        // case exercised by a unit test. Real-world reachability under
        // sustained multi-session traffic (the scenario this branch
        // documents) is not in question — only its determinism from a
        // black-box WS client. Branch tracking for the WHOLE if/else is
        // suppressed below (rather than just the odd-offset arm) because
        // v8's branch-coverage line-attribution for this construct proved
        // sensitive to exactly where the arm boundary comment sits.
        /* v8 ignore start */
        if ((buf.byteOffset & 1) === 0) {
          pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >>> 1);
        } else {
          // A fresh ArrayBuffer is always 0-offset → guaranteed aligned.
          pcm = new Int16Array(buf.byteLength >>> 1);
          new Uint8Array(pcm.buffer).set(buf);
        }
        /* v8 ignore stop */
        // Mic frames are the liveness signal for "the user is at this surface"
        // (spec/07 § Which surface it reaches). A muted or pocketed session
        // still sends them, which is right: the phone is still with them.
        const live = sessions.get(urlSessionId);
        if (live) live.lastActivityAt = Date.now();
        void session.onMicFrame(pcm).catch((err: Error) => {
          log.warn({ err: err.message }, 'audio: mic frame error');
        });
        return;
      }
      // Text frame — JSON control envelope.
      let parsed: AudioEvent;
      try {
        parsed = decodeAudio(data as string | Buffer);
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'audio: decode failed');
        rejectConn(ws, 'invalid_frame', 'decode failed');
        return;
      }
      if (!session) {
        if (parsed.type !== 'audio.session_start') {
          rejectConn(ws, 'invalid_frame', 'first frame must be audio.session_start');
          return;
        }
        const start = parsed as AudioSessionStartEvent;
        if (start.sessionId !== urlSessionId) {
          rejectConn(ws, 'invalid_frame', 'sessionId mismatch with URL path');
          return;
        }
        try {
          claims = verifyVoiceToken({
            secret: opts.internalToken,
            token: start.token,
            ...(opts.nowMs ? { nowMs: opts.nowMs() } : {}),
          });
        } catch (err) {
          const code: AudioErrorCode =
            err instanceof VoiceTokenError && err.code === 'expired'
              ? 'token_expired'
              : 'auth_failed';
          rejectConn(ws, code, (err as Error).message);
          return;
        }
        if (claims.sessionId !== start.sessionId) {
          rejectConn(ws, 'auth_failed', 'token sessionId mismatch');
          return;
        }
        if (claims.accountId !== start.accountId || claims.surfaceId !== start.surfaceId) {
          rejectConn(ws, 'auth_failed', 'token does not bind to declared identity');
          return;
        }
        // E1-d2: the token is bound to the chatId it was minted for. A
        // session_start declaring a DIFFERENT chatId is rejected — a captured
        // token cannot be repointed at another chat.
        if (claims.chatId !== start.chatId) {
          rejectConn(ws, 'auth_failed', 'token does not bind to declared chatId');
          return;
        }
        // E1-d3: reject a session bound to a non-existent chat at
        // session_start time, BEFORE any audio/STT runs, with a specific
        // session_not_found — not a late generic sdk_error after Whisper has
        // transcribed a full utterance.
        if (!opts.chatExists(start.chatId)) {
          rejectConn(ws, 'session_not_found', `chat not found: ${start.chatId}`);
          return;
        }
        // spec/16: a `device` session must carry the originating deviceId so
        // the Speakers turn can be tagged + TTS routed back to it.
        const couplingError = validateDeviceIdCoupling(start);
        if (couplingError !== null) {
          rejectConn(ws, 'invalid_frame', couplingError);
          return;
        }
        if (!replay.consume(claims.jti, claims.exp)) {
          rejectConn(ws, 'token_replayed', 'voice token jti reused');
          return;
        }
        if (sessions.size >= cap) {
          rejectConn(
            ws,
            'concurrency_cap',
            `voice session cap reached (${cap}); try again shortly`,
          );
          return;
        }
        const sessionInit = {
          sessionId: start.sessionId,
          accountId: start.accountId,
          surfaceId: start.surfaceId,
          surfaceKind: start.surfaceKind,
          chatId: start.chatId,
          role: start.role,
          surfaceHasAec: start.surfaceHasAec,
          ...(start.deviceId !== undefined ? { deviceId: start.deviceId } : {}),
          ...(start.mode !== undefined ? { mode: start.mode } : {}),
          ...(start.addressWord !== undefined ? { addressWord: start.addressWord } : {}),
        };
        // spec/07 § Voice — a config matrix. Which surface this session
        // belongs to, then that surface's own {backend, layer} choice, read
        // live (same pattern as `getKokoroVoice`) so a settings change takes
        // effect on the NEXT call with no restart.
        const voiceSurface = deriveVoiceSurface({
          role: start.role,
          surfaceKind: start.surfaceKind,
          ...(start.mode !== undefined ? { mode: start.mode } : {}),
        });
        const voiceConfig = opts.getVoiceConfig?.() ?? DEFAULT_VOICE_CONFIG;
        const cell = voiceCellFor(voiceConfig, voiceSurface);
        // A hosted session whose provider side dies ends the surface session
        // too — the surface must stop streaming into a dead engine.
        const onFatal = (message: string): void => {
          if (ws.readyState === ws.OPEN) ws.close(CLOSE_BAD_FRAME, closeReason(message));
        };
        const sessionLog = log.child({
          sessionId: start.sessionId,
          surface: voiceSurface,
          backend: cell.backend,
          ...(cell.layer !== undefined ? { layer: cell.layer } : {}),
        });
        const sendAudioFn = (ev: AudioEvent): void => send(ws, ev);
        const sendBinaryFn = (pcm: Int16Array): void =>
          ws.send(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), { binary: true });

        if (voiceSurface === 'device' && cell.backend !== 'local') {
          // The device's 16 kHz-mic / 48 kHz-speaker path is specific to
          // VoiceSession's device branch; no hosted session speaks it yet.
          // A real, accepted config cell with no engine behind it — refuse
          // loudly, never run `local` in its place.
          rejectConn(
            ws,
            'voice_config_not_implemented',
            `device does not support backend "${cell.backend}" yet; select "local" instead`,
          );
          return;
        }
        if (cell.backend === 'local' && cell.layer !== undefined && cell.layer !== 'direct') {
          // local + light/heavy: no front model exists for the local backend
          // (Haiku was tried and rejected as not capable enough — spec/07
          // § Light layer / heavy layer split). Only `direct` is built.
          rejectConn(
            ws,
            'voice_config_not_implemented',
            `${voiceSurface} local layer "${cell.layer}" has no front model yet; select "direct"`,
          );
          return;
        }

        if (voiceSurface !== 'dictation' && cell.backend === 'gemini') {
          const geminiKey = readKey(opts.geminiApiKey);
          if (geminiKey === undefined) {
            // NO SILENT FALLBACK: this surface is configured for gemini and
            // this host has no key — refuse the session loudly rather than
            // quietly running a different engine than the one chosen.
            rejectConn(ws, 'voice_key_missing', voiceKeyMissingMessage(voiceSurface, 'gemini'));
            return;
          }
          if (!opts.makeTimeline) throw new Error('audio server: hosted voice needs makeTimeline');
          session = new GeminiLiveSession(sessionInit, {
            timeline: opts.makeTimeline(sessionInit),
            logger: sessionLog,
            sendAudio: sendAudioFn,
            sendBinary: sendBinaryFn,
            submitUserTurn: opts.submitUserTurn,
            apiKey: geminiKey,
            ...(cell.handoff !== undefined ? { handoff: cell.handoff } : {}),
            model: geminiLiveModelFor(cell.layer ?? 'light', {
              light: opts.geminiLiveModel,
              heavy: opts.geminiLiveModelHeavy,
            }),
            onFatal,
            ...(opts.getChatContext ? { getChatContext: opts.getChatContext } : {}),
            ...(opts.lookBack ? { lookBack: opts.lookBack } : {}),
            ...(opts.geminiWsCtor ? { wsCtor: opts.geminiWsCtor } : {}),
            ...(opts.geminiWsUrl ? { wsUrl: opts.geminiWsUrl } : {}),
          });
        } else if (voiceSurface !== 'dictation' && cell.backend === 'openai') {
          const openaiKey = readKey(opts.openaiApiKey);
          if (openaiKey === undefined) {
            rejectConn(ws, 'voice_key_missing', voiceKeyMissingMessage(voiceSurface, 'openai'));
            return;
          }
          if (!opts.makeTimeline) throw new Error('audio server: hosted voice needs makeTimeline');
          session = new OpenAIRealtimeSession(sessionInit, {
            timeline: opts.makeTimeline(sessionInit),
            logger: sessionLog,
            sendAudio: sendAudioFn,
            sendBinary: sendBinaryFn,
            submitUserTurn: opts.submitUserTurn,
            apiKey: openaiKey,
            ...(cell.handoff !== undefined ? { handoff: cell.handoff } : {}),
            model: openaiRealtimeModelFor(cell.layer ?? 'light', {
              light: opts.openaiRealtimeModelLight,
              heavy: opts.openaiRealtimeModelHeavy,
            }),
            onFatal,
            ...(opts.getChatContext ? { getChatContext: opts.getChatContext } : {}),
            ...(opts.lookBack ? { lookBack: opts.lookBack } : {}),
            ...(opts.openaiWsCtor ? { wsCtor: opts.openaiWsCtor } : {}),
            ...(opts.openaiWsUrl ? { wsUrl: opts.openaiWsUrl } : {}),
          });
        } else {
          // The self-hosted pipeline — and dictation on ANY backend, which is
          // STT only: the same VoiceSession, with the configured backend's
          // transcriber in Whisper's place (hosted-stt.ts).
          let whisper: WhisperBackend = opts.whisper;
          if (voiceSurface === 'dictation') {
            const picked = pickDictationTranscriber(
              cell.backend,
              opts.dictationTranscribers ?? { local: opts.whisper },
            );
            if (!picked.ok) {
              rejectConn(ws, 'voice_key_missing', picked.message);
              return;
            }
            whisper = picked.whisper;
          }
          const vad = (opts.makeVad ?? ((): Vad => new MockVad()))();
          const aec = (
            opts.makeAec ??
            ((hasAec: boolean): AecProcessor => (hasAec ? new PassThroughAec() : new NlmsAec()))
          )(start.surfaceHasAec);
          session = new VoiceSession(sessionInit, {
            vad,
            aec,
            whisper,
            kokoro: opts.kokoro,
            logger: sessionLog,
            sendAudio: sendAudioFn,
            sendBinary: sendBinaryFn,
            submitUserTurn: opts.submitUserTurn,
            ...(opts.getPendingPermission
              ? { getPendingPermission: opts.getPendingPermission }
              : {}),
            ...(opts.resolvePermission ? { resolvePermission: opts.resolvePermission } : {}),
            ...(opts.getKokoroVoice ? { getKokoroVoice: opts.getKokoroVoice } : {}),
          });
        }
        isAppCall = voiceSurface === 'call' || voiceSurface === 'hands-free';
        session.onSessionStart();
        sessions.set(start.sessionId, {
          session,
          socket: ws,
          lastActivityAt: Date.now(),
          ...(isAppCall ? { call: { init: sessionInit, startedAt: Date.now() } } : {}),
          surfaceId: start.surfaceId,
          accountId: start.accountId,
          surfaceKind: start.surfaceKind,
          role: start.role,
          ...(start.surfaceKind === 'device' && start.deviceId !== undefined
            ? { deviceId: start.deviceId }
            : {}),
        });
        surfaceIndex.set(start.surfaceId, start.sessionId);
        if (isAppCall) opts.onCallStarted?.(sessionInit);
        // spec/14 ## Sidebar — a live device session lights the Speakers-row
        // pill on every surface. `validateDeviceIdCoupling` above guarantees a
        // `device` session carries a deviceId.
        if (start.surfaceKind === 'device' && start.deviceId !== undefined) {
          opts.onDeviceSession?.(start.deviceId, true);
        }
        log.info(
          {
            sessionId: start.sessionId,
            surfaceKind: start.surfaceKind,
            chatId: start.chatId,
            active: sessions.size,
          },
          'audio: session started',
        );
        return;
      }
      // Already-authed session — handle subsequent control frames.
      switch (parsed.type) {
        case 'audio.pcm16':
          pendingBinaryMeta = { samples: parsed.samples };
          break;
        case 'audio.speak': {
          // spec/07 § Speaking with no session open — an `auto-notify` interrupt
          // on a surface that is not in a conversation. No chat turn, no reply
          // path: synthesise it and stream it back.
          if (parsed.sessionId !== urlSessionId) {
            rejectConn(ws, 'invalid_frame', 'speak sessionId mismatch with this session');
            return;
          }
          void session.speak(parsed.text).catch((err: Error) => {
            log.warn({ err: err.message, sessionId: urlSessionId }, 'audio: speak failed');
          });
          break;
        }
        case 'audio.mode': {
          if (parsed.sessionId !== urlSessionId) {
            rejectConn(ws, 'invalid_frame', 'mode sessionId mismatch with this session');
            return;
          }
          // spec/07 § Session modes — one session, two policies, but only
          // while both modes are configured onto the SAME engine. Flipping in
          // place across engines would keep running the one the new mode is
          // not configured for; the surface opens a fresh session instead.
          if (
            isAppCall &&
            !modesShareVoiceEngine(
              opts.getVoiceConfig?.() ?? DEFAULT_VOICE_CONFIG,
              session.getMode(),
              parsed.mode,
            )
          ) {
            send(ws, {
              type: 'audio.error',
              code: 'voice_config_not_implemented',
              message: `${parsed.mode} is configured for a different voice engine than ${session.getMode()}; end this session and start a new one in ${parsed.mode}`,
              sessionId: urlSessionId,
            });
            break;
          }
          session.setMode(parsed.mode);
          break;
        }
        case 'audio.session_end': {
          // A voice-NOTE (mode 1) commits on the gesture-end: the press-release
          // (or ⏎ in toggle mode) IS the end-of-utterance, not VAD silence. The
          // surface sends `reason: 'committed'`; flush the buffered utterance
          // through STT + commit exactly one user turn BEFORE closing. A
          // voice-CALL ends with no implicit final turn (the call's utterances
          // were already committed via VAD-end). `reason: 'cancelled'` (Esc /
          // abort) drops without committing.
          // spec/03: the documented payload is `{reason}` — the socket already
          // identifies the session. An explicitly supplied `sessionId` must
          // still name THIS session; a mismatched one is a client bug (or a
          // crossed session) and is refused rather than silently ignored.
          if (parsed.sessionId !== undefined && parsed.sessionId !== urlSessionId) {
            rejectConn(ws, 'invalid_frame', 'session_end sessionId mismatch with this session');
            return;
          }
          const active = session;
          const isNoteCommit =
            (parsed as { reason?: string }).reason === 'committed' &&
            sessions.get(urlSessionId)?.role === 'voice-note';
          if (isNoteCommit) {
            void active
              .finalizeNote()
              .catch((err: Error) => {
                log.warn({ err: err.message }, 'audio: voice-note finalize error');
              })
              .finally(() => ws.close());
          } else {
            ws.close();
          }
          break;
        }
        default:
          // Other frames are surface-emitted but unused by the host today.
          break;
      }
    });

    ws.on('close', () => {
      if (claims) {
        const id = claims.sessionId;
        const active = sessions.get(id);
        if (active) {
          surfaceIndex.delete(active.surfaceId);
          void active.session.close().catch(() => undefined);
          if (active.deviceId !== undefined) {
            opts.onDeviceSession?.(active.deviceId, false);
          }
          // A phone-side voice-call ending lets a queued device event proceed
          // (spec/16 priority: phone-active-call > device-active-session).
          const wasPhoneCall = active.role === 'voice-call' && active.surfaceKind !== 'device';
          opts.onSessionClosed?.({ wasPhoneCall });
          if (active.call) {
            opts.onCallEnded?.({
              init: active.call.init,
              chatId: active.session.getCurrentChatId(),
              startedAt: active.call.startedAt,
              endedAt: Date.now(),
              engine: active.session.engineCosting(),
            });
          }
        }
        const stats = active?.session.stats();
        sessions.delete(id);
        // Close the session with what it actually did. "Started" then "ended"
        // with nothing between them describes every possible failure equally;
        // these numbers say which one it was — no mic audio at all, audio but
        // no end-of-utterance, or a turn that ran and produced nothing.
        log.info({ sessionId: id, active: sessions.size, ...stats }, 'audio: session ended');
      }
    });

    ws.on('error', (err: Error) => {
      log.warn({ err: err.message }, 'audio: ws error');
    });
  }

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(opts.port, opts.host, () => resolve());
  });
  log.info({ host: opts.host, port: opts.port }, 'audio WSS listening');

  return {
    address(): AddressInfo {
      const addr = http.address();
      if (!addr || typeof addr === 'string') {
        throw new Error('audio: server not listening');
      }
      return addr;
    },
    activeCount(): number {
      return sessions.size;
    },
    phoneCallActive(): boolean {
      for (const [, active] of sessions) {
        if (active.role === 'voice-call' && active.surfaceKind !== 'device') return true;
      }
      return false;
    },
    sessionsOnChat(chatId: string): VoiceSessionLike[] {
      return [...sessions.values()]
        .map((a) => a.session)
        .filter((sess) => sess.getCurrentChatId() === chatId);
    },
    getSessionState(id: string): SessionState | undefined {
      return sessions.get(id)?.session.getState();
    },
    setFocusForSurface(surfaceId: string, chatId: string): void {
      const sid = surfaceIndex.get(surfaceId);
      if (!sid) return;
      const active = sessions.get(sid);
      if (active) active.session.setFocus(chatId);
    },
    injectUtterance(surfaceId: string, text: string): boolean {
      const sid = surfaceIndex.get(surfaceId);
      if (!sid) return false;
      const active = sessions.get(sid);
      if (!active) return false;
      void active.session.injectTranscript(text).catch((err: Error) => {
        log.warn({ err: err.message, surfaceId }, 'audio: injectUtterance failed');
      });
      return true;
    },
    speakCanned(surfaceId: string, text: string): boolean {
      return speakCannedFor(surfaceId, text);
    },
    interruptOpenCall(text: string): boolean {
      // The surface the user is actually at wins (spec/07 § Which surface it
      // reaches): with a desk session and a phone in a pocket both live, the one
      // that last heard something is the machine they are in front of.
      let target: string | undefined;
      let best = -1;
      for (const [, active] of sessions) {
        if (active.role !== 'voice-call' || active.surfaceKind === 'device') continue;
        if (active.lastActivityAt > best) {
          best = active.lastActivityAt;
          target = active.surfaceId;
        }
      }
      if (target === undefined) return false;
      return speakCannedFor(target, text);
    },
    async close(): Promise<void> {
      for (const [, active] of sessions) {
        try {
          active.socket.close();
        } catch {
          /* ignore */
        }
      }
      sessions.clear();
      surfaceIndex.clear();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
      });
    },
  };
}
