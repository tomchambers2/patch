import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SHORTCUT_TABLE } from '../lib/shortcuts.js';

// spec/14 § Copy — no helper text. Two rules, enforced over the whole web
// source rather than one component at a time, because the drift this catches
// arrives one well-meaning sentence at a time:
//
//   1. A tooltip NAMES the control. It is a short name of a few words, in
//      sentence case — never a sentence explaining what the control does
//      ("Edit", not "Edit — forks a new track from here").
//   2. Visible copy does not join two clauses with an em dash. The dash is
//      helper text wearing punctuation: "Agent offline. Messages are queued…",
//      never "Agent offline — messages will be queued…".
//
// Only STATIC attributes are scanned, PLUS every `shortcutTitle('Name', 'chord')`
// call — a control with a shortcut writes its tooltip through that helper rather
// than as a literal (spec/14 § Discoverability), and the name half of it is
// governed by exactly the same rules as a literal one. Anything else written as a
// `title={…}` expression is usually the sanctioned full-value tooltip (a clipped
// name or path reproduced verbatim, spec/14 § Copy), which is a value rather than
// a name and is deliberately exempt from both the length and the sentence-case
// rule.

const SRC = resolve(process.cwd(), 'src') + '/';

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'node_modules') continue;
      sources(p, out);
    } else if (/\.tsx$/.test(e.name) && !/harness/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const FILES = sources(SRC);

/**
 * Every `title="…"` / `aria-label="…"` written as a literal on a DOM element,
 * with its file.
 *
 * Only lowercase (DOM) tags count. On a component — Settings' `<Row title=…>`,
 * `<SettingsPage title=…>` — `title` is that component's own prop, and those
 * render it as the row's or page's VISIBLE heading, not as a tooltip: a row
 * title is copy, governed by the page, not by the tooltip rule.
 */
function staticAttributes(attr: string): { file: string; value: string }[] {
  const found: { file: string; value: string }[] = [];
  for (const file of FILES) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(new RegExp(`\\s${attr}="([^"]*)"`, 'g'))) {
      const tag = /^<([A-Za-z])/.exec(src.slice(src.lastIndexOf('<', m.index)));
      if (tag && /[A-Z]/.test(tag[1]!)) continue;
      found.push({ file: file.slice(SRC.length), value: m[1]! });
    }
  }
  return found;
}

/** Words, ignoring a trailing keyboard-shortcut hint like `(⌘S)` or `(Esc)`. */
function nameWords(value: string): string[] {
  return value
    .replace(/\s*\([^)]*\)\s*$/, '')
    .split(/\s+/)
    .filter((w) => w !== '');
}

describe('tooltips name the control (spec/14 § Copy — no helper text)', () => {
  const titles = staticAttributes('title');

  it('finds the tooltips to check (the scan itself is not silently empty)', () => {
    expect(titles.length).toBeGreaterThan(30);
  });

  it('none is a sentence explaining what the control does', () => {
    // A tooltip is a name, so it does not run to sentence length. The bar is
    // deliberately generous — "Open sidebar in new window" is still a name.
    const wordy = titles.filter(({ value }) => nameWords(value).length > 5);
    expect(wordy).toEqual([]);
  });

  it('none joins a name to an explanation with an em dash', () => {
    const dashed = titles.filter(({ value }) => value.includes('—'));
    expect(dashed).toEqual([]);
  });

  it('none is punctuated as prose (a full stop, a semicolon, or a comma splice)', () => {
    const prose = titles.filter(({ value }) => /[.;]|,\s/.test(value));
    expect(prose).toEqual([]);
  });

  it('every one is in sentence case', () => {
    // "Discard draft", not "discard draft" (spec/14 § Copy).
    const lower = titles.filter(({ value }) => /^[a-z]/.test(value));
    expect(lower).toEqual([]);
  });
});

describe('accessible labels agree with the tooltip rule', () => {
  it('no static aria-label carries an em-dash clause', () => {
    // An aria-label may name the thing acted on where the tooltip's context
    // makes that redundant, but it never becomes an explanation either.
    const dashed = staticAttributes('aria-label').filter(({ value }) => value.includes('—'));
    expect(dashed).toEqual([]);
  });
});

/** Every `shortcutTitle('Name', 'chord')` call in the source, with its file. */
function shortcutTitleCalls(): { file: string; name: string; chord: string }[] {
  const found: { file: string; name: string; chord: string }[] = [];
  for (const file of FILES) {
    const src = readFileSync(file, 'utf8');
    // Both quote styles: a chord containing `'` is written in double quotes.
    for (const m of src.matchAll(
      /shortcutTitle\(\s*(?:'([^']*)'|"([^"]*)")\s*,\s*(?:'([^']*)'|"([^"]*)")/g,
    )) {
      found.push({
        file: file.slice(SRC.length),
        name: m[1] ?? m[2] ?? '',
        chord: m[3] ?? m[4] ?? '',
      });
    }
  }
  return found;
}

/** Chords the app actually binds, as the cheat-sheet table lists them. */
const BOUND_CHORDS = new Set(
  // A row listing alternatives separates them with a spaced slash (`⌘ ↑ / ⌘ ↓`);
  // `⌘ /` is itself a chord, which is why the separator has to be the spaced one.
  SHORTCUT_TABLE.flatMap((row) => row.keys.split(' / ').map((k) => k.replace(/\s+/g, ''))),
);

describe('a control with a shortcut names it from the one chord source', () => {
  const calls = shortcutTitleCalls();

  it('finds the calls to check (the scan itself is not silently empty)', () => {
    expect(calls.length).toBeGreaterThan(5);
  });

  it('names only chords the app has actually bound', () => {
    // A tooltip promising a key nothing listens for is worse than no tooltip.
    const unbound = calls.filter((c) => !BOUND_CHORDS.has(c.chord.replace(/\s+/g, '')));
    expect(unbound).toEqual([]);
  });

  it('writes the chord in the app’s own macOS-glyph notation, never a rendered one', () => {
    // `shortcutLabel` does the platform rendering. A call site that hardcoded
    // "Ctrl" or "Alt" would print it to a Mac as well.
    const rendered = calls.filter((c) => /Ctrl|Alt|Shift|Cmd|Command/i.test(c.chord));
    expect(rendered).toEqual([]);
  });

  it('gives each a NAME, on the same rules as a literal tooltip', () => {
    const wordy = calls.filter((c) => c.name.split(/\s+/).filter(Boolean).length > 5);
    expect(wordy).toEqual([]);
    expect(calls.filter((c) => /^[a-z]/.test(c.name))).toEqual([]);
    expect(calls.filter((c) => /[.;—]|,\s/.test(c.name))).toEqual([]);
    // The name never spells the chord out a second time.
    expect(calls.filter((c) => /[⌘⌥⇧⌃]|\(/.test(c.name))).toEqual([]);
  });

  it('leaves no hardcoded chord glyph in a literal tooltip', () => {
    // Every chord in a tooltip goes through the renderer, so a literal one is a
    // control that will print ⌘ to a keyboard that has no ⌘ key.
    const hardcoded = staticAttributes('title').filter(({ value }) => /[⌘⌥⌃]/.test(value));
    expect(hardcoded).toEqual([]);
  });
});
