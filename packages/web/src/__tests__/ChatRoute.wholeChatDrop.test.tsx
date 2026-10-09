// Todoist 6hfg48wcWx2j7vxc — "patch drop to attach should have a dropzone of
// whole chat". Dropping a file over the header/transcript, not just the
// composer strip, attaches it (spec/14 § Composer). The composer's own
// drag-and-drop is exercised in Composer.test.tsx; this covers only the
// wider zone and its handoff with the composer's own overlay.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { setActiveWs } from '../api/ws.js';
import { reportAccount } from './presenceHelpers.js';

vi.mock('../api/rest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/rest.js')>();
  return {
    ApiError: actual.ApiError,
    api: {
      markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
      getFileContent: vi.fn(),
      getFileContentAtHead: vi.fn(),
      getChat: vi.fn((_chatId: string): Promise<unknown> => {
        throw new Error('api.getChat not stubbed for this test');
      }),
    },
  };
});

function seedChat(chatId: string): void {
  useChatStore.getState().hydrate([
    {
      chatId,
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: chatId,
      folder: 'foo',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    },
  ]);
}

function renderChat(chatId: string) {
  return render(
    <MemoryRouter initialEntries={[`/chats/${chatId}`]}>
      <Routes>
        <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ChatRoute — whole-chat drop zone', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    reportAccount('d1', true);
    useUiStore.getState().clearToasts();
    setActiveWs(null);
  });
  afterEach(() => {
    cleanup();
    setActiveWs(null);
  });

  it('dragging a file over the header/transcript (outside the composer) shows the panel-wide hint', () => {
    seedChat('c1');
    renderChat('c1');
    const chatMain = screen.getByTestId('chat-main');
    expect(screen.queryByTestId('chat-drop-hint')).toBeNull();
    fireEvent.dragEnter(screen.getByTestId('chat-head'), { dataTransfer: { types: ['Files'] } });
    expect(screen.getByTestId('chat-drop-hint')).toHaveTextContent('Drop to attach');
    fireEvent.dragLeave(screen.getByTestId('chat-head'), { dataTransfer: { types: ['Files'] } });
    expect(screen.queryByTestId('chat-drop-hint')).toBeNull();
    expect(chatMain.className).not.toContain('chat-drag-active');
  });

  it('dropping a file over the transcript attaches it through the composer, same as the file picker', async () => {
    seedChat('c1');
    renderChat('c1');
    const stream = screen.getByTestId('chat-stream');
    const file = new File(['bytes'], 'report.pdf', { type: 'application/pdf' });
    fireEvent.dragEnter(stream, { dataTransfer: { types: ['Files'] } });
    fireEvent.drop(stream, { dataTransfer: { types: ['Files'], files: [file] } });
    await waitFor(() => expect(screen.getByTestId('composer-attachment')).toBeInTheDocument());
    expect(screen.getByTestId('composer-attachment').querySelector('.att-name')?.textContent).toBe(
      'report.pdf',
    );
    expect(screen.queryByTestId('chat-drop-hint')).toBeNull();
  });

  it('dragging directly over the composer hands off to its own overlay instead of double-showing the panel-wide one', () => {
    seedChat('c1');
    renderChat('c1');
    const composer = screen.getByTestId('composer');
    fireEvent.dragEnter(composer, { dataTransfer: { types: ['Files'] } });
    expect(screen.getByTestId('composer-drop-hint')).toHaveTextContent('Drop to attach');
    expect(screen.queryByTestId('chat-drop-hint')).toBeNull();
  });

  it('dropping while Claude is disconnected shows the blocked hint and does not attach', async () => {
    seedChat('c1');
    reportAccount('d1', false);
    renderChat('c1');
    const stream = screen.getByTestId('chat-stream');
    fireEvent.dragEnter(stream, { dataTransfer: { types: ['Files'] } });
    expect(screen.getByTestId('chat-drop-hint')).toHaveTextContent('Can’t attach right now');
    const file = new File(['bytes'], 'report.pdf', { type: 'application/pdf' });
    fireEvent.drop(stream, { dataTransfer: { types: ['Files'], files: [file] } });
    await Promise.resolve();
    expect(screen.queryByTestId('composer-attachment')).toBeNull();
  });
});
