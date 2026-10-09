// A host's refusal of a Settings edit that has no report of its own to land on.
//
// `host.claude_settings_set` (invalid JSON) and `host.claude_memory_set` /
// `_delete` (no such entry) are refused by the host with an out-of-band
// `chat.error` addressed to no chat (`pending-spawn`). The editor that sent the
// frame watches this for a refusal newer than its send, so the host's own
// sentence is shown where the edit was made rather than nowhere.

import { create } from 'zustand';

export interface HostRefusal {
  code: string;
  message: string;
  /** When this surface received it, ms-epoch. */
  at: number;
}

interface HostRefusalState {
  last: HostRefusal | null;
  note(code: string, message: string): void;
  _reset(): void;
}

export const useHostRefusalStore = create<HostRefusalState>((set) => ({
  last: null,
  note(code, message) {
    set({ last: { code, message, at: Date.now() } });
  },
  _reset() {
    set({ last: null });
  },
}));
