// Menu-bar (tray) brand mark.
//
// The tray icon is the ONE surface that historically drifted from the rest of
// the brand: mobile, desktop and web all show the italic serif "p" on Patch
// green, but the macOS menu-bar icon shipped as a featureless black dot. macOS
// template images are monochrome (they get recoloured to match the menu bar),
// so we can't reuse the coloured raster — but we CAN carry the same lowercase
// "p" letterform, descender and all, which is what makes the mark recognisable.
//
// Rather than depend on an SVG rasteriser (none is available in this repo and
// it would make the build non-deterministic), the glyph is drawn analytically
// here and encoded to PNG with the Node zlib built-in. `scripts/gen-tray-icon`
// writes the committed assets from exactly this code, and the tests assert the
// committed PNGs still match — so the menu-bar mark can never silently drift
// back to a dot.

import zlib from 'node:zlib';

export interface RasterImage {
  width: number;
  height: number;
  /** channels-per-pixel, row-major, 8-bit samples. */
  data: Uint8Array;
  /** samples per pixel (2 = gray+alpha, 4 = rgba). */
  channels: number;
}

// ── Glyph ────────────────────────────────────────────────────────────────
//
// A lowercase italic "p": a slanted vertical stem that descends below the
// baseline, with an open bowl (a ring with a hollow counter) hung off its
// upper right. Everything is expressed as a fraction of the icon size so the
// same geometry renders crisply at 16px (@1x) and 32px (@2x).

const STEM_LEFT = 0.31;
const STEM_WIDTH = 0.12;
const STEM_TOP = 0.3;
const STEM_BOTTOM = 0.93; // well below the baseline → the descender
const BOWL_CX = 0.57;
const BOWL_CY = 0.515;
const BOWL_OUTER_RX = 0.24;
const BOWL_OUTER_RY = 0.21;
const BOWL_INNER_CX = 0.595;
const BOWL_INNER_RX = 0.115;
const BOWL_INNER_RY = 0.095;
const SHEAR = 0.16; // italic slant
const SHEAR_PIVOT_Y = 0.5;

function insideGlyph(fx: number, fy: number): boolean {
  // Un-shear so the geometry can be described upright.
  const x = fx - SHEAR * (SHEAR_PIVOT_Y - fy);
  const y = fy;

  const inStem = x >= STEM_LEFT && x <= STEM_LEFT + STEM_WIDTH && y >= STEM_TOP && y <= STEM_BOTTOM;

  const ox = (x - BOWL_CX) / BOWL_OUTER_RX;
  const oy = (y - BOWL_CY) / BOWL_OUTER_RY;
  const inOuter = ox * ox + oy * oy <= 1;

  const ix = (x - BOWL_INNER_CX) / BOWL_INNER_RX;
  const iy = (y - BOWL_CY) / BOWL_INNER_RY;
  const inInner = ix * ix + iy * iy <= 1;

  return inStem || (inOuter && !inInner);
}

/** Antialiased alpha-coverage mask of the "p" glyph at `size`×`size`. */
export function renderPGlyphAlpha(size: number): Uint8Array {
  const SS = 4; // supersampling per axis
  const alpha = new Uint8Array(size * size);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = (px + (sx + 0.5) / SS) / size;
          const fy = (py + (sy + 0.5) / SS) / size;
          if (insideGlyph(fx, fy)) hits++;
        }
      }
      alpha[py * size + px] = Math.round((hits / (SS * SS)) * 255);
    }
  }
  return alpha;
}

/** The gray+alpha template image (black ink, alpha = glyph coverage). */
export function renderTrayTemplate(size: number): RasterImage {
  const alpha = renderPGlyphAlpha(size);
  const data = new Uint8Array(size * size * 2);
  for (let i = 0; i < alpha.length; i++) {
    data[i * 2] = 0; // gray = black
    data[i * 2 + 1] = alpha[i]!; // alpha
  }
  return { width: size, height: size, data, channels: 2 };
}

// ── PNG codec (grayscale+alpha encode, gray+alpha / rgba decode) ───────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Encode an 8-bit grayscale+alpha (color type 4) PNG. */
export function encodeGrayAlphaPng(img: RasterImage): Buffer {
  if (img.channels !== 2) throw new Error('encodeGrayAlphaPng expects 2 channels');
  const { width, height, data } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(4, 9); // color type: gray + alpha
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter
  ihdr.writeUInt8(0, 12); // interlace

  const stride = width * 2;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type: None
    for (let x = 0; x < stride; x++) raw[y * (stride + 1) + 1 + x] = data[y * stride + x]!;
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decode an 8-bit PNG (color type 4 = gray+alpha, or 6 = rgba). */
export function decodePng(buf: Buffer): RasterImage {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  const idatParts: Buffer[] = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels) throw new Error(`unsupported color type ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  let prevRow = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const rowStart = y * (stride + 1) + 1;
    const row = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rowStart + x]!;
      const a = x >= channels ? row[x - channels]! : 0;
      const b = prevRow[x]!;
      const c = x >= channels ? prevRow[x - channels]! : 0;
      let val: number;
      switch (filter) {
        case 0:
          val = rawByte;
          break;
        case 1:
          val = rawByte + a;
          break;
        case 2:
          val = rawByte + b;
          break;
        case 3:
          val = rawByte + ((a + b) >> 1);
          break;
        case 4:
          val = rawByte + paeth(a, b, c);
          break;
        default:
          throw new Error(`unsupported filter ${filter}`);
      }
      row[x] = val & 0xff;
    }
    out.set(row, y * stride);
    prevRow = row;
  }
  return { width, height, data: out, channels };
}

/** Alpha channel of a decoded gray+alpha or rgba image. */
export function alphaOf(img: RasterImage): Uint8Array {
  const { width, height, data, channels } = img;
  const alphaIndex = channels - 1;
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) alpha[i] = data[i * channels + alphaIndex]!;
  return alpha;
}
