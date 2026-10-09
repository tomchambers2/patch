// The `/api/settings` payload the Settings tab draws from (spec/14 § `/settings`
// details — the same call web's Settings page polls).
//
// One store rather than a fetch per section, because several sections read the
// same response (Linked devices and every account-wide preference) and they
// must agree with each other.
//
// NO FALLBACK: until the server has answered, `data` is null and the sections
// that need it say so; a failed read is kept verbatim in `error` for them to
// show. There is no seeded "default" set of preferences standing in for the
// account's real ones.

import { create } from 'zustand';
import { api, type AccountPreferences, type SettingsResponse, type SharedState } from '../api/rest';

interface SettingsState {
  data: SettingsResponse | null;
  /** The last load's failure, verbatim. Cleared by the next successful load. */
  error: string | null;
  /** Fetch `/api/settings`. Never rejects — a failure lands in `error`. */
  load(): Promise<void>;
  /**
   * Write a partial preferences update and settle on the server's answer.
   * Rejects on failure so the control that asked can report it.
   */
  updatePreferences(patch: Partial<AccountPreferences>): Promise<void>;
  /**
   * Take a committed shared state (spec/01 § Settings) — a write's answer or a
   * `settings.changed` push. A state older than the one held is ignored.
   */
  applyShared(state: SharedState): void;
  _reset(): void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  data: null,
  error: null,
  async load() {
    try {
      const data = await api.settings();
      if (!data.preferences) throw new Error('server returned no account preferences');
      set({ data, error: null });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },
  async updatePreferences(patch) {
    const { preferences } = await api.setPreferences(patch);
    const current = get().data;
    if (current) set({ data: { ...current, preferences } });
  },
  applyShared(state) {
    const current = get().data;
    if (!current) return;
    if (current.shared && current.shared.version > state.version) return;
    const { settings, ...shared } = state;
    set({ data: { ...current, preferences: settings, shared } });
  },
  _reset() {
    set({ data: null, error: null });
  },
}));
