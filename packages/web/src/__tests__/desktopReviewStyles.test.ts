// DESKTOP-REVIEW style assertions — the visual/CSS items (A5, B2, B3) can't be
// exercised behaviourally in jsdom (no stylesheet cascade), so they're locked
// against the source of `index.css` instead. Verify the rendered look on prod.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Vitest runs from the @patch/web package root, so index.css is at src/index.css.
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

/** Extract every declaration block whose selector list mentions `needle`. */
function blocksMentioning(needle: string): string[] {
  const blocks: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const selector = (m[1] ?? '').trim();
    if (selector.split(',').some((s) => s.trim().split(/\s+/).includes(needle))) {
      blocks.push(m[2] ?? '');
    }
  }
  return blocks;
}

describe('DESKTOP-REVIEW styles', () => {
  // B2: prose must stay in one font — inline code must NOT pull the mono family
  // into body text. Only fenced code blocks (`.md-pre code`) use mono.
  it('B2: .md-inline-code does not switch to the mono font', () => {
    const blocks = blocksMentioning('.md-inline-code');
    expect(blocks.length).toBeGreaterThan(0);
    for (const body of blocks) {
      expect(body).not.toMatch(/JetBrains Mono/);
    }
  });

  it('B2: fenced code blocks (.md-pre code) still use the mono font', () => {
    const preBlocks = blocksMentioning('code').filter((b) => b.includes('JetBrains Mono'));
    // At least one `code` rule (the fenced-block rule) keeps mono.
    expect(preBlocks.length).toBeGreaterThan(0);
  });

  // B3: the transcript body font is the warmer, bundled Figtree — not Inter.
  it('B3: body uses the bundled Figtree Variable font', () => {
    const bodyBlocks = blocksMentioning('body');
    const withFont = bodyBlocks.filter((b) => b.includes('font-family'));
    expect(withFont.length).toBeGreaterThan(0);
    expect(withFont.some((b) => b.includes('Figtree Variable'))).toBe(true);
    // The font is self-hosted (CSP blocks external fonts) — imported by package.
    expect(css).toContain('@fontsource-variable/figtree');
  });

  // The chat header is a 3-zone grid — folder (left) · title (centre) · actions
  // (right) — with the title centred natively (no kebab, no absolute positioning).
  //
  // It is a FLEX row, not a grid. Grid could not express it: with `1fr auto 1fr`
  // the `auto` centre track sizes to the title's max-content and claims free
  // space before the `fr` tracks, so a long chat name overflowed its column and
  // printed over the folder crumb once the editor rail narrowed the panel (Tom,
  // `patch/todo.md` — "folder crumb and chat title crash into each other when
  // the editor is open"). `minmax(0, auto)` does not help — the zero only sets
  // the base size, the growth limit is still max-content. Flex shrinking is what
  // actually yields, so the construction is asserted, not incidental.
  it('the chat header is a flex row (grid could not make the title yield)', () => {
    const joined = blocksMentioning('.chat-head').join('\n');
    expect(/display:\s*flex/.test(joined)).toBe(true);
    expect(/grid-template-columns/.test(joined)).toBe(false);
  });

  // The title is the only zone that gives up space without a floor.
  it('the title shrinks and truncates; the crumb and actions have floors', () => {
    const title = blocksMentioning('.chat-head-title').join('\n');
    expect(/flex:\s*0 1 auto/.test(title)).toBe(true);
    expect(/min-width:\s*0/.test(title)).toBe(true);

    const chatTitle = blocksMentioning('.chat-title').join('\n');
    expect(/text-overflow:\s*ellipsis/.test(chatTitle)).toBe(true);
    expect(/white-space:\s*nowrap/.test(chatTitle)).toBe(true);

    // The left zone holds only Back / Forward now (the folder/host crumb moved
    // under the title), so it carries NO explicit floor of its own — the nav
    // controls' own `flex-shrink: 0` is what stops them collapsing, and an
    // extra floor on the zone would claim width `.chat-head-actions` needs for
    // its own equal `1 1 0` share at narrow viewports (it did, once — the zone
    // squeezed the actions zone to literally zero). The action icons must never
    // be squeezed below their real tap size either; they collapse into the
    // hamburger instead (see index.css's `@container` rule on `.chat-head-actions`).
    expect(/min-width/.test(blocksMentioning('.chat-head-left').join('\n'))).toBe(false);
    expect(/flex-shrink:\s*0/.test(blocksMentioning('.nav-history').join('\n'))).toBe(true);
    expect(/flex-shrink:\s*0/.test(blocksMentioning('.head-action').join('\n'))).toBe(true);
  });

  // The Manager row needs a visually distinct treatment (todo: "Manager needs a
  // more distinct design to show its special status"). The special row reads as
  // an accent-tinted card with an accent border — not a bare bold row.
  it('the Manager (.sb-row.special) row is an accent-tinted, bordered card', () => {
    const blocks = blocksMentioning('.sb-row.special');
    expect(blocks.length).toBeGreaterThan(0);
    const joined = blocks.join('\n');
    // A visible border keyed to the accent (distinct from ordinary borderless rows).
    expect(/border:\s*1px solid var\(--accent/.test(joined)).toBe(true);
    // An accent-tinted background so the row stands out as special.
    expect(/background:\s*var\(--accent/.test(joined)).toBe(true);
  });

  // The Manager identity glyph is accent-coloured so its special status reads at
  // a glance.
  it('the Manager identity glyph (.manager-glyph) is accent-coloured', () => {
    const blocks = blocksMentioning('.manager-glyph');
    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.join('\n')).toMatch(/color:\s*var\(--accent/);
  });

  // spec/14 § Manager: the Manager row's Voice note, Call and Hands-free
  // controls share one prominent, enlarged, accent-tinted variant — bigger
  // than the 24px hover mic and coloured with the accent.
  it('.mic-btn--manager-ctl enlarges + accent-tints the Manager row trio', () => {
    const blocks = blocksMentioning('.mic-btn--manager-ctl');
    expect(blocks.length).toBeGreaterThan(0);
    const joined = blocks.join('\n');
    // Taller than the base 24px mic, a plain 34px square icon button (no
    // text label, so no content-driven width) shared by all three controls.
    expect(/height:\s*34px/.test(joined)).toBe(true);
    expect(/width:\s*34px/.test(joined)).toBe(true);
    // Accent-coloured (not the base ink-3 grey).
    expect(/color:\s*var\(--accent-strong\)/.test(joined)).toBe(true);
  });
});
