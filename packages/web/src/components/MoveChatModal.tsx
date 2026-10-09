// Move a chat to another host (spec/04 § Moving a chat to another host,
// spec/14 § Chat header). Pick the machine, then the folder the chat will run
// in there — offered from that machine's own folders, the one with the same
// name as the chat's current folder chosen first, else the first it offers —
// or type a path. The chat
// stays where it is until the server says it has arrived; a refusal keeps the
// dialog open with the reason.

import { useEffect, useMemo, useState, type JSX } from 'react';
import { defaultMoveFolder } from '@patch/wire';
import { api, ApiError } from '../api/rest.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import type { ChatRow } from '../stores/types.js';

function hostName(h: { daemonId: string; host: { hostName: string } | null }): string {
  return h.host?.hostName ?? h.daemonId;
}

export function MoveChatModal({
  row,
  onClose,
}: {
  row: ChatRow;
  onClose: () => void;
}): JSX.Element {
  const hosts = usePresenceStore((s) => s.hosts);
  const targets = useMemo(
    () =>
      Object.values(hosts)
        .filter((h) => h.daemonId !== row.daemonId)
        .sort((a, b) => hostName(a).localeCompare(hostName(b))),
    [hosts, row.daemonId],
  );
  const [daemonId, setDaemonId] = useState<string | null>(
    () => targets.find((h) => h.online)?.daemonId ?? null,
  );
  const folders = useMemo(() => {
    const f = daemonId ? hosts[daemonId]?.folders : null;
    return [...new Set([...(f?.roots ?? []), ...(f?.recent ?? [])])];
  }, [hosts, daemonId]);
  const [folder, setFolder] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  // A new machine offers its own folder — never the path typed for another one.
  useEffect(() => {
    setFolder(defaultMoveFolder(row.folder, folders) ?? '');
    setError(null);
  }, [daemonId, folders, row.folder]);

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape' && !moving) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moving, onClose]);

  async function move(): Promise<void> {
    if (!daemonId || folder.trim().length === 0) return;
    setMoving(true);
    setError(null);
    try {
      await api.moveChat(row.chatId, daemonId, folder.trim());
      onClose();
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { message?: unknown } | null) : null;
      setError(typeof body?.message === 'string' ? body.message : (e as Error).message);
    } finally {
      setMoving(false);
    }
  }

  const current = hosts[row.daemonId];
  return (
    <div className="modal-overlay" data-testid="move-chat-modal-overlay">
      <div className="modal-backdrop" onClick={() => (moving ? undefined : onClose())} />
      <div
        className="modal-card move-chat-modal"
        data-testid="move-chat-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Move chat"
      >
        <h2 className="modal-title">Move chat</h2>
        <p className="modal-message move-chat-from" data-testid="move-chat-from">
          {current ? hostName(current) : row.daemonId} · {row.folder}
        </p>
        <div className="move-chat-hosts" role="radiogroup" aria-label="Machine">
          {targets.map((h) => (
            <button
              key={h.daemonId}
              type="button"
              role="radio"
              aria-checked={daemonId === h.daemonId}
              className={`move-chat-host${daemonId === h.daemonId ? ' is-selected' : ''}`}
              data-testid={`move-chat-host-${h.daemonId}`}
              disabled={!h.online || moving}
              onClick={() => setDaemonId(h.daemonId)}
            >
              {hostName(h)}
              {h.online ? null : <span className="move-chat-offline"> · offline</span>}
            </button>
          ))}
        </div>
        {targets.length === 0 ? (
          <p className="modal-message" data-testid="move-chat-no-hosts">
            No other machine
          </p>
        ) : null}
        <input
          className="prompt-modal-input"
          data-testid="move-chat-folder"
          type="text"
          list="move-chat-folders"
          value={folder}
          placeholder="Folder on that machine"
          aria-label="Folder"
          disabled={!daemonId || moving}
          onChange={(e) => setFolder(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            void move();
          }}
        />
        <datalist id="move-chat-folders">
          {folders.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
        {error ? (
          <p className="move-chat-error" data-testid="move-chat-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button
            type="button"
            className="modal-btn"
            data-testid="move-chat-cancel"
            disabled={moving}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="modal-btn primary-btn"
            data-testid="move-chat-confirm"
            disabled={!daemonId || folder.trim().length === 0 || moving}
            onClick={() => void move()}
          >
            {moving ? 'Moving…' : 'Move'}
          </button>
        </div>
      </div>
    </div>
  );
}
