// Voice-call session: calls POST /api/voice/token, opens the audio WSS
// session, starts the Android VoiceAudioService foreground notification,
// and updates the voice store so the in-chat call bar (CallBar) and the
// on-call pill (CallPill) render.
//
// IMPORTANT: the call bar MUST appear the instant the call control is
// tapped. Minting a token (api.me + api.voiceToken), requesting the mic
// permission and acquiring audio focus are all async and on a loaded
// emulator take seconds; doing them BEFORE flipping the store left the
// gesture looking dead ("tap does nothing"). So we mount the call bar
// synchronously in a CONNECTING state, then open the real session in the
// background and upgrade the store to the live session id / audio URL. Any
// failure releases the audio and keeps the bar up with the error and a Retry — NO FALLBACK.
//
// MIC UPLINK (spec/07 § End-to-end voice transport — "Voice call (sustained)").
// The full inbound leg is wired and device-verifiable: token mint,
// mic-permission request, Android foreground service, opening the audio WSS, the
// `audio.session_start` control frame that binds the session, AND — the piece
// that made "nothing happens when I speak" true — streaming raw mic PCM16 up as
// interleaved `audio.pcm16` + binary frames. `expo-av` has no per-frame PCM tap
// (its Recording API only writes a whole file on stop), so capture is done by a
// custom native module (`PatchVoiceMic` → AudioRecord, src/lib/voiceMic.ts). The
// host VADs the frames, transcribes each utterance (Whisper) and commits it as
// a chat turn whose reply streams back into the timeline (spec/07 turn
// semantics). NO FALLBACK: if the native mic module is absent, or the read loop
// fails, the call is torn down and the error surfaced — never a live-looking
// call bar that carries no audio.
//
// OUTBOUND AUDIO (spec/07 § End-to-end voice transport — the down leg). Playing
// the agent's TTS reply out loud is done by a second native module: an
// AudioTrack streaming sink (`PatchVoiceTts` → src/lib/voiceTts.ts). The host
// streams Kokoro TTS as `audio.tts_chunk` PCM16 @ 24 kHz mono BINARY frames on
// the same WS; the `onmessage` handler below feeds each binary frame straight
// into the sink so the user HEARS the reply as it arrives. Barge-in
// (`audio.barge_in`) flushes the sink so cut-off audio stops immediately; the
// live STT `audio.transcript_partial` frames feed the call bar's running
// transcript. NO FALLBACK: if the sink can't init the call is torn down and the
// error surfaced — never a live-looking call bar that plays no audio back.
// (Related: full Android `AUDIOFOCUS_GAIN` vs expo-av's duck-only flag still
// awaits a native audio-focus module.)
//
// VOICE ENGINE (spec/07 § Voice — a config matrix). Nothing in this file is
// specific to the `local` pipeline. `gemini` (Gemini Live) and `openai` (OpenAI
// Realtime) are relayed by the HOST: the phone opens the same audio WSS,
// sends the same `audio.session_start` and the same 16 kHz PCM up, and plays the
// same 24 kHz PCM back through the same long-lived AudioTrack sink, and the
// host runs whichever engine the account's voice config names for this
// session's mode. No provider key or ephemeral token ever reaches the phone,
// and no WebRTC module is needed. What the phone does with the config: it
// names a hosted engine on the call bar (`callEngineLabel`), it opens a fresh
// session when a mode switch crosses engines (`setCallMode`), and it names the
// engine when one fails (`describeVoiceError`) — a hosted engine's failure is
// never answered by running local instead.

import { Audio } from 'expo-av';
import { decodeAudio, type AudioEvent, type AudioSessionMode } from '@patch/wire/audio';
import { api } from '../api/rest';
import { audioWsUrl } from '../config';
import { useVoiceStore } from '../stores/voiceStore';
import { useUiStore } from '../stores/uiStore';
import {
  startVoiceAudioService,
  stopVoiceAudioService,
  updateVoiceAudioService,
  onVoiceServiceAction,
} from './voiceAudioService';
import { startMicCapture, stopMicCapture } from './voiceMic';
import { addressWordOrNull, voiceConfigOrNull } from './preferences';
import { callEngineLabel, describeVoiceError, modeSwitchNeedsNewSession } from './voiceEngine';
import { startTtsPlayback, writeTtsPcm, flushTtsPlayback, stopTtsPlayback } from './voiceTts';

export class VoiceAudioConnectError extends Error {
  override readonly name = 'VoiceAudioConnectError';
  override readonly cause?: Error;
  constructor(message: string, cause?: Error) {
    super(message);
    if (cause) this.cause = cause;
  }
}

let _ws: WebSocket | null = null;
/** Unsubscribe for the notification-button listener, while a session is open. */
let _serviceActions: (() => void) | null = null;
// Bumped each time a call starts; lets a stale async setup detect that the
// user already ended the call (or started a new one) and bail.
let _callGen = 0;
/** Fires if the session never reaches the host (see CALL_CONNECT_TIMEOUT_MS). */
let _connectTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * How long a call may sit in `connecting` before it is declared failed. A
 * session that never gets the host's first `audio.state` has no working
 * audio path; leaving it "Connecting…" forever is a silent failure, so it is
 * torn down and says so, with a retry (spec/15 § Voice states).
 */
export const CALL_CONNECT_TIMEOUT_MS = 15_000;

function clearConnectTimer(): void {
  if (_connectTimer !== null) clearTimeout(_connectTimer);
  _connectTimer = null;
}

/** Release every audio resource the setup may have taken; keeps the store. */
async function releaseAudio(): Promise<void> {
  _ws?.close();
  _ws = null;
  _serviceActions?.();
  _serviceActions = null;
  await stopMicCapture().catch(() => undefined);
  await stopTtsPlayback().catch(() => undefined);
  await stopVoiceAudioService().catch(() => undefined);
}

/**
 * Open a sustained call on `chatId`.
 *
 * `mode` (spec/07 § Session modes) is what it opens in: `call` answers
 * everything you say; `hands-free` leaves the line open — it never ends itself
 * on silence, and only an addressed utterance is a turn. Both are the SAME
 * session; `setCallMode` flips between them without tearing anything down.
 */
export function startVoiceCall(chatId: string, mode: AudioSessionMode = 'call'): void {
  // 1) Mount the call bar synchronously — CONNECTING state, empty session.
  const gen = ++_callGen;
  useVoiceStore.getState().setActive({
    sessionId: '',
    chatId,
    audioUrl: '',
    startedAt: Date.now(),
  });
  useVoiceStore.getState().setCallMode(mode);
  useVoiceStore.getState().setCallAddressWord(addressWordOrNull());
  useVoiceStore.getState().setCallEngine(callEngineLabel(voiceConfigOrNull(), mode));
  // Connect watchdog: the host's first `audio.state` (sent on session_start)
  // is what moves the phase off `connecting`. No answer in time = failed.
  clearConnectTimer();
  _connectTimer = setTimeout(() => {
    _connectTimer = null;
    const st = useVoiceStore.getState();
    if (gen !== _callGen || st.callPhase !== 'connecting' || st.callError !== null) return;
    const secs = Math.round(CALL_CONNECT_TIMEOUT_MS / 1000);
    console.log(`[patch-voice] call connect TIMED OUT after ${secs}s`);
    st.setError(`Could not connect — no answer from the host after ${secs}s`);
    useUiStore.getState().pushError(`voice call: no answer from the host after ${secs}s`);
    void releaseAudio();
  }, CALL_CONNECT_TIMEOUT_MS);
  // Diagnostic (logcat ReactNativeJS) — proves the tap handler fired and the
  // call bar mounted synchronously in CONNECTING state.
  console.log(`[patch-voice] startVoiceCall chatId=${chatId} bar=connecting`);

  // 2) Open the real session in the background.
  void (async () => {
    try {
      // Identity is required in the host session_start frame; mint a
      // one-shot token bound to (this surface, chatId) for a sustained call.
      const addressWord = addressWordOrNull();
      const me = await api.me();
      const tok = await api.voiceToken(chatId, 'voice-call');
      if (gen !== _callGen) return; // user ended/replaced the call during mint
      if (!tok.audioUrl) {
        throw new Error('server returned empty audioUrl');
      }
      console.log(
        `[patch-voice] call token minted sessionId=${tok.sessionId} audioUrl=${tok.audioUrl}`,
      );
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        throw new Error('mic permission denied');
      }
      if (gen !== _callGen) return;
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        // Voice call wants AUDIOFOCUS_GAIN, not duck — but expo-av's API
        // only exposes the duck flag (KNOWN-GAP). Keep duck=false so the
        // call isn't ducked by other media; full GAIN requires a native
        // module on top of AudioManager.requestAudioFocus.
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: false,
      });
      if (gen !== _callGen) return;

      // Bring up the native AudioTrack sink BEFORE opening the WS so the first
      // `audio.tts_chunk` binary frame has somewhere to play. NO FALLBACK: a
      // failed init throws and the outer catch tears the call down.
      await startTtsPlayback();
      console.log('[patch-voice] call TTS AudioTrack sink started (PatchVoiceTts)');
      if (gen !== _callGen) {
        await stopTtsPlayback().catch(() => undefined);
        return;
      }

      // Upgrade the call bar to the live session (real id + audio URL). The
      // timer keeps running off the original startedAt.
      const startedAt = useVoiceStore.getState().activeSession?.startedAt ?? Date.now();
      useVoiceStore.getState().setActive({
        sessionId: tok.sessionId,
        chatId,
        audioUrl: tok.audioUrl,
        startedAt,
      });
      console.log(
        `[patch-voice] voiceCall session live sessionId=${tok.sessionId} audioUrl=${tok.audioUrl}`,
      );

      // Foreground service holds phoneCall|microphone — required on Android
      // to keep the mic alive while CallKeep's UI is in foreground.
      await startVoiceAudioService(chatId, mode, useVoiceStore.getState().callMuted);
      // The notification's own buttons are the control surface for a phone in a
      // pocket (spec/15 § Voice tab). Route them into the same state the
      // call bar drives, so the two can never disagree about what the session is
      // doing.
      _serviceActions?.();
      _serviceActions = onVoiceServiceAction((action) => {
        const store = useVoiceStore.getState();
        if (!store.activeSession) return;
        if (action === 'stop') {
          void endVoiceCall();
          return;
        }
        if (action === 'mute') {
          setCallMuted(!store.callMuted);
          return;
        }
        setCallMode(store.callMode === 'hands-free' ? 'call' : 'hands-free');
      });
      if (gen !== _callGen) {
        await stopVoiceAudioService().catch(() => undefined);
        return;
      }

      // Open the host audio WSS. The server returns a RELATIVE `/audio/<id>`
      // path; resolve it to an absolute ws(s):// URL against the audio plane
      // (same-origin via Caddy in prod; the direct host port in dev).
      const wsUrl = audioWsUrl(tok.audioUrl);
      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (e) {
        throw new VoiceAudioConnectError(
          `failed to open audio WS: ${(e as Error).message}`,
          e as Error,
        );
      }
      _ws = ws;
      // Receive TTS PCM as raw ArrayBuffers (not Blobs) so we can hand the
      // bytes straight to the native sink.
      ws.binaryType = 'arraybuffer';

      // Inbound frames: BINARY = TTS PCM16 @ 24 kHz → play; STRING = JSON
      // control frame (transcript / barge-in / tts_end / error). Mirrors the
      // web surface's audioSession dispatch.
      // Count TTS binary chunks so the down leg's first-audio arrival is
      // pinpointable in logcat without spamming it per-chunk.
      let ttsChunks = 0;
      ws.onmessage = (evt: WebSocketMessageEvent): void => {
        const data = evt.data as unknown;
        if (typeof data !== 'string') {
          if (data instanceof ArrayBuffer) {
            // Guard odd byteLength — never assume 2-byte alignment on the wire.
            const usable = data.byteLength - (data.byteLength % 2);
            if (ttsChunks === 0) {
              console.log(
                `[patch-voice] call FIRST tts_chunk received (${data.byteLength}B) → AudioTrack`,
              );
            }
            ttsChunks++;
            writeTtsPcm(usable === data.byteLength ? data : data.slice(0, usable));
          }
          return;
        }
        let frame: AudioEvent;
        try {
          frame = decodeAudio(data);
        } catch (e) {
          useUiStore
            .getState()
            .pushError(`voice call: malformed audio frame: ${(e as Error).message}`);
          return;
        }
        switch (frame.type) {
          case 'audio.state':
            // Daemon-driven turn phase (spec/15 § Voice states) — drives the
            // call bar's LISTENING → TRANSCRIBING → THINKING → SPEAKING indicator.
            console.log(`[patch-voice] call state → ${frame.state}`);
            if (frame.state !== 'connecting') clearConnectTimer();
            useVoiceStore.getState().setCallPhase(frame.state);
            break;
          case 'audio.transcript_partial':
            // Live interim STT — the call bar shows it as the trailing line of the
            // running transcript until the committed turn lands over the main WS.
            console.log(`[patch-voice] call transcript_partial: "${frame.text}"`);
            useVoiceStore.getState().setCallPhase('transcribing');
            useVoiceStore.getState().setCallTranscriptPartial(frame.text);
            break;
          case 'audio.transcript_final':
            // Final for this utterance; the committed user turn arrives as a
            // normal chat.message, so drop the interim line. The host has moved
            // to 'thinking' (it emits audio.state), but set it here too so the UI
            // advances even if that frame is reordered/lost.
            console.log(`[patch-voice] call transcript_final: "${frame.text}"`);
            useVoiceStore.getState().setCallTranscriptPartial('');
            if (frame.addressed === false) {
              // Heard but not sent (spec/07 § Session modes): no turn is coming,
              // so the phase goes straight back to listening and the words are
              // shown greyed rather than vanishing as if the mic were dead.
              useVoiceStore.getState().setCallUnaddressed(frame.text);
              useVoiceStore.getState().setCallPhase('listening');
              break;
            }
            useVoiceStore.getState().setCallUnaddressed(null);
            useVoiceStore.getState().setCallPhase('thinking');
            break;
          case 'audio.tts_end':
            // Speaking finished (or barge-in) → back to listening. This is the
            // canonical end-of-turn signal; the host does NOT emit an
            // audio.state after tts_end (see session.ts speak() finally).
            console.log(
              `[patch-voice] call tts_end (bargedIn=${frame.bargedIn ?? false}) → listening`,
            );
            useVoiceStore.getState().setCallPhase('listening');
            break;
          case 'audio.barge_in':
            // User spoke over the agent — cut local playback immediately.
            console.log('[patch-voice] call barge_in → flush TTS sink');
            useVoiceStore.getState().setCallPhase('listening');
            void flushTtsPlayback().catch(() => undefined);
            break;
          case 'audio.error': {
            // LOUD + visible: show it in the call bar (setError), not just a
            // toast. A hosted engine's failure (`gemini_unavailable` /
            // `openai_unavailable`) names the engine; the host ends the
            // session behind a fatal one, and the close handler below finds
            // this reason already on screen.
            console.log(`[patch-voice] call audio.error ${frame.code}: ${frame.message}`);
            const text = describeVoiceError(frame.code, frame.message);
            clearConnectTimer();
            useVoiceStore.getState().setError(text);
            useUiStore.getState().pushError(`voice call: ${text}`);
            break;
          }
          default:
            // tts_chunk / session_* are handled by the binary path or are not
            // surface-actionable here.
            break;
        }
      };

      // On open, send the `audio.session_start` control frame so the host
      // verifies the token and BINDS the session (spec/07, wire/audio).
      ws.onopen = (): void => {
        console.log(`[patch-voice] call audio WSS OPEN ${wsUrl}`);
        const start = {
          type: 'audio.session_start' as const,
          sessionId: tok.sessionId,
          accountId: me.account.accountId,
          surfaceId: me.surface.surfaceId,
          surfaceKind: 'mobile' as const,
          chatId,
          role: 'voice-call' as const,
          token: tok.token,
          // Android voice path uses hardware AEC; host bypasses its own.
          surfaceHasAec: true,
          mode,
          ...(addressWord !== null ? { addressWord } : {}),
        };
        try {
          ws.send(JSON.stringify(start));
        } catch (e) {
          useVoiceStore.getState().setError(`audio session_start failed: ${(e as Error).message}`);
          return;
        }
        console.log('[patch-voice] call session_start sent; starting mic capture (PatchVoiceMic)');

        // Stream mic PCM16 up as interleaved `audio.pcm16` + binary frames.
        // This is the leg whose absence made speaking do nothing: the host's
        // onMicFrame → VAD → Whisper → turn chain only runs once frames arrive.
        let frameCount = 0;
        void startMicCapture(
          (pcm: Int16Array): void => {
            // Bail if the call was ended/replaced, the socket closed, or the
            // user muted — muting stops sending frames (the native mic keeps
            // running; we just don't forward, so the host hears silence).
            if (gen !== _callGen || ws.readyState !== WebSocket.OPEN) return;
            if (useVoiceStore.getState().callMuted) return;
            try {
              ws.send(
                JSON.stringify({
                  type: 'audio.pcm16',
                  ts: Date.now(),
                  sampleRate: 16000,
                  samples: pcm.length,
                }),
              );
              ws.send(pcm.buffer as ArrayBuffer);
            } catch (e) {
              useVoiceStore.getState().setError(`mic frame send failed: ${(e as Error).message}`);
              return;
            }
            frameCount++;
            if (frameCount === 1) {
              console.log('[patch-voice] call FIRST mic frame sent up (mic uplink live)');
            } else if (frameCount % 50 === 0) {
              // ~2s cadence at 40ms frames — proves the uplink keeps flowing
              // without spamming logcat.
              console.log(`[patch-voice] call streamed ${frameCount} mic frames up`);
            }
          },
          (message: string): void => {
            // Native read loop failed mid-call. LOUD + visible in the call bar
            // (setError), not just a toast — the user keeps the call bar with the
            // error and ends the dead call themselves (NO silent live-looking call).
            console.log(`[patch-voice] call mic read loop FAILED: ${message}`);
            useVoiceStore.getState().setError(`mic failed: ${message}`);
            useUiStore.getState().pushError(`voice call mic: ${message}`);
          },
        ).catch((e: unknown) => {
          // Missing native module / AudioRecord init failure. LOUD + visible in
          // the call bar so the user SEES why the call is silent (a toast alone is
          // easy to miss). The call bar stays up with the error + End button.
          console.log(`[patch-voice] call mic capture START FAILED: ${(e as Error).message}`);
          useVoiceStore.getState().setError(`mic unavailable: ${(e as Error).message}`);
          useUiStore
            .getState()
            .pushError(`voice call: mic capture failed: ${(e as Error).message}`);
        });
      };
      ws.onerror = (e: Event): void => {
        useVoiceStore.getState().setError(`audio WS error: ${(e as Event).type ?? 'unknown'}`);
      };
      // If the host (or network) drops the session, stop the mic AND the TTS
      // sink so we don't keep capturing into — or playing from — a dead socket.
      ws.onclose = (): void => {
        void stopMicCapture().catch(() => undefined);
        void stopTtsPlayback().catch(() => undefined);
        // A close the user did not ask for (endVoiceCall bumps the generation
        // first) is a dropped call — say so rather than leave a bar that
        // still reads "Listening" over a dead socket.
        if (gen !== _callGen) return;
        clearConnectTimer();
        const st = useVoiceStore.getState();
        if (st.activeSession && st.callError === null) {
          st.setError('Call dropped — the audio connection closed');
        }
      };
    } catch (e) {
      if (gen !== _callGen) return;
      // Setup failed (token / permission / TTS-init / WS-open). LOUD + visible:
      // tear down the audio resources but KEEP the call bar mounted showing the
      // error + End button (setError), so the user SEES why the call is dead
      // instead of the call bar silently vanishing behind a toast. NO FALLBACK.
      console.log(`[patch-voice] call setup FAILED: ${(e as Error).message}`);
      clearConnectTimer();
      // Error first: releasing closes the socket, and its onclose must find
      // the real reason already on screen rather than a generic "dropped".
      useVoiceStore.getState().setError((e as Error).message);
      useUiStore.getState().pushError(`voice call: ${(e as Error).message}`);
      await releaseAudio();
    }
  })();
}

/** Mute (or unmute) the open session, keeping the notification in step. */
export function setCallMuted(muted: boolean): void {
  const store = useVoiceStore.getState();
  if (!store.activeSession) return;
  store.setMuted(muted);
  void updateVoiceAudioService(store.activeSession.chatId, store.callMode, muted).catch(
    () => undefined,
  );
}

/**
 * Flip the open session between its two modes (spec/07 § Session modes). One
 * session, two policies — nothing is torn down or reopened.
 */
export function setCallMode(next: AudioSessionMode): void {
  const store = useVoiceStore.getState();
  if (!store.activeSession) return;
  if (store.callMode === next) return;
  // The two modes can be configured onto different engines (say, call on
  // Gemini Live, hands-free on local). One session runs one engine, so that
  // switch is a fresh session on the same chat — never the old engine carrying
  // on under the new mode's name.
  if (modeSwitchNeedsNewSession(voiceConfigOrNull(), store.callMode, next)) {
    const chatId = store.activeSession.chatId;
    console.log(`[patch-voice] mode ${store.callMode} → ${next} crosses engines: new session`);
    void endVoiceCall().then(() => startVoiceCall(chatId, next));
    return;
  }
  store.setCallMode(next);
  void updateVoiceAudioService(store.activeSession.chatId, next, store.callMuted).catch(
    () => undefined,
  );
  const sessionId = store.activeSession.sessionId;
  if (_ws === null || _ws.readyState !== WebSocket.OPEN || sessionId === '') return;
  try {
    _ws.send(JSON.stringify({ type: 'audio.mode', sessionId, mode: next }));
  } catch (e) {
    useVoiceStore.getState().setError(`mode change failed: ${(e as Error).message}`);
  }
}

export async function endVoiceCall(): Promise<void> {
  // Invalidate any in-flight setup so it tears itself down.
  _callGen++;
  clearConnectTimer();
  const sessionId = useVoiceStore.getState().activeSession?.sessionId;
  try {
    _ws?.send(JSON.stringify({ type: 'audio.session_end', ...(sessionId ? { sessionId } : {}) }));
  } catch {
    // The WS may already be closed; closing below is the source of truth.
    // (This is bounded send-on-shutdown — not silently dropping a real error.)
  }
  _ws?.close();
  _ws = null;
  _serviceActions?.();
  _serviceActions = null;
  await stopMicCapture().catch(() => undefined);
  await stopTtsPlayback().catch(() => undefined);
  await stopVoiceAudioService();
  useVoiceStore.getState().setActive(null);
}

/**
 * Try a failed call again: tear down what is left of it and open a fresh
 * session on the same chat, in the same mode.
 */
export async function retryVoiceCall(): Promise<void> {
  const st = useVoiceStore.getState();
  const session = st.activeSession;
  if (!session) return;
  const mode = st.callMode;
  await endVoiceCall();
  startVoiceCall(session.chatId, mode);
}

export function audioWs(): WebSocket | null {
  return _ws;
}
