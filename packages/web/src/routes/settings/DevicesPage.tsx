// Settings → Devices: the surfaces linked to this account, and linking another.

import type { JSX } from 'react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/rest.js';
import { useUiStore } from '../../stores/uiStore.js';
import { LinkDeviceQr } from '../../components/LinkDeviceQr.js';
import { Group, Note, OnlineDot, Row, SettingsPage } from './ui.js';
import { failed } from '../../lib/errorCopy.js';

export type LinkedDevice = Awaited<ReturnType<typeof api.settings>>['devices'][number];

/** The account's linked surfaces (from `/api/settings`) and revoking one. */
export function useDevices(): {
  devices: LinkedDevice[] | null;
  pushCount: number | null;
  revoke: (surfaceId: string) => void;
} {
  const qc = useQueryClient();
  const pushError = useUiStore((s) => s.pushError);
  const pushNotice = useUiStore((s) => s.pushNotice);
  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings(),
    refetchInterval: 15_000,
  });
  const revokeMut = useMutation({
    mutationFn: (id: string) => api.revoke(id),
    onSuccess: () => {
      pushNotice('Device removed.');
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (e) => pushError(failed('revoke'), undefined, (e as Error).message),
  });
  return {
    devices: settings?.devices ?? null,
    pushCount: settings?.push.tokenCount ?? null,
    revoke: (id) => revokeMut.mutate(id),
  };
}

const KIND_LABEL: Record<string, string> = {
  web: 'Web',
  desktop: 'Desktop',
  mobile: 'Android',
  terminal: 'Terminal',
  'voice-device': 'Voice device',
};

export function DeviceRow({
  device: d,
  onRevoke,
  extra,
}: {
  device: LinkedDevice;
  onRevoke: (surfaceId: string) => void;
  extra?: string;
}): JSX.Element {
  const sub = [
    d.isCurrent ? 'This device' : (KIND_LABEL[d.surfaceKind] ?? d.surfaceKind),
    extra ?? null,
  ].filter((x): x is string => x !== null);
  return (
    <Row
      testid={`device-${d.surfaceId}`}
      title={
        <>
          <OnlineDot online={d.status === 'online'} /> {d.label}
        </>
      }
      sub={sub.join(' · ')}
    >
      {d.isCurrent ? null : (
        <button
          type="button"
          className="set-btn danger"
          data-testid={`device-revoke-${d.surfaceId}`}
          onClick={() => onRevoke(d.surfaceId)}
        >
          Revoke
        </button>
      )}
    </Row>
  );
}

export function DevicesPage(): JSX.Element {
  const { devices, pushCount, revoke } = useDevices();
  const [linking, setLinking] = useState(false);
  const linked = devices?.filter((d) => d.surfaceKind !== 'voice-device') ?? null;

  return (
    <SettingsPage
      title="Devices"
      testid="settings-devices"
      actions={
        <button
          type="button"
          className="set-btn primary"
          data-testid="link-device-open"
          disabled={linking}
          onClick={() => setLinking(true)}
        >
          Link a device
        </button>
      }
    >
      {/* spec/10 § Surface linking — any linked surface can link another, so
          this works from desktop. */}
      {linking ? (
        <Group>
          <div className="set-row stack">
            <LinkDeviceQr onClose={() => setLinking(false)} />
          </div>
        </Group>
      ) : null}

      <Group label="Linked" testid="settings-linked">
        {linked === null ? (
          <Note>Loading…</Note>
        ) : linked.length === 0 ? (
          <Note>No linked surfaces.</Note>
        ) : (
          linked.map((d) => (
            <DeviceRow
              key={d.surfaceId}
              device={d}
              onRevoke={revoke}
              // Push registration belongs to the devices it is about, not to a
              // heading of its own stating a bare number.
              extra={
                d.surfaceKind === 'mobile' && pushCount !== null
                  ? `${pushCount} registered for push`
                  : undefined
              }
            />
          ))
        )}
      </Group>
    </SettingsPage>
  );
}
