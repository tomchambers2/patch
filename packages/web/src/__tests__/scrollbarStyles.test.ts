// todo "swap the thick scroll bars for the more elegant one without borders
// and its own width" — like the DESKTOP-REVIEW style checks, a global
// scrollbar restyle can't be exercised behaviourally in jsdom (no stylesheet
// cascade, and ::-webkit-scrollbar isn't exposed via getComputedStyle even in
// a real browser), so it's locked against the source of `index.css` instead.
// Verify the rendered look on a real Chromium/Android build.
//
// NB: asserts on the raw source rather than via a brace-parsing helper (see
// desktopReviewStyles.test.ts's `blocksMentioning`) — that approach mis-parses
// nested `@media` blocks and mis-attributes a preceding multi-line comment as
// part of the next selector, silently merging blocks together.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

describe('global scrollbar styling', () => {
  it('sets a thin, theme-coloured scrollbar for Firefox', () => {
    expect(css).toMatch(
      /\*\s*\{\s*\n\s*scrollbar-width:\s*thin;\s*\n\s*scrollbar-color:\s*var\(--ink-faint\)\s+transparent;/,
    );
  });

  it('gives the WebKit/Blink scrollbar its own width, not the OS default', () => {
    expect(css).toMatch(
      /\*::-webkit-scrollbar\s*\{\s*\n\s*width:\s*var\(--scrollbar-w\);\s*\n\s*height:\s*var\(--scrollbar-w\);/,
    );
  });

  // The sidebar reserves the gutter its scrollbar takes so its scrolling and
  // fixed bands stay the same width (spec/14 § Sidebar — One column), which
  // means the width has to be a token both can read, and a real length.
  it('the width is a shared token holding a real pixel length', () => {
    expect(css).toMatch(/--scrollbar-w:\s*\d+px;/);
  });

  it('the WebKit thumb has no border and a themed, rounded fill', () => {
    expect(css).toMatch(
      /\*::-webkit-scrollbar-thumb\s*\{\s*\n\s*background-color:\s*var\(--ink-faint\);\s*\n\s*border:\s*none;\s*\n\s*border-radius:\s*999px;/,
    );
  });

  it('the WebKit track is transparent (no boxed-in border look)', () => {
    expect(css).toMatch(/\*::-webkit-scrollbar-track\s*\{\s*\n\s*background:\s*transparent;/);
  });

  // Blink drops every `::-webkit-scrollbar*` rule for an element whose STANDARD
  // scrollbar properties are set, and the `*` rule above sets both on every
  // element — so the styling above reached nothing, and the platform scrollbar
  // it fell back to is an auto-hiding overlay on macOS. The sidebar's two
  // scrolling bands reset both back to `auto` so their overflow is always
  // visibly a scrollbar (spec/14 § Sidebar → Scroll regions). BOTH have to be
  // reset: either one left set keeps the pseudo-elements ignored.
  it('the sidebar’s scrolling bands opt back in to the app’s own scrollbar', () => {
    expect(css).toMatch(
      /\.sb-scroll,\s*\n\.sb-lifecycle\s*\{\s*\n\s*scrollbar-width:\s*auto;\s*\n\s*scrollbar-color:\s*auto;\s*\n\}/,
    );
  });
});
