// Icon consistency across every Patch surface (todo: "Icons for mobile,
// desktop, web, menu bar need to all be consistent").
//
// Patch's mark is a lowercase italic serif "p" in cream on Patch green. Mobile,
// desktop and web already carry it; the macOS menu-bar (tray) icon used to ship
// as a featureless black dot. These tests pin all four surfaces to the shared
// mark and, crucially, assert the tray template actually depicts the "p"
// letterform (bowl + hollow counter + descender) so it can never regress to a
// dot again.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, alphaOf, renderTrayTemplate, type RasterImage } from './tray-icon';

const DESKTOP = join(__dirname, '..');
const REPO = join(__dirname, '..', '..', '..');
const WEB = join(REPO, 'packages', 'web');
const MOBILE = join(REPO, 'apps', 'mobile');

const BRAND_GREEN = '#3a5e2c';
const BRAND_CREAM = '#ebe7dc';

/** Mean alpha (0..255) over a normalised rectangle of an image's alpha mask. */
function meanAlpha(img: RasterImage, x0: number, y0: number, x1: number, y1: number): number {
  const a = alphaOf(img);
  const w = img.width;
  let sum = 0;
  let count = 0;
  for (let y = Math.round(y0 * img.height); y < Math.round(y1 * img.height); y++) {
    for (let x = Math.round(x0 * w); x < Math.round(x1 * w); x++) {
      sum += a[y * w + x]!;
      count++;
    }
  }
  return sum / count;
}

// ── Menu bar (tray) template ───────────────────────────────────────────────

for (const [file, size] of [
  ['trayIconTemplate.png', 16],
  ['trayIconTemplate@2x.png', 32],
] as const) {
  test(`menu-bar ${file} is an ${size}px gray+alpha template`, () => {
    const img = decodePng(readFileSync(join(DESKTOP, 'build', file)));
    assert.equal(img.width, size);
    assert.equal(img.height, size);
    assert.equal(img.channels, 2, 'macOS template images are grayscale+alpha');
    // Template ink must be pure black — macOS recolours by alpha only.
    for (let i = 0; i < img.width * img.height; i++) {
      assert.equal(img.data[i * 2], 0, 'gray channel must be black (0)');
    }
  });

  test(`menu-bar ${file} matches the generated brand "p" glyph`, () => {
    // Single source of truth: the committed asset must equal what
    // renderTrayTemplate() produces, so `pnpm gen:tray` fully reproduces it.
    const committed = decodePng(readFileSync(join(DESKTOP, 'build', file)));
    const generated = renderTrayTemplate(size);
    assert.deepEqual(
      Array.from(alphaOf(committed)),
      Array.from(alphaOf(generated)),
      'tray icon has drifted from the generated brand mark — run `pnpm gen:tray`',
    );
  });
}

test('menu-bar icon depicts the "p" letterform, not a dot', () => {
  const img = decodePng(readFileSync(join(DESKTOP, 'build', 'trayIconTemplate@2x.png')));

  // A hollow counter inside the bowl — a filled dot would be solid ink here.
  assert.ok(
    meanAlpha(img, 0.52, 0.44, 0.66, 0.58) < 60,
    'bowl counter should be hollow (a dot would be solid)',
  );
  // A descender below the baseline in the stem column — absent from a dot.
  assert.ok(meanAlpha(img, 0.28, 0.8, 0.45, 0.92) > 120, 'stem should descend below the baseline');
  // The bowl ring carries ink on its right flank.
  assert.ok(meanAlpha(img, 0.68, 0.46, 0.8, 0.56) > 150, 'bowl ring should be inked');
  // Corners are clear.
  assert.ok(meanAlpha(img, 0, 0, 0.12, 0.12) < 10, 'top-left corner clear');
  assert.ok(meanAlpha(img, 0.88, 0.88, 1, 1) < 10, 'bottom-right corner clear');
});

// ── Web favicon ────────────────────────────────────────────────────────────

test('web favicon carries the brand "p" in brand colours', () => {
  const svg = readFileSync(join(WEB, 'public', 'favicon.svg'), 'utf8');
  assert.match(svg, /fill="#3a5e2c"/i, `favicon should use brand green ${BRAND_GREEN}`);
  assert.match(svg, /fill="#ebe7dc"/i, `favicon should use brand cream ${BRAND_CREAM}`);
  assert.match(svg, />\s*p\s*</, 'favicon should render the lowercase "p"');
  assert.match(svg, /font-style="italic"/, 'brand "p" is italic');
  assert.match(svg, /serif/, 'brand "p" is serif');
});

// ── Mobile + desktop app icon share one source ──────────────────────────────

test('mobile and desktop app icons are the exact same file', () => {
  const mobile = readFileSync(join(MOBILE, 'assets', 'icon.png'));
  const desktop = readFileSync(join(DESKTOP, 'build', 'icon.png'));
  assert.ok(mobile.equals(desktop), 'mobile and desktop must ship one identical app icon');
});

test('mobile adaptive icon is the cream "p" on brand green', () => {
  const img = decodePng(readFileSync(join(MOBILE, 'assets', 'adaptive-icon.png')));
  assert.equal(img.channels, 4);
  const n = img.width * img.height;
  let green = 0;
  let cream = 0;
  for (let i = 0; i < n; i++) {
    const r = img.data[i * 4]!;
    const g = img.data[i * 4 + 1]!;
    const b = img.data[i * 4 + 2]!;
    if (Math.abs(r - 58) < 40 && Math.abs(g - 94) < 40 && Math.abs(b - 44) < 40) green++;
    if (r > 210 && g > 205 && b > 195) cream++;
  }
  assert.ok(green / n > 0.7, `expected mostly brand green, got ${(green / n).toFixed(3)}`);
  assert.ok(cream / n > 0.02, `expected a cream "p", got ${(cream / n).toFixed(3)}`);
});
