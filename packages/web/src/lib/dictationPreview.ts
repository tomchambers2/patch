// Live preview for composer dictation on web (spec/07 § Dictation into the
// composer).
//
// The authoritative transcript is NOT this module's business. `voiceRecorder`
// captures the clip locally and `POST /api/voice/transcribe` returns the final
// words; that path is unchanged and does not depend on anything here. All this
// does is open the host's audio session ALONGSIDE that recording, tee the
// same microphone samples into it, and hand back the `audio.transcript_partial`
// frames the host emits as it re-transcribes the growing utterance — so the
// user sees words while they are still talking.
//
// Two rules follow from that split, and both are deliberate:
//
//   - Exactly ONE microphone capture. The session is opened with
//     `withMic: false` and fed via `sendPcm`, because a second `getUserMedia`
//     for a preview could disturb the capture the transcript actually depends
//     on.
//   - A preview failure is NOT a dictation failure, so it must not abort the
//     recording — but it is not swallowed either. It is reported through
//     `onPreviewError`, which surfaces it and logs it, so a live path that has
//     quietly stopped working is visible rather than looking like "Groq just
//     didn't send any partials this time".
//
// The session is always closed with `reason: 'cancelled'`: `committed` would
// make the host run `finalizeNote` and fire an agent turn, and dictation
// never auto-sends — the composer decides that.

import { openAudioSession, type AudioSession } from './audioSession.js';

export interface DictationPreview {
  /** Feed one frame of 16 kHz PCM16 from the recording already in progress. */
  push(pcm: Int16Array): void;
  /** Close the preview session. Never commits a turn. */
  stop(): void;
}

export interface DictationPreviewCallbacks {
  /** An interim transcript of what has been said so far. */
  onPartial(text: string): void;
  /**
   * The live leg is unavailable or has broken. The recording is unaffected and
   * the final transcript will still land; this exists so the failure is seen
   * rather than read as "no partials arrived".
   */
  onPreviewError(message: string): void;
}

/** Test seam: substitute the session opener. */
export type OpenSession = typeof openAudioSession;

/**
 * Start the preview leg for an in-flight dictation. Returns synchronously; the
 * token mint and WSS open happen in the background and frames pushed before
 * the socket is up are queued and flushed once it is.
 */
export function startDictationPreview(
  chatId: string,
  callbacks: DictationPreviewCallbacks,
  open: OpenSession = openAudioSession,
): DictationPreview {
  let session: AudioSession | null = null;
  let stopped = false;
  const pending: Int16Array[] = [];

  function report(message: string): void {
    // Logged as well as surfaced: the surfaced copy is what the user sees,
    // the log is what a later diagnosis reads.
    console.error(`[patch-voice] live dictation preview: ${message}`);
    callbacks.onPreviewError(message);
  }

  void (async () => {
    try {
      const s = await open({
        chatId,
        role: 'voice-note',
        withMic: false,
        silent: true,
        callbacks: {
          onTranscriptPartial: (text: string) => {
            if (!stopped) callbacks.onPartial(text);
          },
          // A dictation session is ended by the composer's gesture, so the
          // host never produces a final for it — and if one ever arrived it
          // would not be the authoritative transcript, which comes back over
          // HTTP. Ignore it rather than racing the upload.
          onTranscriptFinal: () => {},
          onTtsStart: () => {},
          onTtsEnd: () => {},
          onBargeIn: () => {},
          onLevel: () => {},
          onError: (message: string) => {
            if (!stopped) report(message);
          },
          onClose: () => {},
        },
      });
      if (stopped) {
        s.end('cancelled');
        return;
      }
      session = s;
      for (const pcm of pending.splice(0)) s.sendPcm(pcm);
    } catch (e) {
      if (!stopped) report((e as Error).message);
    }
  })();

  return {
    push(pcm: Int16Array): void {
      if (stopped) return;
      if (session) session.sendPcm(pcm);
      else pending.push(pcm);
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      pending.length = 0;
      session?.end('cancelled');
      session = null;
    },
  };
}
