// A chat the new-chat screen created before anything was sent into it
// (spec/14 § New chat drafts). The header's Call / Files / Open editor, a voice
// note and an attachment upload all create the chat first and act second, so
// the chat exists server-side while it is still empty. Left that way — nothing
// sent, nothing typed — it is deleted rather than staying in the list as an
// empty "New chat" ("new chat should only save if you type, empty chat
// nothing").
//
// Checked when the user leaves it: every route change asks about each chat
// created this way, sparing the one now on screen. A chat that has a message,
// unsent words in its composer, or a voice note or call running on it is the
// user's, and stops being watched.

import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { clearComposerDraft, useComposerDraftStore } from '../stores/composerDraftStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';

const unsent = new Set<string>();

/** The new-chat screen created `chatId` before anything was sent into it. */
export function markUnsentNewChat(chatId: string): void {
  unsent.add(chatId);
}

function hasContent(chatId: string): boolean {
  const chat = useChatStore.getState();
  if (chat.chats[chatId]?.preview) return true;
  if ((chat.timelines[chatId] ?? []).some((e) => e.kind === 'message' && e.role === 'user')) {
    return true;
  }
  return useComposerDraftStore.getState().get(chatId) !== '';
}

function inUse(chatId: string): boolean {
  const voice = useVoiceStore.getState();
  return voice.note?.chatId === chatId || voice.call?.chatId === chatId;
}

/** Delete every still-empty chat created by the new-chat screen, except `onScreen`. */
export function discardUnsentNewChats(onScreen: string | null): void {
  for (const chatId of [...unsent]) {
    if (hasContent(chatId)) {
      unsent.delete(chatId);
      continue;
    }
    if (chatId === onScreen || inUse(chatId)) continue;
    unsent.delete(chatId);
    useChatStore.getState().removeChat(chatId);
    clearComposerDraft(chatId);
    // NO FALLBACK: a refused delete leaves a real empty chat behind, which the
    // user must hear about rather than find later.
    void api.deleteChat(chatId).catch((e: unknown) => {
      useUiStore
        .getState()
        .pushError(`could not remove the empty new chat: ${(e as Error).message}`);
    });
  }
}

/** Mounted once per window: checks on every route change. */
export function useDiscardUnsentNewChats(): void {
  const { pathname } = useLocation();
  useEffect(() => {
    const onScreen = /^\/chats\/([^/]+)$/.exec(pathname)?.[1] ?? null;
    discardUnsentNewChats(onScreen);
  }, [pathname]);
}

/** Test seam — forget every watched chat. */
export function _resetUnsentNewChats(): void {
  unsent.clear();
}
