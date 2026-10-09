// spec/14 § New windows — lib/newWindow.ts. On the desktop shell these go
// through the Electron bridge (`window.patch.openWindow`); in a plain
// browser tab, where there is no bridge, they fall back to `window.open`
// under the SPA's `/app` base path.

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  openChatInNewWindow,
  openTabInNewWindow,
  openNewChatInNewWindow,
  openSidebarInNewWindow,
  SIDEBAR_WINDOW_SIZE,
} from '../lib/newWindow.js';
import { useDraftStore } from '../stores/draftStore.js';

afterEach(() => {
  delete (window as unknown as { patch?: unknown }).patch;
  vi.restoreAllMocks();
  useDraftStore.setState({ drafts: {}, order: [] });
});

describe('openChatInNewWindow', () => {
  // A chat window asks for no size at all — it wants the shell's ordinary
  // document-sized window, unlike the detached sidebar below.
  it('desktop: asks the bridge to open /chats/<id>?sidebar=hidden, with no size', () => {
    const openWindow = vi.fn();
    (window as unknown as { patch?: unknown }).patch = { openWindow };
    openChatInNewWindow('c1');
    expect(openWindow).toHaveBeenCalledWith('/chats/c1?sidebar=hidden', undefined);
  });

  it('browser: falls back to window.open under /app, noopener, new tab', () => {
    const spy = vi.spyOn(window, 'open').mockReturnValue(null);
    openChatInNewWindow('c1');
    expect(spy).toHaveBeenCalledWith('/app/chats/c1?sidebar=hidden', '_blank', 'noopener');
  });

  // A chat opened from a sidebar search result carries `?seq=N` (ChatRoute's
  // jump-to) in the opener's URL — the popout must land on that same message,
  // not the chat's latest, so it has to be forwarded rather than dropped.
  it('carries over the opener’s query string (e.g. a search result’s ?seq=N)', () => {
    const openWindow = vi.fn();
    (window as unknown as { patch?: unknown }).patch = { openWindow };
    openChatInNewWindow('c1', '?seq=42');
    expect(openWindow).toHaveBeenCalledWith('/chats/c1?seq=42&sidebar=hidden', undefined);
  });

  it('forces sidebar=hidden even if the opener’s URL had a different value', () => {
    const openWindow = vi.fn();
    (window as unknown as { patch?: unknown }).patch = { openWindow };
    openChatInNewWindow('c1', '?sidebar=shown&seq=7');
    expect(openWindow).toHaveBeenCalledWith('/chats/c1?sidebar=hidden&seq=7', undefined);
  });
});

describe('openNewChatInNewWindow', () => {
  it('desktop: mints a fresh draft and asks the bridge to open it with sidebar hidden', () => {
    const openWindow = vi.fn();
    (window as unknown as { patch?: unknown }).patch = { openWindow };
    openNewChatInNewWindow();
    const ids = Object.keys(useDraftStore.getState().drafts);
    expect(ids).toHaveLength(1);
    expect(openWindow).toHaveBeenCalledWith(`/chats/new?draft=${ids[0]}&sidebar=hidden`, undefined);
  });

  it('browser: falls back to window.open with the same minted draft path', () => {
    const spy = vi.spyOn(window, 'open').mockReturnValue(null);
    openNewChatInNewWindow();
    const ids = Object.keys(useDraftStore.getState().drafts);
    expect(spy).toHaveBeenCalledWith(
      `/app/chats/new?draft=${ids[0]}&sidebar=hidden`,
      '_blank',
      'noopener',
    );
  });

  it('leaves the CURRENT window alone — it only ever calls the bridge/window.open, never navigates', () => {
    const openWindow = vi.fn();
    (window as unknown as { patch?: unknown }).patch = { openWindow };
    const before = window.location.href;
    openNewChatInNewWindow();
    expect(window.location.href).toBe(before);
  });

  it('purges blank drafts and leaves an in-progress one intact, same as the normal New chat action', () => {
    const st = useDraftStore.getState();
    const withText = st.create();
    st.update(withText, { text: 'half-written thought' });
    const blank = st.create();
    const openWindow = vi.fn();
    (window as unknown as { patch?: unknown }).patch = { openWindow };
    openNewChatInNewWindow();
    const drafts = useDraftStore.getState().drafts;
    expect(drafts[withText]?.text).toBe('half-written thought');
    expect(drafts[blank]).toBeUndefined();
    expect(Object.keys(drafts)).toHaveLength(2);
  });
});

describe('openSidebarInNewWindow', () => {
  it('desktop: asks the bridge to open /sidebar-window at a sidebar width', () => {
    const openWindow = vi.fn();
    (window as unknown as { patch?: unknown }).patch = { openWindow };
    openSidebarInNewWindow();
    expect(openWindow).toHaveBeenCalledWith('/sidebar-window', SIDEBAR_WINDOW_SIZE);
  });

  it('browser: window.open carries the same size in the features string', () => {
    const spy = vi.spyOn(window, 'open').mockReturnValue(null);
    openSidebarInNewWindow();
    expect(spy).toHaveBeenCalledWith(
      '/app/sidebar-window',
      '_blank',
      `noopener,width=${SIDEBAR_WINDOW_SIZE.width},height=${SIDEBAR_WINDOW_SIZE.height}`,
    );
  });

  // spec/14 § Layout — desktop: the sidebar drags between 200 and 600, and a
  // detached one opens somewhere inside that, not at a document's width.
  it('opens at a width the docked sidebar could itself be dragged to', () => {
    expect(SIDEBAR_WINDOW_SIZE.width).toBeGreaterThanOrEqual(200);
    expect(SIDEBAR_WINDOW_SIZE.width).toBeLessThanOrEqual(600);
  });
});

describe('openTabInNewWindow', () => {
  // Unlike openChatInNewWindow, no `?sidebar=hidden` — the popout window is a
  // bare route (AppShell's isBareRoute) with no sidebar or pane area to hide
  // in the first place. `?tabWindow=1` opts the new window's own
  // `layoutStore` out of persistence (see layoutStore.ts's `isTabWindow`).
  it('desktop: asks the bridge to open /tab-window with the encoded descriptor, no size', () => {
    const openWindow = vi.fn();
    (window as unknown as { patch?: unknown }).patch = { openWindow };
    openTabInNewWindow({ kind: 'file', chatId: 'c1', path: 'src/a.ts' });
    expect(openWindow).toHaveBeenCalledWith(
      `/tab-window?tabWindow=1&tab=${encodeURIComponent(
        JSON.stringify({ kind: 'file', chatId: 'c1', path: 'src/a.ts' }),
      )}`,
      undefined,
    );
  });

  it('browser: falls back to window.open under /app, noopener, new tab', () => {
    const spy = vi.spyOn(window, 'open').mockReturnValue(null);
    openTabInNewWindow({ kind: 'terminal', chatId: 'c1' });
    expect(spy).toHaveBeenCalledWith(
      `/app/tab-window?tabWindow=1&tab=${encodeURIComponent(
        JSON.stringify({ kind: 'terminal', chatId: 'c1' }),
      )}`,
      '_blank',
      'noopener',
    );
  });

  it('leaves the CURRENT window alone — it only ever calls the bridge/window.open', () => {
    const openWindow = vi.fn();
    (window as unknown as { patch?: unknown }).patch = { openWindow };
    const before = window.location.href;
    openTabInNewWindow({ kind: 'page', page: 'jobs' });
    expect(window.location.href).toBe(before);
  });
});
