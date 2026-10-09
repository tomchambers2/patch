// TabWindowRoute (/tab-window?tabWindow=1&tab=<encoded TabDescriptor>) — a
// single tab detached into its own window (spec/14 § Panes and tabs —
// "detach into its own window"), reached only via `lib/newWindow.ts`'s
// `openTabInNewWindow`.
//
// Each `window.open`/Electron BrowserWindow is a separate JS execution
// context with its own `useLayoutStore` instance, and `?tabWindow=1` opts
// THIS window's instance out of `localStorage` persistence (`layoutStore.ts`'s
// `isTabWindow`) — so it opens with nothing but the one tab named in `tab`,
// and never overwrites the opener's own saved layout. Mirrors
// `SidebarWindowRoute.tsx`'s shape: a bare route, no sidebar, just this one
// surface filling the window.

import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PaneArea } from '../components/PaneArea.js';
import { useLayoutStore, isTabDescriptor } from '../stores/layoutStore.js';
import type { PatchWs } from '../api/ws.js';

export function TabWindowRoute({ ws }: { ws: PatchWs | null }): JSX.Element {
  const [searchParams] = useSearchParams();
  const openTab = useLayoutStore((s) => s.openTab);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const raw = searchParams.get('tab');
    if (raw === null) {
      setError('No tab to show.');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      setError('Malformed tab.');
      return;
    }
    if (!isTabDescriptor(parsed)) {
      setError('Malformed tab.');
      return;
    }
    openTab(parsed);
    // Read once at mount — this window's URL is immutable for its lifetime.
  }, []);

  if (error) {
    return (
      <div className="editor-window" data-testid="tab-window-error">
        {error}
      </div>
    );
  }

  return (
    <div className="editor-window" data-testid="tab-window">
      <PaneArea ws={ws} />
    </div>
  );
}
