// Reading an image's pixel size out of its header, so a transcript can
// reserve the right box before the picture arrives (spec/04 § History —
// blobs). Every format here is built byte by byte from its own spec, so a
// wrong offset fails rather than agreeing with a wrong implementation.

import { describe, it, expect } from 'vitest';
import { imageSize } from '../src/imageSize.js';

/** A real, complete 1x1 PNG. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(10);
  b.write('GIF89a', 0, 'ascii');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

/**
 * A JPEG as a chain of segments: SOI, then each of `before` as a segment with
 * that marker, then an SOF0 frame header carrying the size.
 */
function jpeg(width: number, height: number, before: number[] = []): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  for (const marker of before) {
    const payload = Buffer.alloc(8, 0x5a);
    const seg = Buffer.alloc(4 + payload.length);
    seg.writeUInt8(0xff, 0);
    seg.writeUInt8(marker, 1);
    seg.writeUInt16BE(2 + payload.length, 2);
    payload.copy(seg, 4);
    parts.push(seg);
  }
  const sof = Buffer.alloc(11);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(0xc0, 1);
  sof.writeUInt16BE(9, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat(parts.concat([sof, Buffer.alloc(16, 0)]));
}

function webpVp8x(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(22, 4);
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

function webpVp8l(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  b.write('VP8L', 12, 'ascii');
  b.writeUInt8(0x2f, 20);
  b.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  return b;
}

describe('imageSize', () => {
  it('reads a real PNG', () => {
    expect(imageSize(PNG_1X1)).toEqual({ width: 1, height: 1 });
  });

  it('reads each format it claims to support', () => {
    expect(imageSize(png(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(imageSize(gif(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageSize(jpeg(1176, 1568))).toEqual({ width: 1176, height: 1568 });
    expect(imageSize(webpVp8x(4000, 3000))).toEqual({ width: 4000, height: 3000 });
    expect(imageSize(webpVp8l(300, 200))).toEqual({ width: 300, height: 200 });
  });

  it('walks past JPEG segments that precede the frame header', () => {
    // APP0 (JFIF) and a comment, the usual lead-in on a real file.
    expect(imageSize(jpeg(800, 600, [0xe0, 0xfe]))).toEqual({ width: 800, height: 600 });
  });

  it('does not mistake a JPEG Huffman table for a frame header', () => {
    // 0xC4/0xC8/0xCC sit inside the SOFn numeric range but are tables, not
    // frames. Reading one as a frame yields garbage dimensions, silently.
    expect(imageSize(jpeg(321, 123, [0xc4, 0xc8, 0xcc]))).toEqual({ width: 321, height: 123 });
  });

  it('returns undefined rather than guessing, for anything it cannot read', () => {
    expect(imageSize(Buffer.from('not an image at all'))).toBeUndefined();
    expect(imageSize(Buffer.alloc(0))).toBeUndefined();
    expect(imageSize(PNG_1X1.subarray(0, 10))).toBeUndefined();
    // A PNG signature with a zero width is corrupt, not a 0-wide image.
    expect(imageSize(png(0, 50))).toBeUndefined();
    // RIFF, but not a WebP.
    const wav = Buffer.alloc(30);
    wav.write('RIFF', 0, 'ascii');
    wav.write('WAVE', 8, 'ascii');
    expect(imageSize(wav)).toBeUndefined();
  });

  it('never throws on a truncated header mid-parse', () => {
    const full = jpeg(640, 480, [0xe0]);
    for (let n = 0; n < full.length; n++) {
      expect(() => imageSize(full.subarray(0, n))).not.toThrow();
    }
  });
});
