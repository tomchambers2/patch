// JobPaneRoute — bridges the URL to the pane/tab layout (spec/14 § Panes and
// tabs). Mounted at `/jobs/new` and `/jobs/:id`, same shape as `ChatPaneRoute`.
// `jobId === 'new'` is the same "not yet saved" sentinel `JobEditorRoute`'s
// `isNew` check already used under the old `/jobs/new` route.

import { useEffect } from 'react';
import type { JSX } from 'react';
import { useParams } from 'react-router-dom';
import { PaneArea } from '../components/PaneArea.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import type { PatchWs } from '../api/ws.js';

export function JobPaneRoute({ ws }: { ws: PatchWs | null }): JSX.Element {
  const { id } = useParams<{ id?: string }>();
  const jobId = id ?? 'new';
  const openTab = useLayoutStore((s) => s.openTab);
  useEffect(() => {
    openTab({ kind: 'page', page: 'job', jobId });
  }, [jobId, openTab]);
  return <PaneArea ws={ws} />;
}
