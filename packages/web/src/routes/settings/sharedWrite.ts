// Writing a shared setting (spec/01 § Settings).
//
// Every write goes to the server, which commits it and answers with the
// committed shared state; hosts pick it up from the snapshot that follows. So
// a write needs the server, not any particular host, and a refusal is the
// server's own sentence.

import type { AccountPreferences, SharedState } from '../../api/rest.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { useUiStore } from '../../stores/uiStore.js';

/** The server's own sentence for a refused change, else the error's. */
export function problemText(err: unknown): string {
  // Read off the error rather than `instanceof ApiError`, so this stays free of
  // the REST module's runtime (tests stand it in).
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
    usePreferencesStore.getState().apply(await call());
    return true;
  } catch (e) {
    useUiStore.getState().pushError(`${what}: ${problemText(e)}`);
    return false;
  }
}

/**
 * Change shared settings. The answer is the committed settings; the rest of the
 * shared state (version, hosts) follows on the `settings.changed` push.
 */
export async function patchShared(
  what: string,
  patch: Partial<AccountPreferences>,
): Promise<boolean> {
  try {
    await usePreferencesStore.getState().update(patch);
    return true;
  } catch (e) {
    useUiStore.getState().pushError(`${what}: ${problemText(e)}`);
    return false;
  }
}
