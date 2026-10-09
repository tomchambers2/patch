// PadsPage — where Pads live (spec/14 § Pads). Every design space Tom has, grouped
// by the app it designs for: a card with a picture of its first screen, the chat
// that owns it, whether the agent is working on a batch he sent or how many
// changes he has pending, and when it last moved. Click one to open it beside
// its chat; New Pad starts one.

import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { Layers, Plus } from 'lucide-react';
import type { PadView } from '../api/rest.js';
import { startPadsPolling, usePadsStore } from '../stores/padsStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { deriveChatTitle } from '../lib/chatTitle.js';
import { relativeTime } from '../lib/relativeTime.js';
import { openPadBesideChat } from '../lib/openPad.js';
import { NavHistoryControls } from './NavHistoryControls.js';

export function PadBadge({ pad }: { pad: PadView }): JSX.Element | null {
  if (pad.working) {
    return (
      <span className="pads-badge working" data-testid={`pad-badge-${pad.id}`}>
        <span className="pads-dot" />
        Working
      </span>
    );
  }
  if (pad.pending > 0) {
    return (
      <span className="pads-badge" data-testid={`pad-badge-${pad.id}`}>
        {pad.pending} {pad.pending === 1 ? 'change' : 'changes'}
      </span>
    );
  }
  return null;
}

export function PadThumb({ pad }: { pad: PadView }): JSX.Element {
  return (
    <div className={`pads-thumb${pad.device === 'phone' ? ' is-phone' : ''}`}>
      {pad.thumbUrl ? (
        <img src={pad.thumbUrl} alt="" />
      ) : pad.thumbError ? (
        <span className="pads-thumb-err" title={pad.thumbError}>
          No picture: {pad.thumbError}
        </span>
      ) : null}
    </div>
  );
}

export function PadsPage(): JSX.Element {
  const pads = usePadsStore((s) => s.pads);
  const error = usePadsStore((s) => s.error);
  useEffect(() => startPadsPolling(5000), []);
  const chats = useChatStore((s) => s.chats);
  const [query, setQuery] = useState('');
  const openTab = useLayoutStore((s) => s.openTab);

  const chatName = (chatId: string): string => {
    const name = chats[chatId]?.name;
    return name === undefined ? chatId : deriveChatTitle(name);
  };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = new Map<string, PadView[]>();
    for (const p of pads ?? []) {
      const hay = `${p.name} ${p.app ?? ''} ${chatName(p.chatId)}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      const key = p.app ?? 'No app';
      out.set(key, [...(out.get(key) ?? []), p]);
    }
    return [...out];
  }, [pads, query, chats]);

  if (error && pads === null) {
    return (
      <div className="route-error" data-testid="pads-error">
        Failed to load pads: {error}
        <button
          type="button"
          className="secondary-btn"
          onClick={() => void usePadsStore.getState().refresh()}
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <main className="pads-route" data-testid="pads-route">
      <header className="route-head">
        <div className="route-head-title">
          <NavHistoryControls />
          <h1 className="display">Pads</h1>
        </div>
        <input
          type="search"
          className="jobs-search"
          data-testid="pads-search"
          data-search-input
          placeholder="Search pads"
          aria-label="Search pads"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="primary-btn pads-new"
          data-testid="pads-new"
          onClick={() => openTab({ kind: 'page', page: 'new-pad' })}
        >
          <Plus size={16} aria-hidden /> New Pad
        </button>
      </header>
      {pads === null ? null : groups.length === 0 ? (
        <p className="jobs-no-matches" data-testid="pads-empty">
          {query ? 'No pads match.' : 'No pads yet.'}
        </p>
      ) : (
        groups.map(([app, pads]) => (
          <section key={app} data-testid={`pads-group-${app}`}>
            <h2 className="jobs-section-head">
              {app}
              <span className="pads-count">{pads.length}</span>
            </h2>
            <div className="pads-grid">
              {pads.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`pads-tile${p.device === 'phone' ? ' is-phone' : ''}`}
                  data-testid={`pad-tile-${p.id}`}
                  onClick={() => openPadBesideChat(p.id, p.chatId)}
                >
                  <PadThumb pad={p} />
                  <span className="pads-tile-body">
                    <span className="pads-tile-row">
                      <span className="pads-tile-title">
                        <Layers size={14} aria-hidden /> {p.name}
                      </span>
                      <PadBadge pad={p} />
                    </span>
                    <span className="pads-tile-meta">
                      <span className="pads-chat">{chatName(p.chatId)}</span>
                      <span className="pads-when">{relativeTime(p.updatedAt)}</span>
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ))
      )}
    </main>
  );
}
