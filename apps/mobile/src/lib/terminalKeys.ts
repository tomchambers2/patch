// The host terminal's extra-key bar (spec/15 § Host files and terminal).
//
// A phone keyboard has no Esc, no Ctrl and no arrow keys, and hides Tab, `|`
// and `~` behind a symbol page — every one of which a shell uses constantly.
// The bar sits above the keyboard and sends each as the exact bytes a real
// terminal's key would.
//
// Ctrl is STICKY: tap it, then the next key (from the bar or the keyboard) is
// sent as its control character, and Ctrl lets go by itself. Holding a modifier
// while typing a second key is not something a touch keyboard can do.
//
// The arrows depend on the terminal's cursor-key mode: a full-screen program
// (vim, less, htop) switches the terminal to APPLICATION mode and expects
// `ESC O A` where the shell expects `ESC [ A`. The WebView reports the mode
// (`terminalPage.ts`), and `keySequence` picks the matching bytes.

export type BarKey =
  | 'esc'
  | 'tab'
  | 'ctrl'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'pipe'
  | 'tilde'
  | 'slash';

export interface BarKeySpec {
  key: BarKey;
  /** What the key shows. */
  label: string;
  /** What a screen reader says. */
  accessibilityLabel: string;
}

/** Left to right, as drawn. */
export const KEY_BAR: readonly BarKeySpec[] = [
  { key: 'esc', label: 'Esc', accessibilityLabel: 'Escape' },
  { key: 'tab', label: 'Tab', accessibilityLabel: 'Tab' },
  { key: 'ctrl', label: 'Ctrl', accessibilityLabel: 'Control' },
  { key: 'up', label: '↑', accessibilityLabel: 'Up arrow' },
  { key: 'down', label: '↓', accessibilityLabel: 'Down arrow' },
  { key: 'left', label: '←', accessibilityLabel: 'Left arrow' },
  { key: 'right', label: '→', accessibilityLabel: 'Right arrow' },
  { key: 'pipe', label: '|', accessibilityLabel: 'Pipe' },
  { key: 'tilde', label: '~', accessibilityLabel: 'Tilde' },
  { key: 'slash', label: '/', accessibilityLabel: 'Slash' },
];

const ARROW_LETTER = { up: 'A', down: 'B', right: 'C', left: 'D' } as const;

const PLAIN: Record<'esc' | 'tab' | 'pipe' | 'tilde' | 'slash', string> = {
  esc: '\x1b',
  tab: '\t',
  pipe: '|',
  tilde: '~',
  slash: '/',
};

/**
 * The bytes one bar key sends. `appCursor` is the terminal's current
 * cursor-key mode; `ctrl` is whether sticky Ctrl was armed when it was pressed.
 * Ctrl on an arrow is the xterm modified-key form (`ESC [ 1 ; 5 A`) — word
 * movement in readline — and on a printable key it is that key's control
 * character. Ctrl has no bytes of its own: pressing it only arms the next key.
 */
export function keySequence(
  key: Exclude<BarKey, 'ctrl'>,
  opts: { appCursor: boolean; ctrl: boolean },
): string {
  if (key === 'up' || key === 'down' || key === 'left' || key === 'right') {
    const letter = ARROW_LETTER[key];
    if (opts.ctrl) return `\x1b[1;5${letter}`;
    return opts.appCursor ? `\x1bO${letter}` : `\x1b[${letter}`;
  }
  const bytes = PLAIN[key];
  return opts.ctrl ? applyCtrl(bytes) : bytes;
}

/**
 * Typed input with Ctrl held: the FIRST character becomes its control
 * character (`c` → ETX, `[` → ESC, `?` → DEL, space → NUL) and the rest passes
 * through. A character with no control form (a digit, Esc itself, a non-ASCII
 * letter) goes through unchanged rather than being guessed at.
 */
export function applyCtrl(data: string): string {
  if (data === '') return data;
  const first = data[0] as string;
  const rest = data.slice(1);
  if (first === ' ') return `\x00${rest}`;
  if (first === '?') return `\x7f${rest}`;
  const code = first.toUpperCase().charCodeAt(0);
  if (code >= 0x40 && code <= 0x5f) return `${String.fromCharCode(code & 0x1f)}${rest}`;
  if (first === '|') return `\x1c${rest}`;
  if (first === '~') return `\x1e${rest}`;
  if (first === '/') return `\x1f${rest}`;
  return data;
}
