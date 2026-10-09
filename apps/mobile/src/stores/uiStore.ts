// UI store — banner errors + transient notices. The wire-decoder pushes
// schema errors here so the user sees something rather than a silent skip.

import { create } from 'zustand';
import { store } from '../lib/credential';
import type { ChatStateFilter } from '../lib/stateFilter';

// The Chats tab's view dropdown (spec/15 § Chats tab) drives both of these.
// Persisted in MMKV — the same store `batchStore`'s own `mode` already uses
// (apps/mobile/src/stores/batchStore.ts) — so picking Unread/Working/Waiting
// on you/Failed is a standing choice, remembered the same way Batch already is.
const ATTENTION_ONLY_KEY = 'patch.sidebar.attentionOnly';
const STATE_FILTER_KEY = 'patch.sidebar.stateFilter';
const STATE_FILTERS: readonly ChatStateFilter[] = ['all', 'failed', 'working', 'waiting', 'done'];

function loadAttentionOnly(): boolean {
  return store().getBoolean(ATTENTION_ONLY_KEY) ?? false;
}

function loadStateFilter(): ChatStateFilter {
  const raw = store().getString(STATE_FILTER_KEY);
  // A missing or garbled value is a legitimate first run — not a swallowed
  // error — and falls back to 'all'.
  return STATE_FILTERS.includes(raw as ChatStateFilter) ? (raw as ChatStateFilter) : 'all';
}

export interface UiError {
  id: number;
  message: string;
  at: number;
}

interface UiState {
  errors: UiError[];
  /**
   * Connection diagnostics screen opened on demand from a banner's Diagnose
   * action (spec/12 § Connection diagnostics screen). The BLOCKING variant is
   * derived from presence state, not this flag.
   */
  diagnosticsOpen: boolean;
  /**
   * The user has closed the BLOCKING diagnostics takeover (spec/12 §
   * Connection diagnostics screen). Latched for the session so a phone that
   * has still never connected does not have the window taken back off the user
   * on the next failed attempt; the banners' Diagnose action is how it returns.
   */
  diagnosticsBlockingClosed: boolean;
  /**
   * A host whose OpenAI sign-in form Settings → Credit sources should open —
   * set by a Hosts row's Sign in on a `codex` backend, cleared once the form
   * has opened (mirrors web's uiStore.codexSignInHost).
   */
  codexSignInHost: string | null;
  /**
   * The Chats tab view dropdown's Unread option (spec/15 § Needs attention;
   * mirrors web's `uiStore.attentionOnly`). Off by default; persisted.
   */
  attentionOnly: boolean;
  /**
   * The Chats tab view dropdown's Working/Waiting on you/Failed options
   * (mirrors web's `uiStore.stateFilter`). `'all'` — the default — filters
   * nothing. Persisted.
   */
  stateFilter: ChatStateFilter;
  setCodexSignInHost(daemonId: string | null): void;
  pushError(msg: string): void;
  dismissError(id: number): void;
  setDiagnosticsOpen(v: boolean): void;
  closeDiagnosticsBlocking(): void;
  setAttentionOnly(v: boolean): void;
  setStateFilter(v: ChatStateFilter): void;
}

let _id = 0;

export const useUiStore = create<UiState>((set, get) => ({
  errors: [],
  diagnosticsOpen: false,
  diagnosticsBlockingClosed: false,
  codexSignInHost: null,
  attentionOnly: loadAttentionOnly(),
  stateFilter: loadStateFilter(),
  setCodexSignInHost(daemonId) {
    set({ codexSignInHost: daemonId });
  },
  setAttentionOnly(v) {
    store().set(ATTENTION_ONLY_KEY, v);
    set({ attentionOnly: v });
  },
  setStateFilter(v) {
    store().set(STATE_FILTER_KEY, v);
    set({ stateFilter: v });
  },
  pushError(msg) {
    const id = ++_id;
    set({ errors: [...get().errors, { id, message: msg, at: Date.now() }] });
  },
  dismissError(id) {
    set({ errors: get().errors.filter((e) => e.id !== id) });
  },
  setDiagnosticsOpen(v) {
    set({ diagnosticsOpen: v });
  },
  closeDiagnosticsBlocking() {
    set({ diagnosticsBlockingClosed: true });
  },
}));
