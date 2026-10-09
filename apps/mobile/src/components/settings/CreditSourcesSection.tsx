// Settings → Usage (design/settings-redesign; spec/10 § Backend credentials):
// the Claude and ChatGPT accounts every host draws from — each list ranked,
// with the strategy that picks among them, each account's freshest usage
// reading from any host, and a ⋯ of actions — and whether a turn stopped by a
// limit resumes on its own.
//
// The accounts are shared settings (spec/01 § Settings): every change is a
// server write that settles on the committed state, and none needs any
// particular host online. A ChatGPT sign-in is the one thing that runs on a
// machine, since Codex does the device flow; its login then goes to the server.

import React from 'react';
import { Alert, Linking, View } from 'react-native';
import type { AccountStrategy, DaemonAccountSummary } from '@patch/wire';
import { api, type SharedBackendId, type SharedState } from '../../api/rest';
import { space } from '../../lib/theme';
import { usePresenceStore, type HostPresence } from '../../stores/presenceStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { AnchoredMenuItem } from '../AnchoredMenu';
import { SettingsSection } from '../SettingsSection';
import { moveAccount, moveItems, Rank, RowMenu, TokenEntry, UsageBars } from './accountRows';
import { hostLabel, sendToHost } from './hostSend';
import { NoticeRow } from './HostSwitcher';
import { SettingsPage } from './SettingsPage';
import { patchShared, writeShared } from './sharedWrite';
import {
  ButtonRow,
  Chips,
  ErrorLine,
  Muted,
  Row,
  SettingsButton,
  ToggleRow,
  WithSettings,
} from './ui';

export { CLAUDE_ACK_TIMEOUT_MS } from './accountRows';

const STRATEGIES: readonly AccountStrategy[] = [
  'priority',
  'round-robin',
  'soonest-reset',
  'least-used',
];
const STRATEGY_LABEL: Record<AccountStrategy, string> = {
  priority: 'Priority',
  'round-robin': 'Round robin',
  'soonest-reset': 'Soonest reset',
  'least-used': 'Least used',
};
const NAME: Record<SharedBackendId, string> = { 'claude-code': 'Claude', codex: 'ChatGPT' };

type SharedRow = SharedState['secrets']['claude'][number] | SharedState['secrets']['codex'][number];

export function UsagePage(): React.ReactElement {
  const shared = useSettingsStore((s) => s.data?.shared ?? null);
  return (
    <SettingsPage title="Usage" testID="settings-page-usage">
      {shared === null ? (
        <SettingsSection title="Claude">
          <NoticeRow testID="usage-loading" text="Settings haven’t loaded yet" />
        </SettingsSection>
      ) : (
        <>
          <Accounts backendId="claude-code" rows={shared.secrets.claude} />
          <Accounts backendId="codex" rows={shared.secrets.codex} />
        </>
      )}
      <WithSettings testID="auto-resume">
        {(data) => (
          <SettingsSection testID="settings-auto-resume">
            <ToggleRow
              label="Resume automatically when a limit resets"
              testID="auto-resume-rate-limit"
              value={data.preferences.autoResumeRateLimit}
              onChange={(next) => void patchShared('Auto-resume', { autoResumeRateLimit: next })}
            />
          </SettingsSection>
        )}
      </WithSettings>
    </SettingsPage>
  );
}

/** The freshest reading of an account any host has taken, and which host took it. */
function useReading(
  backendId: SharedBackendId,
  accountId: string,
): { summary: DaemonAccountSummary; host: HostPresence } | null {
  const hosts = usePresenceStore((s) => s.hosts);
  let best: { summary: DaemonAccountSummary; host: HostPresence } | null = null;
  for (const host of Object.values(hosts)) {
    const summary = host.accounts[backendId]?.accounts?.find((a) => a.id === accountId);
    if (!summary) continue;
    if (best === null || (summary.usage?.at ?? 0) > (best.summary.usage?.at ?? 0)) {
      best = { summary, host };
    }
  }
  return best;
}

/** One backend's shared accounts, ranked, with its strategy and a way to add one. */
function Accounts({
  backendId,
  rows,
}: {
  backendId: SharedBackendId;
  rows: readonly SharedRow[];
}): React.ReactElement {
  const strategy = useSettingsStore(
    (s) => s.data?.preferences.accountStrategy[backendId === 'codex' ? 'codex' : 'claude'],
  );
  const [moving, setMoving] = React.useState(false);
  const name = NAME[backendId];
  const move = (index: number, dir: -1 | 1): void => {
    setMoving(true);
    void writeShared('Reorder', () =>
      api.orderAccounts(
        backendId,
        moveAccount(
          rows.map((r) => r.id),
          index,
          dir,
        ),
      ),
    ).finally(() => setMoving(false));
  };
  return (
    <SettingsSection
      title={name}
      testID={`accounts-${backendId}`}
      footer={backendId === 'codex' ? <AddChatGPT /> : <AddClaude />}
    >
      <Row testID={`strategy-${backendId}`} title="Pick the account by" stack>
        <Chips
          options={STRATEGIES}
          selected={strategy ?? 'priority'}
          labelOf={(s) => STRATEGY_LABEL[s]}
          testIDPrefix={`strategy-${backendId}`}
          labelPrefix={`${name} strategy`}
          onSelect={(s) =>
            void writeShared(`${name} strategy`, () => api.setAccountStrategy(backendId, s))
          }
        />
      </Row>
      {rows.length === 0 ? (
        <NoticeRow testID={`accounts-empty-${backendId}`} text={`No ${name} accounts yet`} />
      ) : (
        rows.map((row, i) => (
          <AccountRow
            key={row.id}
            backendId={backendId}
            row={row}
            rows={rows}
            rank={i + 1}
            moving={moving}
            onMove={(dir) => move(i, dir)}
          />
        ))
      )}
    </SettingsSection>
  );
}

function AccountRow({
  backendId,
  row,
  rows,
  rank,
  moving,
  onMove,
}: {
  backendId: SharedBackendId;
  row: SharedRow;
  rows: readonly SharedRow[];
  rank: number;
  moving: boolean;
  onMove: (dir: -1 | 1) => void;
}): React.ReactElement {
  const reading = useReading(backendId, row.id);
  const [connecting, setConnecting] = React.useState(false);
  const id = `${backendId}-${row.id}`;
  const organizationId = 'organizationId' in row ? row.organizationId : undefined;
  // Two rows on one Claude organisation are one pool of credit under two labels.
  const twin =
    organizationId === undefined
      ? undefined
      : rows.find(
          (r) => r.id !== row.id && 'organizationId' in r && r.organizationId === organizationId,
        );
  const subtitle = [
    row.email ?? null,
    row.connected ? null : 'Not connected',
    'kind' in row && row.kind === 'apiKey' ? 'API key' : null,
    reading ? `read on ${hostLabel(reading.host.daemonId)}` : null,
  ]
    .filter((x): x is string => x !== null)
    .join(' · ');

  const refresh = (): void => {
    const host =
      reading?.host.online === true
        ? reading.host
        : Object.values(usePresenceStore.getState().hosts).find((h) => h.online);
    if (!host) {
      Alert.alert('Refresh usage failed', 'No host is online to read it.');
      return;
    }
    sendToHost(
      host.daemonId,
      { type: 'host.backend_usage_refresh', daemonId: host.daemonId, backendId },
      'Refresh usage',
    );
  };

  const items: AnchoredMenuItem[] = [
    ...moveItems(`account-${id}`, rank - 1, rows.length, moving),
    { id: 'refresh', label: 'Refresh usage', testID: `account-${id}-refresh` },
    ...(backendId === 'claude-code'
      ? [
          {
            id: 'connect',
            label: row.connected ? 'Replace token' : 'Connect',
            testID: `account-${id}-connect`,
          },
        ]
      : []),
    ...(row.connected
      ? [
          {
            id: 'disconnect',
            label: 'Disconnect',
            testID: `account-${id}-disconnect`,
            destructive: true,
          },
        ]
      : []),
    { id: 'remove', label: 'Remove', testID: `account-${id}-remove`, destructive: true },
  ];

  const onSelect = (action: string): void => {
    if (action === 'up') onMove(-1);
    else if (action === 'down') onMove(1);
    else if (action === 'refresh') refresh();
    else if (action === 'connect') setConnecting(true);
    else if (action === 'disconnect') {
      Alert.alert(
        `Disconnect ${row.label}?`,
        'Every host stops using it until it is connected again.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Disconnect',
            style: 'destructive',
            onPress: () =>
              void writeShared('Disconnect', () => api.disconnectAccount(backendId, row.id)),
          },
        ],
      );
    } else if (action === 'remove') {
      Alert.alert(`Remove ${row.label}?`, 'It is removed from every host.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => void writeShared('Remove', () => api.removeAccount(backendId, row.id)),
        },
      ]);
    }
  };

  return (
    <View testID={`account-${id}`} style={{ paddingVertical: space.xs }}>
      <Row
        title={row.label}
        subtitle={subtitle === '' ? undefined : subtitle}
        leading={<Rank n={rank} active={false} />}
        right={
          <RowMenu
            testID={`account-${id}-menu`}
            label={row.label}
            items={items}
            onSelect={onSelect}
          />
        }
      />
      {twin ? (
        <Muted testID={`account-${id}-twin`}>Same Claude account as {twin.label}</Muted>
      ) : null}
      {reading?.summary.error ? (
        <ErrorLine testID={`account-${id}-error`} message={reading.summary.error} />
      ) : null}
      <UsageBars usage={reading?.summary.usage} testID={`account-${id}-usage`} refreshing={false} />
      {connecting ? (
        <TokenEntry
          testID={`account-${id}-token`}
          placeholder="sk-ant-oat01-…"
          submitLabel="Connect"
          onSubmit={(token) => {
            if (token === '') return;
            void writeShared('Connect', () => api.updateAccount(backendId, row.id, { token })).then(
              (ok) => {
                if (ok) setConnecting(false);
              },
            );
          }}
        />
      ) : null}
    </View>
  );
}

/** Add a Claude account from a pasted token, or use a host's own login. */
function AddClaude(): React.ReactElement {
  const hosts = usePresenceStore((s) => s.hosts);
  const [open, setOpen] = React.useState(false);
  const online = Object.values(hosts).filter((h) => h.online);
  return (
    <View style={{ gap: space.sm }}>
      <ButtonRow>
        <SettingsButton
          testID="add-claude-account"
          label="Add account"
          onPress={() => setOpen(true)}
        />
      </ButtonRow>
      {open ? (
        <TokenEntry
          testID="add-claude"
          placeholder="sk-ant-oat01-…"
          submitLabel="Add"
          withLabel
          onSubmit={(token, label) => {
            if (token === '') return;
            void writeShared('Add account', () =>
              api.addAccount('claude-code', { token, ...(label ? { label } : {}) }),
            ).then((ok) => {
              if (ok) setOpen(false);
            });
          }}
        />
      ) : null}
      {online.map((h) => (
        <SettingsButton
          key={h.daemonId}
          testID={`adopt-claude-${h.daemonId}`}
          label={`Use the login on ${hostLabel(h.daemonId)}`}
          variant="quiet"
          onPress={() =>
            void writeShared('Use login', () => api.adoptAccount('claude-code', h.daemonId))
          }
        />
      ))}
    </View>
  );
}

/**
 * Add a ChatGPT account: a device sign-in run on an online host (its login goes
 * to the server), an API key added straight to the server, or a host's own
 * Codex login.
 */
function AddChatGPT(): React.ReactElement {
  const hosts = usePresenceStore((s) => s.hosts);
  const online = Object.values(hosts).filter((h) => h.online);
  const [hostId, setHostId] = React.useState<string | null>(null);
  const [keyOpen, setKeyOpen] = React.useState(false);
  const host = online.find((h) => h.daemonId === hostId) ?? online[0] ?? null;
  const login = host?.accounts['codex']?.login;
  const pending = login?.status === 'pending';
  const signIn = (authMethod: 'device' | 'cancel', requestId?: string): void => {
    if (!host) return;
    setHostId(host.daemonId);
    sendToHost(
      host.daemonId,
      {
        type: 'host.backend_add_account',
        daemonId: host.daemonId,
        backendId: 'codex',
        authMethod,
        requestId: requestId ?? `signin-${Date.now()}`,
      },
      'Sign in',
    );
  };
  return (
    <View style={{ gap: space.sm }} testID="add-chatgpt">
      <ButtonRow>
        <SettingsButton
          testID="chatgpt-signin"
          label="Sign in with ChatGPT"
          disabled={host === null || pending}
          onPress={() => signIn('device')}
        />
        <SettingsButton
          testID="chatgpt-add-api-key"
          label="Add API key"
          variant="quiet"
          onPress={() => setKeyOpen(true)}
        />
      </ButtonRow>
      {host === null ? (
        <NoticeRow testID="chatgpt-no-host" text="Connect a host to sign in" />
      ) : null}
      {keyOpen ? (
        <TokenEntry
          testID="chatgpt-api-key"
          placeholder="sk-…"
          submitLabel="Add"
          onSubmit={(apiKey) => {
            if (apiKey === '') return;
            void writeShared('Add API key', () => api.addAccount('codex', { apiKey })).then(
              (ok) => {
                if (ok) setKeyOpen(false);
              },
            );
          }}
        />
      ) : null}
      {pending && login && host ? (
        <View testID="chatgpt-login-pending" style={{ gap: space.xs }}>
          <Muted>Waiting for sign-in…</Muted>
          {login.code ? <Muted testID="chatgpt-login-code">{login.code}</Muted> : null}
          <ButtonRow>
            {login.url ? (
              <SettingsButton
                testID="chatgpt-login-open"
                label="Open sign-in"
                onPress={() => void Linking.openURL(login.url!)}
              />
            ) : null}
            <SettingsButton
              testID="chatgpt-login-cancel"
              label="Cancel sign-in"
              variant="quiet"
              onPress={() => signIn('cancel', login.requestId)}
            />
          </ButtonRow>
        </View>
      ) : null}
      {login?.status === 'failed' && login.error ? (
        <ErrorLine testID="chatgpt-login-error" message={login.error} />
      ) : null}
    </View>
  );
}
