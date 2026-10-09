// JS bridge to the PatchVoiceMic native module (Android AudioRecord PCM16 tap).
//
// The sustained voice CALL streams mic PCM up the audio WSS (spec/07 §
// End-to-end voice transport — "on mobile the PCM transport is a native module
// … expo-av alone cannot stream PCM"). This module bridges the native
// AudioRecord frames — emitted as base64 `PatchVoiceMicFrame` events — into
// per-frame PCM16 the voice-call code forwards over the WS.
//
// NO FALLBACK: if the native module is missing on Android we throw — that means
// the prebuild didn't include PatchVoiceMicModule and the call would silently
// carry no audio. On non-Android (tests, dev web) we no-op.

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

interface PatchVoiceMicModule {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  addListener: (event: string) => void;
  removeListeners: (count: number) => void;
}

interface MicFrameEvent {
  base64?: string;
  samples?: number;
  /** Set when the native read loop failed mid-stream (NO FALLBACK). */
  error?: string;
}

const MODULE_NAME = 'PatchVoiceMic';
const EVENT = 'PatchVoiceMicFrame';

function getModule(): PatchVoiceMicModule | null {
  if (Platform.OS !== 'android') return null;
  const mod = (NativeModules as Record<string, unknown>)[MODULE_NAME];
  if (!mod) {
    throw new Error(
      'PatchVoiceMic native module missing — is PatchVoiceAudioServicePackage registered and the prebuild current?',
    );
  }
  return mod as PatchVoiceMicModule;
}

// Standard base64 → bytes. RN/Hermes has no atob, and pulling in a decoder dep
// for a hot audio path is overkill; this table decode is dependency-free and
// allocates one fresh (2-byte-aligned) buffer per frame.
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = ((): Int16Array => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i++) t[B64_CHARS.charCodeAt(i)] = i;
  return t;
})();

function decodeBase64(s: string): Uint8Array {
  let len = s.length;
  // The only caller guards `if (!ev.base64) return;` before decoding, so an
  // empty string never actually reaches here — kept as a defensive guard
  // against decodeBase64 being called directly in the future.
  /* v8 ignore next */
  if (len === 0) return new Uint8Array(0);
  let pad = 0;
  if (s.charCodeAt(len - 1) === 61) pad++; // '='
  if (s.charCodeAt(len - 2) === 61) pad++;
  const outLen = ((len * 3) >> 2) - pad;
  const out = new Uint8Array(outLen);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const a = B64_LOOKUP[s.charCodeAt(i)]!;
    const b = B64_LOOKUP[s.charCodeAt(i + 1)]!;
    const c = B64_LOOKUP[s.charCodeAt(i + 2)]!;
    const d = B64_LOOKUP[s.charCodeAt(i + 3)]!;
    const chunk = (a << 18) | (b << 12) | ((c & 63) << 6) | (d & 63);
    if (o < outLen) out[o++] = (chunk >> 16) & 0xff;
    if (o < outLen) out[o++] = (chunk >> 8) & 0xff;
    if (o < outLen) out[o++] = chunk & 0xff;
  }
  return out;
}

let _sub: { remove: () => void } | null = null;

/**
 * Start capturing mic PCM16 @ 16 kHz. Each native frame is decoded to an
 * Int16Array (little-endian, matching the host's wire order) and handed to
 * `onFrame`. A mid-stream native failure calls `onError` (the caller ends the
 * call and surfaces it — NO FALLBACK). No-op on non-Android.
 */
export async function startMicCapture(
  onFrame: (pcm: Int16Array) => void,
  onError: (message: string) => void,
): Promise<void> {
  const m = getModule();
  if (!m) return;
  const emitter = new NativeEventEmitter(m as unknown as never);
  _sub = emitter.addListener(EVENT, (ev: MicFrameEvent) => {
    if (ev.error) {
      onError(ev.error);
      return;
    }
    if (!ev.base64) return;
    const bytes = decodeBase64(ev.base64);
    // `bytes` is a fresh 0-offset buffer, so this Int16Array view is 2-byte
    // aligned and spans the whole buffer — safe to forward as `.buffer`.
    const pcm = new Int16Array(bytes.buffer, 0, bytes.byteLength >>> 1);
    onFrame(pcm);
  });
  await m.start();
}

/** Stop mic capture and drop the frame subscription. Idempotent. No-op on non-Android. */
export async function stopMicCapture(): Promise<void> {
  _sub?.remove();
  _sub = null;
  const m = getModule();
  if (!m) return;
  await m.stop();
}
