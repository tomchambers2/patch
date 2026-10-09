// Writing a shared setting (spec/01 § Settings), as web does.
//
// A write goes to the server, which commits it and sends it to every host; the
// phone settles on the server's answer. A refusal is said in the server's own
// words. Nothing here needs any particular host to be online.

import { Alert } from 'react-native';
import type { AccountPreferences, SharedState } from '../../api/rest';
import { useSettingsStore } from '../../stores/settingsStore';

/** The server's own sentence for a refused change, else the error's. */
export function problemText(err: unknown): string {
  const body = (err as { body?: unknown } | null)?.body;
  if (body && typeof body === 'object') {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Run one write; settle on the committed state, or say why it was refused. */
export async function writeShared(
  what: string,
  call: () => Promise<SharedState>,
): Promise<boolean> {
  try {
    useSettingsStore.getState().applyShared(await call());
    return true;
  } catch (e) {
    Alert.alert(`${what} failed`, problemText(e));
    return false;
  }
}

/** Change shared settings, settling on the committed settings. */
export async function patchShared(
  what: string,
  patch: Partial<AccountPreferences>,
): Promise<boolean> {
  try {
    await useSettingsStore.getState().updatePreferences(patch);
    return true;
  } catch (e) {
    Alert.alert(`${what} failed`, problemText(e));
    return false;
  }
}
