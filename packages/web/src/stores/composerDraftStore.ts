// Composer drafts — unsent text in an EXISTING chat's composer (spec/14
// § Composer). One entry per chatId: what you typed and did not send belongs
// to the chat you typed it in, so it is restored when you re-open that chat
// and is never carried into another one.
//
// Distinct from `draftStore.ts` (spec/14 § New chat drafts), which holds
// not-yet-spawned NEW chats — a draft there is a whole pending chat with a
// folder; an entry here is just the text sitting in a real chat's composer.
//
// SERVER-OWNED (spec/14 § Composer — server-owned settings direction): the
// chat's host can be asleep, but the server is always up, so typing here
// debounces a `composer_draft.set` straight to the server, and every other
// open surface hears about it as `composer_draft.updated`. This module keeps
// a local cache (localStorage) purely so a page reload while offline doesn't
// lose what's typed — the server is still the source of truth once reachable.
//
// Entries are dropped when their text is sent, when the composer is emptied
// back out (see `hasDraftText` — whitespace-only is not a draft either), and
// when their chat is deleted (server-side, on `DELETE /api/chats/:id`).
//
// NO FALLBACK: a corrupt/absent local cache yields an empty set (a legitimate
// first-run state), never a silently-wrong draft.

import { create } from 'zustand';
import type { WireEvent } from '@patch/wire';
import { hasDraftText } from '../lib/draftText.js';
import { useUiStore } from './uiStore.js';
import { getActiveWs } from '../api/ws.js';

/** How long after the last keystroke we wait before telling the server. */
export const DRAFT_SEND_DEBOUNCE_MS = 400;

/** Superseded key from the pre-server-drafts build — read once, then removed. */
const OLD_STORAGE_KEY = 'patch.composer-drafts.v1';
/** Local write-through cache of the server-owned drafts (offline survival only). */
const CACHE_STORAGE_KEY = 'patch.composer-drafts-cache.v1';

const SAVE_FAILED_MESSAGE = 'Couldn’t save your unsent message — it will be lost if you reload.';
/** The exact string `PatchWs.send` throws when there is no open socket — the
 * offline case, which is expected and must never raise this toast. Any OTHER
 * throw from a send attempt is a real failure and does. */
const NOT_CONNECTED_MESSAGE = 'PatchWs: not connected';

function loadCache(key: string): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [chatId, text] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof text === 'string' && hasDraftText(text)) out[chatId] = text;
    }
    return out;
  } catch {
    return {};
  }
}

function persistCache(drafts: Record<string, string>): void {
  try {
    window.localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(drafts));
  } catch (err) {
    // NO FALLBACK: a full/blocked localStorage must not crash the app, but it
    // must not be silent either — the send to the server may still be queued
    // (this is only the offline-survival cache), but say so anyway, since a
    // reload before the send lands would lose it.
    useUiStore.getState().pushError(SAVE_FAILED_MESSAGE, undefined, (err as Error).message);
  }
}

/**
 * Read the pre-server-drafts localStorage blob exactly once, migrating every
 * draft it held into the new store and marking each as owed to the server
 * (`pendingOp`) — the ordinary reconnect-flush path then pushes them up on
 * the very first connection, so nothing typed before this build is lost. The
 * old key is removed immediately so this only ever runs once.
 */
function migrateOldDrafts(): { drafts: Record<string, string>; pending: string[] } | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(OLD_STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    window.localStorage.removeItem(OLD_STORAGE_KEY);
  } catch {
    // Best-effort cleanup only — a removal failure must not block migrating
    // the drafts a read just succeeded at.
  }
  const drafts: Record<string, string> = {};
  const pending: string[] = [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      for (const [chatId, text] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof text === 'string' && hasDraftText(text)) {
          drafts[chatId] = text;
          pending.push(chatId);
        }
      }
    }
  } catch {
    // A corrupt old blob migrates to nothing — not a crash, not a guess.
  }
  persistCache(drafts);
  return { drafts, pending };
}

interface PendingRemote {
  /** `null` means the remote side cleared it while we were focused. */
  text: string | null;
  updatedAt: number;
}

interface ComposerDraftStore {
  /** chatId -> unsent composer text. A chat with nothing typed has no key. */
  drafts: Record<string, string>;
  /** Which chats' composers currently have DOM focus, this surface only. */
  focused: Record<string, boolean>;
  /**
   * An incoming server update for a FOCUSED chat — held rather than applied,
   * so it never overwrites text under the cursor. Resolved on blur.
   */
  pendingRemote: Record<string, PendingRemote>;
  /** Record what is currently typed in `chatId`'s composer. */
  setDraft(chatId: string, text: string): void;
  /** Drop `chatId`'s entry (its text was sent, or the chat was deleted). */
  clearDraft(chatId: string): void;
  /** The text to seed `chatId`'s composer with; '' when there is none. */
  get(chatId: string): string;
  /**
   * Declare whether `chatId`'s composer has focus right now. On a true→false
   * transition (blur), returns the text to apply if a newer server update was
   * held back while focused — `undefined` when there is nothing to apply
   * (keep whatever is on screen).
   */
  setFocused(chatId: string, isFocused: boolean): string | undefined;
  /** Wire intake: the account's full draft snapshot (sent once after auth.ok). */
  applyDraftList(drafts: { chatId: string; text: string; updatedAt: number }[]): void;
  /** Wire intake: `chatId`'s draft changed, from any surface (including this one's own echo). */
  applyDraftUpdated(chatId: string, text: string, updatedAt: number): void;
  /** Wire intake: `chatId`'s draft is gone, from any surface. */
  applyDraftCleared(chatId: string, updatedAt: number): void;
  /** The link just came back — push every write the server never confirmed. */
  resendPendingOnReconnect(): void;
  /** Test seam — the store loads once at module init and outlives a render. */
  _reset(): void;
}

/** chatId -> ms-epoch of the last LOCAL edit (every keystroke, not just a send
 * attempt) — the clock `setFocused` compares an incoming update against on
 * blur, so a keystroke made after a now-stale server update was captured
 * isn't reverted by it. */
const localEditAt = new Map<string, number>();
/** chatId -> debounce timer for the next `composer_draft.set`. */
const sendTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** chatIds whose current local state the server has not yet confirmed —
 * flushed immediately on `clearDraft`, after the debounce on `setDraft`, and
 * swept on every reconnect. */
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
 * Send whatever `chatId` currently needs the server to know — a `set` with
 * its current text, or a `clear` if it has none. Best-effort: offline
 * (`getActiveWs()` null, or a "not connected" throw) leaves it in `pendingOp`
 * for the next debounce/reconnect; any OTHER throw is a real failure and is
 * reported (spec/14 § Composer — "if a save to the server fails, say so").
 */
function flushPending(chatId: string): void {
  if (!pendingOp.has(chatId)) return;
  const ws = getActiveWs();
  if (!ws) return;
  const drafts = useComposerDraftStore.getState().drafts;
  const event: WireEvent =
    chatId in drafts
      ? { type: 'composer_draft.set', chatId, text: drafts[chatId] as string }
      : { type: 'composer_draft.clear', chatId };
  try {
    ws.send(event);
    pendingOp.delete(chatId);
  } catch (err) {
    if ((err as Error).message === NOT_CONNECTED_MESSAGE) return;
    useUiStore.getState().pushError(SAVE_FAILED_MESSAGE, undefined, (err as Error).message);
  }
}

const migrated = migrateOldDrafts();
const initialDrafts = migrated?.drafts ?? loadCache(CACHE_STORAGE_KEY);
for (const chatId of migrated?.pending ?? []) pendingOp.add(chatId);

export const useComposerDraftStore = create<ComposerDraftStore>((set, get) => ({
  drafts: initialDrafts,
  focused: {},
  pendingRemote: {},

  setDraft(chatId, text) {
    // An emptied composer is not a draft, and neither is one holding only
    // whitespace (`hasDraftText`): typed-then-deleted must leave the chat
    // exactly as it found it.
    if (!hasDraftText(text)) {
      get().clearDraft(chatId);
      return;
    }
    if (get().drafts[chatId] === text) return;
    localEditAt.set(chatId, Date.now());
    const drafts = { ...get().drafts, [chatId]: text };
    persistCache(drafts);
    set({ drafts });
    pendingOp.add(chatId);
    armSendTimer(chatId);
  },

  clearDraft(chatId) {
    cancelSendTimer(chatId);
    localEditAt.set(chatId, Date.now());
    if (chatId in get().drafts) {
      const drafts = { ...get().drafts };
      delete drafts[chatId];
      persistCache(drafts);
      set({ drafts });
    }
    if (chatId in get().pendingRemote) {
      const pendingRemote = { ...get().pendingRemote };
      delete pendingRemote[chatId];
      set({ pendingRemote });
    }
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
    // Newest write wins: a keystroke made after this update was captured
    // supersedes it, even though it arrived while we were still focused.
    if (pending.updatedAt <= (localEditAt.get(chatId) ?? 0)) return undefined;
    if (pending.text === null) {
      const drafts = { ...get().drafts };
      delete drafts[chatId];
      persistCache(drafts);
      set({ drafts });
      return '';
    }
    const drafts = { ...get().drafts, [chatId]: pending.text };
    persistCache(drafts);
    set({ drafts });
    return pending.text;
  },

  applyDraftList(entries) {
    const incoming = new Map(entries.map((e) => [e.chatId, e]));
    const drafts = { ...get().drafts };
    const pendingRemote = { ...get().pendingRemote };
    const focused = get().focused;
    for (const { chatId, text, updatedAt } of entries) {
      // Focused takes priority over "we have our own write in flight": never
      // touch what's rendered, but still remember the snapshot so a blur can
      // compare it against whatever was typed after it arrived.
      if (focused[chatId]) {
        pendingRemote[chatId] = { text, updatedAt };
        continue;
      }
      // Not focused, but we have our own write for this chat still to
      // reconcile — don't let a (possibly already-stale) snapshot race ahead
      // of it.
      if (pendingOp.has(chatId)) continue;
      drafts[chatId] = text;
    }
    // A local draft the server no longer has (cleared, or its chat deleted,
    // while we were offline) is dropped too — but never a write we still owe.
    for (const chatId of Object.keys(drafts)) {
      if (incoming.has(chatId) || pendingOp.has(chatId) || focused[chatId]) continue;
      delete drafts[chatId];
    }
    persistCache(drafts);
    set({ drafts, pendingRemote });
  },

  applyDraftUpdated(chatId, text, updatedAt) {
    // The server has since told us the authoritative state for this chat —
    // whether this is our own echo or someone else's newer write, we no
    // longer owe it our (possibly stale) local copy.
    pendingOp.delete(chatId);
    if (get().focused[chatId]) {
      set({ pendingRemote: { ...get().pendingRemote, [chatId]: { text, updatedAt } } });
      return;
    }
    const drafts = { ...get().drafts, [chatId]: text };
    persistCache(drafts);
    set({ drafts });
  },

  applyDraftCleared(chatId, updatedAt) {
    pendingOp.delete(chatId);
    if (get().focused[chatId]) {
      set({ pendingRemote: { ...get().pendingRemote, [chatId]: { text: null, updatedAt } } });
      return;
    }
    if (!(chatId in get().drafts)) return;
    const drafts = { ...get().drafts };
    delete drafts[chatId];
    persistCache(drafts);
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
    try {
      window.localStorage.removeItem(CACHE_STORAGE_KEY);
      window.localStorage.removeItem(OLD_STORAGE_KEY);
    } catch {
      // Nothing to clear if storage is unavailable.
    }
    set({ drafts: {}, focused: {}, pendingRemote: {} });
  },
}));

/** Imperative drop, for non-React callers (chat deletion). */
export function clearComposerDraft(chatId: string): void {
  useComposerDraftStore.getState().clearDraft(chatId);
}
