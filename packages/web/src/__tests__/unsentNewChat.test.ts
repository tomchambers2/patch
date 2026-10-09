// lib/unsentNewChat — a chat the new-chat screen created before anything was
// sent into it is deleted once the user leaves it empty, and kept the moment it
// holds anything of theirs (spec/14 § New chat drafts). Driven through the real
// stores; only the REST client is doubled.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const deleteChat = vi.fn(async (_chatId: string) => ({ ok: true as const }));
vi.mock('../api/rest.js', () => ({ api: { deleteChat: (id: string) => deleteChat(id) } }));

import {
  _resetUnsentNewChats,
  discardUnsentNewChats,
  markUnsentNewChat,
} from '../lib/unsentNewChat.js';
import { useChatStore } from '../stores/chatStore.js';
import { useComposerDraftStore } from '../stores/composerDraftStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';

const ID = 'chat_created_empty';

function created(): void {
  useChatStore.getState().ensureChat(ID, '/home/tom/projects/portfolio');
  markUnsentNewChat(ID);
}

beforeEach(() => {
  deleteChat.mockClear();
  deleteChat.mockImplementation(async () => ({ ok: true as const }));
  _resetUnsentNewChats();
  useChatStore.getState()._reset();
  useComposerDraftStore.getState()._reset();
  useVoiceStore.getState().endCall();
  useUiStore.setState({ errors: [] });
});

describe('unsentNewChat', () => {
  it('deletes the chat once the user is somewhere else, and forgets it', () => {
    created();
    discardUnsentNewChats('chat_md');

    expect(useChatStore.getState().chats[ID]).toBeUndefined();
    expect(deleteChat).toHaveBeenCalledWith(ID);

    discardUnsentNewChats(null);
    expect(deleteChat).toHaveBeenCalledTimes(1);
  });

  it('leaves the chat alone while it is the one on screen', () => {
    created();
    discardUnsentNewChats(ID);

    expect(useChatStore.getState().chats[ID]).toBeDefined();
    expect(deleteChat).not.toHaveBeenCalled();
  });

  it('keeps a chat that has a message in it, and stops watching it', () => {
    created();
    useChatStore.getState().addLocalMessage(ID, 'hello', 'l1', '/home/tom/projects/portfolio');
    discardUnsentNewChats('chat_md');
    useChatStore.getState().removeChat(ID);
    useChatStore.getState().ensureChat(ID, '/home/tom/projects/portfolio');
    discardUnsentNewChats('chat_md');

    expect(deleteChat).not.toHaveBeenCalled();
  });

  it('keeps a chat with unsent words in its composer', () => {
    created();
    useComposerDraftStore.getState().setDraft(ID, 'half a thought');
    discardUnsentNewChats('chat_md');

    expect(useChatStore.getState().chats[ID]).toBeDefined();
    expect(deleteChat).not.toHaveBeenCalled();
  });

  it('waits while a call is running on it, then deletes it if the call left nothing', () => {
    created();
    useVoiceStore.getState().startCall(ID);
    discardUnsentNewChats('chat_md');
    expect(deleteChat).not.toHaveBeenCalled();

    useVoiceStore.getState().endCall();
    discardUnsentNewChats('chat_md');
    expect(deleteChat).toHaveBeenCalledWith(ID);
  });

  it('says so when the server refuses the delete', async () => {
    deleteChat.mockImplementation(async () => {
      throw new Error('server down');
    });
    created();
    discardUnsentNewChats('chat_md');
    await vi.waitFor(() =>
      expect(useUiStore.getState().errors.map((e) => e.message)).toContain(
        'could not remove the empty new chat: server down',
      ),
    );
  });
});
