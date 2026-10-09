// audioSession — the surface side of the voice audio plane (spec/07).
//
// G5 owns the surface-side voice UX; the host-side STT/TTS/VAD pipeline is
// E1. This module is the glue: it mints a one-shot voice token via
// `POST /api/voice/token`, opens the host's per-session audio WSS
// (`/audio/<sessionId>`), streams mic PCM16 (16 kHz mono) out as binary frames,
// plays the host's TTS PCM16 (24 kHz mono) back through the speaker, and
// dispatches the JSON control frames (transcript partial/final, tts chunk/end,
// barge-in, error) to callbacks the voiceStore wires up.
//
// Audio capture/playback uses the Web Audio API. NO FALLBACK: if mic access is
// denied or a backend frame is malformed we surface the error to the caller
// rather than silently degrading.

import {
  decodeAudio,
  type AudioEvent,
  type AudioSessionRole,
  type AudioSessionMode,
  type AudioSessionStateName,
} from '@patch/wire/audio';
import { api } from '../api/rest.js';
import { loadCredential, decodeSurfaceClaims } from './credential.js';
import { createPcm16Downsampler, MIC_SAMPLE_RATE } from './pcmDownsample.js';
import { silentAudioContext } from './silentAudioContext.js';

export { MIC_SAMPLE_RATE };
/** Host TTS sample rate (Kokoro streams 24 kHz mono — spec/07, E1 build-context). */
export const TTS_SAMPLE_RATE = 24_000;
/** 30 ms @ 16 kHz = 480 samples per mic frame (E1 build-context). */
export const MIC_FRAME_SAMPLES = 480;

export interface AudioSessionCallbacks {
  /** Live STT transcript (italic, updates as the user speaks). */
  onTranscriptPartial(text: string): void;
  /**
   * Final STT transcript for the utterance. `addressed` is false when a quiet
   * session heard it but did NOT send it (spec/07 § Session modes) — the surface
   * shows it as heard-but-not-sent rather than echoing it into the chat.
   */
  onTranscriptFinal(text: string, addressed: boolean): void;
  /**
   * Turn-cycle state transition (`audio.state`). Optional: a voice NOTE has no
   * phase indicator to drive, a sustained session does.
   */
  onState?(state: AudioSessionStateName): void;
  /** Host began streaming a TTS reply (agent is speaking). */
  onTtsStart(): void;
  /** Host finished (or barge-in halted) the TTS reply. */
  onTtsEnd(bargedIn: boolean): void;
  /** Host detected the user speaking over the agent: TTS was cut. */
  onBargeIn(): void;
  /** Smoothed input level 0..1 for the waveform visualiser. */
  onLevel(level: number): void;
  /** Fatal session error (auth, concurrency cap, backend unavailable, …). */
  onError(message: string): void;
  /** WSS closed (clean or otherwise). */
  onClose(): void;
}

export interface OpenAudioSessionOpts {
  chatId: string;
  role: AudioSessionRole;
  callbacks: AudioSessionCallbacks;
  /** Mode a call opens in (spec/07 § Session modes). Defaults to live. */
  mode?: AudioSessionMode;
  /** The account's address word, which an address-gated session uses. */
  addressWord?: string;
  /**
   * Whether to capture the microphone. False opens a session that only plays —
   * the `auto-notify` interrupt of spec/07 § Speaking with no session open,
   * which must not hold the mic so a podcast can keep playing underneath.
   */
  withMic?: boolean;
  /**
   * Open no audio output. For a session that only listens — composer
   * dictation's live preview — so it doesn't wake the output device for
   * speech it will never play (lib/silentAudioContext.ts). Speech that
   * arrives anyway is reported through `onError`, not dropped.
   */
  silent?: boolean;
  /** Test seam: inject a WebSocket factory + a media-stream factory. */
  deps?: AudioSessionDeps;
}

export interface AudioSessionDeps {
  WebSocketImpl?: typeof WebSocket;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  AudioContextImpl?: typeof AudioContext;
  /** Resolve `/audio/<id>` to an absolute ws(s) URL. Defaults to same-origin. */
  resolveAudioUrl?: (path: string) => string;
}

/** A live audio session. Surface keeps a handle to mute / end / inspect it. */
export interface AudioSession {
  readonly sessionId: string;
  readonly chatId: string;
  /** Stop sending mic frames (agent still speaks). */
  setMuted(muted: boolean): void;
  /** Flip the open session's turn-taking policy (spec/07 § Session modes). */
  setSessionMode(mode: AudioSessionMode): void;
  /** Ask the host to synthesise and play `text`, with no chat turn behind it. */
  speak(text: string): void;
  /**
   * Push one frame of already-16 kHz PCM16 mic audio up the session. For a
   * session opened with `withMic: false` because the caller is already
   * capturing the microphone for its own reasons and must not open a second
   * capture of it — composer dictation records the authoritative clip locally
   * and feeds the same samples here purely to get live partials back.
   */
  sendPcm(pcm: Int16Array): void;
  /** True while muted. */
  isMuted(): boolean;
  /** Tear the session down: send session_end, stop mic, close WSS. */
  end(reason?: string): void;
}

function defaultResolveAudioUrl(path: string): string {
  // `path` is the server-returned `/audio/<sessionId>`. In production the
  // host audio plane is reached same-origin through Caddy; in dev the Vite
  // `/audio` proxy forwards to the host's audio port. Either way we mount it
  // on the current origin's ws(s):// scheme.
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}${path}`;
}

/**
 * Open a voice audio session against the host. Resolves once the WSS is open
 * and the `audio.session_start` control frame has been sent and mic capture has
 * started. Rejects (and cleans up) on mint failure, mic-permission denial, or
 * WSS open failure.
 */
export async function openAudioSession(opts: OpenAudioSessionOpts): Promise<AudioSession> {
  const { chatId, role, callbacks } = opts;
  const deps = opts.deps ?? {};
  const WS = deps.WebSocketImpl ?? WebSocket;
  const resolveUrl = deps.resolveAudioUrl ?? defaultResolveAudioUrl;
  const getMedia =
    deps.getUserMedia ?? ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));
  const AudioCtx =
    deps.AudioContextImpl ??
    ((window as unknown as { AudioContext?: typeof AudioContext }).AudioContext as
      | typeof AudioContext
      | undefined);
  if (!AudioCtx) throw new Error('Web Audio API unavailable');

  // 1. Identity (accountId/surfaceId) — required in the session_start frame.
  // accountId comes from /api/auth/me; the surfaceId is read from our own
  // credential JWT (the authenticated identity, always present), NOT from
  // me.surface — the server only populates me.surface when its in-memory
  // registry already knows this surface, so relying on it crashed the audio
  // session for a freshly-paired surface (NO FALLBACK on a missing surfaceId).
  const me = await api.me();
  const surface = decodeSurfaceClaims();
  if (!surface) {
    throw new Error('audio session: no surface credential — cannot open a voice session');
  }
  // 2. Mint a one-shot token bound to this surface + chat.
  const minted = await api.voiceToken(chatId, role);

  // 3. Mic capture — skipped entirely for a play-only session, which must not
  // hold the microphone (spec/07 § Speaking with no session open).
  const withMic = opts.withMic !== false;
  const stream = withMic ? await getMedia({ audio: true }) : null;
  const silent = opts.silent === true;
  const audioCtx = silent ? silentAudioContext(AudioCtx) : new AudioCtx();
  // A fresh AudioContext starts `suspended` unless created inside a user-gesture
  // handler. The voice gestures (press-and-hold / tap-toggle / hotkey) ARE user
  // gestures, but the async `await api.me()` / `await api.voiceToken()` above
  // breaks out of the gesture's synchronous call stack, so Chrome no longer
  // treats the context as gesture-initiated and leaves it suspended. A
  // suspended context never fires `onaudioprocess`, so NO mic PCM is ever
  // streamed — the host's STT sees silence and the live transcript stays
  // empty. Explicitly resume; await it so capture is genuinely running before
  // we resolve. NO FALLBACK: a context that refuses to resume is a hard error.
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }
  const source = stream ? audioCtx.createMediaStreamSource(stream) : null;
  // ScriptProcessor is deprecated but universally available and works in
  // headless test browsers; an AudioWorklet would be the modern path but is
  // not required for the surface-side gesture/transcript UX G5 owns.
  const BUFFER = 2048;
  const processor = withMic ? audioCtx.createScriptProcessor(BUFFER, 1, 1) : null;

  let muted = false;
  let closed = false;

  const ws: WebSocket = new WS(resolveUrl(minted.audioUrl));
  ws.binaryType = 'arraybuffer';

  // TTS playback scheduling: queue 24 kHz PCM16 chunks and play them back to
  // back so the agent's voice is continuous.
  let playHead = 0;
  function playTts(pcm: Int16Array): void {
    const buf = audioCtx.createBuffer(1, pcm.length, TTS_SAMPLE_RATE);
    const ch = buf.getChannelData(0);
    /* v8 ignore next -- `i < pcm.length` is the loop invariant, so `pcm[i]` is always defined; the `?? 0` only exists to satisfy noUncheckedIndexedAccess. */
    for (let i = 0; i < pcm.length; i++) ch[i] = (pcm[i] ?? 0) / 32768;
    const node = audioCtx.createBufferSource();
    node.buffer = buf;
    node.connect(audioCtx.destination);
    const now = audioCtx.currentTime;
    const startAt = Math.max(now, playHead);
    node.start(startAt);
    playHead = startAt + buf.duration;
  }
  function stopTts(): void {
    // Drop any scheduled-but-not-yet-played audio by resetting the play head.
    playHead = audioCtx.currentTime;
  }

  // Mic → PCM16 16 kHz binary frames + level metering for the waveform.
  const downsample = createPcm16Downsampler(audioCtx.sampleRate);
  if (processor)
    processor.onaudioprocess = (e: AudioProcessingEvent): void => {
      if (closed || muted || ws.readyState !== WS.OPEN) return;
      const input = e.inputBuffer.getChannelData(0);
      // RMS level for the visualiser.
      let sumSq = 0;
      /* v8 ignore next -- `i < input.length` is the loop invariant, so `input[i]` is always defined; the `?? 0` only exists to satisfy noUncheckedIndexedAccess. */
      for (let i = 0; i < input.length; i++) sumSq += (input[i] ?? 0) ** 2;
      const rms = Math.sqrt(sumSq / input.length);
      callbacks.onLevel(Math.min(1, rms * 4));
      ws.send(downsample(input).buffer);
    };
  const sink = audioCtx.createGain();
  if (source && processor) {
    source.connect(processor);
    // ScriptProcessor only fires while connected to the destination; route it
    // through a muted gain node so we don't loop the mic back to the speaker.
    sink.gain.value = 0;
    processor.connect(sink);
    sink.connect(audioCtx.destination);
  }

  function cleanup(): void {
    if (closed) return;
    closed = true;
    try {
      processor?.disconnect();
      source?.disconnect();
      sink.disconnect();
    } catch {
      /* best-effort */
    }
    if (stream) for (const t of stream.getTracks()) t.stop();
    void audioCtx.close().catch(() => {});
  }

  ws.addEventListener('message', (evt: MessageEvent) => {
    if (typeof evt.data !== 'string') {
      // Binary frame = TTS PCM16 @ 24 kHz.
      const ab = evt.data instanceof ArrayBuffer ? evt.data : null;
      if (ab) {
        // Guard odd byteLength (E1 build-context: never assume alignment).
        const usable = ab.byteLength - (ab.byteLength % 2);
        if (silent) {
          callbacks.onError('speech arrived on a session opened without audio output');
          return;
        }
        playTts(new Int16Array(ab.slice(0, usable)));
      }
      return;
    }
    let frame: AudioEvent;
    try {
      frame = decodeAudio(evt.data);
    } catch (err) {
      callbacks.onError(`malformed audio frame: ${(err as Error).message}`);
      return;
    }
    dispatchFrame(frame, callbacks, stopTts);
  });

  return await new Promise<AudioSession>((resolve, reject) => {
    let settled = false;
    const onOpen = (): void => {
      const start = {
        type: 'audio.session_start' as const,
        sessionId: minted.sessionId,
        accountId: me.account.accountId,
        surfaceId: surface.surfaceId,
        surfaceKind: 'web' as const,
        chatId,
        role,
        token: minted.token,
        // Browsers have OS/hardware AEC, so the host bypasses its own.
        surfaceHasAec: true,
        ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
        ...(opts.addressWord !== undefined ? { addressWord: opts.addressWord } : {}),
      };
      ws.send(JSON.stringify(start));
      settled = true;
      resolve({
        sessionId: minted.sessionId,
        chatId,
        setMuted(m: boolean): void {
          muted = m;
        },
        isMuted(): boolean {
          return muted;
        },
        speak(text: string): void {
          if (ws.readyState !== WS.OPEN) return;
          ws.send(JSON.stringify({ type: 'audio.speak', sessionId: minted.sessionId, text }));
        },
        sendPcm(pcm: Int16Array): void {
          if (closed || ws.readyState !== WS.OPEN) return;
          ws.send(pcm.buffer as ArrayBuffer);
        },
        setSessionMode(mode: AudioSessionMode): void {
          if (ws.readyState !== WS.OPEN) return;
          ws.send(
            JSON.stringify({
              type: 'audio.mode',
              sessionId: minted.sessionId,
              mode,
            }),
          );
        },
        end(reason?: string): void {
          if (ws.readyState === WS.OPEN) {
            try {
              ws.send(
                JSON.stringify({
                  type: 'audio.session_end',
                  sessionId: minted.sessionId,
                  ...(reason ? { reason } : {}),
                }),
              );
            } catch {
              /* best-effort */
            }
          }
          cleanup();
          ws.close();
        },
      });
    };
    ws.addEventListener('open', onOpen);
    ws.addEventListener('error', () => {
      if (!settled) {
        cleanup();
        reject(new Error('audio WSS failed to open'));
      }
    });
    ws.addEventListener('close', () => {
      cleanup();
      callbacks.onClose();
    });
  });
}

function dispatchFrame(frame: AudioEvent, cb: AudioSessionCallbacks, stopTts: () => void): void {
  switch (frame.type) {
    case 'audio.state':
      cb.onState?.(frame.state);
      return;
    case 'audio.transcript_partial':
      cb.onTranscriptPartial(frame.text);
      return;
    case 'audio.transcript_final':
      cb.onTranscriptFinal(frame.text, frame.addressed !== false);
      return;
    case 'audio.tts_chunk':
      cb.onTtsStart();
      return;
    case 'audio.tts_end':
      cb.onTtsEnd(frame.bargedIn === true);
      return;
    case 'audio.barge_in':
      // User spoke over the agent: cut local playback immediately so the user
      // never experiences a hung audio session (spec/07 ## Barge-in).
      stopTts();
      cb.onBargeIn();
      return;
    case 'audio.error':
      // `voice_key_missing` is already the whole sentence (key, host, the
      // Settings → Voice fix); every other code keeps its code prefix.
      cb.onError(
        frame.code === 'voice_key_missing' || frame.code === 'mic_silent'
          ? frame.message
          : `${frame.code}: ${frame.message}`,
      );
      return;
    default:
      // session_start/end + pcm16 envelopes are not surface-inbound here.
      return;
  }
}

/** True iff a credential is present — voice requires an authed surface. */
export function hasVoiceCredential(): boolean {
  return loadCredential() !== null;
}
