// The chat panel when `/chats/:chatId` names a chat this surface has no row
// for (spec/14 § Main chat panel — Unknown chat).
//
// Two different situations share that shape and must not look the same:
//
//   - The roster has not landed yet. Every cold start passes through this for a
//     moment, so it says nothing more than that it is loading and offers no
//     actions — a "not found" flashed here would be a lie.
//   - The roster HAS landed and the chat is not in it. The cold-start roster is
//     the active inbox only, so this is the ordinary state of an archived,
//     snoozed or deleted chat opened straight from its URL: it exists, it is
//     just not in the snapshot. So the chat is looked up by id, which either
//     produces the row (and the chat opens normally) or 404s — the only answer
//     that means the chat really is gone.
//
// NO FALLBACK: a lookup that fails for any other reason says so, with the
// server's own message, rather than presenting itself as "not found".

import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';

type LookupState =
  | { phase: 'looking' }
  | { phase: 'absent' }
  | { phase: 'failed'; message: string };

export function ChatNotFound({ chatId }: { chatId: string }): JSX.Element {
  const hydrated = useChatStore((s) => s.hydrated);
  const mergeChats = useChatStore((s) => s.mergeChats);
  const [state, setState] = useState<LookupState>({ phase: 'looking' });
  // Bumped by Retry to re-run the lookup effect.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Nothing to conclude from an absent row until the roster has arrived.
    if (!hydrated) return;
    let cancelled = false;
    setState({ phase: 'looking' });
    void (async () => {
      try {
        const c = await api.getChat(chatId);
        if (cancelled) return;
        // NO FALLBACK: a 200 that isn't a chat row is a broken server, not a
        // chat. Merging it anyway seeds a row with no folder and takes the
        // sidebar's grouping down with it, which reads as a crash somewhere
        // else entirely.
        if (typeof c?.chatId !== 'string' || typeof c?.folder !== 'string') {
          throw new Error(`malformed chat row: ${JSON.stringify(c)}`);
        }
        // Merge, not hydrate: this row is an addition to the active snapshot,
        // not a replacement for it.
        mergeChats([
          {
            chatId: c.chatId,
            name: c.name,
            preview: c.preview,
            goal: c.goal,
            reminder: c.reminder,
            pendingWake: c.pendingWake,
            todos: c.todos,
            daemonId: c.daemonId,
            permissionMode: c.permissionMode,
            folder: c.folder,
            activity: c.activity,
            status: c.status,
            pinned: c.pinned,
            pinnedAt: c.pinnedAt,
            disabled: c.disabled,
            lastUpdated: c.lastUpdated,
            jobId: c.jobId,
            // A hidden chat reached by URL must stay out of the active list
            // (spec/04 § Hidden) — it is exactly the kind of row this fetch finds.
            hidden: c.hidden,
          },
        ]);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404) {
          setState({ phase: 'absent' });
          return;
        }
        setState({ phase: 'failed', message: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatId, hydrated, attempt, mergeChats]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  if (!hydrated || state.phase === 'looking') {
    return (
      <main className="chat-main" data-testid="chat-main-loading">
        <div className="chat-missing">
          <p className="chat-missing-note">Loading chat…</p>
        </div>
      </main>
    );
  }

  return (
    <main className="chat-main" data-testid="chat-main-empty">
      <div className="chat-missing">
        <h2 className="chat-missing-title">
          {state.phase === 'absent' ? 'Chat not found' : 'Could not load this chat'}
        </h2>
        <p className="chat-missing-note" data-testid="chat-missing-detail">
          {state.phase === 'absent' ? chatId : state.message}
        </p>
        <div className="chat-missing-actions">
          {/* `/` is the Manager thread (it redirects there), so this is one
              route rather than a second copy of that resolution. */}
          <Link to="/" className="primary-btn" data-testid="chat-missing-manager">
            Back to Manager
          </Link>
          <button
            type="button"
            className="secondary-btn"
            data-testid="chat-missing-retry"
            onClick={retry}
          >
            Retry
          </button>
        </div>
      </div>
    </main>
  );
}
