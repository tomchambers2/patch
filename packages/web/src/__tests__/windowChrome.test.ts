// spec/05 § Desktop packaging → Window chrome. Which windows have to reserve
// the traffic lights' strip, and which must NOT.

import { describe, it, expect, afterEach } from 'vitest';
import {
  hasOverlayTitleBar,
  applyOverlayTitleBarClass,
  OVERLAY_TITLE_BAR_CLASS,
} from '../lib/windowChrome.js';

describe('hasOverlayTitleBar', () => {
  it('a plain browser gets no inset — it has a real title bar', () => {
    expect(hasOverlayTitleBar({ overlayTitleBar: false, pathname: '/app/chats/c1' })).toBe(false);
    // Even on a route the shell also serves.
    expect(hasOverlayTitleBar({ overlayTitleBar: false, pathname: '/app/sidebar-window' })).toBe(
      false,
    );
  });

  it('the shell document windows reserve the strip', () => {
    for (const pathname of [
      '/app/',
      '/app/chats/c1',
      '/app/settings',
      // A chat detached into its own window (spec/14 § New windows).
      '/app/chats/c1',
      // The detached sidebar is a real child window, so it has traffic lights
      // too — unlike the popovers below.
      '/app/sidebar-window',
      // The dev harness, which is how e2e measures this.
      '/app/dev-harness.html',
    ]) {
      expect(hasOverlayTitleBar({ overlayTitleBar: true, pathname })).toBe(true);
    }
  });

  it('the frameless popovers do NOT — indenting them would be for lights that are not there', () => {
    // The tray popover and voice overlay are opened `frame: false`: no title
    // bar, and no traffic lights either.
    for (const route of ['/menubar', '/voice-overlay']) {
      expect(hasOverlayTitleBar({ overlayTitleBar: true, pathname: route })).toBe(false);
      // Production serves the SPA under a /app base path.
      expect(hasOverlayTitleBar({ overlayTitleBar: true, pathname: `/app${route}` })).toBe(false);
    }
  });
});

describe('applyOverlayTitleBarClass', () => {
  afterEach(() => {
    document.documentElement.classList.remove(OVERLAY_TITLE_BAR_CLASS);
  });

  it('marks the document only when this window actually lost its title bar', () => {
    const root = document.documentElement;
    applyOverlayTitleBarClass(root, { overlayTitleBar: true, pathname: '/app/chats/c1' });
    expect(root.classList.contains(OVERLAY_TITLE_BAR_CLASS)).toBe(true);

    // Same document, popover route: the class comes back off rather than
    // lingering and indenting a window with no lights.
    applyOverlayTitleBarClass(root, { overlayTitleBar: true, pathname: '/app/menubar' });
    expect(root.classList.contains(OVERLAY_TITLE_BAR_CLASS)).toBe(false);

    applyOverlayTitleBarClass(root, { overlayTitleBar: false, pathname: '/app/chats/c1' });
    expect(root.classList.contains(OVERLAY_TITLE_BAR_CLASS)).toBe(false);
  });
});
