// The narrow-width sidebar drawer (spec/14 § Layout → Narrow widths) is a pure
// CSS rule keyed on a breakpoint that ALSO exists as a JS constant — the hook
// auto-collapses at `SIDEBAR_AUTO_COLLAPSE_WIDTH`, the stylesheet turns the
// sidebar into a drawer below the same width. Two values that must agree, in
// two files that have no import between them, so lock them together here.
//
// jsdom computes no layout and applies no stylesheet cascade, so the drawer's
// actual geometry can only be proven in a real browser — see
// e2e/narrow-layout.spec.ts § narrow-width sidebar drawer. This file only
// guards the parts a browser test can't tell you: that the breakpoint still
// matches the constant, and that the rules are keyed on the selectors the
// components actually render.
//
// NB: asserts on the raw source rather than via desktopReviewStyles.test.ts's
// `blocksMentioning` helper — that helper's brace regex desyncs permanently
// once it crosses a nested `@media` block (index.css has one near the top) and
// it doesn't strip comments, so an assertion there can pass by matching
// explanatory prose. Same reasoning as scrollbarStyles.test.ts.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SIDEBAR_AUTO_COLLAPSE_WIDTH } from '../lib/responsiveShell.js';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

describe('narrow-width sidebar drawer styles', () => {
  it('turns the sidebar into a drawer at exactly the width the hook auto-collapses at', () => {
    expect(css).toMatch(
      new RegExp(`@media\\s*\\(width\\s*<\\s*${SIDEBAR_AUTO_COLLAPSE_WIDTH}px\\)`),
    );
  });

  it('takes the open sidebar out of the flex flow so the chat panel keeps the window', () => {
    expect(css).toMatch(
      /\.three-col:not\(\.sidebar-collapsed\):not\(\.sidebar-window\)\s+\.sb\s*\{\s*\n\s*position:\s*absolute;/,
    );
  });

  it('caps the drawer so a dragged-wide sidebar cannot cover the whole window', () => {
    expect(css).toMatch(/max-width:\s*85vw;/);
  });

  it('exempts the detached sidebar window, which fills a narrow window instead', () => {
    // Every rule inside the drawer media query carries the exemption.
    const block = css.slice(
      css.indexOf(`@media (width < ${SIDEBAR_AUTO_COLLAPSE_WIDTH}px)`),
      css.indexOf('.sidebar-backdrop {'),
    );
    const selectors = block.match(/^\s{2}\.three-col[^{]*\{/gm) ?? [];
    expect(selectors.length).toBeGreaterThan(0);
    for (const sel of selectors) {
      expect(sel).toContain(':not(.sidebar-window)');
    }
  });

  it('hides the drag divider while the sidebar is a drawer', () => {
    expect(css).toMatch(
      /\.three-col:not\(\.sidebar-collapsed\):not\(\.sidebar-window\)\s+\[data-testid='sidebar-divider'\]\s*\{\s*\n\s*display:\s*none;/,
    );
  });

  it('keeps the backdrop hidden by default, so it only ever shows as a drawer', () => {
    expect(css).toMatch(/\.sidebar-backdrop\s*\{\s*\n\s*display:\s*none;/);
  });

  it('draws the backdrop under the drawer, so the drawer stays clickable', () => {
    const drawerZ = /\.sb\s*\{[^}]*?z-index:\s*(\d+);/s.exec(
      css.slice(css.indexOf(`@media (width < ${SIDEBAR_AUTO_COLLAPSE_WIDTH}px)`)),
    );
    const backdropZ = /\.sidebar-backdrop\s*\{[^}]*?z-index:\s*(\d+);/s.exec(css);
    expect(drawerZ).not.toBeNull();
    expect(backdropZ).not.toBeNull();
    expect(Number(drawerZ![1])).toBeGreaterThan(Number(backdropZ![1]));
  });
});
