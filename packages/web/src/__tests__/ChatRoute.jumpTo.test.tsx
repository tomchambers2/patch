// Jump-to from a sidebar search result: `/chats/:id?seq=N` opens the chat at
// message N, rings it briefly, and drops the param so nothing re-jumps later.
// jsdom has no layout, so the scroll GEOMETRY is e2e's
// (e2e/chat-search.spec.ts); this pins the wiring.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore, type ChatEventEntry } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { deliveryTracker } from '../lib/deliveryTracker.js';
import { setActiveWs } from '../api/ws.js';

vi.mock('../api/rest.js', () => ({
  api: {
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
    getFileContent: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    getFileContentAtHead: vi.fn(async () => ({ path: '', content: '', size: 0 })),
  },
}));

function msg(seq: number): ChatEventEntry {
  return {
    seq,
    kind: 'message',
    role: seq % 2 === 0 ? 'user' : 'assistant',
    content: `message ${seq}`,
    at: seq,
  } as ChatEventEntry;
}

function seed(timeline: ChatEventEntry[]): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'c1',
      folder: 'foo',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);
  useChatStore.setState((s) => ({ timelines: { ...s.timelines, c1: timeline } }));
}

function LocationProbe(): JSX.Element {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );
}

function bubble(seq: number): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid="msg"][data-seq="${seq}"]`);
  if (el === null) throw new Error(`no bubble for seq ${seq}`);
  return el;
}

describe('ChatRoute — jump to a message (?seq=)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    setActiveWs(null);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    deliveryTracker.reset();
    setActiveWs(null);
  });

  it('every message bubble carries its seq', () => {
    seed([msg(0), msg(1), msg(2)]);
    renderAt('/chats/c1');
    const seqs = screen.getAllByTestId('msg').map((el) => el.getAttribute('data-seq'));
    expect(seqs).toEqual(['0', '1', '2']);
  });

  it('rings the target message, then fades it, and drops the param', () => {
    seed([msg(0), msg(1), msg(2), msg(3), msg(4)]);
    renderAt('/chats/c1?seq=2');
    expect(bubble(2)).toHaveClass('msg-jump-target');
    expect(bubble(1)).not.toHaveClass('msg-jump-target');
    expect(bubble(4)).not.toHaveClass('msg-jump-target');
    // Taken once: the URL no longer asks for it, so a re-render cannot re-jump.
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/chats\/c1$/);
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(bubble(2)).not.toHaveClass('msg-jump-target');
  });

  it('waits for a message that hydrates after the open', () => {
    seed([msg(0)]);
    renderAt('/chats/c1?seq=3');
    expect(document.querySelector('.msg-jump-target')).toBeNull();
    act(() => {
      useChatStore.setState((s) => ({
        timelines: { ...s.timelines, c1: [msg(0), msg(1), msg(2), msg(3)] },
      }));
    });
    expect(bubble(3)).toHaveClass('msg-jump-target');
  });

  it('a seq that is not in the transcript leaves the chat as it was', () => {
    seed([msg(0), msg(1)]);
    renderAt('/chats/c1?seq=99');
    expect(document.querySelector('.msg-jump-target')).toBeNull();
    expect(screen.getAllByTestId('msg')).toHaveLength(2);
    expect(screen.getByTestId('loc')).toHaveTextContent(/^\/chats\/c1$/);
  });

  it('opening without ?seq rings nothing', () => {
    seed([msg(0), msg(1)]);
    renderAt('/chats/c1');
    expect(document.querySelector('.msg-jump-target')).toBeNull();
  });
});
