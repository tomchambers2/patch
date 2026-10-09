// Per-chat unsent composer text (spec/15 § Composer, spec/14 § Composer).
// What you typed and did not send belongs to the chat you typed it in: it is
// restored when you re-open that chat and is never carried into another one.
//
// SERVER-OWNED (spec/14 § Composer — server-owned settings direction): the
// chat's host can be asleep, but the server is always up, so typing here
// debounces a `composer_draft.set` straight to the server, and every other
// open surface hears about it as `composer_draft.updated`. MMKV (the same
// store the credential uses) is kept as a write-through cache — one key per
// chat, same as before this build — purely so a reload/relaunch while offline
// doesn't lose what's typed; the server is the source of truth once reachable.
//
// One key per chat (no JSON blob to parse). NO FALLBACK: a missing key is an
// empty composer, never someone else's text.

import { create } from 'zustand';
import type { WireEvent } from '@patch/wire';
import { store } from './credential';
import { getWs } from '../api/ws';
import { useUiStore } from '../stores/uiStore';
import { NEW_CHAT_DRAFT_KEY } from './newChat';

const COMPOSER_DRAFT_PREFIX = 'patch.composerDraft:';

/** How long after the last keystroke we wait before telling the server. */
export const DRAFT_SEND_DEBOUNCE_MS = 400;

const SAVE_FAILED_MESSAGE = 'Couldn’t save your unsent message — it will be lost if you reload.';
/** The exact string `PatchWs.send` throws when there is no open socket — the
 * offline case, which is expected and must never raise this toast. Any OTHER
 * throw from a send attempt is a real failure and does. */
const NOT_CONNECTED_MESSAGE = 'PatchWs: not connected';

/**
 * True when `text` is a real draft — not empty, not whitespace-only. Same
 * rule as web's `hasDraftText` (`packages/web/src/lib/draftText.ts`), so the
 * two surfaces cannot answer "is there a draft here?" differently.
 */
export function hasDraftText(text: string): boolean {
  return text.trim() !== '';
}

interface PendingRemote {
  /** `null` means the remote side cleared it while we were focused. */
  text: string | null;
  updatedAt: number;
}

interface ComposerDraftState {
  /** chatId -> unsent composer text. A chat with nothing typed has no key. */
  drafts: Record<string, string>;
  /** Which chats' composers currently have focus, this device only. */
  focused: Record<string, boolean>;
  /**
   * An incoming server update for a FOCUSED chat — held rather than applied,
   * so it never overwrites text under the cursor. Resolved on blur.
   */
  pendingRemote: Record<string, PendingRemote>;
  setDraft(chatId: string, text: string): void;
  clearDraft(chatId: string): void;
  get(chatId: string): string;
  /**
   * Declare whether `chatId`'s composer has focus right now. On a true→false
   * transition (blur), returns the text to apply if a newer server update was
   * held back while focused — `undefined` when there is nothing to apply.
   */
  setFocused(chatId: string, isFocused: boolean): string | undefined;
  applyDraftList(drafts: { chatId: string; text: string; updatedAt: number }[]): void;
  applyDraftUpdated(chatId: string, text: string, updatedAt: number): void;
  applyDraftCleared(chatId: string, updatedAt: number): void;
  /** The link just came back — push every write the server never confirmed. */
  resendPendingOnReconnect(): void;
  /** Test seam. */
  _reset(): void;
}

function mmkvKey(chatId: string): string {
  return COMPOSER_DRAFT_PREFIX + chatId;
}

function persistOne(chatId: string, text: string): void {
  try {
    if (hasDraftText(text)) store().set(mmkvKey(chatId), text);
    else store().delete(mmkvKey(chatId));
  } catch (err) {
    useUiStore.getState().pushError(`${SAVE_FAILED_MESSAGE} (${(err as Error).message})`);
  }
}

/**
 * Every draft MMKV already holds, keyed by chatId — this is the ENTIRE
 * migration story for the move to server-owned drafts: the on-device format
 * doesn't change, so nothing needs rewriting. Every one of them is marked as
 * owed to the server (`pendingOp`), and the ordinary reconnect-flush pushes
 * them up on the very first connection.
 */
function loadAll(): { drafts: Record<string, string>; pending: string[] } {
  const drafts: Record<string, string> = {};
  const pending: string[] = [];
  let keys: string[];
  try {
    keys = store().getAllKeys();
  } catch {
    return { drafts, pending };
  }
  for (const key of keys) {
    if (!key.startsWith(COMPOSER_DRAFT_PREFIX)) continue;
    const chatId = key.slice(COMPOSER_DRAFT_PREFIX.length);
    if (chatId === '') continue;
    let text: string | undefined;
    try {
      text = store().getString(key);
    } catch {
      continue;
    }
    if (typeof text === 'string' && hasDraftText(text)) {
      drafts[chatId] = text;
      if (chatId !== NEW_CHAT_DRAFT_KEY) pending.push(chatId);
    }
  }
  return { drafts, pending };
}

const localEditAt = new Map<string, number>();
const sendTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingOp = new Set<string>();

function cancelSendTimer(chatId: string): void {
  const timer = sendTimers.get(chatId);
  if (timer) {
    clearTimeout(timer);
    sendTimers.delete(chatId);
  }
}

function armSendTimer(chatId: string): void {
  cancelSendTimer(chatId);
  sendTimers.set(
    chatId,
    setTimeout(() => {
      sendTimers.delete(chatId);
      flushPending(chatId);
    }, DRAFT_SEND_DEBOUNCE_MS),
  );
}

/**
 * Send whatever `chatId` currently needs the server to know. Best-effort: a
 * "not connected" throw leaves it in `pendingOp` for the next debounce or
 * reconnect; any OTHER throw is a real failure and is reported (spec/14
 * § Composer — "if a save to the server fails, say so").
 */
function flushPending(chatId: string): void {
  if (!pendingOp.has(chatId)) return;
  const drafts = useComposerDraftStore.getState().drafts;
  const event: WireEvent =
    chatId in drafts
      ? { type: 'composer_draft.set', chatId, text: drafts[chatId] as string }
      : { type: 'composer_draft.clear', chatId };
  try {
    getWs().send(event);
    pendingOp.delete(chatId);
  } catch (err) {
    if ((err as Error).message === NOT_CONNECTED_MESSAGE) return;
    useUiStore.getState().pushError(`${SAVE_FAILED_MESSAGE} (${(err as Error).message})`);
  }
}

const initial = loadAll();
for (const chatId of initial.pending) pendingOp.add(chatId);

export const useComposerDraftStore = create<ComposerDraftState>((set, get) => ({
  drafts: initial.drafts,
  focused: {},
  pendingRemote: {},

  setDraft(chatId, text) {
    if (chatId === '') return;
    if (!hasDraftText(text)) {
      get().clearDraft(chatId);
      return;
    }
    if (get().drafts[chatId] === text) return;
    localEditAt.set(chatId, Date.now());
    persistOne(chatId, text);
    set({ drafts: { ...get().drafts, [chatId]: text } });
    // The new-chat key belongs to no chat: it stays on this device.
    if (chatId === NEW_CHAT_DRAFT_KEY) return;
    pendingOp.add(chatId);
    armSendTimer(chatId);
  },

  clearDraft(chatId) {
    if (chatId === '') return;
    cancelSendTimer(chatId);
    localEditAt.set(chatId, Date.now());
    if (chatId in get().drafts) {
      persistOne(chatId, '');
      const drafts = { ...get().drafts };
      delete drafts[chatId];
      set({ drafts });
    }
    if (chatId in get().pendingRemote) {
      const pendingRemote = { ...get().pendingRemote };
      delete pendingRemote[chatId];
      set({ pendingRemote });
    }
    if (chatId === NEW_CHAT_DRAFT_KEY) return;
    pendingOp.add(chatId);
    flushPending(chatId);
  },

  get(chatId) {
    return get().drafts[chatId] ?? '';
  },

  setFocused(chatId, isFocused) {
    const wasFocused = get().focused[chatId] === true;
    set({ focused: { ...get().focused, [chatId]: isFocused } });
    if (isFocused || !wasFocused) return undefined;
    const pending = get().pendingRemote[chatId];
    if (!pending) return undefined;
    const pendingRemote = { ...get().pendingRemote };
    delete pendingRemote[chatId];
    set({ pendingRemote });
    if (pending.updatedAt <= (localEditAt.get(chatId) ?? 0)) return undefined;
    if (pending.text === null) {
      persistOne(chatId, '');
      const drafts = { ...get().drafts };
      delete drafts[chatId];
      set({ drafts });
      return '';
    }
    persistOne(chatId, pending.text);
    set({ drafts: { ...get().drafts, [chatId]: pending.text } });
    return pending.text;
  },

  applyDraftList(entries) {
    const incoming = new Map(entries.map((e) => [e.chatId, e]));
    const drafts = { ...get().drafts };
    const pendingRemote = { ...get().pendingRemote };
    const focused = get().focused;
    for (const { chatId, text, updatedAt } of entries) {
      if (chatId === NEW_CHAT_DRAFT_KEY) continue;
      if (focused[chatId]) {
        pendingRemote[chatId] = { text, updatedAt };
        continue;
      }
      if (pendingOp.has(chatId)) continue;
      drafts[chatId] = text;
      persistOne(chatId, text);
    }
    for (const chatId of Object.keys(drafts)) {
      if (chatId === NEW_CHAT_DRAFT_KEY) continue;
      if (incoming.has(chatId) || pendingOp.has(chatId) || focused[chatId]) continue;
      delete drafts[chatId];
      persistOne(chatId, '');
    }
    set({ drafts, pendingRemote });
  },

  applyDraftUpdated(chatId, text, updatedAt) {
    if (chatId === NEW_CHAT_DRAFT_KEY) return;
    pendingOp.delete(chatId);
    if (get().focused[chatId]) {
      set({ pendingRemote: { ...get().pendingRemote, [chatId]: { text, updatedAt } } });
      return;
    }
    persistOne(chatId, text);
    set({ drafts: { ...get().drafts, [chatId]: text } });
  },

  applyDraftCleared(chatId, updatedAt) {
    if (chatId === NEW_CHAT_DRAFT_KEY) return;
    pendingOp.delete(chatId);
    if (get().focused[chatId]) {
      set({ pendingRemote: { ...get().pendingRemote, [chatId]: { text: null, updatedAt } } });
      return;
    }
    if (!(chatId in get().drafts)) return;
    persistOne(chatId, '');
    const drafts = { ...get().drafts };
    delete drafts[chatId];
    set({ drafts });
  },

  resendPendingOnReconnect() {
    for (const chatId of [...pendingOp]) flushPending(chatId);
  },

  _reset() {
    for (const timer of sendTimers.values()) clearTimeout(timer);
    sendTimers.clear();
    pendingOp.clear();
    localEditAt.clear();
    for (const chatId of Object.keys(get().drafts)) {
      try {
        store().delete(mmkvKey(chatId));
      } catch {
        // Nothing to clear if storage is unavailable.
      }
    }
    set({ drafts: {}, focused: {}, pendingRemote: {} });
  },
}));

/** The unsent text for `chatId`, or '' when there is none. */
export function getComposerDraft(chatId: string): string {
  return useComposerDraftStore.getState().get(chatId);
}

/** Record what is currently typed in `chatId`'s composer. */
export function setComposerDraft(chatId: string, text: string): void {
  useComposerDraftStore.getState().setDraft(chatId, text);
}

/** Drop `chatId`'s entry (its text was sent, or the chat is gone). */
export function clearComposerDraft(chatId: string): void {
  useComposerDraftStore.getState().clearDraft(chatId);
}
