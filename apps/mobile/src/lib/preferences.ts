// The account preferences the phone reads (spec/14 § `/settings` details).
//
// Two of them matter to a voice session. The address word a quiet call gates
// utterances on (spec/07 § Session modes), and the per-surface voice config
// (spec/07 § Voice — a config matrix) — which engine each surface runs on. The
// HOST is what picks the engine for a session; the phone reads the config
// only to name the engine on the call bar and to know when a mode switch
// crosses engines and so needs a fresh session. Both are cached at boot so
// opening a call needs no round-trip, and NOT defaulted — until the server has
// actually answered, a session carries no address word rather than a guess the
// host would enforce, and the call bar names no engine rather than a guess.

import type { VoiceConfig } from '@patch/wire/audio';
import { api, type AccountPreferences } from '../api/rest';
import { useSettingsStore } from '../stores/settingsStore';

let addressWord: string | null = null;
let voiceConfig: VoiceConfig | null = null;
let suppressProviderSwitchWarning = false;
let verbosity: AccountPreferences['providerContextVerbosity'] = 'summary';

export async function loadPreferences(): Promise<void> {
  const settings = await api.settings();
  if (!settings.preferences) throw new Error('server returned no account preferences');
  addressWord = settings.preferences.addressWord;
  voiceConfig = settings.preferences.voiceConfig;
  suppressProviderSwitchWarning = settings.preferences.suppressProviderSwitchWarning;
  verbosity = settings.preferences.providerContextVerbosity;
}

/**
 * The address word, or null until the preferences have actually loaded. A
 * Settings load or edit since boot is newer than the boot-time read, so it wins.
 */
export function addressWordOrNull(): string | null {
  return useSettingsStore.getState().data?.preferences.addressWord ?? addressWord;
}

/** The account's voice config, or null until the preferences have loaded. Same precedence. */
export function voiceConfigOrNull(): VoiceConfig | null {
  return useSettingsStore.getState().data?.preferences.voiceConfig ?? voiceConfig;
}

/**
 * Whether the provider-switch confirmation (spec/04 § History) should be
 * SKIPPED. Unlike the two accessors above, this defaults to `false` rather
 * than an unloaded null — a boolean has no "unknown" state to represent, and
 * the safe default is to show the warning until told otherwise, never to
 * silently suppress it because preferences haven't loaded yet.
 */
export function suppressProviderSwitchWarningOrFalse(): boolean {
  return (
    useSettingsStore.getState().data?.preferences.suppressProviderSwitchWarning ??
    suppressProviderSwitchWarning
  );
}

/**
 * The provider-level context bar's default expand state, as read at boot.
 * `summary` until then — the account's own default, and the setting that
 * hides nothing and opens nothing (spec/02 § Provider-level context).
 */
export function providerContextVerbosity(): AccountPreferences['providerContextVerbosity'] {
  return verbosity;
}

/** Test seam: forget the boot-time read. */
export function __resetPreferences(): void {
  addressWord = null;
  voiceConfig = null;
  suppressProviderSwitchWarning = false;
  verbosity = 'summary';
}
