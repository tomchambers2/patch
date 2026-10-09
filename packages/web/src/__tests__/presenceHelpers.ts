// Test helpers for the per-host presence store.
//
// Credentials are per host per backend (spec/10 § Surface in Settings), so a
// test that wants "Claude is connected" has to say WHICH machine — there is no
// account-wide slot to set. These wrap the `daemon.account` report the host
// really sends.

import {
  CLAUDE_BACKEND_ID,
  type ClaudeMemoryEntry,
  type DaemonAccountEvent,
  type DaemonAccountSummary,
  type DaemonHostEvent,
} from '@patch/wire';
import { usePresenceStore } from '../stores/presenceStore.js';

/** Report one host's Claude credential, exactly as `daemon.account` does. */
export function reportAccount(
  daemonId: string,
  connected: boolean,
  accountEmail: string | null = null,
  usage?: DaemonAccountEvent['usage'],
): void {
  usePresenceStore.getState().setHostAccount({
    type: 'daemon.account',
    daemonId,
    backendId: CLAUDE_BACKEND_ID,
    connected,
    accountEmail,
    ...(usage === undefined ? {} : { usage }),
  });
}

/**
 * Report one host's Claude credential state carrying the multi-account list
 * (spec/10 § Backend credentials — multiple accounts). The top-level
 * `connected`/`accountEmail`/`usage` mirror whichever entry is
 * `activeAccountId` (or the first entry, if `activeAccountId` is omitted),
 * exactly as the real host does — so a test can assert on either the
 * legacy single-row fields or the new per-account rows off the same report.
 */
export function reportAccounts(
  daemonId: string,
  accounts: DaemonAccountSummary[],
  activeAccountId?: string,
): void {
  const active = accounts.find((a) => a.id === activeAccountId) ?? accounts[0] ?? undefined;
  usePresenceStore.getState().setHostAccount({
    type: 'daemon.account',
    daemonId,
    backendId: CLAUDE_BACKEND_ID,
    connected: active?.connected ?? false,
    accountEmail: active?.accountEmail ?? null,
    ...(active?.usage === undefined ? {} : { usage: active.usage }),
    accounts,
    ...(activeAccountId === undefined ? {} : { activeAccountId }),
  });
}

/**
 * Report one host's self-description (`daemon.host`), which is where the host's
 * last-used model comes from (spec/02 § Agent backends, spec/03 § `daemon.host`).
 */
export function reportHost(
  daemonId: string,
  patch: Partial<Omit<DaemonHostEvent, 'type' | 'daemonId'>> = {},
): void {
  const {
    questionExpiry,
    questionExpirySeconds,
    hostName,
    permissionModeDefault,
    permissionOverrides,
    isHomeHost,
    audioRelayHost,
    ...rest
  } = patch;
  usePresenceStore.getState().setHostReport({
    type: 'daemon.host',
    daemonId,
    hostName: hostName ?? daemonId,
    platform: 'darwin',
    arch: 'arm64',
    daemonVersion: '0.0.0-test',
    updateAvailable: false,
    permissionModeDefault: permissionModeDefault ?? 'bypassPermissions',
    permissionOverrides: permissionOverrides ?? 0,
    isHomeHost: isHomeHost ?? true,
    audioRelayHost: audioRelayHost ?? '127.0.0.1:3003',
    backends: [],
    components: [],
    // Anything else the test names (harnessMcpServers, kokoroVoice, backends,
    // updateAvailable, …) is reported exactly as given.
    ...rest,
    // Stated together or not at all — Settings reads the pair's absence as
    // "this host predates the setting" and offers no control for it.
    ...(questionExpiry === undefined || questionExpirySeconds === undefined
      ? {}
      : { questionExpiry, questionExpirySeconds }),
  });
}

/** Report one host's Claude Code settings + memory snapshot (`claude_settings.list`). */
export function reportClaudeSettings(
  daemonId: string,
  memories: ClaudeMemoryEntry[] = [],
  drift?: string,
): void {
  usePresenceStore.getState().setClaudeSettings(daemonId, drift, memories);
}

/** Report one host's folder registry (`folders.list` / `folders.updated`). */
export function reportFolders(daemonId: string, roots: string[], recent: string[] = []): void {
  usePresenceStore.getState().setHostFolders(daemonId, roots, recent);
}

/** Back to "no host has reported anything" — the pre-greeting state. */
export function clearHosts(): void {
  usePresenceStore.setState({ hosts: {}, daemonOnline: false });
}

/**
 * Report a credential validation failure from the host, exactly as
 * `daemon.account` does with `credentialError` set. One-shot: the server
 * does not cache it, so a surface that connects after the fact never sees it.
 */
export function reportCredentialError(
  daemonId: string,
  credentialError: NonNullable<DaemonAccountEvent['credentialError']>,
  /** The accounts that are still in the store (unchanged after a rejection). */
  accounts: DaemonAccountSummary[] = [],
  activeAccountId?: string,
): void {
  const active = accounts.find((a) => a.id === activeAccountId) ?? accounts[0] ?? undefined;
  usePresenceStore.getState().setHostAccount({
    type: 'daemon.account',
    daemonId,
    backendId: CLAUDE_BACKEND_ID,
    connected: active?.connected ?? false,
    accountEmail: active?.accountEmail ?? null,
    ...(accounts.length > 0 ? { accounts } : {}),
    ...(activeAccountId === undefined ? {} : { activeAccountId }),
    credentialError,
  });
}
