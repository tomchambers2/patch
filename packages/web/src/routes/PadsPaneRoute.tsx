// PadsPaneRoute — bridges the URL to the pane/tab layout for Pads (spec/14 §
// Pads), same shape as `JobsPaneRoute`. `/pads` is the list, `/pads/new` the New
// Pad form, `/pads/:id` a Pad opened beside its chat (what a link to a Pad
// resolves to).

import { useEffect } from 'react';
import type { JSX } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { PaneArea } from '../components/PaneArea.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { api } from '../api/rest.js';
import { openPadBesideChat } from '../lib/openPad.js';
import type { PatchWs } from '../api/ws.js';

export function PadsPaneRoute({
  ws,
  mode,
}: {
  ws: PatchWs | null;
  mode: 'list' | 'new' | 'open';
}): JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const openTab = useLayoutStore((s) => s.openTab);
  const { data: pad } = useQuery({
    queryKey: ['pad', id],
    queryFn: () => api.getPad(id),
    enabled: mode === 'open',
  });
  useEffect(() => {
    if (mode === 'list') openTab({ kind: 'page', page: 'pads' });
    if (mode === 'new') openTab({ kind: 'page', page: 'new-pad' });
  }, [mode, openTab]);
  useEffect(() => {
    if (mode === 'open' && pad) openPadBesideChat(pad.id, pad.chatId);
  }, [mode, pad]);
  return <PaneArea ws={ws} />;
}
