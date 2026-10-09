// The embedded Monaco editor + diff editor must follow the app palette
// (spec/14 § Theming) — Todoist: "diff not visible on dark mode" / "editor does
// not folow light/dark theme".
//
// Two halves are locked here:
//   1. The theme-resolution logic itself (which palette, which tokens, which
//      derived diff colours, and that it re-applies on an OS scheme flip).
//   2. The DARK diff colours against the REAL shipped dark palette, parsed out
//      of `index.css` (same approach as terminalTheme.test.ts — jsdom has no
//      cascade, so the source is the only truth available here). A tint that
//      composites to within a hair of the surface is the bug being fixed, so the
//      contrast floor is asserted, not eyeballed.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DARK_SCHEME_QUERY,
  DIFF_LINE_ALPHA,
  MONACO_PALETTE_TOKENS,
  MONACO_THEME,
  applyMonacoTheme,
  buildMonacoTheme,
  readMonacoPalette,
  startMonacoThemeSync,
  themeModeFrom,
  withAlpha,
  type MediaQueryLike,
  type MonacoPalette,
  type MonacoThemeApi,
  type MonacoThemeData,
  type ThemeWindowLike,
} from '../lib/monacoTheme.js';

const LIGHT: MonacoPalette = {
  surface: '#ffffff',
  surfaceSoft: '#f4f2eb',
  ink: '#1b1813',
  inkDim: '#645c50',
  inkFaint: '#8a8175',
  line: '#ddd6c6',
  added: '#46802f',
  removed: '#b4462f',
};

const DARK: MonacoPalette = {
  surface: '#2d2b28',
  surfaceSoft: '#262421',
  ink: '#efede9',
  inkDim: '#928d84',
  inkFaint: '#6c6862',
  line: '#38352f',
  added: '#77a966',
  removed: '#cd7e70',
};

/** A computed-style stand-in over a token → value map. */
function styleOf(values: Record<string, string>): { getPropertyValue(p: string): string } {
  return { getPropertyValue: (p) => values[p] ?? '' };
}

/** Every token, mapped to its value in `palette`. */
function tokenValues(palette: MonacoPalette, pad = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [role, token] of Object.entries(MONACO_PALETTE_TOKENS)) {
    out[token] = `${pad}${palette[role as keyof MonacoPalette]}${pad}`;
  }
  return out;
}

function fakeMonaco(): MonacoThemeApi & {
  defined: Array<[string, MonacoThemeData]>;
  activated: string[];
} {
  const defined: Array<[string, MonacoThemeData]> = [];
  const activated: string[] = [];
  return {
    defined,
    activated,
    editor: {
      defineTheme: (name, data) => defined.push([name, data]),
      setTheme: (name) => activated.push(name),
    },
  };
}

describe('themeModeFrom', () => {
  it('maps the prefers-color-scheme match to a palette name', () => {
    expect(themeModeFrom(true)).toBe('dark');
    expect(themeModeFrom(false)).toBe('light');
  });
});

describe('readMonacoPalette', () => {
  it('reads every role off the computed style', () => {
    expect(readMonacoPalette(styleOf(tokenValues(DARK)))).toEqual(DARK);
  });

  it('trims the value (a computed custom property keeps its authored whitespace)', () => {
    expect(readMonacoPalette(styleOf(tokenValues(LIGHT, ' ')))).toEqual(LIGHT);
  });

  it('throws naming every missing token — no silent half-read palette', () => {
    const values = tokenValues(DARK);
    delete values['--bg-elevated'];
    values['--danger'] = '  ';
    expect(() => readMonacoPalette(styleOf(values))).toThrow(/--bg-elevated, --danger/);
  });

  // The production CSS is MINIFIED and a custom property's computed value is the
  // token stream as authored, so a built app hands back `#fff` where index.css
  // says `#ffffff`. Monaco rejects `#fff` outright ("Illegal value for token
  // color"), which took the entire light palette down in the built app while dev
  // — unminified — looked fine.
  it('expands the shorthand hex the CSS minifier produces', () => {
    const values = tokenValues(LIGHT);
    values['--bg-elevated'] = '#fff';
    expect(readMonacoPalette(styleOf(values)).surface).toBe('#ffffff');
  });

  it('throws naming the token if a palette colour is not hex at all', () => {
    const values = tokenValues(LIGHT);
    values['--accent'] = 'rgb(70 128 47)';
    expect(() => readMonacoPalette(styleOf(values))).toThrow(
      /--accent is not a hex colour — got "rgb\(70 128 47\)"/,
    );
  });
});

describe('withAlpha', () => {
  it('appends the alpha byte to a 6-digit hex', () => {
    expect(withAlpha('#77A966', 0.22)).toBe('#77a96638');
    expect(withAlpha('#000000', 1)).toBe('#000000ff');
    expect(withAlpha('#000000', 0)).toBe('#00000000');
  });

  it('throws on anything that is not a 6-digit hex (rgba()/3-digit tokens)', () => {
    expect(() => withAlpha('rgba(0,0,0,0.2)', 0.2)).toThrow(/6-digit hex/);
    expect(() => withAlpha('#fff', 0.2)).toThrow(/6-digit hex/);
  });
});

describe('buildMonacoTheme', () => {
  it('inherits the matching built-in base per palette', () => {
    expect(buildMonacoTheme('dark', DARK).base).toBe('vs-dark');
    expect(buildMonacoTheme('light', LIGHT).base).toBe('vs');
    expect(buildMonacoTheme('dark', DARK).inherit).toBe(true);
    // No token rules of our own: the base theme's syntax colours are kept.
    expect(buildMonacoTheme('dark', DARK).rules).toEqual([]);
  });

  it('paints the editor surface + ink from the palette, not a Monaco default', () => {
    const { colors } = buildMonacoTheme('dark', DARK);
    expect(colors['editor.background']).toBe(DARK.surface);
    expect(colors['editor.foreground']).toBe(DARK.ink);
    expect(colors['editorGutter.background']).toBe(DARK.surface);
    expect(colors['editorLineNumber.foreground']).toBe(DARK.inkFaint);
  });

  it('derives the diff add/remove colours from the accent + danger tokens', () => {
    const { colors } = buildMonacoTheme('dark', DARK);
    expect(colors['diffEditor.insertedLineBackground']).toBe(
      withAlpha(DARK.added, DIFF_LINE_ALPHA),
    );
    expect(colors['diffEditor.removedLineBackground']).toBe(
      withAlpha(DARK.removed, DIFF_LINE_ALPHA),
    );
    // Character-level tints sit ON TOP of the line wash, so they must be stronger.
    expect(colors['diffEditor.insertedTextBackground']).not.toBe(
      colors['diffEditor.insertedLineBackground'],
    );
    expect(colors['diffEditor.removedTextBackground']).not.toBe(
      colors['diffEditor.removedLineBackground'],
    );
    // Added and removed must never resolve to the same wash.
    expect(colors['diffEditor.insertedLineBackground']).not.toBe(
      colors['diffEditor.removedLineBackground'],
    );
  });

  it('gives light and dark different colours (the bug was one theme for both)', () => {
    expect(buildMonacoTheme('light', LIGHT).colors).not.toEqual(
      buildMonacoTheme('dark', DARK).colors,
    );
  });
});

describe('applyMonacoTheme', () => {
  it('defines the one theme name and activates it', () => {
    const monaco = fakeMonaco();
    applyMonacoTheme(monaco, 'dark', DARK);
    expect(monaco.defined).toHaveLength(1);
    expect(monaco.defined[0]![0]).toBe(MONACO_THEME);
    expect(monaco.defined[0]![1].base).toBe('vs-dark');
    expect(monaco.activated).toEqual([MONACO_THEME]);
  });
});

describe('startMonacoThemeSync', () => {
  function fakeWindow(palette: { current: MonacoPalette }, prefersDark: boolean) {
    const listeners: Array<() => void> = [];
    const media: MediaQueryLike = {
      matches: prefersDark,
      addEventListener: (_type, listener) => listeners.push(listener),
      removeEventListener: (_type, listener) => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      },
    };
    const queries: string[] = [];
    const win = {
      matchMedia: (q: string) => {
        queries.push(q);
        return media;
      },
      getComputedStyle: () => styleOf(tokenValues(palette.current)),
      document: { documentElement: {} as Element },
    } as unknown as ThemeWindowLike;
    return { win, media, listeners, queries };
  }

  it('applies the current palette immediately, keyed on prefers-color-scheme', () => {
    const monaco = fakeMonaco();
    const { win, queries } = fakeWindow({ current: DARK }, true);
    startMonacoThemeSync(monaco, win);
    expect(queries).toEqual([DARK_SCHEME_QUERY]);
    expect(monaco.defined[0]![1].base).toBe('vs-dark');
    expect(monaco.defined[0]![1].colors['editor.background']).toBe(DARK.surface);
  });

  it('re-reads the palette and redefines the theme when the OS scheme flips', () => {
    const monaco = fakeMonaco();
    const palette = { current: DARK };
    const { win, media, listeners } = fakeWindow(palette, true);
    startMonacoThemeSync(monaco, win);

    // The OS flips to light: index.css recomputes :root, so the same read now
    // yields the light palette.
    palette.current = LIGHT;
    (media as { matches: boolean }).matches = false;
    for (const l of listeners) l();

    expect(monaco.defined).toHaveLength(2);
    expect(monaco.defined[1]![1].base).toBe('vs');
    expect(monaco.defined[1]![1].colors['editor.background']).toBe(LIGHT.surface);
    // Redefining the ACTIVE theme is what repaints mounted editors, so the same
    // single name is (re)activated rather than a second theme being introduced.
    expect(monaco.activated).toEqual([MONACO_THEME, MONACO_THEME]);
  });

  it('stops listening when disposed', () => {
    const monaco = fakeMonaco();
    const { win, listeners } = fakeWindow({ current: DARK }, true);
    const stop = startMonacoThemeSync(monaco, win);
    expect(listeners).toHaveLength(1);
    stop();
    expect(listeners).toHaveLength(0);
  });

  it('lets a missing palette token throw rather than theming Monaco half-read', () => {
    const monaco = fakeMonaco();
    const win = {
      matchMedia: () => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
      getComputedStyle: () => styleOf({}),
      document: { documentElement: {} as Element },
    } as unknown as ThemeWindowLike;
    expect(() => startMonacoThemeSync(monaco, win)).toThrow(/palette token\(s\) missing/);
  });
});

// ---------------------------------------------------------------------------
// The real shipped dark palette (parsed from index.css) must produce a diff a
// human can actually see on the dark surface.
// ---------------------------------------------------------------------------

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

function paletteBlock(selector: string): string {
  const at = css.indexOf(selector);
  expect(at, `${selector} not found`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

function tokenValue(block: string, name: string): string {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(block);
  expect(m, `${name} missing from palette block`).not.toBeNull();
  return (m as RegExpExecArray)[1]!.trim();
}

/** Read a whole MonacoPalette out of one `index.css` palette block. */
function paletteFromCss(selector: string): MonacoPalette {
  const block = paletteBlock(selector);
  const read: Partial<MonacoPalette> = {};
  for (const [role, token] of Object.entries(MONACO_PALETTE_TOKENS)) {
    read[role as keyof MonacoPalette] = tokenValue(block, token);
  }
  return read as MonacoPalette;
}

type Rgb = [number, number, number];

function parseHex(hex: string): { rgb: Rgb; alpha: number } {
  const h = hex.replace('#', '');
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
  const alpha = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { rgb, alpha };
}

/** Source-over composite of `fg` (possibly `#rrggbbaa`) onto opaque `bg`. */
function composite(fg: string, bg: string): Rgb {
  const top = parseHex(fg);
  const under = parseHex(bg);
  return top.rgb.map((c, i) => Math.round(c * top.alpha + under.rgb[i]! * (1 - top.alpha))) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const chan = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }) as Rgb;
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
}

function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe("Monaco's diff is visible against the real palettes", () => {
  const cases: Array<['light' | 'dark', string]> = [
    ['light', ':root {'],
    ['dark', ":root[data-theme='dark'] {"],
  ];

  for (const [mode, selector] of cases) {
    it(`${mode}: added + removed line washes separate from the editor surface`, () => {
      const palette = paletteFromCss(selector);
      const { colors } = buildMonacoTheme(mode, palette);
      const surface = parseHex(palette.surface).rgb;
      const added = composite(colors['diffEditor.insertedLineBackground']!, palette.surface);
      const removed = composite(colors['diffEditor.removedLineBackground']!, palette.surface);
      // A wash below ~1.15:1 against the surface is what "diff not visible"
      // looked like. Both directions must clear it.
      expect(contrast(added, surface)).toBeGreaterThan(1.15);
      expect(contrast(removed, surface)).toBeGreaterThan(1.15);
      // Luminance alone can't tell add from remove (a green and a red wash of
      // the same alpha land at almost the same lightness), so the two are also
      // held apart by HUE: added must pull green away from red relative to the
      // surface, removed must pull red away from green.
      const greenBias = (c: Rgb): number => c[1] - c[0];
      expect(greenBias(added)).toBeGreaterThan(greenBias(surface) + 8);
      expect(greenBias(removed)).toBeLessThan(greenBias(surface) - 8);
    });

    it(`${mode}: the code on a changed line stays readable over the wash`, () => {
      const palette = paletteFromCss(selector);
      const { colors } = buildMonacoTheme(mode, palette);
      const ink = parseHex(palette.ink).rgb;
      for (const key of [
        'diffEditor.insertedLineBackground',
        'diffEditor.removedLineBackground',
        'diffEditor.insertedTextBackground',
        'diffEditor.removedTextBackground',
      ]) {
        const bg = composite(colors[key]!, palette.surface);
        expect(contrast(ink, bg), `${key} in ${mode}`).toBeGreaterThan(4.5);
      }
    });
  }

  it('the two dark palette blocks agree on every token Monaco reads', () => {
    const explicit = paletteFromCss(":root[data-theme='dark'] {");
    const media = paletteFromCss(':root:not([data-theme]) {');
    expect(media).toEqual(explicit);
  });
});
