// The countdown ring and the Settings → Agent → Questions controls, locked
// against the source of `index.css`.
//
// Two controls with a history behind them. A tick box that inherits Settings'
// FIELD vocabulary — a min-width, padding, a border — which is written for a
// typed or picked value turns into a wide empty slab. And a class name in `packages/web` is not evidence of a rule: the
// settings.json editor carried none at all and collapsed to an invisible
// zero-height box (see `claudeSettingsEditorStyles.test.ts`), which is the bug
// this file exists to stop recurring on the next new control.
//
// jsdom has no stylesheet cascade, so the RENDERED boxes are measured in
// Playwright (`e2e/question-countdown.spec.ts`). This locks the source so the
// rules cannot be dropped again.
//
// Asserts against the raw source with anchored regexes rather than via
// desktopReviewStyles.test.ts's `blocksMentioning` helper — that helper
// mis-parses everything after `index.css`'s first nested `@media` block and
// does not strip comments, so a substring assertion there can pass on comment
// prose alone.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

/** Every rule as its selector list (whitespace-normalised) and body, comments stripped. */
const RULES = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  (m) => ({
    selectors: m[1]!.split(',').map((x) => x.trim().replace(/\s+/g, ' ')),
    body: m[2]!,
  }),
);

/** Declarations of the rules whose selector list is exactly this one selector. */
function own(selector: string): string {
  const found = RULES.filter((r) => r.selectors.length === 1 && r.selectors[0] === selector);
  expect(found.length, `no rule of its own for \`${selector}\``).toBeGreaterThan(0);
  return found.map((r) => r.body).join('\n');
}

/** The declaration body of exactly one selector, comments stripped. */
function body(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `no rule for \`${selector}\` in index.css`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  expect(close, `unterminated rule for \`${selector}\``).toBeGreaterThan(open);
  return css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('the question countdown ring', () => {
  it('is pinned to the card rather than pushed into the question flow', () => {
    // Its anchor: without `position: relative` on the card the ring escapes to
    // the nearest positioned ancestor, which is the scrolling transcript.
    expect(body('.question-card')).toMatch(/position:\s*relative;/);
    const ring = body('.question-countdown');
    expect(ring).toMatch(/position:\s*absolute;/);
    expect(ring).toMatch(/top:\s*\d+px;/);
    expect(ring).toMatch(/right:\s*\d+px;/);
  });

  it('has a real size, so it is never a zero-height nothing', () => {
    const ring = body('.question-countdown');
    const w = /width:\s*(\d+)px;/.exec(ring);
    const h = /height:\s*(\d+)px;/.exec(ring);
    expect(w, 'the ring sets no width').not.toBeNull();
    expect(h, 'the ring sets no height').not.toBeNull();
    expect(Number(w?.[1])).toBeGreaterThanOrEqual(16);
    expect(Number(h?.[1])).toBeGreaterThanOrEqual(16);
  });

  it('never swallows a click meant for the card underneath it', () => {
    expect(body('.question-countdown')).toMatch(/pointer-events:\s*none;/);
  });

  it('starts its depletion at the top and runs clockwise', () => {
    expect(body('.question-countdown svg')).toMatch(/transform:\s*rotate\(-90deg\);/);
  });

  it('draws both the track and the depleting arc, in theme tokens only', () => {
    for (const sel of ['.question-countdown-track', '.question-countdown-fill']) {
      const decls = body(sel);
      expect(decls, `${sel} paints its interior`).toMatch(/fill:\s*none;/);
      const stroke = /\n\s*stroke:\s*([^;]+);/.exec(decls);
      expect(stroke, `${sel} sets no stroke`).not.toBeNull();
      // A literal colour here reads in one theme and is invisible in the other.
      expect(stroke?.[1]?.trim()).toMatch(/^var\(--[a-z-]+\)$/);
      const width = /stroke-width:\s*(\d+)/.exec(decls);
      expect(width, `${sel} sets no stroke-width`).not.toBeNull();
      expect(Number(width?.[1])).toBeGreaterThanOrEqual(2);
    }
  });

  it('animates the arc, so a 250ms tick reads as movement rather than a jump', () => {
    expect(body('.question-countdown-fill')).toMatch(
      /transition:\s*stroke-dashoffset\s+\d+ms\s+linear;/,
    );
  });

  it('greys the arc when it has run out instead of hiding the ring', () => {
    const expired = body(".question-countdown[data-expired='true'] .question-countdown-fill");
    expect(expired).toMatch(/stroke:\s*var\(--line\);/);
    expect(expired).not.toMatch(/display:\s*none;/);
  });
});

describe('Settings → Agent → Questions controls', () => {
  // Since the Settings redesign the on/off is a Toggle (spec/14 § Controls:
  // toggles, never checkboxes) and the window is a number field. The history
  // this guards: a tick box that inherited the FIELD vocabulary — min-width,
  // padding, a border — rendered as a wide empty slab.
  const fieldRule = RULES.find((r) => r.selectors.includes(".settings-route input[type='number']"));

  it('styles only typed or picked values as bordered fields, never a checkbox', () => {
    expect(fieldRule, 'no bordered-field rule for Settings inputs').toBeDefined();
    expect(fieldRule?.body).toMatch(/border:\s*1px solid var\(--line\);/);
    // Every input the rule reaches is named by type, so the Toggle's own
    // (visually hidden) checkbox is never drawn as a field.
    for (const sel of fieldRule?.selectors ?? []) {
      expect(sel).not.toMatch(/checkbox/);
      expect(sel).not.toMatch(/^\.settings-route input$/);
      expect(sel).not.toMatch(/input\s*$/);
    }
  });

  it('sizes the seconds field to a number, not a full-width box', () => {
    const w = /\n\s*width:\s*(\d+)px;/.exec(own('.set-num'));
    expect(w, 'the number field sets no width').not.toBeNull();
    expect(Number(w?.[1])).toBeGreaterThanOrEqual(48);
    expect(Number(w?.[1])).toBeLessThanOrEqual(120);
  });

  it('draws the on/off as a switch that does not shrink out of the row', () => {
    const track = own('.toggle-track');
    expect(track).toMatch(/flex:\s*none;/);
    expect(track).toMatch(/\n\s*width:\s*\d+px;/);
    expect(track).toMatch(/\n\s*height:\s*\d+px;/);
    // The real checkbox is there for keyboard and screen readers, but hidden.
    const input = own('.toggle-input');
    expect(input).toMatch(/opacity:\s*0;/);
    expect(input).toMatch(/position:\s*absolute;/);
  });

  it('takes the switch colours from the palette, so it inverts with the theme', () => {
    for (const sel of ['.toggle-track', '.toggle-input:checked + .toggle-track']) {
      const bg = /background:\s*([^;]+);/.exec(own(sel));
      expect(bg, `${sel} sets no background`).not.toBeNull();
      expect(bg?.[1]?.trim()).toMatch(/^var\(--[a-z-]+\)$/);
    }
  });

  it('keeps the shared focus ring every other Settings field uses', () => {
    const focus = RULES.find((r) => r.selectors.includes('.settings-route input:focus'));
    expect(focus, 'no shared Settings focus rule').toBeDefined();
    expect(focus?.body).toMatch(/border-color:\s*var\(--accent\);/);
    // …and the switch has a visible focus of its own.
    expect(own('.toggle-input:focus-visible + .toggle-track')).toMatch(/outline:\s*2px solid/);
  });
});
