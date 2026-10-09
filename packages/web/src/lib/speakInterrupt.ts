// Playing an `auto-notify` interrupt on a surface that is not in a session
// (spec/07 § Speaking with no session open, spec/09 § Reaching the user).
//
// The server sends `chat.speak` instead of ringing when the account's reach is
// `auto-notify`. The surface opens a short audio session that NEVER starts the
// microphone — that is what lets a podcast keep playing underneath — asks the
// host to synthesise the message, plays it, and closes when the audio ends.
//
// There is no reply path. This is monitoring, not conversation: to answer, the
// user opens a session.

import { openAudioSession, type AudioSession, type AudioSessionDeps } from './audioSession.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { failed } from './errorCopy.js';

/** Test seam: inject the audio-session opener. */
type Opener = typeof openAudioSession;
let openImpl: Opener = openAudioSession;
export function __setSpeakOpenerForTests(o: Opener | null): void {
  openImpl = o ?? openAudioSession;
}

/**
 * Longest a single spoken interrupt may hold the session open. A host that
 * never sends `audio.tts_end` (a dead Kokoro, a dropped socket) must not leave
 * the session — and on mobile the podcast — parked indefinitely.
 */
export const SPEAK_TIMEOUT_MS = 60_000;

let active: AudioSession | null = null;

/**
 * Speak `message` on `chatId`. A session already open takes precedence and this
 * is a no-op: the host speaks a `patch_call` straight into an open session,
 * so playing it here as well would say it twice.
 */
export async function speakInterrupt(
  chatId: string,
  message: string,
  deps?: AudioSessionDeps,
): Promise<void> {
  if (useVoiceStore.getState().call !== null) return;
  // One at a time: a second interrupt while the first is still speaking replaces
  // it rather than talking over it.
  active?.end('superseded');
  active = null;
  let timer: number | undefined;
  const close = (): void => {
    if (timer !== undefined) window.clearTimeout(timer);
    active?.end('spoken');
    active = null;
  };
  try {
    const session = await openImpl({
      chatId,
      role: 'voice-call',
      withMic: false,
      deps: deps ?? {},
      callbacks: {
        onTranscriptPartial: () => {},
        onTranscriptFinal: () => {},
        onTtsStart: () => {},
        onTtsEnd: () => close(),
        onBargeIn: () => {},
        onLevel: () => {},
        onError: (m) => {
          useUiStore.getState().pushError(failed('spoken alert'), undefined, m);
          close();
        },
        onClose: () => {
          if (timer !== undefined) window.clearTimeout(timer);
          active = null;
        },
      },
    });
    active = session;
    session.speak(message);
    timer = window.setTimeout(close, SPEAK_TIMEOUT_MS);
  } catch (err) {
    active = null;
    useUiStore.getState().pushError(failed('spoken alert'), undefined, (err as Error).message);
  }
}
