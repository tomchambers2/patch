// Composer input height bounds (spec/15 § Composer — the field grows upward).
//
// The composer sits BELOW a `flex: 1` transcript list, so a taller input takes
// its space from the list and the composer's own bottom edge never moves: the
// box grows upward into the transcript, which is what "expand upwards" means
// in a column-flow layout. React Native's multiline `TextInput` does the
// growing itself — it sizes to its content between `minHeight` and `maxHeight`
// — so these two numbers ARE the behaviour; there is no measuring code.
//
// Kept in their own module rather than inline because two things must agree on
// the cap: the input, and the live-dictation mirror drawn on top of it. When
// those drifted apart the preview clipped at a different line from the field
// underneath it.

/**
 * One-line height. Matches the 40px action buttons on the row beneath, so an
 * empty composer reads as one uniform bar rather than a short field next to
 * taller icons.
 */
export const COMPOSER_MIN_HEIGHT = 40;

/**
 * Cap, in dp. Past this the input scrolls internally instead of growing, so a
 * long paste can never swallow the transcript entirely.
 *
 * 200 is the same cap the web composer uses (`MAX_INPUT_HEIGHT` in
 * `packages/web/src/components/Composer.tsx`) — one number for the same
 * decision on both surfaces. At the composer's 16px type that is roughly nine
 * lines, up from the four and a bit that 120 allowed: the old cap started
 * hiding text about a sentence and a half in, which is well short of the
 * messages people actually type. It is deliberately a fixed dp value and not a
 * fraction of the window: with the soft keyboard up, the window height Android
 * reports moves under `adjustResize`, and a cap derived from it would grow and
 * shrink the field as the keyboard opened and closed.
 */
export const COMPOSER_MAX_HEIGHT = 200;
