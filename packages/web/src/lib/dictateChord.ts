// The dictate shortcut (spec/14 ## Keyboard shortcuts): one chord, ⌘⇧D unless
// changed in Settings → Voice. It drives the open chat's composer mic
// (lib/composerMic.ts), or a voice note where there is no composer.
//
// Kept per machine in localStorage: a chord belongs to the keyboard it is
// pressed on, not to the account. ⌘ (Ctrl off-Mac) is always part of it, so
// the chord can never swallow a key being typed.
//
// Matched on the physical key (`e.code`), so ⇧ and ⌥ can't turn the key into
// a different character and miss.

export interface DictateChord {
  alt: boolean;
  shift: boolean;
  /** `KeyboardEvent.code` of the non-modifier key, e.g. `KeyD`. */
  code: string;
}

export const DEFAULT_DICTATE_CHORD: DictateChord = { alt: false, shift: true, code: 'KeyD' };

const STORAGE_KEY = 'patch.voice.dictateChord';

const MODIFIER_CODES = new Set([
  'MetaLeft',
  'MetaRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'CapsLock',
  'Fn',
]);

const CODE_GLYPHS: Record<string, string> = {
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
  Space: 'Space',
};

function keyGlyph(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return CODE_GLYPHS[code] ?? code;
}

/** The chord in the macOS glyphs every shortcut is written in (`⌘⇧D`). */
export function chordGlyphs(chord: DictateChord): string {
  return `⌘${chord.alt ? '⌥' : ''}${chord.shift ? '⇧' : ''}${keyGlyph(chord.code)}`;
}

/** The chord a keydown spells, or null when it can't be one (no ⌘/Ctrl, or
 *  only modifiers held so far). */
export function chordFromEvent(e: KeyboardEvent): DictateChord | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  if (e.code === '' || MODIFIER_CODES.has(e.code)) return null;
  return { alt: e.altKey, shift: e.shiftKey, code: e.code };
}

export function matchesChord(e: KeyboardEvent, chord: DictateChord): boolean {
  return (
    (e.metaKey || e.ctrlKey) &&
    e.altKey === chord.alt &&
    e.shiftKey === chord.shift &&
    e.code === chord.code
  );
}

function isChord(value: unknown): value is DictateChord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['alt'] === 'boolean' &&
    typeof v['shift'] === 'boolean' &&
    typeof v['code'] === 'string'
  );
}

export function loadDictateChord(): DictateChord {
  /* v8 ignore next -- jsdom always defines localStorage; this SSR guard can't be hit under vitest+jsdom. */
  if (typeof localStorage === 'undefined') return DEFAULT_DICTATE_CHORD;
  const raw = localStorage.getItem(STORAGE_KEY);
  // Never set is a legitimate first run. A value that is set but unreadable is
  // not — say so, rather than quietly answering to a chord nobody chose.
  if (raw === null) return DEFAULT_DICTATE_CHORD;
  const parsed: unknown = JSON.parse(raw);
  if (!isChord(parsed)) throw new Error(`${STORAGE_KEY} is not a chord: ${raw}`);
  return parsed;
}

export function saveDictateChord(chord: DictateChord): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(chord));
}
