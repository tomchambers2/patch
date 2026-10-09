// The one place that decides what "save this" / "send this" looks like on a
// keyboard (spec/14 § Keyboard shortcuts).
//
// Every editable field in the app that has a save or commit action commits on
// `⌘↵` / `Ctrl↵`. That is one rule, so it is one predicate: a field wiring its
// own `if (e.metaKey || e.ctrlKey)` is how the app ended up with surfaces where
// the chord silently did nothing (the message editor had no key handler at all,
// so the only way to save an edited turn was the mouse).

/**
 * A keydown, in either shape the app sees: React's synthetic event (which
 * carries the IME flag on `nativeEvent`) or the DOM's own (which carries it
 * directly). Structural rather than the React type so a `window` listener and a
 * JSX `onKeyDown` can share the predicate.
 */
export interface SubmitChordEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean | undefined;
  nativeEvent?: { isComposing?: boolean | undefined } | undefined;
}

/**
 * Is this keydown the commit chord?
 *
 * `⌥` and `⇧` are excluded rather than ignored: `⇧↵` is the newline key, and
 * leaving either modifier unchecked makes the chord fire on chords that mean
 * something else. IME composition is never hijacked — `↵` mid-composition
 * commits the candidate, and a field that stole it could not be typed in at all
 * in Japanese or Chinese.
 */
export function isSubmitChord(e: SubmitChordEvent): boolean {
  if (e.key !== 'Enter') return false;
  if (e.isComposing === true || e.nativeEvent?.isComposing === true) return false;
  if (e.shiftKey || e.altKey) return false;
  return e.metaKey || e.ctrlKey;
}
