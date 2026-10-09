// PCM16 → WAV encoding for the composer's live-dictation upload (spec/07 §
// "Dictation into the composer"). Mirrors the host's own encoder
// (`packages/daemon/src/audio/whisper.ts` `pcm16ToWav`) byte-for-byte — same
// 44-byte canonical header, mono, little-endian — so the server's existing
// `.wav` auto-detection (`packages/server/src/voice/note.ts`, extension/
// mimetype sniff) accepts it with ZERO server changes.
//
// RN/Hermes has no `btoa`; base64-encoding a large PCM buffer with a decoder
// dependency is overkill for a one-shot upload, so this is a dependency-free
// table encode (mirrors `voiceMic.ts`'s dependency-free table DEcode).

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Build a canonical 44-byte-header mono PCM16 WAV file from one merged buffer. */
export function encodePcm16Wav(pcm: Int16Array, sampleRate: number): Uint8Array {
  const dataLen = pcm.length * 2;
  const buf = new Uint8Array(44 + dataLen);
  const view = new DataView(buf.buffer);
  const writeStr = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataLen, true);
  // PCM samples are already the wire's little-endian order (voiceMic.ts /
  // the host agree on LE) — copy directly, no per-sample byte-swap.
  for (let i = 0; i < pcm.length; i++) {
    view.setInt16(44 + i * 2, pcm[i]!, true);
  }
  return buf;
}

/** Standard base64 (with `=` padding), dependency-free. */
export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    const b2 = bytes[i + 2]!;
    out +=
      B64_CHARS[b0 >> 2]! +
      B64_CHARS[((b0 & 3) << 4) | (b1 >> 4)]! +
      B64_CHARS[((b1 & 15) << 2) | (b2 >> 6)]! +
      B64_CHARS[b2 & 63]!;
  }
  const rem = len - i;
  if (rem === 1) {
    const b0 = bytes[i]!;
    out += B64_CHARS[b0 >> 2]! + B64_CHARS[(b0 & 3) << 4]! + '==';
  } else if (rem === 2) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    out +=
      B64_CHARS[b0 >> 2]! +
      B64_CHARS[((b0 & 3) << 4) | (b1 >> 4)]! +
      B64_CHARS[(b1 & 15) << 2]! +
      '=';
  }
  return out;
}

/** Concatenate frames captured in arrival order into one Int16Array. */
export function mergePcmChunks(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return merged;
}
