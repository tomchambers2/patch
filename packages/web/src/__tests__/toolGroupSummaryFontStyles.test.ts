// Todoist: "Patch give a brief description of a batch of tool calls... And
// doesn't need code font." The collapsed batch row (`.tool-group-summary` §
// spec/14 "Tool runs collapse to one row") reads as a plain description, not
// code, so it must not inherit `.tool-group`'s monospace font. jsdom has no
// stylesheet cascade, so this is locked against the source of `index.css`
// (same approach as `desktopReviewStyles.test.ts`).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

/** The declaration body of exactly one selector, comments stripped. */
function body(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `no rule for \`${selector}\` in index.css`).toBeGreaterThan(-1);
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  expect(close, `unterminated rule for \`${selector}\``).toBeGreaterThan(open);
  return css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('the collapsed tool-run summary row', () => {
  it('keeps the code font for tool rows in general', () => {
    expect(body('.tool-group')).toMatch(/JetBrains Mono/);
  });

  it('overrides back to the body font for its own one-line description', () => {
    const rule = body('.tool-group .tool-summary-text');
    expect(rule).not.toMatch(/JetBrains Mono/);
    expect(rule).toMatch(/Figtree Variable/);
  });
});
