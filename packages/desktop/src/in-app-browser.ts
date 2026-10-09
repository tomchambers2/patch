// The embedded web panel — spec/14 § "Links and the web panel".
//
// Patch's own browser. Two things open it: a page PATCH wants to show you (an
// artifact, a preview, a page an agent asks to display), and a link the user
// chose to open in Patch rather than in their real browser — a plain click, or
// the right-click "Open Link in Patch" (link-policy.ts, context-menu.ts).
// It is a SIDE panel and its page can always be popped out to the real browser,
// which is what keeps it from trapping the user in a browser Patch is worse at
// being — an earlier version took over the whole window, and that did.
//
// Shape: a RIGHT-DOCKED SIDE PANEL, like Claude Code's — full height, a fraction
// of the window width, with the Patch UI inset by exactly that width so the chat
// and composer stay usable beside it. A slim toolbar strip sits at the top of
// the panel (back / forward / reload / open-in-browser / close), so the page can
// always be popped out to the real browser.
//
// Implementation: two Electron WebContentsViews layered onto the main window's
// contentView — a `toolbar` strip at the top of the panel column, and the `page`
// view filling the rest of it. The toolbar is our own trusted HTML (loaded from
// a data: URL) and talks to main over a dedicated preload (iab-preload). The
// page view hosts the remote site with node integration OFF.
//
// The geometry (computeLayout / panelWidthFor) lives in in-app-browser-layout.ts
// so it can be unit-tested without Electron: this file imports electron, which
// throws at module load outside an Electron runtime, so nothing sharing a file
// with the controller is testable at all. It is re-exported below so importers
// still see one module.
// The controller wiring is exercised by the real-Electron
// smoke (scripts/smoke-in-app-browser.cjs). NO FALLBACK: nothing here silently
// swallows a failed load — a broken page shows the browser's own error, and a
// missing toolbar preload throws at view creation.

import { BrowserWindow, WebContentsView, shell } from 'electron';
import { join } from 'node:path';

export {
  TOOLBAR_HEIGHT,
  PANEL_WIDTH_FRACTION,
  PANEL_MIN_WIDTH,
  PANEL_MAX_FRACTION,
  panelWidthFor,
  panelFractionFor,
  computeLayout,
  TOOLBAR_HTML,
} from './in-app-browser-layout';
export type { Rect, Layout, IabState } from './in-app-browser-layout';

import {
  computeLayout,
  panelFractionFor,
  PANEL_WIDTH_FRACTION,
  TOOLBAR_HTML,
  type IabState,
} from './in-app-browser-layout';

/**
 * The embedded-browser controller, bound to one parent BrowserWindow. Lazily
 * builds its two WebContentsViews on first open, then reuses them for
 * subsequent links (opening a new URL navigates the existing page view rather
 * than stacking panels). `close()` tears the views down and detaches the resize
 * listener; a later open() rebuilds them.
 */
export class InAppBrowser {
  private readonly parent: BrowserWindow;
  private pageView: WebContentsView | null = null;
  private toolbarView: WebContentsView | null = null;
  private url = '';
  private resizeBound = false;
  private readonly onResize = (): void => this.layout();
  /** Share of the window width the panel takes — the dragged/persisted value,
   * not always PANEL_WIDTH_FRACTION (spec/14 § Links and the web panel). */
  private fraction: number;

  constructor(parent: BrowserWindow, widthFraction = PANEL_WIDTH_FRACTION) {
    this.parent = parent;
    this.fraction = widthFraction;
  }

  isOpen(): boolean {
    return this.pageView !== null;
  }

  /**
   * The window this panel is docked into. There is one panel app-wide (the
   * toolbar's IPC channels are global), so `openInAppBrowser` compares this
   * against the window a link was clicked in and MOVES the panel when they
   * differ rather than opening a second one.
   */
  parentWindow(): BrowserWindow {
    return this.parent;
  }

  /** The controller is dead once its parent window is gone. */
  isDestroyed(): boolean {
    return this.parent.isDestroyed();
  }

  currentUrl(): string {
    return this.url;
  }

  /** Test/smoke introspection. */
  getPageView(): WebContentsView | null {
    return this.pageView;
  }

  getToolbarView(): WebContentsView | null {
    return this.toolbarView;
  }

  /** Open (or navigate to) `url` in the embedded browser. */
  open(url: string): void {
    if (this.parent.isDestroyed()) return;
    if (!this.pageView) this.createViews();
    this.url = url;
    void this.pageView!.webContents.loadURL(url);
    this.layout();
    this.pushState();
  }

  private createViews(): void {
    // Toolbar: our own HTML + the iab preload bridge (window.iab).
    const toolbar = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, 'iab-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    void toolbar.webContents.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(TOOLBAR_HTML),
    );
    this.toolbarView = toolbar;

    // Page: the remote site, sandboxed (no node integration, no preload).
    const page = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    // A window.open / target=_blank inside the embedded page navigates the SAME
    // panel rather than spawning an OS window or bouncing to the real browser.
    page.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://') || url.startsWith('https://')) this.open(url);
      return { action: 'deny' };
    });
    const refresh = (): void => {
      const current = page.webContents.getURL();
      if (current) this.url = current;
      this.pushState();
    };
    page.webContents.on('did-navigate', refresh);
    page.webContents.on('did-navigate-in-page', refresh);
    this.pageView = page;

    // Toolbar UNDER page in z-order doesn't matter — they don't overlap — but
    // add toolbar first so it paints behind if a rounding gap ever appears.
    this.parent.contentView.addChildView(toolbar);
    this.parent.contentView.addChildView(page);

    if (!this.resizeBound) {
      this.parent.on('resize', this.onResize);
      this.resizeBound = true;
    }
  }

  private layout(): void {
    if (!this.pageView || !this.toolbarView) return;
    const { width, height } = this.parent.getContentBounds();
    const { toolbar, page, panelWidth } = computeLayout(
      { width, height },
      undefined,
      this.fraction,
    );
    this.toolbarView.setBounds(toolbar);
    this.pageView.setBounds(page);
    this.pushInset(panelWidth);
  }

  /** The panel's current share of the window (persisted by the caller). */
  getWidthFraction(): number {
    return this.fraction;
  }

  /**
   * The divider is being dragged to `px` (spec/14 § Links and the web panel:
   * "drag-resizable like every other column"). Re-lays out the real
   * WebContentsViews and re-pushes the inset immediately, so the page and the
   * Patch UI follow the pointer live rather than snapping into place on
   * release. A no-op while the panel is closed — there is nothing to resize.
   */
  resizeTo(px: number): void {
    if (!this.pageView || !this.toolbarView) return;
    const { width } = this.parent.getContentBounds();
    this.fraction = panelFractionFor(px, width);
    this.layout();
  }

  /** Double-click on the divider: back to the default share. */
  resetWidth(): void {
    this.fraction = PANEL_WIDTH_FRACTION;
    if (this.pageView) this.layout();
  }

  /**
   * Tell the Patch renderer how much room the panel is taking so it can inset
   * itself by exactly that much — the difference between a SIDE panel and an
   * overlay that covers the chat and composer (spec/14 § Links and the web
   * panel). `0` on close restores the full-width app.
   */
  private pushInset(width: number): void {
    if (this.parent.isDestroyed()) return;
    const wc = this.parent.webContents;
    if (wc.isDestroyed()) return;
    wc.send('patch:panel-inset', { width });
  }

  private pushState(): void {
    if (!this.toolbarView || this.toolbarView.webContents.isDestroyed()) return;
    const wc = this.pageView?.webContents;
    const state: IabState = {
      url: this.url,
      canGoBack: wc ? wc.canGoBack() : false,
      canGoForward: wc ? wc.canGoForward() : false,
    };
    const tb = this.toolbarView.webContents;
    const send = (): void => {
      if (this.toolbarView && !this.toolbarView.webContents.isDestroyed()) {
        tb.send('patch:iab:state', state);
      }
    };
    // The toolbar's data: URL loads async; a state push right after createViews
    // would be dropped before the renderer registers its onState listener.
    if (tb.isLoading()) tb.once('did-finish-load', send);
    else send();
  }

  goBack(): void {
    const wc = this.pageView?.webContents;
    if (wc && wc.canGoBack()) wc.goBack();
  }

  goForward(): void {
    const wc = this.pageView?.webContents;
    if (wc && wc.canGoForward()) wc.goForward();
  }

  reload(): void {
    this.pageView?.webContents.reload();
  }

  /** Pop the current page out to the user's real browser, then close the panel. */
  openExternal(): void {
    if (this.url) void shell.openExternal(this.url);
    this.close();
  }

  close(): void {
    if (this.resizeBound) {
      this.parent.removeListener('resize', this.onResize);
      this.resizeBound = false;
    }
    for (const view of [this.pageView, this.toolbarView]) {
      if (!view) continue;
      try {
        this.parent.contentView.removeChildView(view);
        view.webContents.close();
      } catch {
        // View/webContents may already be gone (parent destroyed) — detaching
        // is best-effort; we're tearing it all down regardless.
      }
    }
    this.pageView = null;
    this.toolbarView = null;
    this.url = '';
    this.pushInset(0); // panel gone — give the app its full width back.
  }
}
