// Dark / night mode (spec/15 § Dark mode). The app ships a warm dark
// translation of the leaf/cream identity and follows the OS colour scheme via
// useTheme(). These guard the two things that make dark mode correct rather
// than half-done: the dark palette is COMPLETE (no token silently missing, so a
// screen can never fall back to an undefined colour) and DISTINCT from light,
// and the resolver/hook actually swaps palette with the OS scheme.

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { lightColors, darkColors, resolveTheme, useTheme } from '../src/lib/theme';
// The vitest config aliases 'react-native' to this stub, so this is the exact
// module theme.ts's useColorScheme() reads from — driving it here IS mocking
// the OS colour scheme.
import { __setColorScheme } from './stubs/react-native';

afterEach(() => {
  // Leave the shared stub back on its default so ordering can't leak.
  __setColorScheme('light');
});

describe('dark palette completeness', () => {
  it('defines every token the light palette defines — no missing colour', () => {
    expect(Object.keys(darkColors).sort()).toEqual(Object.keys(lightColors).sort());
    for (const key of Object.keys(lightColors) as Array<keyof typeof lightColors>) {
      expect(typeof darkColors[key]).toBe('string');
      expect(darkColors[key].length).toBeGreaterThan(0);
    }
  });

  it('is a genuine dark translation, not the light palette — every token differs', () => {
    for (const key of Object.keys(lightColors) as Array<keyof typeof lightColors>) {
      expect(darkColors[key]).not.toBe(lightColors[key]);
    }
  });
});

describe('resolveTheme — scheme → palette', () => {
  it("returns the dark palette for 'dark'", () => {
    expect(resolveTheme('dark')).toBe(darkColors);
  });
  it("returns the light palette for 'light'", () => {
    expect(resolveTheme('light')).toBe(lightColors);
  });
  it('defaults to light when the OS scheme is unknown (null / undefined)', () => {
    expect(resolveTheme(null)).toBe(lightColors);
    expect(resolveTheme(undefined)).toBe(lightColors);
  });
});

describe('useTheme — follows the OS colour scheme', () => {
  it("returns the dark palette when useColorScheme is 'dark'", () => {
    __setColorScheme('dark');
    expect(useTheme()).toBe(darkColors);
    expect(useTheme().paper).toBe(darkColors.paper);
  });

  it("returns the light palette when useColorScheme is 'light'", () => {
    __setColorScheme('light');
    expect(useTheme()).toBe(lightColors);
    expect(useTheme().paper).toBe(lightColors.paper);
  });
});

// Both palettes say they are "kept in sync with the web palette in
// packages/web/src/index.css". The two are one brand, and the phone reading as
// a different, harsher app than the desktop (a darker, more saturated green on
// a browner paper) is exactly the drift this seam exists to stop: every token
// that names the same colour on both surfaces is locked, in BOTH schemes.
describe('palette parity with web', () => {
  const css = readFileSync(
    resolve(import.meta.dirname, '../../../packages/web/src/index.css'),
    'utf8',
  );

  /** A custom property's value inside one CSS block of index.css. */
  function webToken(blockStart: string, name: string): string {
    const at = css.indexOf(blockStart);
    expect(at, `${blockStart} moved or was renamed`).toBeGreaterThan(-1);
    const block = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
    const m = new RegExp(`${name}:\\s*([^;]+);`).exec(block);
    expect(m, `${name} missing from ${blockStart}`).not.toBeNull();
    return (m as RegExpExecArray)[1]!.trim();
  }

  // Tokens that are the same colour on both surfaces in both schemes.
  const SHARED: Array<[keyof typeof lightColors, string]> = [
    ['paper', '--bg-app'],
    ['leaf', '--accent'],
    ['leafSoft', '--accent-strong'],
    ['accentSoft', '--accent-soft'],
    ['accentTint', '--accent-tint'],
    ['amber', '--waiting'],
    ['waiting', '--waiting'],
    ['waitingTint', '--waiting-tint'],
    ['red', '--danger'],
    ['divider', '--line'],
    ['lineSoft', '--line-soft'],
    ['ink', '--ink'],
    ['ink2', '--ink-2'],
    ['ink3', '--ink-3'],
    ['inkFaint', '--ink-faint'],
    ['bgElevated', '--bg-elevated'],
    ['diffAdd', '--diff-add'],
    ['diffDel', '--diff-del'],
    ['onAccent', '--on-accent'],
  ];
  // Light only: a card is white like desktop's panels, and the soft ground
  // matches. Dark keeps its own raised step (mobile has no four-step elevation).
  const LIGHT_ONLY: Array<[keyof typeof lightColors, string]> = [
    ['paperRaised', '--bg-elevated'],
    ['bgSoft', '--bg-soft'],
  ];

  for (const [mobile, web] of [...SHARED, ...LIGHT_ONLY]) {
    it(`light ${mobile} matches web's ${web}`, () => {
      expect(lightColors[mobile]).toBe(webToken(':root {', web));
    });
  }
  for (const [mobile, web] of SHARED) {
    it(`dark ${mobile} matches web's ${web}`, () => {
      expect(darkColors[mobile]).toBe(webToken(":root[data-theme='dark'] {", web));
    });
  }
});
