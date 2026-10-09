// monacoTheme — the embedded Monaco editor + diff editor follow the app theme
// (spec/14 § Theming, § Editor — two surfaces).
//
// Monaco shipped on its built-in `vs` (light) theme regardless of the app's
// palette: in dark mode the rail was a white slab, and the diff editor's own
// insert/delete tints were the VS defaults over that white — Todoist: "diff not
// visible on dark mode" / "editor does not folow light/dark theme".
//
// Two facts shape this module:
//
//  1. `index.css` is the single palette source of truth (spec/14 § Theming: "no
//     component hardcodes a colour"), but `monaco.editor.defineTheme` takes
//     CONCRETE colours — it cannot read `var(--…)`. So the palette is read back
//     out of the live computed style of `:root`, which is already whichever of
//     the light/dark blocks the OS selected. Nothing is duplicated in TS.
//  2. Redefining the CURRENTLY ACTIVE theme name re-applies it to every mounted
//     editor and diff editor (monaco's `defineTheme` calls `setTheme` again when
//     the name matches the active theme). So one theme name, redefined on every
//     `prefers-color-scheme` flip, gives a LIVE theme switch with no remount and
//     no per-component plumbing.
//
// NO FALLBACK: a palette token that is missing or empty throws by name. A
// silently substituted colour is exactly how the editor ended up stuck on light.

/** The app's two palettes (spec/14 § Theming — the OS is the only source). */
export type ThemeMode = 'light' | 'dark';

/** The single theme name Monaco is ever set to. Redefined per palette. */
export const MONACO_THEME = 'patch';

/** The media query that decides the palette — same one `index.css` keys on. */
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

/**
 * The `index.css` tokens Monaco needs, by role. `--bg-elevated` is the editor
 * surface because the rail sits on the same elevated surface as the chat panel;
 * `--accent`/`--danger` drive the diff because they are the palette's "added"
 * green and "removed" red in BOTH modes (the flat `--diff-add`/`--diff-del`
 * washes are sized for a 13px inline chat preview and disappear behind Monaco's
 * own per-line decorations).
 */
export const MONACO_PALETTE_TOKENS = {
  surface: '--bg-elevated',
  surfaceSoft: '--bg-soft',
  ink: '--ink',
  inkDim: '--ink-3',
  inkFaint: '--ink-faint',
  line: '--line',
  added: '--accent',
  removed: '--danger',
} as const;

// `-readonly` because MONACO_PALETTE_TOKENS is `as const`: a mapped type over it
// would inherit the readonly modifiers and `readMonacoPalette` builds its result
// key by key.
export type MonacoPalette = { -readonly [K in keyof typeof MONACO_PALETTE_TOKENS]: string };

/** Alpha of a whole added/removed LINE background, composited over the surface. */
export const DIFF_LINE_ALPHA = 0.22;
/** Alpha of the changed CHARACTERS inside such a line — deliberately stronger. */
export const DIFF_TEXT_ALPHA = 0.45;

/** Minimal shape of what `getComputedStyle()` gives us. */
export interface StyleLike {
  getPropertyValue(property: string): string;
}

/** Minimal shape of the monaco namespace this module drives. */
export interface MonacoThemeData {
  base: 'vs' | 'vs-dark';
  inherit: boolean;
  rules: never[];
  colors: Record<string, string>;
}
export interface MonacoThemeApi {
  editor: {
    defineTheme(themeName: string, themeData: MonacoThemeData): void;
    setTheme(themeName: string): void;
  };
}

/** Minimal shape of a MediaQueryList (only what the sync loop uses). */
export interface MediaQueryLike {
  matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

/** Minimal shape of `window` for the sync loop. */
export interface ThemeWindowLike {
  matchMedia(query: string): MediaQueryLike;
  getComputedStyle(element: Element): StyleLike;
  document: { documentElement: Element };
}

/** Which palette the OS has asked for. */
export function themeModeFrom(prefersDark: boolean): ThemeMode {
  return prefersDark ? 'dark' : 'light';
}

const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6 = /^#[0-9a-f]{6}$/i;

/**
 * Normalise a palette token to `#rrggbb`.
 *
 * Shorthand has to be expanded because the PRODUCTION CSS is minified: the
 * bundler rewrites `--bg-elevated: #ffffff` to `#fff`, and a custom property's
 * computed value is the token stream as authored — so what comes back out of
 * `getComputedStyle` in a built app is NOT what `index.css` says. Monaco then
 * rejects `#fff` outright ("Illegal value for token color"), which took the
 * whole light palette down in the built app while dev was fine.
 *
 * Anything that is not a 3- or 6-digit hex throws, naming the token: every
 * palette colour Monaco needs is authored as hex, so another form means the
 * palette moved and the theme needs rethinking, not patching over.
 */
export function normaliseHexToken(token: string, value: string): string {
  const short = HEX3.exec(value);
  if (short)
    return `#${short[1]!}${short[1]!}${short[2]!}${short[2]!}${short[3]!}${short[3]!}`.toLowerCase();
  if (HEX6.test(value)) return value.toLowerCase();
  throw new Error(`monaco theme: ${token} is not a hex colour — got "${value}"`);
}

/**
 * Read the palette Monaco needs off a computed style (normally `:root`'s).
 * Throws, naming every token, if any is missing — an editor themed from a
 * half-read palette is worse than an obvious failure.
 */
export function readMonacoPalette(style: StyleLike): MonacoPalette {
  const read: Partial<MonacoPalette> = {};
  const missing: string[] = [];
  for (const [role, token] of Object.entries(MONACO_PALETTE_TOKENS) as Array<
    [keyof MonacoPalette, string]
  >) {
    const value = style.getPropertyValue(token).trim();
    if (value === '') {
      missing.push(token);
      continue;
    }
    read[role] = normaliseHexToken(token, value);
  }
  if (missing.length > 0) {
    throw new Error(`monaco theme: palette token(s) missing from :root — ${missing.join(', ')}`);
  }
  return read as MonacoPalette;
}

/**
 * `#rrggbb` + alpha → `#rrggbbaa` (the form Monaco's theme colours accept), so
 * a diff tint composites over whatever surface the palette put behind it
 * instead of needing a second, pre-blended token per mode.
 */
export function withAlpha(hex: string, alpha: number): string {
  if (!HEX6.test(hex)) {
    throw new Error(`monaco theme: expected a 6-digit hex colour, got "${hex}"`);
  }
  const byte = Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex.toLowerCase()}${byte}`;
}

/**
 * Build the Monaco theme for one palette. `base` picks the matching built-in so
 * inherited syntax-token colours are legible on the surface; every colour we
 * actually care about is overridden from the app's own tokens.
 */
export function buildMonacoTheme(mode: ThemeMode, palette: MonacoPalette): MonacoThemeData {
  const addedLine = withAlpha(palette.added, DIFF_LINE_ALPHA);
  const removedLine = withAlpha(palette.removed, DIFF_LINE_ALPHA);
  return {
    base: mode === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': palette.surface,
      'editor.foreground': palette.ink,
      'editorGutter.background': palette.surface,
      'editorLineNumber.foreground': palette.inkFaint,
      'editorLineNumber.activeForeground': palette.inkDim,
      'editorWidget.background': palette.surfaceSoft,
      'editorWidget.border': palette.line,
      'editorHoverWidget.background': palette.surfaceSoft,
      'editorHoverWidget.border': palette.line,
      'editorSuggestWidget.background': palette.surfaceSoft,
      'editorIndentGuide.background1': withAlpha(palette.line, 0.7),
      'editorRuler.foreground': palette.line,
      'editorOverviewRuler.border': palette.line,
      'scrollbarSlider.background': withAlpha(palette.inkFaint, 0.35),
      'scrollbarSlider.hoverBackground': withAlpha(palette.inkFaint, 0.55),
      'scrollbarSlider.activeBackground': withAlpha(palette.inkFaint, 0.7),
      // The diff. Line washes are what make a change readable at a glance;
      // the character-level tints sit on top of them inside a changed line.
      'diffEditor.insertedLineBackground': addedLine,
      'diffEditor.insertedTextBackground': withAlpha(palette.added, DIFF_TEXT_ALPHA),
      'diffEditor.removedLineBackground': removedLine,
      'diffEditor.removedTextBackground': withAlpha(palette.removed, DIFF_TEXT_ALPHA),
      'diffEditorGutter.insertedLineBackground': addedLine,
      'diffEditorGutter.removedLineBackground': removedLine,
      'diffEditorOverview.insertedForeground': withAlpha(palette.added, 0.7),
      'diffEditorOverview.removedForeground': withAlpha(palette.removed, 0.7),
      'diffEditor.border': palette.line,
      'diffEditor.diagonalFill': withAlpha(palette.line, 0.8),
    },
  };
}

/**
 * Define the theme for `mode` and make it active. Called at boot and on every
 * subsequent palette flip; the second and later calls redefine the active theme,
 * which is what repaints already-mounted editors.
 */
export function applyMonacoTheme(
  monaco: MonacoThemeApi,
  mode: ThemeMode,
  palette: MonacoPalette,
): void {
  monaco.editor.defineTheme(MONACO_THEME, buildMonacoTheme(mode, palette));
  monaco.editor.setTheme(MONACO_THEME);
}

/**
 * Apply the app palette to Monaco now, and re-apply it whenever the OS colour
 * scheme changes. Returns a stop function (the app never stops it — Monaco is a
 * process-wide singleton — but tests do).
 */
export function startMonacoThemeSync(monaco: MonacoThemeApi, win: ThemeWindowLike): () => void {
  const media = win.matchMedia(DARK_SCHEME_QUERY);
  const apply = (): void => {
    // Re-read on every flip: the custom properties on :root have already been
    // recomputed by the time `change` fires, so this picks up the new palette.
    const palette = readMonacoPalette(win.getComputedStyle(win.document.documentElement));
    applyMonacoTheme(monaco, themeModeFrom(media.matches), palette);
  };
  apply();
  media.addEventListener('change', apply);
  return () => media.removeEventListener('change', apply);
}
