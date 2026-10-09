// Visual system mirrors the desktop app (spec/14 § Visual system, spec/15 §
// Visual language). Warm paper ground, white cards and the leaf-green accent in
// LIGHT; a warm dark translation of the same brand in DARK. Both palettes are
// paired token-for-token with packages/web/src/index.css (theme.test.ts).
// Components read the ACTIVE palette via useTheme() (which follows the OS
// colour scheme) rather than importing a static object — so the same screen
// renders correctly in either scheme. Fonts / type / radii / space are
// scheme-independent and stay plain exports.

import { useColorScheme, type ColorSchemeName } from 'react-native';

// The token set. Every screen's colour comes from one of these names; the light
// and dark palettes below both implement the full shape so a screen can swap
// palette without a missing token.
export const lightColors = {
  // Surfaces: the app ground is desktop's warm paper (--bg-app) and a raised
  // card is white, as desktop's panels and cards are (--bg-elevated).
  paper: '#f2f0ea',
  paperRaised: '#ffffff',
  ink: '#1b1813',
  ink2: '#423b32',
  ink3: '#645c50',
  inkFaint: '#8a8175',
  divider: '#ddd6c6',
  leaf: '#46802f',
  leafSoft: '#356026',
  amber: '#c46a12',
  red: '#b4462f',
  shade: 'rgba(20, 18, 14, 0.86)',
  // Group 22 design tokens (mobile cards layout):
  accentTint: '#e7f0dd',
  accentSoft: '#cfddc1',
  lineSoft: '#e8e2d4',
  bgSoft: '#f4f2eb',
  bgElevated: '#ffffff',
  waiting: '#c46a12',
  waitingTint: '#ecc99a',
  diffAdd: '#e6efde',
  diffAddInk: '#2f5520',
  diffDel: '#f1ddd2',
  diffDelInk: '#7a1f1f',
  // Text/icon ON a solid fill (leaf, red, amber, ink2 chip) — web's --on-accent.
  onAccent: '#ffffff',
  // A hairline / code-chip ground drawn ON a solid accent fill (the user bubble).
  onAccentLine: 'rgba(255, 255, 255, 0.4)',
  codeOnAccent: 'rgba(255, 255, 255, 0.18)',
  // Markdown tables in the transcript (spec/14 § Theming → Tables): the grid
  // line, the header row's fill, and every other body row's fill. Measured
  // against `paper`, the ground an assistant reply sits on.
  tableLine: '#8a8175',
  tableHead: '#e8e2d4',
  tableStripe: '#ffffff',
} as const;

// The shape every palette must satisfy — light is the reference.
export type ThemeColors = { [K in keyof typeof lightColors]: string };

// Dark is a considered translation of the leaf/cream identity into a clean warm
// CHARCOAL key, NOT an inversion and NOT sepia: the blue channel is raised so
// the surfaces read as neutral warm-grey rather than muddy brown, and ink is a
// crisp near-white. The accent and state hues are MUTED against that ground
// rather than brightened onto it — the same leaf green, amber and terracotta at
// roughly two-thirds of the light palette's chroma, so a solid accent fill reads
// as considered colour rather than neon. Accent tints stay deep greens so
// selected rows / bubbles remain on-brand. Kept in sync with the web palette in
// packages/web/src/index.css.
export const darkColors: ThemeColors = {
  paper: '#191817',
  paperRaised: '#242220',
  ink: '#efede9',
  ink2: '#c6c2ba',
  ink3: '#928d84',
  inkFaint: '#6c6862',
  divider: '#38352f',
  leaf: '#77a966',
  leafSoft: '#95c186',
  amber: '#c8ac6a',
  red: '#cd7e70',
  shade: 'rgba(0, 0, 0, 0.86)',
  accentTint: '#252e1f',
  accentSoft: '#415337',
  lineSoft: '#2a2724',
  bgSoft: '#211f1d',
  bgElevated: '#2d2b28',
  waiting: '#c8ac6a',
  waitingTint: '#372b1b',
  diffAdd: '#1e281a',
  diffAddInk: '#95c186',
  diffDel: '#382624',
  diffDelInk: '#daa59a',
  onAccent: '#0f1a08',
  onAccentLine: 'rgba(15, 26, 8, 0.4)',
  codeOnAccent: 'rgba(0, 0, 0, 0.24)',
  tableLine: '#928d84',
  tableHead: '#433f3a',
  tableStripe: '#2d2b28',
};

// Scheme-INDEPENDENT colours: things that are the same in light and dark by
// design, so they are not palette tokens (the palette test requires every token
// to differ between schemes). Text on the `shade` scrim is light in both
// schemes because the scrim is near-black in both; a drop shadow and the
// backdrop behind a live camera preview are black in both.
export const fixed = {
  onShade: '#ffffff',
  onShade2: '#d8d2c4',
  shadow: '#000000',
  camera: '#000000',
  backdrop: 'rgba(0, 0, 0, 0.5)',
  // The full-screen image viewer's near-opaque ground.
  lightbox: 'rgba(0, 0, 0, 0.92)',
  // Round call controls on the scrim (voice-call overlay): rest / pressed / on.
  control: '#222222',
  controlPressed: '#444444',
  controlOn: '#888888',
} as const;

// Pure scheme → palette resolver (unit-testable without a renderer). A null /
// undefined scheme (OS setting unknown) resolves to light — the app's default
// identity — which is a deliberate choice, not an error-hiding fallback.
export function resolveTheme(scheme: ColorSchemeName): ThemeColors {
  return scheme === 'dark' ? darkColors : lightColors;
}

// The active palette, following the OS light/dark setting. Components call this
// at the top of their render and read `colors.*` from the result.
export function useTheme(): ThemeColors {
  return resolveTheme(useColorScheme());
}

// Desktop's radii (spec/14 § Visual system): small for chips and badges,
// standard for rows and fields, large for cards and banners, pill for status
// pills and segmented controls.
export const radii = {
  sm: 6,
  md: 10,
  lg: 16,
  pill: 999,
} as const;

// One 8px-based spacing scale (spec/15 § spacing): 4 · 8 · 12 · 16 · 24 · 32 ·
// 48. Every screen uses a scale step — no one-off pixel insets — so the app
// reads as one system.
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

/**
 * Minimum text size, mirroring web's `--text-min` (spec/14 § Legibility). NO UI
 * string renders smaller than this on any surface, however secondary — the
 * counterpart to `space`/`radii`: a scale value, never a one-off literal.
 * Anything below it goes through here so the floor is raised in one place.
 */
export const textMin = 13;

export const fonts = {
  // Italic Fraunces is the wordmark only — it is the logo, as on desktop.
  brand: 'Fraunces_500Medium_Italic',
  brandLight: 'Fraunces_400Regular_Italic',
  // Upright Fraunces: screen titles, chat titles, empty-state titles —
  // desktop's page and chat titles.
  display: 'Fraunces_500Medium',
  body: 'Inter_400Regular',
  bodyMedium: 'Inter_500Medium',
  bodyBold: 'Inter_600SemiBold',
  // Code ONLY — code blocks, inline code, tool-call args/output, diffs, the
  // file editor, the terminal, script fields. Never labels, paths, ids,
  // timestamps or status text; monoGuard.test.ts holds the line.
  mono: 'JetBrainsMono_400Regular',
} as const;

/**
 * The shared type styles (spec/15 § Visual language). Screens spread one of
 * these and add a colour — never a one-off family/size pairing — so every
 * surface reads in the same soft, desktop-like system: sentence-case section
 * headers in the body face, upright Fraunces titles, Inter for everything a
 * person reads, mono for code alone. Colour is not part of a type style
 * because it follows the scheme (`useTheme()`).
 */
export const typography = {
  /** The "patch" wordmark — the one italic. */
  wordmark: { fontFamily: fonts.brand, fontSize: 24 },
  /** A screen's own title (Settings, Jobs, New chat, a host tool). */
  screenTitle: { fontFamily: fonts.display, fontSize: 24, lineHeight: 30 },
  /** A chat's title in its header, a sheet or modal title, an empty state. */
  title: { fontFamily: fonts.display, fontSize: 20, lineHeight: 26 },
  /** A group label over a list or card: sentence case, body face. */
  sectionHeader: { fontFamily: fonts.bodyBold, fontSize: 14, lineHeight: 20 },
  /** Running text. */
  body: { fontFamily: fonts.body, fontSize: 16, lineHeight: 24 },
  /** A row's or card's name. */
  rowTitle: { fontFamily: fonts.bodyMedium, fontSize: 16, lineHeight: 22 },
  /** A button or control label. */
  label: { fontFamily: fonts.bodyMedium, fontSize: 15 },
  /** Second line under a row title: preview, subtitle. */
  secondary: { fontFamily: fonts.body, fontSize: 14, lineHeight: 20 },
  /** Metadata: folder crumbs, times, status words, counts, ids, paths. */
  meta: { fontFamily: fonts.body, fontSize: textMin, lineHeight: 18 },
  /** Code — see `fonts.mono` for where that is. */
  code: { fontFamily: fonts.mono, fontSize: textMin, lineHeight: 19 },
} as const;
