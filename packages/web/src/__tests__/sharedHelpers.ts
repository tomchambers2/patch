// Put the shared settings (spec/01 § Settings) into the store the way the
// server's greeting does, for tests of the pages that read them.

import {
  DEFAULT_SHARED_SETTINGS,
  type SharedSecretsSummary,
  type SharedSettings,
} from '@patch/wire';
import type { SharedState } from '../api/rest.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';

export const NO_SECRETS: SharedSecretsSummary = {
  claude: [],
  codex: [],
  providerKeys: [
    { id: 'gemini', set: false },
    { id: 'openai', set: false },
    { id: 'groq', set: false },
  ],
};

export function sharedState(
  opts: {
    version?: number;
    settings?: Partial<SharedSettings>;
    secrets?: Partial<SharedSecretsSummary>;
    hosts?: SharedState['hosts'];
    problem?: string;
  } = {},
): SharedState {
  return {
    version: opts.version ?? 1,
    settings: { ...DEFAULT_SHARED_SETTINGS, ...opts.settings },
    secrets: { ...NO_SECRETS, ...opts.secrets },
    hosts: opts.hosts ?? [],
    ...(opts.problem ? { problem: opts.problem } : {}),
  };
}

/** Load shared settings as though the server had just sent them. */
export function loadShared(opts: Parameters<typeof sharedState>[0] = {}): SharedState {
  const state = sharedState(opts);
  usePreferencesStore.setState({ shared: null });
  usePreferencesStore.getState().apply(state);
  return state;
}

export function resetShared(): void {
  usePreferencesStore.setState({
    preferences: DEFAULT_SHARED_SETTINGS,
    loaded: false,
    shared: null,
  });
}
