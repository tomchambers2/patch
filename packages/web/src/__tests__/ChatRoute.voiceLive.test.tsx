// Todo (Tom, patch/todo.md — "Voice message should appear live."): when a voice
// note is committed, its bubble must appear in the chat timeline the INSTANT the
// user finishes speaking — in a live "Transcribing…" state — instead of only
// popping in after the upload + Whisper round-trip completes (a long dead gap on
// slow/train internet). Once the transcript returns, the same bubble fills in.
//
// This file covers the RENDER half: a message entry flagged `transcribing` must
// render a visible live placeholder (not be dropped by the empty-content guard).

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';

function renderChat(chatId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/chats/${chatId}`]}>
        <Routes>
          <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ChatRoute — live voice-note (transcribing) bubble', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
  });

  it('renders a live "transcribing" placeholder bubble for an in-flight voice note (empty content)', () => {
    const chatId = 'c-vn';
    // A voice note committed but not yet transcribed: empty content, transcribing.
    useChatStore.getState().addTranscribingMessage(chatId, 'VN1', '/x/folder');
    useChatStore.getState().setActiveChat(chatId);

    renderChat(chatId);

    // The bubble is NOT dropped by the empty-content guard — it shows live.
    const bubble = screen.getByTestId('msg-transcribing');
    expect(bubble).toBeInTheDocument();
  });

  it('once resolved, the same bubble shows the recognised text and drops the transcribing placeholder', () => {
    const chatId = 'c-vn2';
    useChatStore.getState().addTranscribingMessage(chatId, 'VN2', '/x/folder');
    useChatStore.getState().resolveTranscription(chatId, 'VN2', 'check the oven');
    useChatStore.getState().setActiveChat(chatId);

    renderChat(chatId);

    expect(screen.queryByTestId('msg-transcribing')).not.toBeInTheDocument();
    expect(screen.getByText('check the oven')).toBeInTheDocument();
  });
});
