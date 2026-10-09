// Share-sheet destination picker (app/share.tsx, spec/15 § Share into
// Patch). Pins:
//   - renders null once there's nothing pending (no other way in, per the
//     screen's own header comment)
//   - shows the shared text verbatim, and each shared file as a chip
//   - "Start a new chat" puts the share in the NEW-CHAT composer (draft text +
//     attachment chips), clears shareStore, and opens /new-chat
//   - tapping an existing chat puts the share in ITS composer — text added to
//     anything already typed, never replacing it — and replaces to that chat;
//     never auto-sent
//   - the search field filters the destination list
//   - Cancel clears shareStore without touching any composer
//   - archived/deleted chats are not offered as destinations

import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  renderRN,
  actAsync,
  actSync,
  flush,
  findHost,
  findAllHost,
  byTestId,
  byLabel,
  hasText,
} from './testUtils/render';
import Share from '../app/share';
import { useChatStore } from '../src/stores/chatStore';
import { useShareStore } from '../src/stores/shareStore';
import { useComposerAttachmentStore } from '../src/stores/composerAttachmentStore';
import { getComposerDraft, clearComposerDraft, setComposerDraft } from '../src/lib/composerDraft';
import { NEW_CHAT_DRAFT_KEY } from '../src/lib/newChat';
import { routerMock, __resetRouterMock } from './stubs/expo-router';
import type { ChatRow } from '../src/stores/types';

function row(partial: Partial<ChatRow> & { chatId: string }): ChatRow {
  return {
    name: null,
    preview: null,
    folder: '',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    lastUpdated: 1,
    ...partial,
  } as ChatRow;
}

const TEXT = 'https://example.com/interesting-article';
const IMAGE = {
  uri: 'file:///cache/shared-in/1-photo.jpg',
  name: 'photo.jpg',
  mimeType: 'image/jpeg',
  kind: 'image' as const,
};
const PDF = {
  uri: 'file:///cache/shared-in/2-doc.pdf',
  name: 'doc.pdf',
  mimeType: 'application/pdf',
  kind: 'file' as const,
};

beforeEach(() => {
  __resetRouterMock();
  useChatStore.getState()._reset();
  useShareStore.getState().clear();
  useComposerAttachmentStore.getState()._reset();
  clearComposerDraft('chat_a');
  clearComposerDraft('chat_b');
  clearComposerDraft(NEW_CHAT_DRAFT_KEY);
  useChatStore.setState({
    chats: {
      chat_a: row({ chatId: 'chat_a', name: 'Recipe ideas', lastUpdated: 2 }),
      chat_b: row({ chatId: 'chat_b', name: 'Older chat', lastUpdated: 1 }),
      chat_archived: row({
        chatId: 'chat_archived',
        name: 'Old',
        status: 'archived',
        lastUpdated: 3,
      }),
    },
  });
});

async function renderReady(): Promise<ReturnType<typeof renderRN>> {
  let r!: ReturnType<typeof renderRN>;
  await actAsync(async () => {
    r = renderRN(<Share />);
    await flush();
  });
  return r;
}

async function press(r: ReturnType<typeof renderRN>, testID: string): Promise<void> {
  await actAsync(async () => {
    findHost(r.root, byTestId(testID)).props.onPress();
    await flush();
  });
}

const fileChips = (r: ReturnType<typeof renderRN>): unknown[] =>
  findAllHost(r.root, (i) => String(i.props['testID'] ?? '').startsWith('share-file-'));

describe('Share — nothing pending', () => {
  it('renders null', async () => {
    const r = await renderReady();
    expect(r.toJSON()).toBeNull();
  });
});

describe('Share — shared text', () => {
  beforeEach(() => {
    useShareStore.getState().setPending({ text: TEXT, files: [] });
  });

  it('shows the shared text and no file chips', async () => {
    const r = await renderReady();
    expect(hasText(findHost(r.root, byTestId('share-text')), TEXT)).toBe(true);
    expect(fileChips(r)).toHaveLength(0);
  });

  it('does not list an archived chat as a destination', async () => {
    const r = await renderReady();
    expect(() => findHost(r.root, byTestId('share-chat-option-chat_archived'))).toThrow();
    expect(findHost(r.root, byTestId('share-chat-option-chat_a'))).toBeTruthy();
  });

  it('"Start a new chat" drafts the text into the new-chat composer and opens it', async () => {
    const r = await renderReady();
    await press(r, 'share-new-chat');
    expect(getComposerDraft(NEW_CHAT_DRAFT_KEY)).toBe(TEXT);
    expect(routerMock.replace).toHaveBeenCalledWith('/new-chat');
    expect(useShareStore.getState().pending).toBeNull();
  });

  it('tapping an existing chat drafts into ITS composer and replaces to it — never sent', async () => {
    const r = await renderReady();
    await press(r, 'share-chat-option-chat_a');
    expect(getComposerDraft('chat_a')).toBe(TEXT);
    expect(useShareStore.getState().pending).toBeNull();
    expect(routerMock.replace).toHaveBeenCalledWith('/chats/chat_a');
    expect(getComposerDraft('chat_b')).toBe('');
  });

  it('adds to text already typed in that chat rather than replacing it', async () => {
    setComposerDraft('chat_a', 'half a thought');
    const r = await renderReady();
    await press(r, 'share-chat-option-chat_a');
    expect(getComposerDraft('chat_a')).toBe(`half a thought\n\n${TEXT}`);
  });

  it('the search field filters the chats on offer', async () => {
    const r = await renderReady();
    const search = findHost(r.root, byTestId('share-search'));
    actSync(() => search.props.onChangeText('recipe'));
    expect(findHost(r.root, byTestId('share-chat-option-chat_a'))).toBeTruthy();
    expect(() => findHost(r.root, byTestId('share-chat-option-chat_b'))).toThrow();
    actSync(() => search.props.onChangeText('zzz'));
    expect(hasText(findHost(r.root, byTestId('share-no-chats')), 'No chats match.')).toBe(true);
  });

  it('Cancel clears the pending share without seeding any draft', async () => {
    const r = await renderReady();
    await actAsync(async () => {
      findHost(r.root, byLabel('Cancel')).props.onPress();
      await flush();
    });
    expect(useShareStore.getState().pending).toBeNull();
    expect(getComposerDraft('chat_a')).toBe('');
    expect(routerMock.replace).toHaveBeenCalledWith('/(tabs)/chats');
  });
});

describe('Share — shared images and files', () => {
  beforeEach(() => {
    useShareStore.getState().setPending({ text: null, files: [IMAGE, PDF] });
  });

  it('shows a chip per file and no text box', async () => {
    const r = await renderReady();
    expect(findHost(r.root, byTestId('share-file-photo.jpg'))).toBeTruthy();
    expect(findHost(r.root, byTestId('share-file-doc.pdf'))).toBeTruthy();
    expect(findAllHost(r.root, byTestId('share-text'))).toHaveLength(0);
  });

  it("into an existing chat: each file becomes that composer's attachment chip", async () => {
    const r = await renderReady();
    await press(r, 'share-chat-option-chat_b');
    const atts = useComposerAttachmentStore.getState().byKey['chat_b'] ?? [];
    expect(atts.map(({ uri, name, mimeType, kind }) => ({ uri, name, mimeType, kind }))).toEqual([
      IMAGE,
      PDF,
    ]);
    expect(new Set(atts.map((a) => a.key)).size).toBe(2);
    expect(getComposerDraft('chat_b')).toBe('');
    expect(routerMock.replace).toHaveBeenCalledWith('/chats/chat_b');
  });

  it('into a new chat: the files wait in the new-chat composer', async () => {
    const r = await renderReady();
    await press(r, 'share-new-chat');
    expect(useComposerAttachmentStore.getState().byKey[NEW_CHAT_DRAFT_KEY]).toHaveLength(2);
    expect(routerMock.replace).toHaveBeenCalledWith('/new-chat');
  });
});

describe('Share — no chats yet', () => {
  it('says so', async () => {
    useChatStore.getState()._reset();
    useShareStore.getState().setPending({ text: TEXT, files: [] });
    const r = await renderReady();
    expect(hasText(findHost(r.root, byTestId('share-no-chats')), 'No chats yet.')).toBe(true);
  });
});
