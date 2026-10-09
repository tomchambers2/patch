// Unit tests for the web panel LAYOUT math (pure, electron-free).
//
// The InAppBrowser controller itself drives real WebContentsViews and is
// exercised by the real-Electron smoke (scripts/smoke-in-app-browser.cjs). Here
// we lock down the geometry: spec/14 § "Links and the web panel" says the panel
// is a RIGHT-DOCKED SIDE PANEL (like Claude Code's), not a full-window
// takeover — so it must leave the Patch UI a usable column to its left.
//
// Imports the LAYOUT module, not in-app-browser: that one imports electron,
// which throws at module load on any machine without an Electron binary, so this
// whole file failed there — for reasons having nothing to do with the geometry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLayout,
  panelWidthFor,
  panelFractionFor,
  TOOLBAR_HTML,
  TOOLBAR_HEIGHT,
  PANEL_MIN_WIDTH,
  PANEL_WIDTH_FRACTION,
  PANEL_MAX_FRACTION,
} from './in-app-browser-layout';

test('the panel docks to the RIGHT edge and leaves the app visible beside it', () => {
  const { toolbar, page, panelWidth } = computeLayout({ width: 1200, height: 800 });
  // A fraction of the window, not the whole thing.
  assert.equal(panelWidth, Math.round(1200 * PANEL_WIDTH_FRACTION));
  assert.ok(panelWidth < 1200, 'panel must not take the full window');
  // Both views start at the same x — the panel's left edge, at the right side.
  assert.equal(toolbar.x, 1200 - panelWidth);
  assert.equal(page.x, 1200 - panelWidth);
  assert.equal(toolbar.x + toolbar.width, 1200, 'panel is flush with the right edge');
  assert.equal(toolbar.width, panelWidth);
  assert.equal(page.width, panelWidth);
});

test('inside the panel the toolbar sits above the page, exactly tiling its height', () => {
  const { toolbar, page } = computeLayout({ width: 1200, height: 800 });
  assert.equal(toolbar.y, 0);
  assert.equal(toolbar.height, TOOLBAR_HEIGHT);
  assert.equal(page.y, toolbar.y + toolbar.height); // no overlap, no gap
  assert.equal(toolbar.height + page.height, 800); // full height of the window
});

test('panelWidthFor floors at PANEL_MIN_WIDTH on a narrow window', () => {
  // 600 * fraction would be under the floor, so the floor wins.
  assert.equal(panelWidthFor(600), PANEL_MIN_WIDTH);
});

test('panelWidthFor never exceeds the window width (tiny windows)', () => {
  assert.equal(panelWidthFor(200), 200);
  assert.equal(panelWidthFor(0), 0);
  assert.equal(panelWidthFor(-50), 0);
});

test('computeLayout rounds fractional device sizes to whole pixels', () => {
  const { toolbar, page, panelWidth } = computeLayout({ width: 1000.6, height: 700.4 });
  assert.equal(panelWidth, Math.round(1001 * PANEL_WIDTH_FRACTION));
  assert.equal(toolbar.width, panelWidth);
  assert.equal(page.height, 700 - TOOLBAR_HEIGHT); // 700 rounded, minus toolbar
});

test('computeLayout clamps negative / zero sizes to a non-negative rect', () => {
  const { toolbar, page, panelWidth } = computeLayout({ width: -50, height: -10 });
  assert.equal(panelWidth, 0);
  assert.equal(toolbar.width, 0);
  assert.equal(toolbar.height, 0); // can't be taller than the (0) content
  assert.equal(page.width, 0);
  assert.equal(page.height, 0);
  assert.ok(page.y >= 0);
  assert.ok(toolbar.x >= 0);
});

test('a window shorter than the toolbar gives the toolbar all the height and the page none', () => {
  const { toolbar, page } = computeLayout({ width: 900, height: 20 }, 44);
  assert.equal(toolbar.height, 20);
  assert.equal(page.y, 20);
  assert.equal(page.height, 0);
});

test('panelWidthFor honours a dragged fraction, not just the default', () => {
  // The divider drags the panel's SHARE, not a fixed pixel width — the same
  // window at a wider share is a wider panel (spec/14 § Links and the web
  // panel: "drag-resizable like every other column").
  assert.equal(panelWidthFor(1000, 0.6), 600);
  assert.equal(panelWidthFor(1000), Math.round(1000 * PANEL_WIDTH_FRACTION), 'default unchanged');
});

test('computeLayout threads the dragged fraction through to the panel width', () => {
  const { panelWidth } = computeLayout({ width: 1000, height: 800 }, TOOLBAR_HEIGHT, 0.6);
  assert.equal(panelWidth, 600);
});

test('panelFractionFor clamps a drag below PANEL_MIN_WIDTH up to the floor', () => {
  // Dragging the panel almost shut still leaves it at the usable floor, not a
  // sliver — same floor panelWidthFor itself enforces.
  const fraction = panelFractionFor(10, 1000);
  assert.equal(panelWidthFor(1000, fraction), PANEL_MIN_WIDTH);
});

test('panelFractionFor clamps a drag past PANEL_MAX_FRACTION down to the ceiling', () => {
  // Spec: "max leaves the sidebar and a usable chat column visible (~85%, as
  // the editor rail)" — a drag toward the far edge cannot swallow the window.
  const fraction = panelFractionFor(950, 1000);
  assert.equal(panelWidthFor(1000, fraction), Math.round(1000 * PANEL_MAX_FRACTION));
});

test('panelFractionFor round-trips an in-range drag back to the same pixel width', () => {
  const fraction = panelFractionFor(550, 1000);
  assert.equal(panelWidthFor(1000, fraction), 550);
});

test('a fraction chosen at one window width keeps its SHARE at another (window resize)', () => {
  // spec/14: "window resizes keep the same share." The stored fraction, not a
  // remembered pixel width, is what a resize re-applies.
  const fraction = panelFractionFor(600, 1000); // 60% at a 1000px window
  assert.equal(panelWidthFor(2000, fraction), 1200); // still 60% at 2000px
});

test('the toolbar carries an open-in-browser button wired to the bridge', () => {
  // spec/14: "open in browser" is the escape hatch out of the embedded panel.
  assert.match(TOOLBAR_HTML, /title="Open in browser"/);
  assert.match(TOOLBAR_HTML, /window\.iab\.openExternal\(\)/);
});

test('the toolbar address-bar text keeps the query string (Todoist: open-in-browser was not copying it over)', () => {
  // Runs the toolbar's actual <script> body against fake DOM/bridge stand-ins,
  // rather than regex-matching the source, so this fails if the query string
  // is ever dropped again regardless of how the display line is phrased.
  const scriptMatch = TOOLBAR_HTML.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(scriptMatch, 'toolbar <script> not found in TOOLBAR_HTML');
  const scriptBody = scriptMatch[1];
  assert.ok(scriptBody, 'toolbar <script> body was empty');

  const urlEl: { textContent: string } = { textContent: '' };
  const elements: Record<
    string,
    { textContent?: string; disabled?: boolean; onclick?: () => void }
  > = {
    back: {},
    fwd: {},
    reload: {},
    url: urlEl,
    ext: {},
    close: {},
  };
  let onState:
    | ((s: { url: string; canGoBack: boolean; canGoForward: boolean }) => void)
    | undefined;
  const fakeWindow = {
    iab: {
      back(): void {},
      forward(): void {},
      reload(): void {},
      close(): void {},
      openExternal(): void {},
      onState(cb: typeof onState): void {
        onState = cb;
      },
    },
  };
  const fakeDocument = { getElementById: (id: string) => elements[id] };

  new Function('window', 'document', scriptBody)(fakeWindow, fakeDocument);

  assert.ok(onState, 'toolbar script never registered window.iab.onState');
  onState!({
    url: 'https://example.com/chats/123?sidebar=hidden',
    canGoBack: false,
    canGoForward: false,
  });
  assert.equal(urlEl.textContent, 'example.com/chats/123?sidebar=hidden');
});
