// The Android cold-start splash (Todoist: "Patch startup screen has edges cut
// off"). Android 12+'s SplashScreen API masks the splash icon to a circle
// 192dp across, centred in a 288dp canvas, whatever shape the image is. The
// logo is the full-bleed adaptive-icon square, so any of it further than 96dp
// from the centre — its corners first — is cut off.
//
// Two halves, because the config is not what ships: `expo prebuild` renders
// `imageWidth` into the committed `splashscreen_logo.png` drawables, and it is
// those the APK carries. So the config must fit the circle AND every committed
// drawable must actually have been rendered from it.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, it, expect } from 'vitest';
import config from '../app.config';

const CANVAS_DP = 288;
const MASK_RADIUS_DP = 96;
const RES = join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');

function splashImageWidth(): number {
  const entry = (config.plugins ?? []).find(
    (p) => Array.isArray(p) && p[0] === 'expo-splash-screen',
  ) as [string, { imageWidth: number }] | undefined;
  if (!entry) throw new Error('app.config has no expo-splash-screen plugin entry');
  return entry[1].imageWidth;
}

/** Decode an 8-bit, non-interlaced RGBA PNG — all prebuild writes here. */
function decodeRgba(file: string): { width: number; height: number; px: Uint8Array } {
  const buf = readFileSync(file);
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colour, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (depth !== 8 || colour !== 6 || interlace !== 0) {
        throw new Error(`${file}: not an 8-bit non-interlaced RGBA PNG`);
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    for (let x = 0; x < stride; x++) {
      const cur = raw[y * (stride + 1) + 1 + x]!;
      const a = x >= 4 ? px[y * stride + x - 4]! : 0;
      const b = y > 0 ? px[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4]! : 0;
      let v: number;
      if (filter === 0) v = cur;
      else if (filter === 1) v = cur + a;
      else if (filter === 2) v = cur + b;
      else if (filter === 3) v = cur + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, px };
}

/** The logo's extent, in dp, as painted over the flat background. */
function logoExtent(file: string): { maxRadiusDp: number; widthDp: number } {
  const { width, height, px } = decodeRgba(file);
  const dpPerPx = CANVAS_DP / width;
  const bg = px.subarray(0, 4);
  let maxRadius = 0;
  let minX = width;
  let maxX = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let diff = 0;
      for (let k = 0; k < 4; k++) diff += Math.abs(px[i + k]! - bg[k]!);
      if (diff <= 40) continue;
      maxRadius = Math.max(maxRadius, Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2));
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
  }
  return { maxRadiusDp: maxRadius * dpPerPx, widthDp: (maxX - minX + 1) * dpPerPx };
}

const drawables = readdirSync(RES)
  .filter((d) => d.startsWith('drawable-'))
  .flatMap((d) =>
    readdirSync(join(RES, d))
      .filter((f) => f === 'splashscreen_logo.png')
      .map((f) => join(d, f)),
  );

describe('Android cold-start splash fits the SplashScreen mask', () => {
  it('the configured logo size keeps its corners inside the 192dp circle', () => {
    const half = splashImageWidth() / 2;
    expect(Math.hypot(half, half)).toBeLessThanOrEqual(MASK_RADIUS_DP);
  });

  it('there is a committed splash drawable for every density', () => {
    expect(drawables.length).toBeGreaterThanOrEqual(5);
  });

  it.each(drawables)('%s was rendered from that size and fits the circle', (file) => {
    const { maxRadiusDp, widthDp } = logoExtent(join(RES, file));
    expect(maxRadiusDp).toBeLessThanOrEqual(MASK_RADIUS_DP);
    expect(Math.abs(widthDp - splashImageWidth())).toBeLessThanOrEqual(2);
  });
});
