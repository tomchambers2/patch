// spec/14 § Main chat panel — "Breathing room" (todo: "Chat page feels cramped").
//
// This is a pure vertical-rhythm contract: jsdom has no cascade, so there is
// nothing behavioural to assert. The values are locked against the source of
// `index.css` instead, the same way `desktopReviewStyles.test.ts` locks the
// other visual rules.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Vitest runs from the @patch/web package root, so index.css is at src/index.css.
// Comments are stripped first: they sit between rules, so a comment's prose
// would otherwise be captured as part of the following rule's selector.
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** Declaration blocks whose selector list contains `selector` verbatim. */
function blocksFor(selector: string): string[] {
  const blocks: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const parts = (m[1] ?? '').split(',').map((s) => s.trim().replace(/\s+/g, ' '));
    if (parts.includes(selector)) blocks.push(m[2] ?? '');
  }
  return blocks;
}

/** The value of `prop` in the rule for `selector`. */
function decl(selector: string, prop: string): string {
  const blocks = blocksFor(selector);
  expect(blocks.length, `no CSS rule for \`${selector}\``).toBeGreaterThan(0);
  const re = new RegExp(`(?:^|;|\\n)\\s*${prop}\\s*:\\s*([^;}]+)`);
  for (const body of blocks) {
    const m = re.exec(body);
    if (m) return (m[1] ?? '').trim();
  }
  throw new Error(`no \`${prop}\` declared on \`${selector}\``);
}

/** First component of a shorthand value (e.g. `0.6em 0` -> `0.6em`). */
function first(value: string): string {
  return value.trim().split(/\s+/)[0] ?? '';
}

/** Parse a px length into a number. */
function px(value: string): number {
  if (value.trim() === '0') return 0;
  const m = /^(-?[\d.]+)px$/.exec(value.trim());
  if (!m) throw new Error(`expected a px length, got "${value}"`);
  return Number(m[1]);
}

/** Parse an em length into a number. */
function em(value: string): number {
  const m = /^(-?[\d.]+)em$/.exec(value.trim());
  if (!m) throw new Error(`expected an em length, got "${value}"`);
  return Number(m[1]);
}

/** Split a shorthand like `32px 32px 40px` into top/right/bottom/left px. */
function box(shorthand: string): { top: number; right: number; bottom: number; left: number } {
  const parts = shorthand.trim().split(/\s+/).map(px);
  const [a, b, c, d] = parts;
  if (a === undefined) throw new Error(`empty shorthand: "${shorthand}"`);
  if (b === undefined) return { top: a, right: a, bottom: a, left: a };
  if (c === undefined) return { top: a, right: b, bottom: a, left: b };
  if (d === undefined) return { top: a, right: b, bottom: c, left: b };
  return { top: a, right: b, bottom: c, left: d };
}

describe('chat transcript breathing room (spec/14 § Main chat panel)', () => {
  it('the scroller keeps the transcript off the header rule and the composer', () => {
    const pad = box(decl('.chat-stream', 'padding'));
    expect(pad.top).toBeGreaterThanOrEqual(32);
    expect(pad.left).toBeGreaterThanOrEqual(32);
    expect(pad.right).toBeGreaterThanOrEqual(32);
    // Extra room at the foot so the last message never presses on the composer.
    expect(pad.bottom).toBeGreaterThanOrEqual(40);
  });

  it('separates two turns more than it separates paragraphs inside one turn', () => {
    // The load-bearing rule: assistant replies have no bubble and no label, so
    // if these two gaps are comparable, consecutive turns read as one block.
    // The margin is `calc(28px - var(--msg-tail))`: the message pads itself by the
    // tail below its meta strip, so the visible gap between turns is still the 28px.
    const margin = decl('.msg', 'margin-bottom');
    const tailed = /^calc\(\s*([\d.]+)px\s*-\s*var\(--msg-tail\)\s*\)$/.exec(margin);
    const turnGap = tailed ? Number(tailed[1]) : px(margin);
    expect(turnGap).toBeGreaterThanOrEqual(28);

    // `.msg .content p` margin is in em against the 16px body size.
    const paraGapPx = em(first(decl('.msg .content p', 'margin'))) * 16;
    expect(turnGap).toBeGreaterThan(paraGapPx * 2);
  });

  it('sets a comfortable leading on transcript prose', () => {
    expect(Number(decl('.msg .content', 'line-height'))).toBeGreaterThanOrEqual(1.65);
  });

  it('gives markdown blocks room without falling back to browser defaults', () => {
    const paraGap = em(first(decl('.msg .content p', 'margin')));
    expect(paraGap).toBeGreaterThanOrEqual(0.6);
    // Still tighter than the browser's 1em default — a reply must not read as
    // if it is full of blank lines.
    expect(paraGap).toBeLessThan(1);

    const listGap = em(first(decl('.msg .content ul', 'margin')));
    expect(listGap).toBeGreaterThanOrEqual(0.6);
    expect(listGap).toBeLessThan(1);

    const itemGap = em(first(decl('.msg .content li', 'margin')));
    expect(itemGap).toBeGreaterThanOrEqual(0.25);
  });

  it('pads the user bubble so text does not press against its edge', () => {
    const pad = box(decl('.msg-user .content', 'padding'));
    expect(pad.top).toBeGreaterThanOrEqual(12);
    expect(pad.left).toBeGreaterThanOrEqual(16);
  });

  it('separates tool-call rows so a run of them reads as distinct rows', () => {
    const margin = box(decl('.tool-call', 'margin'));
    expect(margin.top).toBeGreaterThanOrEqual(10);
    expect(margin.bottom).toBeGreaterThanOrEqual(10);
  });

  it('leaves the 780px reading measure alone (the cramping was vertical)', () => {
    // The literal sits on `.chat-stream` rather than on the content column,
    // because a wide table has to measure the panel against the same number
    // (spec/14 § Wide tables) — so both halves are locked here.
    expect(decl('.chat-stream', '--measure')).toBe('780px');
    expect(decl('.chat-stream-content', 'max-width')).toBe('var(--measure)');
  });
});
