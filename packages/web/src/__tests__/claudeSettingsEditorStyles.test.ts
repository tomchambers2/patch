// Settings → Agent → Claude Code settings.json: the editor, and every other
// Settings text box that shares its rules (spec/14 § `/settings` details →
// Claude Code settings).
//
// The editor once carried no rule at all, so the textarea inherited the
// borderless reset. With an empty settings.json it collapsed to zero height
// with no border, leaving a heading and an orphan Save button and nothing that
// read as an editor.
//
// Since the Settings redesign (design/settings-redesign) there is no editor-
// specific class to hang this on: every Settings textarea — this one, the two
// prompt layers, a memory's text — takes the same two rules, the bordered-field
// rule shared with inputs and selects, and a textarea rule that sizes the box.
// This locks both, so the editor cannot collapse again.
//
// jsdom has no stylesheet cascade, so the rendered box itself is measured in
// Playwright. This locks the source of `index.css`.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** Every rule as its selector list (each selector whitespace-normalised) and body. */
const RULES = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1]!.split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
  body: m[2]!,
}));

/** Declarations of the rules whose selector list is exactly this one selector. */
function own(selector: string): string {
  const found = RULES.filter((r) => r.selectors.length === 1 && r.selectors[0] === selector);
  expect(found.length, `no rule of its own for \`${selector}\` in index.css`).toBeGreaterThan(0);
  return found.map((r) => r.body).join('\n');
}

/** Declarations of the grouped rules that list this selector among others. */
function shared(selector: string): string {
  const found = RULES.filter((r) => r.selectors.length > 1 && r.selectors.includes(selector));
  expect(found.length, `no shared rule lists \`${selector}\``).toBeGreaterThan(0);
  return found.map((r) => r.body).join('\n');
}

describe('Claude Code settings.json editor styling', () => {
  const editor = '.settings-route textarea';

  it('stands several lines tall so an empty file still shows a box', () => {
    const decls = own(editor);
    const min = /min-height:\s*(\d+)lh;/.exec(decls);
    expect(min, 'the editor has no min-height in lines').not.toBeNull();
    // Several rows of JSON, not a single collapsed line.
    expect(Number(min?.[1])).toBeGreaterThanOrEqual(5);
  });

  it('grows with what it holds, within a bound that keeps the page usable', () => {
    const decls = own(editor);
    expect(decls).toMatch(/field-sizing:\s*content;/);
    expect(decls).toMatch(/max-height:\s*\d+vh;/);
  });

  it('draws a real 1px border in the shared line token, not a tinted fill', () => {
    expect(shared(editor)).toMatch(/border:\s*1px solid var\(--line\);/);
  });

  it('insets its text from that border', () => {
    expect(shared(editor)).toMatch(/padding:\s*\d+px \d+px;/);
  });

  it('sets the JSON in the app’s monospace face', () => {
    expect(own(editor)).toMatch(
      /font-family:\s*'JetBrains Mono Variable', ui-monospace, monospace;/,
    );
  });

  it('takes every colour from a theme token, so it reads in light and dark alike', () => {
    const decls = shared(editor);
    for (const prop of ['background', 'color']) {
      const m = new RegExp(`\\n\\s*${prop}:\\s*([^;]+);`).exec(decls);
      expect(m, `the editor sets no \`${prop}\``).not.toBeNull();
      expect(m?.[1]?.trim()).toMatch(/^var\(--[a-z-]+\)$/);
    }
    // No literal colour anywhere in either rule.
    expect(`${decls}\n${own(editor)}`).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
  });

  it('spans the field column and only drags taller, never wider than it', () => {
    const decls = own(editor);
    expect(decls).toMatch(/width:\s*100%;/);
    expect(decls).toMatch(/resize:\s*vertical;/);
    // `width: 100%` plus padding and border only fits because every box is
    // border-box, app-wide.
    expect(own('*')).toMatch(/box-sizing:\s*border-box;/);
  });

  it('marks focus the same way every other Settings field does', () => {
    const decls = shared(`${editor}:focus`);
    expect(decls).toMatch(/border-color:\s*var\(--accent\);/);
    expect(decls).toMatch(/box-shadow:\s*0 0 0 2px var\(--accent-tint\);/);
    // One rule for every field, so no field's focus can drift from the others.
    const focus = RULES.find((r) => r.selectors.includes(`${editor}:focus`));
    expect(focus?.selectors).toEqual(
      expect.arrayContaining(['.settings-route select:focus', '.settings-route input:focus']),
    );
  });

  it('opens as a column so Save sits directly under the box it saves', () => {
    // The editor row switches to `.set-row.stack` while open.
    const decls = own('.set-row.stack');
    expect(decls).toMatch(/flex-direction:\s*column;/);
    const gap = /\n\s*gap:\s*(\d+)px;/.exec(decls);
    expect(gap, 'the open row sets no gap').not.toBeNull();
    expect(Number(gap?.[1])).toBeGreaterThanOrEqual(6);
  });

  it('keeps Save the width of its own label, in a row of its own under the box', () => {
    // `.set-actions` is its own flex row, so a stretched column cannot turn
    // the buttons into full-width bars.
    const decls = own('.set-actions');
    expect(decls).toMatch(/display:\s*flex;/);
    expect(decls).toMatch(/justify-content:\s*flex-end;/);
    expect(own('.set-btn')).toMatch(/display:\s*inline-flex;/);
  });
});
