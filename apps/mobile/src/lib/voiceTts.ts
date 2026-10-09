// JS bridge to the PatchVoiceTts native module (Android AudioTrack PCM16 sink).
//
// The sustained voice CALL streams the host's Kokoro TTS reply DOWN the audio
// WSS as `audio.tts_chunk` PCM16 @ 24 kHz mono binary frames (spec/07 §
// End-to-end voice transport). expo-av's Sound plays a whole asset, not an
// append-as-you-go PCM ring, so hearing the reply needs a native AudioTrack in
// streaming mode. This module bridges the received PCM (as base64) into that
// native track so the user actually HEARS the agent.
//
// NO FALLBACK: if the native module is missing on Android we throw — that means
// the prebuild didn't include PatchVoiceTtsModule and the call would silently
// carry no audio back. On non-Android (tests, dev web) we no-op.

import { NativeModules, Platform } from 'react-native';

interface PatchVoiceTtsModule {
  start: () => Promise<void>;
  write: (base64: string) => Promise<void>;
  flush: () => Promise<void>;
  stop: () => Promise<void>;
}

const MODULE_NAME = 'PatchVoiceTts';

function getModule(): PatchVoiceTtsModule | null {
  if (Platform.OS !== 'android') return null;
  const mod = (NativeModules as Record<string, unknown>)[MODULE_NAME];
  if (!mod) {
    throw new Error(
      'PatchVoiceTts native module missing — is PatchVoiceAudioServicePackage registered and the prebuild current?',
    );
  }
  return mod as PatchVoiceTtsModule;
}

// Standard bytes → base64. RN/Hermes has no btoa, and pulling in a codec dep for
// a hot audio path is overkill; this table encode is dependency-free and mirrors
// the decoder in voiceMic.ts.
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      B64_CHARS[(n >> 18) & 63]! +
      B64_CHARS[(n >> 12) & 63]! +
      B64_CHARS[(n >> 6) & 63]! +
      B64_CHARS[n & 63]!;
  }
  const rem = len - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += B64_CHARS[(n >> 18) & 63]! + B64_CHARS[(n >> 12) & 63]! + '==';
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out +=
      B64_CHARS[(n >> 18) & 63]! + B64_CHARS[(n >> 12) & 63]! + B64_CHARS[(n >> 6) & 63]! + '=';
  }
  return out;
}

/**
 * Start the AudioTrack sink. Resolves once playback is live; rejects if the
 * track can't initialise (the caller ends the call and surfaces it — NO
 * FALLBACK). No-op on non-Android.
 */
export async function startTtsPlayback(): Promise<void> {
  const m = getModule();
  if (!m) return;
  await m.start();
}

/**
 * Enqueue one TTS PCM16 chunk (24 kHz mono, little-endian) for playback. Fire
 * and forget from the WS message handler — the native writer thread drains the
 * queue so the RN bridge never blocks. No-op on non-Android.
 */
export function writeTtsPcm(pcm: ArrayBuffer): void {
  const m = getModule();
  if (!m) return;
  const bytes = new Uint8Array(pcm);
  void m.write(encodeBase64(bytes));
}

/** Barge-in: drop queued + in-flight TTS audio immediately. No-op on non-Android. */
export async function flushTtsPlayback(): Promise<void> {
  const m = getModule();
  if (!m) return;
  await m.flush();
}

/** Stop playback and release the track. Idempotent. No-op on non-Android. */
export async function stopTtsPlayback(): Promise<void> {
  const m = getModule();
  if (!m) return;
  await m.stop();
}
