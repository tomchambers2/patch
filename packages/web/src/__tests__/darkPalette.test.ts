// spec/14 § Theming — the DARK palette, locked against the source of
// `index.css`. jsdom has no cascade for custom properties, so the source is the
// only truth available here (same approach as terminalTheme.test.ts; and for the
// reasons scrollbarStyles.test.ts documents, this matches on the raw source
// rather than a brace-parsing helper).
//
// Three things are guarded, all of which have already gone wrong or nearly did:
//
//  1. The dark palette is declared TWICE — `:root[data-theme='dark']` (a
//     defensive mirror, never set at runtime) and the
//     `prefers-color-scheme: dark` media block (the live one). Editing one and
//     not the other is the classic bug in this file, and the existing guards
//     cover only the `--term-*` set and the tokens Monaco reads. This covers
//     EVERY token in the block, in both directions.
//  2. The accent + state hues are deliberately MUTED against the warm-charcoal
//     ground rather than brightened onto it. That headroom came out of
//     saturation, not contrast, so the contrast floors are the thing a future
//     "just take it down a bit more" must not be able to cross silently.
//  3. The state hues have to stay mutually distinguishable at the 8-9px the
//     sidebar dots render at, and `--permission` has to stay the one cool hue
//     in a warm palette. Desaturation is exactly the move that quietly collapses
//     both.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

/** The body of a top-level palette block, by its selector. */
function paletteBlock(selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `${selector} not found`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

/** Every `--token: value;` declaration in a block body, comments stripped. */
function tokensOf(block: string): Map<string, string> {
  const body = block.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

const LIGHT = tokensOf(paletteBlock(':root {'));
const DARK_EXPLICIT = tokensOf(paletteBlock(":root[data-theme='dark'] {"));
const DARK_MEDIA = tokensOf(paletteBlock(':root:not([data-theme]) {'));

describe('the two dark palette blocks are one palette', () => {
  it('declares exactly the same set of tokens in both', () => {
    expect([...DARK_MEDIA.keys()].sort()).toEqual([...DARK_EXPLICIT.keys()].sort());
  });

  it('gives every token the same value in both', () => {
    for (const [token, value] of DARK_EXPLICIT) {
      expect(DARK_MEDIA.get(token), `${token} drifted between the two dark blocks`).toBe(value);
    }
  });

  // A COLOUR that exists in light but not dark falls through to the light value
  // — a bright surface or a black-on-black label for everyone on dark only. The
  // scheme-independent scalars in `:root` (radii, --text-min, --tap-min,
  // --scrollbar-w) are deliberately not repeated.
  it('gives every light colour a dark value', () => {
    for (const [token, value] of LIGHT) {
      if (!/^(#|rgba?\(|var\()/.test(value)) continue;
      expect(DARK_EXPLICIT.has(token), `${token} has no dark value`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Contrast
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
  const h = hex.trim().replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  expect(full, `${hex} is not a hex colour`).toMatch(/^[0-9a-fA-F]{6}$/);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
}

function luminance(hex: string): number {
  const chan = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }) as Rgb;
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function dark(token: string): string {
  const v = DARK_EXPLICIT.get(token);
  expect(v, `${token} missing from the dark palette`).toBeDefined();
  return v as string;
}

const AA = 4.5;

// Every surface an accent or state hue is painted on: the app frame, the
// sidebar/panels, the soft inset rows, and the (lightest) content panel — which
// is the worst case in dark, because the palette inverts its elevation.
const SURFACES = ['--bg-app', '--bg-panel', '--bg-soft', '--bg-elevated'];

// The hues that carry meaning: they are drawn as text, icons, dots and rules.
const STATE_HUES = [
  '--accent',
  '--accent-strong',
  '--running',
  '--waiting',
  '--permission',
  '--voice',
  '--danger',
  '--git-pending',
  '--leaf',
];

describe('dark accent + state hues clear AA on every dark surface', () => {
  for (const token of STATE_HUES) {
    it(`${token} clears ${AA}:1 on all four surfaces`, () => {
      for (const surface of SURFACES) {
        const ratio = contrast(dark(token), dark(surface));
        expect(ratio, `${token} on ${surface} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
      }
    });
  }

  // The read tick lives in the sidebar, on --bg-panel.
  it('--read clears AA on the sidebar surface', () => {
    const ratio = contrast(dark('--read'), dark('--bg-panel'));
    expect(ratio, `--read on --bg-panel is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
  });
});

describe('dark fills stay legible under --on-accent', () => {
  // --on-accent is the label colour on ANY accent/state fill (spec/14 §
  // Theming), so dimming a fill has to be checked against it, not just against
  // the surface behind the fill. If a dim breaks this, --on-accent moves — the
  // dim does not get backed out.
  for (const token of ['--accent', '--accent-strong', '--waiting', '--voice', '--danger']) {
    it(`--on-accent clears ${AA}:1 on a ${token} fill`, () => {
      const ratio = contrast(dark('--on-accent'), dark(token));
      expect(ratio, `--on-accent on ${token} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
    });
  }

  // The chat header's "waiting on you" pill: --permission text on its own wash.
  it('--permission clears AA on --permission-tint', () => {
    const ratio = contrast(dark('--permission'), dark('--permission-tint'));
    expect(
      ratio,
      `--permission on --permission-tint is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(AA);
  });
});

// --term-stderr's AAA floor is asserted in terminalTheme.test.ts alongside the
// rest of the terminal sub-palette; it is not repeated here.

// ---------------------------------------------------------------------------
// Distinguishability at badge size
// ---------------------------------------------------------------------------

/** CIE L*a*b*, D65. */
function lab(hex: string): Rgb {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }) as Rgb;
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

// The five states the sidebar draws as an 8-9px dot. Nothing but colour tells
// two dots apart at that size, so the palette has to hold them apart itself.
const DOTS = ['--running', '--waiting', '--permission', '--voice', '--read'];

// Well clear of the ~2.3 "just noticeable" threshold, and of the ~10 at which
// two colours read as the same family. The tightest pair in the palette this
// replaced sat at 28.
const MIN_DELTA_E = 22;

describe('sidebar status dots stay mutually distinguishable', () => {
  for (let i = 0; i < DOTS.length; i += 1) {
    for (let j = i + 1; j < DOTS.length; j += 1) {
      const [a, b] = [DOTS[i] as string, DOTS[j] as string];
      it(`${a} is distinguishable from ${b}`, () => {
        const d = deltaE(dark(a), dark(b));
        expect(d, `${a} vs ${b} is ΔE ${d.toFixed(1)}`).toBeGreaterThan(MIN_DELTA_E);
      });
    }
  }

  // spec/14 § Status badges: --permission is the ONE cool hue in a warm palette,
  // and that is what makes it unmistakable at badge size. Muting it must not
  // walk it back toward neutral — or, worse, toward the red end.
  it('--permission stays clearly cool, and clearly not red', () => {
    const [r, g, b] = rgb(dark('--permission'));
    expect(b - r, '--permission is no longer blue-dominant').toBeGreaterThanOrEqual(30);
    expect(b - g, '--permission is no longer blue-dominant').toBeGreaterThanOrEqual(30);
    expect(r).toBeLessThan(b);
  });

  // ...and the warm hues must not all collapse into one dusty brown as the
  // chroma comes down: green has to stay green, amber amber, terracotta red.
  it('keeps the warm hues on their own sides', () => {
    const green = rgb(dark('--running'));
    expect(green[1] - green[0], '--running is no longer green-dominant').toBeGreaterThanOrEqual(30);
    const amber = rgb(dark('--waiting'));
    expect(amber[0] - amber[2], '--waiting has lost its warmth').toBeGreaterThanOrEqual(60);
    expect(amber[1], '--waiting has gone red rather than amber').toBeGreaterThan(amber[2]);
    const voice = rgb(dark('--voice'));
    expect(voice[0] - voice[1], '--voice is no longer red-dominant').toBeGreaterThanOrEqual(40);
  });
});

// ---------------------------------------------------------------------------
// Muted, not brightened
// ---------------------------------------------------------------------------

/** HSL saturation, 0-100. */
function saturation(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => v / 255) as Rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 2;
  return (100 * (max - min)) / (l > 0.5 ? 2 - max - min : max + min);
}

describe('the dark palette is muted, not brightened', () => {
  // The greens are painted as SOLID FILLS across roughly twenty call sites —
  // buttons, badges, chat bubbles — so they are the single largest block of
  // colour in the app, and a saturated green there reads as a neon slab against
  // near-black. They carry the tightest cap.
  it('holds the fill greens well below the neon line', () => {
    for (const token of ['--accent', '--accent-strong', '--running', '--leaf', '--term-caret']) {
      const s = saturation(dark(token));
      expect(s, `${token} is ${s.toFixed(1)}% saturated`).toBeLessThanOrEqual(36);
    }
  });

  // The rest are dots, rules and short runs of text rather than fills, so they
  // can carry a little more chroma — but not the near-neon they had. Nothing may
  // push these back up without also having to change these numbers and say why.
  it('holds every other accent + state hue below the neon line', () => {
    for (const token of [...STATE_HUES, '--term-stderr', '--git-pending']) {
      const s = saturation(dark(token));
      expect(s, `${token} is ${s.toFixed(1)}% saturated`).toBeLessThanOrEqual(50);
    }
  });

  // ...but it is still colour, not grey. Muting to the point of neutrality
  // would pass every contrast and separation check above.
  it('keeps the accent recognisably the brand leaf green', () => {
    const s = saturation(dark('--accent'));
    expect(s, `--accent is ${s.toFixed(1)}% saturated`).toBeGreaterThanOrEqual(20);
    const [r, g, b] = rgb(dark('--accent'));
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
  });
});
