// lib/pcmWav.ts — the composer live-dictation WAV encoder. This mirrors the
// host's own `pcm16ToWav` (`packages/daemon/src/audio/whisper.ts`) byte-for-
// byte on purpose (see that file's header comment) so the server's existing
// `.wav` extension/mimetype sniff (`packages/server/src/voice/note.ts`) accepts
// the upload with zero server changes — these tests pin that contract
// directly, independent of `dictation.test.ts` (which mocks `api.voiceTranscribe`
// and so never actually exercises the encoded bytes).

import { describe, it, expect } from 'vitest';
import { encodePcm16Wav, encodeBase64, mergePcmChunks } from '../src/lib/pcmWav';

describe('encodePcm16Wav', () => {
  it('writes the canonical 44-byte RIFF/WAVE/fmt/data header, matching the host encoder', () => {
    const pcm = new Int16Array([1, -1, 32767, -32768, 0]);
    const wav = encodePcm16Wav(pcm, 16000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const str = (offset: number, len: number): string =>
      String.fromCharCode(...wav.slice(offset, offset + len));

    expect(wav.byteLength).toBe(44 + pcm.length * 2);
    expect(str(0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + pcm.length * 2);
    expect(str(8, 4)).toBe('WAVE');
    expect(str(12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16); // PCM chunk size
    expect(view.getUint16(20, true)).toBe(1); // format = PCM
    expect(view.getUint16(22, true)).toBe(1); // channels = mono
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint32(28, true)).toBe(16000 * 2); // byte rate
    expect(view.getUint16(32, true)).toBe(2); // block align
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(str(36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(pcm.length * 2);
  });

  it('copies PCM samples in little-endian order with no byte-swap', () => {
    const pcm = new Int16Array([0x1234, -1]);
    const wav = encodePcm16Wav(pcm, 16000);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getInt16(44, true)).toBe(0x1234);
    expect(view.getInt16(46, true)).toBe(-1);
  });

  it('handles an empty PCM buffer (header only, zero-length data chunk)', () => {
    const wav = encodePcm16Wav(new Int16Array(0), 16000);
    expect(wav.byteLength).toBe(44);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(view.getUint32(40, true)).toBe(0);
  });
});

describe('encodeBase64', () => {
  it.each([
    [0],
    [1],
    [2],
    [3],
    [4],
    [5],
    [6],
    [16],
    [44], // exactly one WAV header's worth
    [100],
  ])('matches Node Buffer.toString("base64") for a %i-byte input', (len) => {
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 11) % 256;
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });

  it('round-trips through Buffer.from(..., "base64") back to the original bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 128, 64, 32]);
    const encoded = encodeBase64(bytes);
    const decoded = new Uint8Array(Buffer.from(encoded, 'base64'));
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
  });
});

describe('mergePcmChunks', () => {
  it('concatenates chunks in arrival order', () => {
    const merged = mergePcmChunks([
      new Int16Array([1, 2]),
      new Int16Array([3]),
      new Int16Array([4, 5, 6]),
    ]);
    expect(Array.from(merged)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('returns an empty array for no chunks', () => {
    expect(mergePcmChunks([]).length).toBe(0);
  });
});
