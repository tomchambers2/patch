// spec/14 § Composer — opening a chat puts the cursor in the composer, so
// typing is what you do next without clicking the field first.
//
// The mechanism is `<Composer autoFocus key={chatId}>` on ChatRoute: the key
// remounts the composer on every client-side navigation into a chat (sidebar
// click, keyboard switch, the auto-advance after archiving), so the mount-time
// focus fires each time rather than only once per session. These lock both
// halves — that the prop is passed at all, and that the remount re-fires it —
// plus the guard that stops it stealing the cursor from a card that has
// already taken it for its own keys.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore, type ChatEventEntry } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { setActiveWs } from '../api/ws.js';

vi.mock('../api/rest.js', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
  },
}));

function row(chatId: string) {
  return {
    chatId,
    daemonId: 'd1',
    permissionMode: 'auto' as const,
    name: chatId,
    folder: 'foo',
    activity: 'idle' as const,
    status: 'active' as const,
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
  };
}

// One `hydrate()` call for every chat a test needs — it REPLACES the map.
function seed(chatIds: string[], timelines: Record<string, ChatEventEntry[]> = {}): void {
  useChatStore.getState().hydrate(chatIds.map(row));
  useChatStore.setState((s) => ({ timelines: { ...s.timelines, ...timelines } }));
}

// A "go to that chat" control rendered beside the route, so a chat switch runs
// through the real router the way a sidebar click does.
function GoTo({ to }: { to: string }): JSX.Element {
  const navigate = useNavigate();
  return (
    <button type="button" data-testid="go-to" onClick={() => navigate(`/chats/${to}`)}>
      go
    </button>
  );
}

function renderAt(chatId: string, switchTo?: string) {
  const ws = {
    send() {},
    requestReplay() {},
  } as unknown as Parameters<typeof ChatRoute>[0]['ws'];
  return render(
    <MemoryRouter initialEntries={[`/chats/${chatId}`]}>
      {switchTo ? <GoTo to={switchTo} /> : null}
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={ws} />} />
      </Routes>
    </MemoryRouter>,
  );
}

function composer(): HTMLElement {
  return screen.getByTestId('composer-input');
}

describe('ChatRoute — composer focus on chat open', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    useUiStore.setState({ pendingDiffByChat: {} });
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
  });
  afterEach(() => cleanup());

  it('puts the cursor in the composer when a chat is opened directly', () => {
    seed(['c-a']);
    renderAt('c-a');
    expect(document.activeElement).toBe(composer());
  });

  // The regression this guards: without `autoFocus` on ChatRoute's Composer the
  // above passes nowhere, and without `key={chatId}` the composer is reused
  // across the switch and the mount effect never runs a second time.
  it('re-focuses the composer on a switch to another chat', () => {
    seed(['c-a', 'c-b']);
    renderAt('c-a', 'c-b');
    const first = composer();
    expect(document.activeElement).toBe(first);

    // Move the cursor off the composer, then navigate the way a sidebar row
    // click does.
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    act(() => {
      screen.getByTestId('go-to').click();
    });

    const second = composer();
    expect(second).not.toBe(first);
    expect(document.activeElement).toBe(second);
    elsewhere.remove();
  });

  // A pending approval card focuses itself on mount so its documented 1/2/3
  // chords work immediately. Its effect runs before the composer's (it is
  // earlier in the tree), and the composer must leave that claim alone.
  it('leaves the cursor on a pending permission card', () => {
    const permission: ChatEventEntry = {
      seq: 1,
      kind: 'permission',
      tool: 'Write',
      requestId: 'req-1',
      at: 0,
    };
    seed(['c-perm'], { 'c-perm': [permission] });
    renderAt('c-perm');

    expect(document.activeElement).toBe(screen.getByTestId('permission'));
    expect(document.activeElement).not.toBe(composer());
  });

  it('takes nothing while the connection is down', () => {
    usePresenceStore.getState().setConnection('reconnecting');
    seed(['c-a']);
    renderAt('c-a');
    expect(document.activeElement).not.toBe(composer());
  });
});
