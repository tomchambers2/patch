// Regression (Tom, "pasted an image but its not there"): an image-only user
// message — a pasted/attached image with NO typed text — must still render its
// attachment. The transcript previously dropped any settled message whose text
// was empty, which took the image down with it (ChatRoute § empty-message
// guard). spec/14 § Composer — attachments render inline.

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatRoute } from '../routes/ChatRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import type { AttachmentRef } from '@patch/wire';

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

describe('ChatRoute — image-only message', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
  });

  it('renders the attachment of a user message that has NO text', () => {
    const chatId = 'c-img';
    const img: AttachmentRef = {
      id: '01ABC',
      name: 'image.jpg',
      mimeType: 'image/jpeg',
      kind: 'image',
    };
    // Empty content + one image attachment (a pasted image, no typed text).
    useChatStore.getState().addLocalMessage(chatId, '', 'L1', '/x/folder', [img]);
    useChatStore.getState().setActiveChat(chatId);

    renderChat(chatId);

    // The message is NOT dropped, and its inline image renders.
    expect(screen.getByTestId('msg-attachment-img')).toBeInTheDocument();
  });

  // B1 (DESKTOP-REVIEW): an image-only message must NOT render an empty
  // accent-tint text bubble above/around the image — only the attachment shows.
  it('B1: does NOT render an empty text bubble for an image-only message', () => {
    const chatId = 'c-img2';
    const img: AttachmentRef = {
      id: '01ABD',
      name: 'photo.png',
      mimeType: 'image/png',
      kind: 'image',
    };
    useChatStore.getState().addLocalMessage(chatId, '', 'L2', '/x/folder', [img]);
    useChatStore.getState().setActiveChat(chatId);

    renderChat(chatId);

    // Image present, but no empty `.content` bubble.
    expect(screen.getByTestId('msg-attachment-img')).toBeInTheDocument();
    expect(screen.queryByTestId('msg-content')).not.toBeInTheDocument();
  });
});
