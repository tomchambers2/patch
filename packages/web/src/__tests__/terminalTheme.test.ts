// spec/14 § Theming + § Terminal: the terminal is a recessed surface that
// FOLLOWS THE OS THEME — light paper in light mode, deep warm dark in dark. It
// used to hardcode a dark palette in raw hex, so it stayed black at midday.
//
// jsdom has no stylesheet cascade, so this is locked against the source of
// `index.css` (same approach as desktopReviewStyles.test.ts): every colour in
// the terminal block must be a `--term-*` token, the token must be defined in
// all three palette blocks, and the light values must clear AA.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

/** The terminal section — from its banner comment to the next `/* ---` banner. */
function terminalSection(): string {
  const start = css.indexOf('/* ---- Terminal drawer');
  expect(start).toBeGreaterThan(-1);
  const end = css.indexOf('/* ---------- Connection diagnostics', start);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end);
}

/** The body of a top-level palette block, by its selector. */
function paletteBlock(selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `${selector} not found`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

/** Value of a custom property inside a palette block body. */
function tokenValue(block: string, name: string): string {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(block);
  expect(m, `${name} missing from palette block`).not.toBeNull();
  return (m as RegExpExecArray)[1]!.trim();
}

const TERM_TOKENS = [
  '--term-bg',
  '--term-ink',
  '--term-ink-dim',
  '--term-line',
  '--term-line-strong',
  '--term-btn-bg',
  '--term-stderr',
  '--term-caret',
  '--term-resize-tint',
];

/** WCAG relative luminance / contrast ratio. */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h;
  const chan = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

describe('terminal follows the app theme (spec/14 § Terminal, § Theming)', () => {
  it('hardcodes no colour in the terminal block — every colour is a --term-* token', () => {
    const section = terminalSection();
    // No raw hex anywhere in the terminal rules.
    expect(section).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // The specific dark values that used to be baked in are gone.
    for (const dead of [
      '#14140f',
      '#2b2b2b',
      '#8f8a7e',
      '#e8e6df',
      '#e8776b',
      '#1f1f18',
      '#4a4a3f',
    ]) {
      expect(section).not.toContain(dead);
    }
    // The resize grip's hover tint was a white wash — invisible on light paper.
    expect(section).not.toMatch(/rgb\(255 255 255/);
  });

  it('the terminal surface, ink, stderr and caret all read tokens', () => {
    const section = terminalSection();
    for (const token of [
      '--term-bg',
      '--term-ink',
      '--term-stderr',
      '--term-caret',
      '--term-line',
    ]) {
      expect(section, `${token} unused`).toContain(`var(${token})`);
    }
  });

  it('defines every --term-* token in all three palette blocks', () => {
    const light = paletteBlock(':root {');
    const darkExplicit = paletteBlock(":root[data-theme='dark'] {");
    const darkMedia = paletteBlock(':root:not([data-theme]) {');
    for (const token of TERM_TOKENS) {
      expect(light, `${token} missing from :root (light)`).toContain(token);
      expect(darkExplicit, `${token} missing from [data-theme='dark']`).toContain(token);
      expect(darkMedia, `${token} missing from the prefers-color-scheme block`).toContain(token);
    }
  });

  it('keeps the two dark blocks in sync', () => {
    const darkExplicit = paletteBlock(":root[data-theme='dark'] {");
    const darkMedia = paletteBlock(':root:not([data-theme]) {');
    for (const token of TERM_TOKENS) {
      expect(tokenValue(darkMedia, token), `${token} drifted between the dark blocks`).toBe(
        tokenValue(darkExplicit, token),
      );
    }
  });

  // Everything here is still the dark palette the tokenisation refactor locked in,
  // EXCEPT --term-stderr, which was deliberately lifted off the original #e8776b
  // because stderr carries walls of ordinary tool output, not just error lines.
  it('holds the dark terminal palette', () => {
    const dark = paletteBlock(":root[data-theme='dark'] {");
    expect(tokenValue(dark, '--term-bg')).toBe('#14140f');
    expect(tokenValue(dark, '--term-ink')).toBe('#e8e6df');
    expect(tokenValue(dark, '--term-ink-dim')).toBe('#8f8a7e');
    expect(tokenValue(dark, '--term-line')).toBe('#2b2b2b');
    expect(tokenValue(dark, '--term-line-strong')).toBe('#4a4a3f');
    expect(tokenValue(dark, '--term-btn-bg')).toBe('#1f1f18');
    expect(tokenValue(dark, '--term-stderr')).toBe('#daa59a');
    expect(tokenValue(dark, '--term-caret')).toBe('#77a966');
  });

  it('gives light mode a genuinely light terminal surface', () => {
    const light = paletteBlock(':root {');
    const bg = tokenValue(light, '--term-bg');
    // Paper, not ink: the light surface must be bright enough to read as light.
    expect(luminance(bg)).toBeGreaterThan(0.6);
    // ...and the ink on it must be dark, not the dark palette's off-white.
    expect(luminance(tokenValue(light, '--term-ink'))).toBeLessThan(0.1);
  });

  it('clears AA for terminal text in BOTH palettes', () => {
    for (const [name, selector] of [
      ['light', ':root {'],
      ['dark', ":root[data-theme='dark'] {"],
    ] as const) {
      const block = paletteBlock(selector);
      const bg = tokenValue(block, '--term-bg');
      const btn = tokenValue(block, '--term-btn-bg');
      for (const token of ['--term-ink', '--term-ink-dim', '--term-stderr', '--term-caret']) {
        const ratio = contrast(tokenValue(block, token), bg);
        expect(
          ratio,
          `${name} ${token} on --term-bg is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      // The Restart button's label sits on its own fill.
      const onBtn = contrast(tokenValue(block, '--term-ink'), btn);
      expect(
        onBtn,
        `${name} --term-ink on --term-btn-bg is ${onBtn.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  // spec/14 § Theming: the shell runs on pipes, not a pty, so git/pnpm/curl progress
  // all lands on stderr — it is a body-text stream. AA is the floor for a shouted
  // line; a wall of 12px red on the deepest dark surface needs AAA to stay readable.
  it('clears AAA for dark stderr, which carries body-text volumes', () => {
    const dark = paletteBlock(":root[data-theme='dark'] {");
    const ratio = contrast(tokenValue(dark, '--term-stderr'), tokenValue(dark, '--term-bg'));
    expect(
      ratio,
      `dark --term-stderr on --term-bg is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(7);
  });

  // ...but it must not solve contrast by going white: stderr has to stay visibly the
  // warm stream next to the neutral off-white of --term-ink, or the signal is gone.
  it('keeps dark stderr distinguishable from ordinary ink', () => {
    const dark = paletteBlock(":root[data-theme='dark'] {");
    const stderrHex = tokenValue(dark, '--term-stderr').replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(stderrHex.slice(i, i + 2), 16)) as [
      number,
      number,
      number,
    ];
    // Warm: red channel clearly ahead of both green and blue.
    expect(r - Math.max(g, b), 'dark --term-stderr is not visibly warm').toBeGreaterThanOrEqual(24);
  });
});
