// SettingsPaneRoute — bridges the URL to the pane/tab layout (spec/14 §
// Panes and tabs). Mounted at `/settings/*`, same shape as `ChatPaneRoute`.
//
// There is only ever one Settings tab — `SettingsRoute` holds which of its
// own sub-pages is on screen as its OWN state now, not a nested route (see
// its top-of-file note) — so a `/settings/<page>` deep link (an "Open
// Settings" banner/link elsewhere) seeds that sub-page via `requestSettingsPage`
// rather than a route param.

import { useEffect } from 'react';
import type { JSX } from 'react';
import { useParams } from 'react-router-dom';
import { PaneArea } from '../components/PaneArea.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { SETTINGS_PAGES } from './settings/pages.js';
import type { PatchWs } from '../api/ws.js';

export function SettingsPaneRoute({ ws }: { ws: PatchWs | null }): JSX.Element {
  const { '*': sub } = useParams<{ '*': string }>();
  const openTab = useLayoutStore((s) => s.openTab);
  const requestSettingsPage = useUiStore((s) => s.requestSettingsPage);
  useEffect(() => {
    openTab({ kind: 'page', page: 'settings' });
    const page = SETTINGS_PAGES.find((p) => p.id === sub);
    if (page) requestSettingsPage(page.id);
  }, [sub, openTab, requestSettingsPage]);
  return <PaneArea ws={ws} />;
}
