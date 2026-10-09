// Tools store — the per-chat set of tools the user has switched OFF in the
// Tools sheet. Mirrors packages/web/src/stores/toolsStore.ts (deliberately
// duplicated, same convention as chatStore/ws.ts between the two apps); the
// OFF set is surface-local and persisted per-user across reloads (MMKV, not
// localStorage — the one real difference from web), and rides every
// `chat.input` so the host removes the disabled tools from the model's
// context for the turn.
//
// NO FALLBACK: a corrupt/absent blob yields an empty set (a legitimate
// first-run "every tool on" state), never a silently-wrong gating.

import { create } from 'zustand';
import { store } from '../lib/credential';

const STORAGE_KEY = 'patch.tools.disabledByChat.v1';

/** Read + sanitise the persisted OFF set. Exported for direct branch testing;
 *  the store calls it once at init. Junk (non-arrays, non-strings, empty lists,
 *  corrupt JSON, non-object roots) is dropped to a first-run empty set. */
export function loadDisabledFromStorage(): Record<string, string[]> {
  try {
    const raw = store().getString(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, string[]> = {};
    for (const [chatId, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(list)) {
        const names = list.filter((n): n is string => typeof n === 'string');
        if (names.length > 0) out[chatId] = names;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function persist(disabledByChat: Record<string, string[]>): void {
  store().set(STORAGE_KEY, JSON.stringify(disabledByChat));
}

interface ToolsState {
  /** chatId → names of tools switched OFF for that chat. */
  disabledByChat: Record<string, string[]>;
  /** Is this tool switched OFF for this chat? */
  isDisabled(chatId: string, name: string): boolean;
  /** The OFF set for this chat (stable empty array when none). */
  disabledFor(chatId: string): string[];
  /** Flip a tool's on/off state for a chat (persisted). */
  toggle(chatId: string, name: string): void;
  /** Reset (tests). */
  _reset(): void;
}

const EMPTY: string[] = [];

export const useToolsStore = create<ToolsState>((set, get) => ({
  disabledByChat: loadDisabledFromStorage(),
  isDisabled(chatId, name) {
    return (get().disabledByChat[chatId] ?? EMPTY).includes(name);
  },
  disabledFor(chatId) {
    return get().disabledByChat[chatId] ?? EMPTY;
  },
  toggle(chatId, name) {
    const cur = get().disabledByChat;
    const list = cur[chatId] ?? EMPTY;
    const nextList = list.includes(name) ? list.filter((n) => n !== name) : [...list, name];
    const next = { ...cur };
    if (nextList.length > 0) next[chatId] = nextList;
    else delete next[chatId];
    persist(next);
    set({ disabledByChat: next });
  },
  _reset() {
    persist({});
    set({ disabledByChat: {} });
  },
}));
