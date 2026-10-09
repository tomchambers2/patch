// audioRecorder — records mic audio locally via expo-av for the composer's
// OWN dictation mic (spec/07 § "Dictation into the composer"). Mirrors the
// shape of packages/web/src/lib/voiceRecorder.ts: capture is fully local, the
// caller stops (→ clip uri) or cancels (→ discard) it, and the clip is
// uploaded ONCE to a transcribe-only endpoint.
//
// Deliberately has NO ties to voiceStore/VoiceNoteOverlay: dictation mounts no
// overlay — the composer's own draft text is the only feedback surface
// (spec/15 § Voice states). That is what separates this module from
// lib/voiceNote.ts, which backs the OTHER voice-note triggers (chat-row,
// Voice tab, Manager row) and DOES drive the overlay + auto-send a chat turn.
//
// NO FALLBACK: a denied mic permission, or `stop()` on a recording that never
// produced a usable clip, rejects rather than silently returning nothing.

import { Audio } from 'expo-av';

/** A live recording. The caller stops (→ clip uri) or cancels (→ discard). */
export interface Recording {
  /** Stop capture and return the recorded clip's local file uri. */
  stop(): Promise<string>;
  /** Discard the recording without producing a clip. */
  cancel(): void;
}

/**
 * Begin recording the mic. Resolves once capture is running. Rejects on
 * mic-permission denial or a recording-prepare failure.
 */
export async function startRecording(): Promise<Recording> {
  const perm = await Audio.requestPermissionsAsync();
  if (!perm.granted) throw new Error('mic permission denied');
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
    staysActiveInBackground: false,
    shouldDuckAndroid: true,
    playThroughEarpieceAndroid: false,
  });
  const rec = new Audio.Recording();
  await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
  await rec.startAsync();

  let stopped = false;
  return {
    async stop(): Promise<string> {
      if (stopped) throw new Error('recording already stopped');
      stopped = true;
      await rec.stopAndUnloadAsync();
      const uri = rec.getURI();
      if (!uri) throw new Error('no audio captured');
      return uri;
    },
    cancel(): void {
      if (stopped) return;
      stopped = true;
      void rec.stopAndUnloadAsync().catch(() => undefined);
    },
  };
}
