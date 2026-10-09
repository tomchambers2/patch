// Pixel dimensions straight out of an image's header bytes (spec/04 § History
// — blobs). Patch needs these for one reason: a transcript reserves the exact
// box an image will occupy BEFORE fetching it, so a picture arriving late
// cannot shove everything below it down the page while the reader is looking.
//
// Header-only by design — never decode. The four formats below put their size
// in the first few dozen bytes, so this reads a slice, not a megabyte. Any
// format we do not recognise returns `undefined` and the surface falls back to
// its own layout rules; guessing a size would be worse than not having one.

/** Width and height in pixels, as the file's own header states them. */
export type ImageSize = { width: number; height: number };

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * PNG: an 8-byte signature, then the IHDR chunk, whose first two fields are
 * width and height as big-endian uint32 at a fixed offset.
 */
function pngSize(b: Buffer): ImageSize | undefined {
  if (b.length < 24 || !b.subarray(0, 8).equals(PNG_MAGIC)) return undefined;
  if (b.subarray(12, 16).toString('ascii') !== 'IHDR') return undefined;
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * GIF: `GIF87a`/`GIF89a`, then the logical screen width and height as
 * little-endian uint16.
 */
function gifSize(b: Buffer): ImageSize | undefined {
  if (b.length < 10) return undefined;
  const magic = b.subarray(0, 6).toString('ascii');
  if (magic !== 'GIF87a' && magic !== 'GIF89a') return undefined;
  const width = b.readUInt16LE(6);
  const height = b.readUInt16LE(8);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * JPEG: a chain of segments. Walk them until one of the SOFn frame headers
 * (which carry the dimensions) turns up; skip the rest by their own length.
 * SOF4 (0xC4), SOF8 (0xC8) and SOFC (0xCC) are NOT frame headers — they are
 * Huffman/arithmetic tables that happen to sit in the same numeric range.
 */
function jpegSize(b: Buffer): ImageSize | undefined {
  if (b.length < 4 || b.readUInt16BE(0) !== 0xffd8) return undefined;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b[i + 1]!;
    // Standalone markers: padding (0xFF), and RSTn/SOI/EOI, which carry no length.
    if (marker === 0xff || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      const height = b.readUInt16BE(i + 5);
      const width = b.readUInt16BE(i + 7);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    const segmentLength = b.readUInt16BE(i + 2);
    if (segmentLength < 2) return undefined;
    i += 2 + segmentLength;
  }
  return undefined;
}

/**
 * WebP: a RIFF container with three different chunk layouts, each storing its
 * size differently. Lossy (`VP8 `) uses two 14-bit values; lossless (`VP8L`)
 * packs width-1 and height-1 into 14 bits each across a 32-bit field; extended
 * (`VP8X`) uses two 24-bit little-endian values, also minus one.
 */
function webpSize(b: Buffer): ImageSize | undefined {
  if (b.length < 30) return undefined;
  if (b.subarray(0, 4).toString('ascii') !== 'RIFF') return undefined;
  if (b.subarray(8, 12).toString('ascii') !== 'WEBP') return undefined;
  const chunk = b.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X') {
    const width = 1 + (b.readUIntLE(24, 3) & 0xffffff);
    const height = 1 + (b.readUIntLE(27, 3) & 0xffffff);
    return { width, height };
  }
  if (chunk === 'VP8 ') {
    const width = b.readUInt16LE(26) & 0x3fff;
    const height = b.readUInt16LE(28) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return undefined;
    const bits = b.readUInt32LE(21);
    const width = 1 + (bits & 0x3fff);
    const height = 1 + ((bits >> 14) & 0x3fff);
    return { width, height };
  }
  return undefined;
}

/**
 * The image's pixel size, or `undefined` for bytes that are not an image we
 * can read a header from. Never throws: a truncated or corrupt header is an
 * image without a known size, not a failed chat open.
 */
export function imageSize(bytes: Buffer): ImageSize | undefined {
  try {
    return pngSize(bytes) ?? jpegSize(bytes) ?? gifSize(bytes) ?? webpSize(bytes);
  } catch {
    return undefined;
  }
}
