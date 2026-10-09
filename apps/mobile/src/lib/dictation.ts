// Composer live-dictation session (spec/07 § "Dictation into the composer" —
// Todoist 6hHGqGVpJqfcXPmm: "voice message on mobile should show live
// transcription inside the text input").
//
// READ FIRST: `voiceNote.ts`'s "WHY UPLOAD" header comment documents the
// prior streaming attempt that was reverted (`2c94aab`) for two reasons:
//   (a) Groq Whisper isn't a streaming backend, so a WS-only "live transcript"
//       was always blank.
//   (b) A quick tap/hold-release raced the async WSS-open, so
//       `audio.session_start` / `audio.session_end` never reached the host
//       and the note SILENTLY vanished — worst on the fastest gesture.
//
// (a) no longer holds: the host's `VoiceSession.maybeTranscribePartial()`
// (`packages/daemon/src/audio/session.ts`, added in `71be70e`, AFTER the
// revert) periodically RE-transcribes the growing utterance and emits real
// `audio.transcript_partial` frames even over the non-streaming Groq backend.
// That already ships today and needs no wire/daemon change here.
//
// (b) is fixed here by DECOUPLING note-correctness from the socket entirely:
//   - Native mic capture (`voiceMic.ts`'s `PatchVoiceMic` tap — the same one
//     `voiceCall.ts` uses) starts as soon as local permission + audio-mode
//     setup resolve — NO network round trip is on that path. Every captured
//     PCM16 frame is kept in a local buffer for the session's whole life.
//   - The token mint + WSS open happen CONCURRENTLY, purely to drive the
//     live/greyed preview (`audio.transcript_partial`). Frames captured before
//     the socket opens are queued and flushed once it does; if the socket
//     never opens in time (a slow network, or the gesture ending before it
//     could), the preview simply never appears — that is the ONLY thing lost.
//   - The FINAL, authoritative transcript never touches the socket at all: on
//     commit the full local PCM buffer is encoded to a WAV (`pcmWav.ts`) and
//     POSTed to the existing, proven `POST /api/voice/transcribe`
//     (`api.voiceTranscribe`) — the same transcribe-only endpoint the old
//     expo-av dictation flow used, just fed a WAV instead of an m4a.
//   - The session is ALWAYS closed with `audio.session_end {reason:
//     'cancelled'}` (session.ts: cancelled → `ws.close()` with no finalize) —
//     NEVER `'committed'`, which would make the host run `finalizeNote` →
//     `submitUserTurn` and auto-run an agent turn. Dictation must never
//     auto-send; the composer decides that.
//
// TIMING: the permission check and the recording audio-mode switch are NOT on
// the press path. They used to be, and because the composer's hold gesture
// only fires `onLongPress` after 350ms, the user's first words were lost every
// single time and a short gesture captured nothing at all. `warmDictation()`
// resolves both AHEAD of the gesture (the composer calls it on mount and again
// on mic press-in) and caches the result, so `startMicCapture` is the only
// thing between the press and the first PCM frame — called SYNCHRONOUSLY from
// `startDictation`. Warming is not a bypass: a genuinely denied permission or
// a missing native module still reaches `onError`.
//
// role: 'voice-note' is used (not 'voice-call') because `VoiceSession` never
// auto-commits a note on VAD utterance-end (`session.ts`: "a voice NOTE never
// commits on VAD silence" — `if (this.isNote) return;`), matching spec/07 § 4:
// "A sustained session is not ended by silence… only a gesture ever ends the
// session."

import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import { decodeAudio, type AudioEvent } from '@patch/wire/audio';
import { api } from '../api/rest';
import { audioWsUrl } from '../config';
import { startMicCapture, stopMicCapture } from './voiceMic';
import { encodePcm16Wav, encodeBase64, mergePcmChunks } from './pcmWav';

/**
 * Why an outcome UNION rather than `string | null`: a dictation that produces
 * no text has three genuinely different causes and the user needs to be told
 * which one happened — nothing was captured, the clip was too short to be an
 * utterance, or the clip transcribed to silence. Collapsing them loses the
 * only information that distinguishes a broken microphone from a mumble.
 */
export type DictationOutcome =
  /** The recognised text, already trimmed and guaranteed non-empty. */
  | { kind: 'text'; text: string }
  /** `finish(false)`, or a second `finish()` — nothing to report. */
  | { kind: 'discarded' }
  /** Not one PCM frame arrived: capture never started before the gesture ended. */
  | { kind: 'no-audio' }
  /** Audio arrived but under `MIN_UTTERANCE_MS`; not uploaded. */
  | { kind: 'too-short'; ms: number }
  /** Uploaded, and the transcript came back empty. */
  | { kind: 'no-speech' };

/**
 * Shortest clip worth uploading. Native frames are 40ms, so a stab at the mic
 * button yields one or two of them; Whisper answers those with an empty string
 * and the user is left with no feedback at all. Below this the clip is
 * reported as too short instead of being sent.
 */
export const MIN_UTTERANCE_MS = 300;

const SAMPLE_RATE = 16000;
const AUDIO_MODE = {
  allowsRecordingIOS: true,
  playsInSilentModeIOS: true,
  staysActiveInBackground: false,
  shouldDuckAndroid: true,
  playThroughEarpieceAndroid: false,
} as const;

export interface DictationHandle {
  /**
   * Stop capture. `send=true` encodes the FULL locally-buffered clip
   * (independent of whether the preview socket ever connected) and uploads it
   * for transcription; `send=false` discards.
   *
   * Idempotent: a second call resolves `{ kind: 'discarded' }` without
   * re-uploading.
   */
  finish(send: boolean): Promise<DictationOutcome>;
}

// Resolved permission + audio mode, cached for the app's life. Only a SUCCESS
// is cached: a denial must be re-requestable, since the user can grant it in
// Settings and come straight back.
let audioReady = false;
let audioReadyInFlight: Promise<void> | null = null;
let warmInFlight: Promise<void> | null = null;

/** Test seam: drop the cached audio-plane state so a test starts from cold. */
export function __resetDictationAudio(): void {
  audioReady = false;
  audioReadyInFlight = null;
  warmInFlight = null;
}

/** Prompt for mic permission if needed, then switch to the recording audio mode. */
function prepareAudio(): Promise<void> {
  if (audioReady) return Promise.resolve();
  if (audioReadyInFlight) return audioReadyInFlight;
  const run = (async (): Promise<void> => {
    const perm = await Audio.requestPermissionsAsync();
    if (!perm.granted) throw new Error('mic permission denied');
    await Audio.setAudioModeAsync(AUDIO_MODE);
    audioReady = true;
  })();
  audioReadyInFlight = run;
  run.catch(() => {
    if (audioReadyInFlight === run) audioReadyInFlight = null;
  });
  return run;
}

/**
 * Warm the audio plane ahead of any gesture, so `startDictation` has no
 * awaits in front of `startMicCapture`. Deliberately never prompts — it reads
 * the CURRENT grant, because this runs when a chat merely opens and an OS
 * permission dialog there would be unprovoked. If the grant isn't there yet
 * the audio plane stays cold and the press path prompts (and surfaces a
 * denial) instead.
 */
export async function warmDictation(): Promise<void> {
  if (audioReady || audioReadyInFlight) return;
  if (warmInFlight) return warmInFlight;
  const run = (async (): Promise<void> => {
    const perm = await Audio.getPermissionsAsync();
    if (!perm.granted) return;
    await Audio.setAudioModeAsync(AUDIO_MODE);
    audioReady = true;
  })();
  warmInFlight = run;
  try {
    await run;
  } finally {
    warmInFlight = null;
  }
}

/**
 * Start a dictation session. Mic capture is started SYNCHRONOUSLY when the
 * audio plane has been warmed (`warmDictation`), and otherwise as soon as the
 * permission prompt + audio-mode switch resolve; the token mint and WS open
 * always happen in the background. `onPartial` is
 * called with the live/interim transcript as `audio.transcript_partial`
 * frames arrive (best-effort — may never fire on a very short utterance or a
 * slow network); `onError` is called for a genuine local capture failure
 * (missing native module, permission denied, native read-loop failure) and
 * for the host refusing the surface (`voice_key_missing`) — any other
 * slow/failed preview socket is swallowed here, exactly because that failure
 * mode must never affect whether the note is captured (see file header).
 */
export function startDictation(
  chatId: string,
  onPartial: (text: string) => void,
  onError: (message: string) => void,
): DictationHandle {
  let closed = false;
  let finished = false;
  let ws: WebSocket | null = null;
  let wsOpen = false;
  let micStarted = false;
  // Source of truth for the final transcript — populated regardless of the
  // socket's fate.
  const pcmAll: Int16Array[] = [];
  // Queued only until the socket opens, then flushed once — live preview only.
  const pcmPending: Int16Array[] = [];

  function forwardFrame(pcm: Int16Array): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(
        JSON.stringify({
          type: 'audio.pcm16',
          ts: Date.now(),
          sampleRate: SAMPLE_RATE,
          samples: pcm.length,
        }),
      );
      ws.send(pcm.buffer as ArrayBuffer);
    } catch {
      // Best-effort preview only — never surfaced (see file header).
    }
  }

  function onMicFrame(pcm: Int16Array): void {
    pcmAll.push(pcm);
    if (wsOpen) forwardFrame(pcm);
    else pcmPending.push(pcm);
  }
  function onMicFailure(message: string): void {
    onError(`dictation mic failed: ${message}`);
  }

  /** End the session for good and report `message` — nothing is uploaded. */
  async function refuse(message: string): Promise<void> {
    if (finished) return;
    finished = true;
    closed = true;
    ws?.close();
    onError(message);
    if (micStarted) await stopMicCapture().catch(() => undefined);
  }

  // Capture starts HERE — the ENTIRE dependency for "was the dictation
  // captured". No network call precedes it, and when the audio plane is warm
  // (the normal case) no `await` does either: an async function body runs
  // synchronously up to its first `await`, and with `audioReady` true there
  // isn't one before `startMicCapture`. So the mic opens in the same tick as
  // the press and the user's first syllable is on the wire.
  async function beginCapture(): Promise<void> {
    if (!audioReady) {
      await prepareAudio();
      if (closed) return; // gesture ended while the permission dialog was up
    }
    await startMicCapture(onMicFrame, onMicFailure);
    micStarted = true;
  }
  const capture = beginCapture();

  void (async () => {
    try {
      await capture;
      if (closed) {
        if (micStarted) await stopMicCapture().catch(() => undefined);
        return;
      }
    } catch (e) {
      // A failure ANYWHERE above this point means capture itself never
      // started — that's the one failure mode that must reach the user.
      onError(`dictation setup failed: ${(e as Error).message}`);
      return;
    }

    // From here down: best-effort live preview ONLY, in its OWN try/catch —
    // deliberately NOT the one above. Mic capture already succeeded, so the
    // transcript is already safe (see file header); a token-mint/WS failure
    // here must be swallowed, not routed through `onError`, because
    // Composer's onError handler nulls out its session handle and resets to
    // idle — which would silently kill an otherwise-healthy in-progress
    // recording over what is, to the user, an invisible preview hiccup.
    try {
      const me = await api.me();
      const tok = await api.voiceToken(chatId, 'voice-note');
      if (closed) return;
      const socket = new WebSocket(audioWsUrl(tok.audioUrl));
      ws = socket;
      socket.onopen = (): void => {
        if (closed) {
          socket.close();
          return;
        }
        try {
          socket.send(
            JSON.stringify({
              type: 'audio.session_start',
              sessionId: tok.sessionId,
              accountId: me.account.accountId,
              surfaceId: me.surface.surfaceId,
              surfaceKind: 'mobile',
              chatId,
              role: 'voice-note',
              token: tok.token,
              surfaceHasAec: true,
            }),
          );
        } catch {
          return;
        }
        wsOpen = true;
        for (const pcm of pcmPending.splice(0)) forwardFrame(pcm);
      };
      socket.onmessage = (evt: WebSocketMessageEvent): void => {
        if (typeof evt.data !== 'string') return; // TTS chunks are irrelevant to a note session.
        let frame: AudioEvent;
        try {
          frame = decodeAudio(evt.data);
        } catch {
          return;
        }
        if (frame.type === 'audio.transcript_partial') onPartial(frame.text);
        // The one socket answer that is NOT an invisible preview hiccup: the
        // host refusing the dictation surface outright because its backend
        // has no key on this host. The final upload would be refused with the
        // same sentence, so stop now and say it while the user is still
        // holding the mic, rather than after they have finished speaking.
        if (frame.type === 'audio.error' && frame.code === 'voice_key_missing') {
          void refuse(frame.message);
        }
      };
      // onerror / onclose intentionally left as no-ops: a dead preview socket
      // is invisible to the user by design (see file header).
    } catch {
      // Swallowed — see comment above. The recording is unaffected; the user
      // simply gets no live/greyed preview text for this session.
    }
  })();

  return {
    async finish(send: boolean): Promise<DictationOutcome> {
      if (finished) return { kind: 'discarded' };
      finished = true;
      closed = true;
      try {
        ws?.send(JSON.stringify({ type: 'audio.session_end', reason: 'cancelled' }));
      } catch {
        // Socket may already be closed/never opened — closing below is the
        // source of truth.
      }
      ws?.close();
      if (micStarted) await stopMicCapture().catch(() => undefined);
      if (!send) return { kind: 'discarded' };
      if (pcmAll.length === 0) return { kind: 'no-audio' };

      const merged = mergePcmChunks(pcmAll);
      const ms = Math.round((merged.length / SAMPLE_RATE) * 1000);
      if (ms < MIN_UTTERANCE_MS) return { kind: 'too-short', ms };

      const wav = encodePcm16Wav(merged, SAMPLE_RATE);
      const base64 = encodeBase64(wav);
      const dir = FileSystem.cacheDirectory;
      if (!dir) throw new Error('no cache directory available');
      const uri = `${dir}dictation-${Date.now()}.wav`;
      await FileSystem.writeAsStringAsync(uri, base64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const { transcript } = await api.voiceTranscribe(uri);
      const text = transcript.trim();
      return text.length > 0 ? { kind: 'text', text } : { kind: 'no-speech' };
    },
  };
}
