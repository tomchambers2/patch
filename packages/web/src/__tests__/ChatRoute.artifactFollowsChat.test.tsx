// spec/14 § Artifacts — an opened artifact is OWNED by the chat it was opened
// in. The desktop web panel shows the CURRENT chat's artifact: switching away
// closes it (or swaps in the other chat's), switching back re-opens it, leaving
// the chat route closes it, and a panel the USER closed is forgotten rather
// than resurrected on the next visit.
//
// The bridge is stubbed on `window.patch` exactly as ChatRoute.artifact.test.tsx
// does; the plain web surface has neither method and is proved to be untouched.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatRoute } from '../routes/ChatRoute.js';
import { SettingsRoute } from '../routes/SettingsRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { _resetArtifactPanel } from '../lib/artifactPanel.js';
import type { WireEvent } from '@patch/wire';

const artifact = (chatId: string, artifactId: string, title: string): WireEvent =>
  ({
    type: 'chat.artifact',
    chatId,
    artifactId,
    title,
    url: `/api/chats/${chatId}/artifact/${artifactId}`,
    path: `out/${artifactId}.html`,
    updatedAt: 1_700_000_000_000,
    seq: 4,
  }) as WireEvent;

/** The panel bridge, plus a hook to fire an inset back at the renderer. */
function stubBridge(): {
  openPanel: ReturnType<typeof vi.fn>;
  closePanel: ReturnType<typeof vi.fn>;
  fireInset: (width: number) => void;
} {
  const listeners: ((e: { width: number }) => void)[] = [];
  const openPanel = vi.fn();
  const closePanel = vi.fn();
  (window as unknown as { patch?: unknown }).patch = {
    openPanel,
    closePanel,
    onPanelInset(cb: (e: { width: number }) => void) {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
  return {
    openPanel,
    closePanel,
    fireInset: (width) => listeners.slice().forEach((cb) => cb({ width })),
  };
}

function seedChats(chatIds: string[]): void {
  useChatStore.getState().hydrate(
    chatIds.map((chatId) => ({
      chatId,
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: chatId,
      folder: 'foo',
      activity: 'idle' as const,
      status: 'active' as const,
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    })),
  );
}

/** Two chats + /settings, all reachable by client-side links. */
function renderShell(startAt: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const nav = (
    <>
      <Link to="/chats/chat_a" data-testid="to-a">
        a
      </Link>
      <Link to="/chats/chat_b" data-testid="to-b">
        b
      </Link>
      <Link to="/settings" data-testid="to-settings">
        s
      </Link>
    </>
  );
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[startAt]}>
        <Routes>
          <Route
            path="/chats/:chatId"
            element={
              <>
                {nav}
                <ChatRoute ws={null} />
              </>
            }
          />
          <Route
            path="/settings"
            element={
              <>
                {nav}
                <SettingsRoute />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('the web panel shows the CURRENT chat s artifact', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    _resetArtifactPanel();
  });
  afterEach(() => {
    cleanup();
    delete (window as unknown as { patch?: unknown }).patch;
    _resetArtifactPanel();
    vi.restoreAllMocks();
  });

  it('closes the panel when you switch to a chat with no artifact, and re-opens it on return', () => {
    const { openPanel, closePanel } = stubBridge();
    seedChats(['chat_a', 'chat_b']);
    useChatStore.getState().applyEvent(artifact('chat_a', 'aaa', 'A page'));
    renderShell('/chats/chat_a');

    fireEvent.click(screen.getByTestId('artifact-card'));
    expect(openPanel).toHaveBeenCalledTimes(1);
    expect(openPanel.mock.calls[0]![0]).toContain('/api/chats/chat_a/artifact/aaa');

    // chat_b has none — the panel goes away rather than sitting beside it.
    fireEvent.click(screen.getByTestId('to-b'));
    expect(closePanel).toHaveBeenCalledTimes(1);
    expect(openPanel).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('to-a'));
    expect(openPanel).toHaveBeenCalledTimes(2);
    expect(openPanel.mock.calls[1]![0]).toContain('/api/chats/chat_a/artifact/aaa');
  });

  it('shows the OTHER chat s artifact when it has one — never the one you came from', () => {
    const { openPanel } = stubBridge();
    seedChats(['chat_a', 'chat_b']);
    useChatStore.getState().applyEvent(artifact('chat_a', 'aaa', 'A page'));
    useChatStore.getState().applyEvent(artifact('chat_b', 'bbb', 'B page'));
    renderShell('/chats/chat_a');

    fireEvent.click(screen.getByTestId('artifact-card'));
    fireEvent.click(screen.getByTestId('to-b'));
    fireEvent.click(screen.getByTestId('artifact-card'));

    fireEvent.click(screen.getByTestId('to-a'));
    const last = openPanel.mock.calls[openPanel.mock.calls.length - 1]![0] as string;
    expect(last).toContain('/api/chats/chat_a/artifact/aaa');
    expect(last).not.toContain('bbb');
  });

  it('leaving the chat route closes the panel; returning to the chat re-opens it', () => {
    const { openPanel, closePanel } = stubBridge();
    seedChats(['chat_a', 'chat_b']);
    useChatStore.getState().applyEvent(artifact('chat_a', 'aaa', 'A page'));
    renderShell('/chats/chat_a');

    fireEvent.click(screen.getByTestId('artifact-card'));
    fireEvent.click(screen.getByTestId('to-settings'));
    expect(closePanel).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('to-a'));
    expect(openPanel).toHaveBeenCalledTimes(2);
  });

  it('a panel the USER closed is forgotten — it does not resurrect on the next visit', () => {
    const { openPanel, fireInset } = stubBridge();
    seedChats(['chat_a', 'chat_b']);
    useChatStore.getState().applyEvent(artifact('chat_a', 'aaa', 'A page'));
    renderShell('/chats/chat_a');

    fireEvent.click(screen.getByTestId('artifact-card'));
    // main echoes the open's width, then the user hits the panel toolbar's ×.
    fireInset(420);
    fireInset(0);

    fireEvent.click(screen.getByTestId('to-b'));
    fireEvent.click(screen.getByTestId('to-a'));
    expect(openPanel).toHaveBeenCalledTimes(1);
  });

  it('a close WE drove on a chat switch does not clear the newly-open chat s artifact', () => {
    const { openPanel, fireInset } = stubBridge();
    seedChats(['chat_a', 'chat_b']);
    useChatStore.getState().applyEvent(artifact('chat_b', 'bbb', 'B page'));
    renderShell('/chats/chat_b');

    // Open B's artifact, then go to A (no artifact → we close the panel), then
    // straight back to B. Main's inset-0 for OUR close lands while B is open
    // again: read as a user close it would wipe B's artifact.
    fireEvent.click(screen.getByTestId('artifact-card'));
    fireInset(420);
    fireEvent.click(screen.getByTestId('to-a'));
    fireEvent.click(screen.getByTestId('to-b'));
    fireInset(0); // the delayed echo of our own close
    expect(openPanel).toHaveBeenCalledTimes(2);

    // B still owns it: leaving and returning opens it a third time.
    fireEvent.click(screen.getByTestId('to-a'));
    fireEvent.click(screen.getByTestId('to-b'));
    expect(openPanel).toHaveBeenCalledTimes(3);
  });

  it('a window resize (inset > 0) is not a close and forgets nothing', () => {
    const { openPanel, fireInset } = stubBridge();
    seedChats(['chat_a', 'chat_b']);
    useChatStore.getState().applyEvent(artifact('chat_a', 'aaa', 'A page'));
    renderShell('/chats/chat_a');

    fireEvent.click(screen.getByTestId('artifact-card'));
    fireInset(420);
    fireInset(360);

    fireEvent.click(screen.getByTestId('to-b'));
    fireEvent.click(screen.getByTestId('to-a'));
    expect(openPanel).toHaveBeenCalledTimes(2);
  });

  it('the plain web surface has no panel: nothing about artifacts changes', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    seedChats(['chat_a', 'chat_b']);
    useChatStore.getState().applyEvent(artifact('chat_a', 'aaa', 'A page'));
    renderShell('/chats/chat_a');

    fireEvent.click(screen.getByTestId('artifact-card'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0]![0])).toContain('/api/chats/chat_a/artifact/aaa');

    // Switching chats must not throw reaching for a bridge that isn't there.
    fireEvent.click(screen.getByTestId('to-b'));
    expect(screen.queryByTestId('artifact-card')).toBeNull();
  });
});
