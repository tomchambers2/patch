// Account-wide preferences (spec/14 § `/settings` details — Manager).
//
// These live on the server, because the Manager watch loop that acts on them
// runs there. The surface caches them for the two places that need them
// without an await: the Settings page's controls, and the address word a quiet
// voice call carries into its own audio session (spec/07 § Session modes).
//
// NO FALLBACK on a failed load: `loaded` stays false and the error is surfaced
// by whoever asked, rather than a made-up set of preferences being presented as
// the account's.

import { create } from 'zustand';
import { DEFAULT_SHARED_SETTINGS } from '@patch/wire';
import { api, type AccountPreferences, type SharedState } from '../api/rest.js';

/** What the server uses when the account has never set anything. */
export const DEFAULT_PREFERENCES: AccountPreferences = DEFAULT_SHARED_SETTINGS;

interface PreferencesState {
  preferences: AccountPreferences;
  loaded: boolean;
  /**
   * The rest of the shared state (spec/01 § Settings): the accounts and keys as
   * a surface may see them, and which version each host runs. Null until loaded.
   */
  shared: Omit<SharedState, 'settings'> | null;
  set(preferences: AccountPreferences): void;
  /** Take a committed shared state — a write's answer or a `settings.changed`. */
  apply(state: SharedState): void;
  /** Fetch from the server. Rejects on failure — the caller surfaces it. */
  load(): Promise<void>;
  /** Write a partial update through to the server and settle on its answer. */
  update(patch: Partial<AccountPreferences>): Promise<void>;
}

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  preferences: DEFAULT_PREFERENCES,
  loaded: false,
  shared: null,
  set(preferences) {
    set({ preferences, loaded: true });
  },
  apply(state) {
    const { settings, ...shared } = state;
    // A reply can race a push; the higher version is the later state.
    const current = get().shared;
    if (current !== null && current.version > shared.version) return;
    set({ preferences: settings, shared, loaded: true });
  },
  async load() {
    const settings = await api.settings();
    // NO FALLBACK, and no half-loaded state either: a response without them is
    // a server that does not serve preferences, which is worth saying out loud
    // rather than storing `undefined` as though it were the account's answer.
    if (!settings.preferences) throw new Error('server returned no account preferences');
    set({
      preferences: settings.preferences,
      ...(settings.shared ? { shared: settings.shared } : {}),
      loaded: true,
    });
  },
  async update(patch) {
    const { preferences } = await api.setPreferences(patch);
    set({ preferences, loaded: true });
  },
}));

/**
 * The address word a quiet call gates utterances on. Returns null until the
 * preferences have actually loaded, so the session carries nothing rather than
 * a guess the host would then enforce.
 */
export function addressWordOrNull(): string | null {
  const { preferences, loaded } = usePreferencesStore.getState();
  return loaded ? preferences.addressWord : null;
}
