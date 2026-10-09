// The web panel's GEOMETRY and toolbar markup — pure, with no electron import.
//
// This is a separate module from in-app-browser.ts for one reason: importing
// electron outside an Electron runtime throws at module load, so anything in the
// same file as the InAppBrowser controller cannot be unit-tested at all. The
// geometry used to live there behind a comment claiming it was "pure so it can be
// unit-tested without Electron" — which was not true of the file it sat in, and
// its test failed on any machine without an Electron binary. Same seam-and-fake
// split as permissions.ts and context-menu.ts.
/** Height (px) of the toolbar strip at the top of the panel. */
export const TOOLBAR_HEIGHT = 44;

/** Default share of the window width the side panel takes, and what
 * double-clicking its divider resets to (spec/14 § Links and the web panel). */
export const PANEL_WIDTH_FRACTION = 0.42;

/** Narrowest usable panel (px) — below this a page is unreadable. */
export const PANEL_MIN_WIDTH = 360;

/** Widest share the divider drags to — the same ceiling the editor rail drags
 * to (spec/14 § Editor), leaving the sidebar and a usable chat column visible. */
export const PANEL_MAX_FRACTION = 0.85;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Layout {
  toolbar: Rect;
  page: Rect;
  /** Width (px) of the panel column — the inset the renderer must apply. */
  panelWidth: number;
}

/**
 * Width of the side panel for a window `contentWidth` px wide: `fraction` of the
 * window (the dragged share, defaulting to PANEL_WIDTH_FRACTION), floored at
 * PANEL_MIN_WIDTH, and never wider than the window itself (a window narrower
 * than the floor gives the panel the whole width). Never negative.
 */
export function panelWidthFor(contentWidth: number, fraction = PANEL_WIDTH_FRACTION): number {
  const w = Math.max(0, Math.round(contentWidth));
  return Math.min(w, Math.max(PANEL_MIN_WIDTH, Math.round(w * fraction)));
}

/**
 * The divider is dragged in PIXELS, but what persists (and what a window
 * resize must keep) is the SHARE of the window it represented — otherwise
 * widening the window would leave the panel at its old, now-proportionally-
 * narrower, pixel width instead of tracking the share the user actually chose.
 * Clamps the pixel value to [PANEL_MIN_WIDTH, PANEL_MAX_FRACTION of the window]
 * first, so the stored fraction is always one `panelWidthFor` can round-trip
 * back to the same pixel width.
 */
export function panelFractionFor(px: number, contentWidth: number): number {
  const w = Math.max(1, Math.round(contentWidth));
  const maxPx = Math.min(w, Math.round(w * PANEL_MAX_FRACTION));
  const minPx = Math.min(PANEL_MIN_WIDTH, maxPx);
  const clamped = Math.max(minPx, Math.min(maxPx, Math.round(px)));
  return clamped / w;
}

/**
 * Lay the panel out against the right edge of a content area of `content` size:
 * a full-height column `panelWidth` wide, with the toolbar taking its top
 * `toolbarHeight` px (clamped to the available height) and the page filling the
 * remainder. Sizes are rounded to whole device pixels and never go negative, so
 * the two rects always exactly tile the panel column with no overlap or gap.
 */
export function computeLayout(
  content: { width: number; height: number },
  toolbarHeight = TOOLBAR_HEIGHT,
  fraction = PANEL_WIDTH_FRACTION,
): Layout {
  const w = Math.max(0, Math.round(content.width));
  const h = Math.max(0, Math.round(content.height));
  const panelWidth = panelWidthFor(w, fraction);
  const x = w - panelWidth;
  const tb = Math.max(0, Math.min(Math.round(toolbarHeight), h));
  return {
    toolbar: { x, y: 0, width: panelWidth, height: tb },
    page: { x, y: tb, width: panelWidth, height: Math.max(0, h - tb) },
    panelWidth,
  };
}

/** Navigation state pushed to the toolbar renderer after each navigation. */
export interface IabState {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

/**
 * The toolbar UI — our own trusted HTML, loaded via a data: URL. Kept minimal
 * per the design principles (icon buttons with tooltips, no explainer text; the
 * current URL shown read-only). It drives the page purely through `window.iab`,
 * which iab-preload exposes over the context bridge, and reflects nav state
 * pushed on `iab.onState`.
 */
export const TOOLBAR_HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    display: flex; align-items: center; gap: 4px; height: 100%;
    padding: 0 8px; font: 13px -apple-system, system-ui, sans-serif;
    background: Canvas; color: CanvasText;
    border-bottom: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
    -webkit-user-select: none; user-select: none;
  }
  button {
    all: unset; cursor: pointer; width: 28px; height: 28px; border-radius: 6px;
    display: grid; place-items: center; font-size: 15px; color: CanvasText;
  }
  button:hover { background: color-mix(in srgb, CanvasText 10%, transparent); }
  button:disabled { opacity: 0.3; cursor: default; background: none; }
  #url {
    flex: 1; min-width: 0; height: 28px; line-height: 28px; padding: 0 10px;
    border-radius: 6px; background: color-mix(in srgb, CanvasText 7%, transparent);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-variant-numeric: tabular-nums; opacity: 0.85;
  }
</style></head><body>
  <button id="back" title="Back">&#8249;</button>
  <button id="fwd" title="Forward">&#8250;</button>
  <button id="reload" title="Reload">&#8635;</button>
  <div id="url"></div>
  <button id="ext" title="Open in browser">&#8599;</button>
  <button id="close" title="Close">&#10005;</button>
<script>
  const $ = (id) => document.getElementById(id);
  $('back').onclick = () => window.iab.back();
  $('fwd').onclick = () => window.iab.forward();
  $('reload').onclick = () => window.iab.reload();
  $('ext').onclick = () => window.iab.openExternal();
  $('close').onclick = () => window.iab.close();
  window.iab.onState((s) => {
    $('back').disabled = !s.canGoBack;
    $('fwd').disabled = !s.canGoForward;
    try {
      const u = new URL(s.url);
      $('url').textContent = u.host + u.pathname + u.search;
    } catch { $('url').textContent = s.url || ''; }
  });
</script></body></html>`;
