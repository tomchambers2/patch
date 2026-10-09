// Shared fixtures for the Settings section tests: a full `/api/settings`
// response, and helpers that put hosts into the presence store exactly as the
// wire does (`daemon.host`, `daemon.account`).

import { act, type ReactTestInstance } from 'react-test-renderer';
import type { DaemonAccountSummary, DaemonHostEvent } from '@patch/wire';
import { CLAUDE_BACKEND_ID, DEFAULT_SHARED_SETTINGS } from '@patch/wire';
import type { SettingsResponse } from '../../src/api/rest';
import { usePresenceStore } from '../../src/stores/presenceStore';
import { useSettingsStore } from '../../src/stores/settingsStore';
import { useSettingsHostChoice } from '../../src/components/settings/HostSwitcher';

export function settingsFixture(patch: Partial<SettingsResponse> = {}): SettingsResponse {
  return {
    devices: [],
    push: { tokenCount: 1 },
    // The shared settings (spec/01 § Settings) as the server starts them.
    preferences: { ...DEFAULT_SHARED_SETTINGS },
    shared: {
      version: 1,
      secrets: {
        claude: [],
        codex: [],
        providerKeys: [
          { id: 'gemini', set: false },
          { id: 'openai', set: false },
          { id: 'groq', set: false },
        ],
      },
      hosts: [],
    },
    ...patch,
  };
}

/** Seed the settings store as though `/api/settings` had answered. */
export function seedSettings(patch: Partial<SettingsResponse> = {}): SettingsResponse {
  const data = settingsFixture(patch);
  useSettingsStore.setState({ data, error: null });
  return data;
}

/** An empty roster with a live link, and no host picked in the Settings switcher. */
export function resetHosts(connection: 'connected' | 'offline' = 'connected'): void {
  usePresenceStore.setState({ hosts: {}, connection, daemon: 'unknown' });
  useSettingsHostChoice.setState({ daemonId: null });
}

/** Pick the host the per-host Settings pages show (the switcher's tap). */
export function pickHost(daemonId: string | null): void {
  useSettingsHostChoice.setState({ daemonId });
}

/** One host, online, having reported itself (`daemon.host`). */
export function reportHost(
  daemonId: string,
  patch: Partial<Omit<DaemonHostEvent, 'type' | 'daemonId'>> = {},
  online = true,
): void {
  const s = usePresenceStore.getState();
  s.setHostOnline(daemonId, online);
  s.setHostReport({
    type: 'daemon.host',
    daemonId,
    hostName: daemonId,
    platform: 'darwin',
    arch: 'arm64',
    daemonVersion: '0.1.375',
    updateAvailable: false,
    permissionModeDefault: 'default',
    permissionOverrides: 0,
    isHomeHost: false,
    audioRelayHost: '127.0.0.1:3003',
    backends: [],
    components: [],
    ...patch,
  });
}

/** One host's Claude credential report (`daemon.account`). */
export function reportClaude(
  daemonId: string,
  patch: {
    connected?: boolean;
    accountEmail?: string | null;
    accounts?: DaemonAccountSummary[];
    usage?: DaemonAccountSummary['usage'];
    credentialError?: { message: string; accountId?: string };
  } = {},
): void {
  usePresenceStore.getState().setHostAccount({
    type: 'daemon.account',
    daemonId,
    backendId: CLAUDE_BACKEND_ID,
    connected: patch.connected ?? false,
    accountEmail: patch.accountEmail ?? null,
    ...(patch.accounts ? { accounts: patch.accounts } : {}),
    ...(patch.usage ? { usage: patch.usage } : {}),
    ...(patch.credentialError
      ? { credentialError: { kind: 'rejected', ...patch.credentialError } }
      : {}),
  } as Parameters<ReturnType<typeof usePresenceStore.getState>['setHostAccount']>[0]);
}

/**
 * Open a row's ⋯ menu and press one of its items (AnchoredMenu). The menu's
 * Modal only mounts while open, so the item exists only after the ⋯ press.
 */
export async function pressMenuItem(
  root: ReactTestInstance,
  menuTestID: string,
  itemTestID: string,
): Promise<void> {
  const menu = root.findAll((i) => typeof i.type === 'string' && i.props.testID === menuTestID);
  if (menu.length !== 1) throw new Error(`pressMenuItem: no single ⋯ with testID ${menuTestID}`);
  await act(async () => {
    menu[0]!.props.onPress();
  });
  const item = root.findAll((i) => typeof i.type === 'string' && i.props.testID === itemTestID);
  if (item.length !== 1) throw new Error(`pressMenuItem: no single item with testID ${itemTestID}`);
  await act(async () => {
    item[0]!.props.onPress();
  });
}
