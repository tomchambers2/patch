// Playing an `auto-notify` interrupt with no session open (spec/07 § Speaking
// with no session open, spec/09 § Reaching the user).
//
// The phone opens a short audio session that NEVER starts the microphone —
// that is what lets a podcast keep playing underneath — asks the host to
// synthesise the message, plays it through the same native AudioTrack sink a
// call uses, and closes when the audio ends. Transient-exclusive audio focus is
// taken for the length of the message, so the podcast pauses and then resumes
// on its own.
//
// There is no reply path. This is monitoring, not conversation.

import { Audio } from 'expo-av';
import { decodeAudio, type AudioEvent } from '@patch/wire/audio';
import { api } from '../api/rest';
import { audioWsUrl } from '../config';
import { useVoiceStore } from '../stores/voiceStore';
import { useUiStore } from '../stores/uiStore';
import { startTtsPlayback, writeTtsPcm, stopTtsPlayback } from './voiceTts';

/**
 * Longest a single spoken interrupt may hold the audio. A host that never
 * sends `audio.tts_end` must not leave the podcast paused indefinitely.
 */
export const SPEAK_TIMEOUT_MS = 60_000;

let _ws: WebSocket | null = null;
let _timer: ReturnType<typeof setTimeout> | null = null;

async function teardown(): Promise<void> {
  if (_timer) clearTimeout(_timer);
  _timer = null;
  try {
    _ws?.close();
  } catch {
    // Already closed; closing is the source of truth either way.
  }
  _ws = null;
  await stopTtsPlayback().catch(() => undefined);
  // Hand the audio back — this is what lets the paused podcast resume.
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
    playsInSilentModeIOS: true,
    staysActiveInBackground: false,
    shouldDuckAndroid: true,
    playThroughEarpieceAndroid: false,
  }).catch(() => undefined);
}

/**
 * Speak `message` on `chatId`. A session already open takes precedence and this
 * is a no-op: the host speaks a `patch_call` straight into an open session,
 * so playing it here as well would say it twice.
 */
export function speakInterrupt(chatId: string, message: string): void {
  if (useVoiceStore.getState().activeSession) return;
  void (async () => {
    // A second interrupt while the first is still speaking replaces it rather
    // than talking over it.
    await teardown();
    try {
      const me = await api.me();
      const tok = await api.voiceToken(chatId, 'voice-call');
      if (!tok.audioUrl) throw new Error('server returned empty audioUrl');
      // Take the audio for the length of the message only. No recording flag:
      // this session holds no microphone, which is the whole point.
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: false,
      });
      await startTtsPlayback();
      const ws = new WebSocket(audioWsUrl(tok.audioUrl));
      _ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onmessage = (evt: WebSocketMessageEvent): void => {
        const data = evt.data as unknown;
        if (typeof data !== 'string') {
          if (data instanceof ArrayBuffer) {
            const usable = data.byteLength - (data.byteLength % 2);
            writeTtsPcm(usable === data.byteLength ? data : data.slice(0, usable));
          }
          return;
        }
        let frame: AudioEvent;
        try {
          frame = decodeAudio(data);
        } catch {
          return;
        }
        if (frame.type === 'audio.tts_end') {
          void teardown();
        } else if (frame.type === 'audio.error') {
          useUiStore.getState().pushError(`spoken alert: ${frame.code}: ${frame.message}`);
          void teardown();
        }
      };
      ws.onopen = (): void => {
        ws.send(
          JSON.stringify({
            type: 'audio.session_start',
            sessionId: tok.sessionId,
            accountId: me.account.accountId,
            surfaceId: me.surface.surfaceId,
            surfaceKind: 'mobile',
            chatId,
            role: 'voice-call',
            token: tok.token,
            surfaceHasAec: true,
          }),
        );
        ws.send(JSON.stringify({ type: 'audio.speak', sessionId: tok.sessionId, text: message }));
      };
      ws.onclose = (): void => {
        void teardown();
      };
      _timer = setTimeout(() => void teardown(), SPEAK_TIMEOUT_MS);
    } catch (e) {
      await teardown();
      useUiStore.getState().pushError(`spoken alert failed: ${(e as Error).message}`);
    }
  })();
}
