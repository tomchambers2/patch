// PadPane — a Pad open in a pane (spec/14 § Pads). The editor (View/Edit,
// Select/Note/Draw, Desktop/Phone, the screen list, the numbered changes and
// Send) is the Pad's own page, served by the server from a signed URL and shown
// in a frame: it reaches into the design's document to edit it, which has to be
// same-origin. The pane around it is Patch's: the Pad's name, the app and chat
// it belongs to, a way back to that chat, and delete.
//
// The editor tells this pane what it holds (`pad:state`) so the Pads list and
// the sidebar count follow edits at once instead of waiting for their poll.

import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Trash2 } from 'lucide-react';
import { api } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { deriveChatTitle } from '../lib/chatTitle.js';
import { failed } from '../lib/errorCopy.js';
import { InlineEditText } from './InlineEditText.js';
import { PadBadge } from './PadsPage.js';
import { usePadsStore } from '../stores/padsStore.js';

export function PadPane({ padId }: { padId: string }): JSX.Element {
  const qc = useQueryClient();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const pushError = useUiStore((s) => s.pushError);
  const { data: pad, error } = useQuery({
    queryKey: ['pad', padId],
    queryFn: () => api.getPad(padId),
    refetchInterval: 5000,
  });
  const chatName = useChatStore((s) =>
    pad
      ? s.chats[pad.chatId]?.name === undefined
        ? pad.chatId
        : deriveChatTitle(s.chats[pad.chatId]?.name ?? null)
      : '',
  );

  useEffect(() => {
    function onMessage(e: MessageEvent): void {
      if (e.source !== frameRef.current?.contentWindow) return;
      const d = e.data as { type?: string; id?: string };
      if (d?.type !== 'pad:state' || d.id !== padId) return;
      void qc.invalidateQueries({ queryKey: ['pad', padId] });
      void usePadsStore.getState().refresh();
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [padId, qc]);

  const rename = useMutation({
    mutationFn: (name: string) => api.patchPad(padId, { name }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pad', padId] });
      void usePadsStore.getState().refresh();
    },
    onError: (e) => pushError(failed('rename'), undefined, (e as Error).message),
  });

  async function remove(): Promise<void> {
    const ok = await useUiStore.getState().confirm({
      title: 'Delete this Pad?',
      message: 'Its screens and any changes not yet sent are removed.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.deletePad(padId);
    } catch (e) {
      pushError(failed('delete'), undefined, (e as Error).message);
      return;
    }
    const layout = useLayoutStore.getState();
    const found = layout.findTab({ kind: 'page', page: 'pad', padId });
    if (found) layout.closeTab(found.pane.id, found.tab.id);
    void usePadsStore.getState().refresh();
  }

  if (error) {
    return (
      <div className="route-error" data-testid="pad-error">
        Failed to load this pad: {(error as Error).message}
      </div>
    );
  }
  if (!pad) return <main className="pad-pane" data-testid="pad-pane" />;

  return (
    <main className="pad-pane" data-testid="pad-pane">
      <header className="pad-pane-head">
        <div className="pad-pane-title">
          <h1 className="display">
            <InlineEditText
              value={pad.name}
              onCommit={(name) => rename.mutate(name)}
              className="pad-pane-name"
              editLabel="Rename pad"
              testId="pad-name"
            />
          </h1>
          <div className="pad-pane-sub">
            {pad.app ? <span>{pad.app}</span> : null}
            <span>{chatName}</span>
            <PadBadge pad={pad} />
          </div>
        </div>
        <div className="pad-pane-actions">
          <button
            type="button"
            className="head-action"
            data-testid="pad-open-chat"
            aria-label="Open chat"
            title="Open chat"
            onClick={() => useLayoutStore.getState().openTab({ kind: 'chat', chatId: pad.chatId })}
          >
            <MessageSquare size={16} aria-hidden />
          </button>
          <button
            type="button"
            className="head-action"
            data-testid="pad-delete"
            aria-label="Delete pad"
            title="Delete"
            onClick={() => void remove()}
          >
            <Trash2 size={16} aria-hidden />
          </button>
        </div>
      </header>
      {pad.screensError ? (
        <div className="route-error" data-testid="pad-screens-error">
          This pad's screens could not be read: {pad.screensError}
        </div>
      ) : (
        <iframe
          ref={frameRef}
          className="pad-frame"
          data-testid="pad-frame"
          title={pad.name}
          src={pad.frameUrl}
        />
      )}
    </main>
  );
}
