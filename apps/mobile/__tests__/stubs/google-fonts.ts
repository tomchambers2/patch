// Shared stub for the three @expo-google-fonts/* packages this app loads.
// The real packages `require(...).ttf` per font weight, which has no loader
// under vitest/node — this stand-in exports plain string placeholders for
// every font-weight constant the app references, plus a `useFonts` that
// resolves loaded=true synchronously (no real asset fetch under test).
//
// On a real cold start the five font files take a moment to load. The app
// paints through that window on the platform default face, so it is about
// WHICH face is in use, not about whether anything renders at all.
// `__setFontsLoaded(false)` opens the window on demand, and `__setFontsError`
// reproduces a font set that genuinely failed to load.
let _loaded = true;
let _error: Error | null = null;

/** Test helper: hold fonts unloaded to reproduce the cold-start window. */
export function __setFontsLoaded(loaded: boolean): void {
  _loaded = loaded;
}

/** Test helper: make the font load report a hard failure. */
export function __setFontsError(error: Error | null): void {
  _error = error;
}

export function useFonts(_map: Record<string, unknown>): [boolean, Error | null] {
  return [_loaded, _error];
}

export const Fraunces_400Regular_Italic = 'Fraunces_400Regular_Italic';
export const Fraunces_500Medium = 'Fraunces_500Medium';
export const Fraunces_500Medium_Italic = 'Fraunces_500Medium_Italic';
export const Inter_400Regular = 'Inter_400Regular';
export const Inter_500Medium = 'Inter_500Medium';
export const Inter_600SemiBold = 'Inter_600SemiBold';
export const JetBrainsMono_400Regular = 'JetBrainsMono_400Regular';
