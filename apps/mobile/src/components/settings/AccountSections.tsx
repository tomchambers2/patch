// Settings → Account (design/settings-redesign): which account this phone is
// linked to and which server it talks to; then This device — Sign this device
// out (Deactivate).

import React from 'react';
import { Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { api } from '../../api/rest';
import { routeLabel } from '../../config';
import { teardown } from '../../lib/bootstrap';
import { clearCredential, decodeSurfaceClaims } from '../../lib/credential';
import { friendlyDeviceName } from '../../lib/labels';
import { useUiStore } from '../../stores/uiStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { SettingsSection } from '../SettingsSection';
import { SettingsPage } from './SettingsPage';
import { Row, SettingsButton, ValueRow } from './ui';

interface Me {
  account: { accountId: string; userPublicKey: string; createdAt: number };
  surface: { surfaceId: string; surfaceKind: string; label: string; issuedAt: number };
}

/** This surface's identity, seeded from the local credential (no network wait). */
function seededMe(): Me | null {
  const c = decodeSurfaceClaims();
  return c
    ? {
        account: { accountId: c.accountId, userPublicKey: c.accountId, createdAt: 0 },
        surface: {
          surfaceId: c.surfaceId,
          surfaceKind: c.surfaceKind,
          label: c.label,
          issuedAt: 0,
        },
      }
    : null;
}

/** `patch.example.com` — the server's address without its scheme. */
export function serverHost(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export function AccountPage(): React.ReactElement {
  return (
    <SettingsPage title="Account" testID="settings-page-account">
      <AccountSection />
      <SettingsSection title="Connection" testID="settings-connection">
        <SettingsButton
          testID="account-connection"
          label="Reconnect to server"
          onPress={() => useUiStore.getState().setDiagnosticsOpen(true)}
        />
      </SettingsSection>
      <ThisSurfaceSection />
    </SettingsPage>
  );
}

/**
 * The account and server — painted instantly from the locally-held credential
 * JWT; `/api/auth/me` is only a background refresh and must not gate first
 * paint. A failed refresh keeps the seeded identity: those values come from
 * the trusted credential, not /me.
 */
export function AccountSection(): React.ReactElement {
  const [me, setMe] = React.useState<Me | null>(seededMe);
  const [loading, setLoading] = React.useState(() => decodeSurfaceClaims() === null);

  React.useEffect(() => {
    let live = true;
    void api
      .me()
      .then((r) => {
        if (live) setMe(r);
      })
      .catch(() => {
        /* keep the seeded identity; /me is a non-authoritative refresh */
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <SettingsSection testID="settings-account">
      <ValueRow
        label="Account"
        testID="account-id"
        value={me ? me.account.accountId : undefined}
        loading={loading}
      />
      <ValueRow label="Server" value={routeLabel()} testID="connection-origin" />
      <ValueRow
        label="This device"
        testID="account-this-device"
        value={me ? friendlyDeviceName(me.surface.surfaceKind, me.surface.label) : undefined}
        loading={loading}
      />
    </SettingsSection>
  );
}

/**
 * This device — Sign this device out. Not a "log out": this surface is LINKED
 * to the account, so leaving means revoking it (`POST /api/auth/revoke` with
 * its own id, as web does) and pairing again by QR. Confirmed first; cancelling
 * is a complete no-op. A failed revoke still clears locally and says so, so
 * what happened is visible.
 */
export function ThisSurfaceSection(): React.ReactElement {
  const router = useRouter();

  const deactivate = async (): Promise<void> => {
    const surfaceId =
      decodeSurfaceClaims()?.surfaceId ?? usePresenceStore.getState().surfaceId ?? null;
    let failure: string | null = null;
    if (surfaceId === null) {
      failure = 'this phone does not know its own surface id, so it could not be revoked';
    } else {
      try {
        await api.revoke(surfaceId);
      } catch (e) {
        failure = (e as Error).message;
      }
    }
    clearCredential();
    teardown();
    router.replace('/pair');
    if (failure !== null) Alert.alert('Revoke failed', failure);
  };

  return (
    <SettingsSection title="This device" testID="settings-this-surface">
      <Row
        title="Sign this device out"
        right={
          <SettingsButton
            testID="deactivate-surface"
            label="Deactivate"
            variant="danger"
            onPress={() =>
              Alert.alert(
                'Sign this device out?',
                'It is removed from your account and has to be paired again to be used.',
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Deactivate', style: 'destructive', onPress: () => void deactivate() },
                ],
              )
            }
          />
        }
      />
    </SettingsSection>
  );
}
