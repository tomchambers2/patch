// Settings → Account: which account and server this surface is on, and taking
// this surface off it.

import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/rest.js';
import { clearCredential } from '../../lib/credential.js';
import { useUiStore } from '../../stores/uiStore.js';
import { Group, Row, SettingsPage } from './ui.js';
import { failed } from '../../lib/errorCopy.js';

export function AccountPage(): JSX.Element {
  const pushError = useUiStore((s) => s.pushError);
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: () => api.me() });
  const { data: health } = useQuery({ queryKey: ['healthz'], queryFn: () => api.healthz() });
  const { data: relay } = useQuery({
    queryKey: ['relay'],
    queryFn: () => api.relay(),
    refetchInterval: 10_000,
  });

  async function handleDeactivateSurface(): Promise<void> {
    // spec/14 § /settings details → "This surface". Not a "log out": there is no
    // session to end — this surface is LINKED to the account, so leaving means
    // revoking it, and it must be paired again by QR to come back. Destructive,
    // so it is confirmed first; cancelling is a complete no-op.
    const ok = await useUiStore.getState().confirm({
      title: 'Deactivate surface',
      message:
        'Deactivate this surface? It is removed from your account and has to be paired again to be used.',
      confirmLabel: 'Deactivate',
      danger: true,
    });
    if (!ok) return;
    const surfaceId = me?.surface?.surfaceId;
    try {
      // Self-revoke this surface (server requires the id).
      if (surfaceId) await api.revoke(surfaceId);
    } catch (e) {
      pushError(failed('revoke'), undefined, (e as Error).message);
    }
    clearCredential();
    window.location.reload();
  }

  return (
    <SettingsPage title="Account" testid="settings-account">
      <Group testid="settings-build">
        <Row
          title="Account"
          sub={<code data-testid="account-id">{me?.account.accountId ?? '—'}</code>}
        />
        <Row
          title="Server"
          testid="build-line"
          sub={
            <>
              <code data-testid="build-origin">{window.location.origin}</code>
              {' · '}
              <code data-testid="build-sha">{health?.gitSha ?? '—'}</code>
            </>
          }
        />
        {relay?.enabled ? (
          <Row
            title="Remote access"
            testid="relay-line"
            sub={
              <span data-testid="relay-state">
                {relay.connected
                  ? `Reachable through ${relay.url.replace(/^wss?:\/\//, '')}${relay.sessions > 0 ? ` · ${relay.sessions} connected` : ''}`
                  : `Not reachable through ${relay.url.replace(/^wss?:\/\//, '')}${relay.lastError ? `: ${relay.lastError}` : ''}`}
              </span>
            }
          />
        ) : null}
      </Group>
      <Group label="This device" testid="settings-session">
        <Row title="Sign this device out">
          <button
            type="button"
            className="set-btn danger"
            data-testid="deactivate-surface"
            onClick={() => void handleDeactivateSurface()}
          >
            Deactivate
          </button>
        </Row>
      </Group>
    </SettingsPage>
  );
}
