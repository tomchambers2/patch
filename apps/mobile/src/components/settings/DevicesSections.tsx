// Settings → Devices (design/settings-redesign): Link a device, and the Linked
// devices (each other one revocable). And the Voice devices group Settings →
// Voice shows.
//
// Linked reads the same `/api/settings` list web does, each other device
// revocable (`POST /api/auth/revoke`). Link a device mints a pairing QR another
// phone scans (`POST /api/auth/pair/start`).

import React from 'react';
import { Alert, Pressable, Text, View, useColorScheme } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { create as createQr } from 'qrcode';
import { api, type LinkedDevice } from '../../api/rest';
import { getRoute } from '../../config';
import { encodePairingUri } from '@patch/wire';
import { LINKED_DEVICES_TITLE, friendlyDeviceName } from '../../lib/labels';
import { fonts, radii, space, typography, useTheme } from '../../lib/theme';
import { usePresenceStore } from '../../stores/presenceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { SettingsSection } from '../SettingsSection';
import { agoLabel } from './hostSend';
import { NoticeRow } from './HostSwitcher';
import { SettingsPage } from './SettingsPage';
import { Dot, ErrorLine, Muted, Row, SettingsButton, WithSettings } from './ui';

export function DevicesPage(): React.ReactElement {
  const [linking, setLinking] = React.useState(false);
  return (
    <SettingsPage
      title="Devices"
      testID="settings-page-devices"
      right={
        linking ? null : (
          <SettingsButton
            testID="link-device"
            label="Link a device"
            onPress={() => setLinking(true)}
          />
        )
      }
    >
      {linking ? <LinkDeviceQr onClose={() => setLinking(false)} /> : null}
      <LinkedDevicesSection />
    </SettingsPage>
  );
}

export function LinkedDevicesSection(): React.ReactElement {
  return (
    <SettingsSection title="Linked" testID="settings-devices">
      <WithSettings testID="devices">
        {(data) => (
          <>
            {data.devices.length === 0 ? (
              <NoticeRow testID="devices-empty" text={`No ${LINKED_DEVICES_TITLE.toLowerCase()}`} />
            ) : (
              data.devices.map((d) => (
                <Row
                  key={d.surfaceId}
                  testID={`device-${d.surfaceId}`}
                  leading={<Dot on={d.status === 'online'} />}
                  title={friendlyDeviceName(d.surfaceKind, d.label)}
                  subtitle={deviceSubtitle(d)}
                  right={
                    d.isCurrent ? null : (
                      <SettingsButton
                        testID={`device-revoke-${d.surfaceId}`}
                        label="Revoke"
                        variant="danger"
                        onPress={() => {
                          void api
                            .revoke(d.surfaceId)
                            .then(() => useSettingsStore.getState().load())
                            .catch((e: Error) => Alert.alert('Revoke failed', e.message));
                        }}
                      />
                    )
                  }
                />
              ))
            )}
            <Row
              title="Push"
              right={<Muted testID="push-count">{`${data.push.tokenCount} registered`}</Muted>}
            />
          </>
        )}
      </WithSettings>
    </SettingsSection>
  );
}

/** `This device`, or its kind and, when it is not online, when it was last seen. */
export function deviceSubtitle(d: LinkedDevice, now: number = Date.now()): string {
  if (d.isCurrent) return 'This device';
  const kind = friendlyDeviceName(d.surfaceKind);
  return d.status === 'online' ? kind : `${kind} · seen ${agoLabel(d.lastHeartbeat, now)}`;
}

/**
 * The pairing code the QR encodes (spec/05 § Canonical QR payload): the one the
 * server made, which knows how a new device should reach it; failing that, the
 * way THIS device reaches it.
 */
export function buildPairingPayload(issued: { nonce: string; uri?: string }): string {
  if (issued.uri) return issued.uri;
  const route = getRoute();
  if (route === null) throw new Error('This device is not paired to a server yet');
  return route.kind === 'direct'
    ? encodePairingUri({ nonce: issued.nonce, server: route.url })
    : encodePairingUri({ nonce: issued.nonce, relay: route.relay });
}

/** The QR as one SVG path of unit squares. */
export function qrPath(payload: string): { size: number; d: string } {
  const { modules } = createQr(payload, { errorCorrectionLevel: 'M' });
  let d = '';
  for (let r = 0; r < modules.size; r++) {
    for (let c = 0; c < modules.size; c++) {
      if (modules.data[r * modules.size + c]) d += `M${c} ${r}h1v1h-1z`;
    }
  }
  return { size: modules.size, d };
}

/**
 * Link a device (spec/10 § Surface linking): mint a genuine single-use nonce
 * only when opened, and show it as a QR the new phone scans plus the code in
 * text. Re-minted before the five-minute expiry while open. A mint failure is
 * shown as itself with a Retry — never a decorative image (NO FALLBACK).
 */
function LinkDeviceQr({ onClose }: { onClose: () => void }): React.ReactElement {
  const colors = useTheme();
  const scheme = useColorScheme();
  const [issued, setIssued] = React.useState<{ nonce: string; uri?: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const mint = React.useCallback(() => {
    setError(null);
    void api
      .surfacePairStart()
      .then((r) => setIssued(r))
      .catch((e: Error) => {
        setIssued(null);
        setError(e.message);
      });
  }, []);

  React.useEffect(() => {
    mint();
    const timer = setInterval(mint, 4.5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [mint]);

  // Scanners read dark modules on a light ground, so the QR always takes the
  // darker of the two palette inks for its modules, whichever scheme is on.
  const dark = scheme === 'dark' ? colors.paper : colors.ink;
  const light = scheme === 'dark' ? colors.ink : colors.paper;
  const nonce = issued?.nonce ?? null;
  const qr = issued ? qrPath(buildPairingPayload(issued)) : null;

  return (
    <SettingsSection title="Link a device" testID="link-device-panel">
      <View style={{ padding: space.md, gap: space.sm }}>
        {error ? (
          <ErrorLine
            testID="link-device-error"
            message={`Could not issue a pairing code: ${error}`}
            onRetry={mint}
          />
        ) : qr && nonce ? (
          <>
            <View
              style={{
                alignSelf: 'center',
                padding: space.md,
                backgroundColor: light,
                borderRadius: radii.sm,
              }}
            >
              <Svg
                testID="link-device-qr"
                width={220}
                height={220}
                viewBox={`0 0 ${qr.size} ${qr.size}`}
                accessibilityLabel="Link-a-device pairing QR code"
              >
                <Rect x={0} y={0} width={qr.size} height={qr.size} fill={light} />
                <Path d={qr.d} fill={dark} />
              </Svg>
            </View>
            <Text
              testID="link-device-nonce"
              selectable
              style={{ color: colors.ink, ...typography.meta, textAlign: 'center' }}
            >
              {nonce}
            </Text>
          </>
        ) : (
          <Muted testID="link-device-loading">Issuing a pairing code…</Muted>
        )}
        <Pressable
          testID="link-device-close"
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
          style={{ alignSelf: 'center' }}
        >
          <Text style={{ color: colors.leaf, fontFamily: fonts.bodyMedium }}>Close</Text>
        </Pressable>
      </View>
    </SettingsSection>
  );
}

/**
 * Voice devices (spec/16) — the account's voice satellites. A voice device has
 * no screen, camera or keyboard, so there is no code or QR to offer here; it is
 * adopted by a machine during its adoption window, opened on that machine with
 * `patch hosts pair-device`.
 */
export function VoiceDevicesSection(): React.ReactElement {
  const hosts = usePresenceStore((s) => s.hosts);
  const machines = Object.values(hosts).filter((h) => h.host !== null);
  return (
    <SettingsSection title="Voice devices" testID="settings-voice-devices">
      {machines.length === 0 ? (
        <NoticeRow testID="voice-devices-no-machines" text="Add a host first" />
      ) : (
        <Row
          testID="voice-devices-empty"
          title="None paired"
          subtitle="patch hosts pair-device"
          subtitleTestID="voice-devices-how"
        />
      )}
    </SettingsSection>
  );
}
