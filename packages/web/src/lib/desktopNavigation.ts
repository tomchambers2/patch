// desktopNavigation — the renderer half of the desktop shell's "take me there"
// IPC (spec/09 § `### desktop`, spec/14 § Desktop shell).
//
// The shell's main process is the only thing that can see a native OS toast
// being clicked, and the only thing that owns the tray menu. Neither can route
// the SPA: the desktop surface IS the SPA in an Electron BrowserWindow, so main
// hands the destination back over the preload bridge (`patch:navigate`) and the
// renderer does the routing. Without this subscription main's send goes nowhere
// and a clicked notification just raises the window on whatever chat you were
// already reading.
//
// NO FALLBACK: a path the shell sends that is not an in-app route is surfaced
// as an error toast rather than being dropped or coerced into something
// plausible — a destination that silently does nothing is exactly the bug this
// exists to fix.

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getDesktopBridge } from './desktopBridge.js';
import { useUiStore } from '../stores/uiStore.js';
import { showBatch } from './batchNotifier.js';

/** In-app routes are absolute SPA paths; the shell never sends anything else. */
export function isInAppPath(path: unknown): path is string {
  return typeof path === 'string' && path.startsWith('/') && !path.startsWith('//');
}

/**
 * Subscribe to the shell's navigate requests for as long as the app is mounted.
 * Must be called from inside the router. No-op in a plain browser, which has no
 * shell and therefore no bridge.
 */
export function useDesktopNavigation(): void {
  const navigate = useNavigate();
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.onNavigate) return;
    return bridge.onNavigate(({ path }) => {
      // spec/09 § Batch check-in — not a real route: the batch view is a
      // sidebar-view toggle, not a page to navigate to.
      if (path === '/batch') {
        showBatch();
        return;
      }
      if (!isInAppPath(path)) {
        useUiStore
          .getState()
          .pushError(
            `The desktop app asked for a page that does not exist: ${JSON.stringify(path)}`,
          );
        return;
      }
      navigate(path);
    });
  }, [navigate]);
}
