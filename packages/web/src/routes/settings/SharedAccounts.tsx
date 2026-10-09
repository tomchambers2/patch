// Usage → the Claude and ChatGPT accounts (spec/10 § Backend credentials).
//
// The accounts are shared settings (spec/01 § Settings): one ordered list per
// backend, held on the server and sent to every host. Every change here is a
// server write and settles on its answer. What a host does add is its own view
// of each account — whether its check passed and how much is used — which
// arrives on that host's `daemon.account` report; the freshest reading any
// host has taken is the one shown.

import type { JSX, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { AccountStrategy, DaemonAccountSummary } from '@patch/wire';
import { api, type SharedBackendId } from '../../api/rest.js';
import { getActiveWs } from '../../api/ws.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { usePresenceStore, type HostPresence } from '../../stores/presenceStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { formatReadAt } from '../../lib/usage.js';
import { hostLabel, sortHosts } from './hostScope.js';
import { sendToHost } from './hostWrite.js';
import { writeShared } from './sharedWrite.js';
import { AccountRow, RankedList, UsageBars } from './accountList.js';
import { Note, Pills, Row } from './ui.js';

const STRATEGIES: readonly AccountStrategy[] = [
  'priority',
  'round-robin',
  'soonest-reset',
  'least-used',
];
const STRATEGY_LABELS: Record<AccountStrategy, string> = {
  priority: 'Priority',
  'round-robin': 'Round robin',
  'soonest-reset': 'Soonest reset',
  'least-used': 'Least used',
};

const BACKEND_NAME: Record<SharedBackendId, string> = { 'claude-code': 'Claude', codex: 'ChatGPT' };

interface SharedRow {
  id: string;
  label: string;
  connected: boolean;
  email?: string;
  organizationId?: string;
  kind?: 'chatgpt' | 'apiKey';
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

/** One backend's shared accounts, ranked, with the strategy that picks among them. */
export function SharedAccounts({ backendId }: { backendId: SharedBackendId }): JSX.Element {
  const shared = usePreferencesStore((s) => s.shared);
  const strategy = usePreferencesStore(
    (s) => s.preferences.accountStrategy[backendId === 'codex' ? 'codex' : 'claude'],
  );
  const loaded = usePreferencesStore((s) => s.loaded);
  if (shared === null) return <Note testid={`accounts-loading-${backendId}`}>Loading…</Note>;
  const rows: SharedRow[] = backendId === 'codex' ? shared.secrets.codex : shared.secrets.claude;
  const name = BACKEND_NAME[backendId];

  return (
    <div data-testid={`accounts-${backendId}`}>
      <Row title="Pick the account by" testid={`strategy-row-${backendId}`}>
        <Pills
          label={`${name} account strategy`}
          options={STRATEGIES}
          value={strategy}
          disabled={!loaded}
          labels={STRATEGY_LABELS}
          testid={`strategy-${backendId}`}
          onChange={(next) =>
            void writeShared(`${name} strategy`, () => api.setAccountStrategy(backendId, next))
          }
        />
      </Row>
      {rows.length === 0 ? (
        <Note testid={`accounts-empty-${backendId}`}>No {name} accounts yet</Note>
      ) : (
        <RankedList
          testid={`accounts-rank-${backendId}`}
          onCommit={(next) =>
            writeShared(`${name} order`, () => api.orderAccounts(backendId, next))
          }
          items={rows.map((a) => ({
            id: a.id,
            render: (handle: ReactNode, rank: number) => (
              <AccountEntry backendId={backendId} row={a} rows={rows} handle={handle} rank={rank} />
            ),
          }))}
        />
      )}
    </div>
  );
}

function AccountEntry({
  backendId,
  row,
  rows,
  handle,
  rank,
}: {
  backendId: SharedBackendId;
  row: SharedRow;
  rows: SharedRow[];
  handle: ReactNode;
  rank: number;
}): JSX.Element {
  const pushError = useUiStore((s) => s.pushError);
  const reading = useReading(backendId, row.id);
  const name = BACKEND_NAME[backendId];
  const id = `${backendId}-${row.id}`;
  // Two rows on one Claude organisation are one pool of credit under two
  // labels: failover between them has nowhere to go, so it is said.
  const twin =
    row.organizationId === undefined
      ? undefined
      : rows.find((r) => r.id !== row.id && r.organizationId === row.organizationId);
  const readAt = formatReadAt(reading?.summary.usage?.at);
  const sub = [
    row.email ?? null,
    row.connected ? null : 'Not connected',
    row.kind === 'apiKey' ? 'API key' : null,
    readAt && reading ? `${readAt} on ${hostLabel(reading.host)}` : null,
  ].filter((x): x is string => x !== null);

  const refresh = (): void => {
    const host =
      reading?.host.online === true
        ? reading.host
        : Object.values(usePresenceStore.getState().hosts).find((h) => h.online);
    if (!host) {
      pushError('refresh usage: no host is online to read it');
      return;
    }
    sendToHost(host, { type: 'host.backend_usage_refresh', daemonId: host.daemonId, backendId });
  };

  const menu = [
    { label: 'Refresh usage', onSelect: refresh, testid: `account-refresh-${id}` },
    {
      label: 'Rename',
      testid: `account-rename-${id}`,
      onSelect: () =>
        void (async () => {
          const label = await useUiStore.getState().prompt({
            title: `Rename ${row.label}`,
            message: 'New name:',
            placeholder: row.label,
            confirmLabel: 'Rename',
          });
          if (label === null || label.trim() === '') return;
          await writeShared('rename', () =>
            api.updateAccount(backendId, row.id, { label: label.trim() }),
          );
        })(),
    },
    ...(backendId === 'claude-code'
      ? [
          {
            label: row.connected ? 'Replace token' : 'Connect',
            testid: `account-connect-${id}`,
            onSelect: () =>
              void (async () => {
                const token = await useUiStore.getState().prompt({
                  title: `Connect ${row.label}`,
                  message: 'Paste a token from `claude setup-token`:',
                  placeholder: 'sk-ant-oat01-…',
                  confirmLabel: 'Connect',
                });
                if (token === null || token.trim() === '') return;
                await writeShared('connect', () =>
                  api.updateAccount(backendId, row.id, { token: token.trim() }),
                );
              })(),
          },
        ]
      : []),
    ...(row.connected
      ? [
          {
            label: 'Disconnect',
            danger: true,
            testid: `account-disconnect-${id}`,
            onSelect: () =>
              void (async () => {
                const ok = await useUiStore.getState().confirm({
                  title: `Disconnect ${row.label}`,
                  message: `Disconnect ${row.label}? Every host stops using it until it is connected again.`,
                  confirmLabel: 'Disconnect',
                  danger: true,
                });
                if (ok)
                  await writeShared('disconnect', () => api.disconnectAccount(backendId, row.id));
              })(),
          },
        ]
      : []),
    {
      label: 'Remove',
      danger: true,
      testid: `account-remove-${id}`,
      onSelect: () =>
        void (async () => {
          const ok = await useUiStore.getState().confirm({
            title: `Remove ${row.label}`,
            message: `Remove ${row.label} from every host? Its row goes too.`,
            confirmLabel: 'Remove',
            danger: true,
          });
          if (ok) await writeShared('remove', () => api.removeAccount(backendId, row.id));
        })(),
    },
  ];

  return (
    <AccountRow
      handle={handle}
      rank={rank}
      active={false}
      testid={`account-${id}`}
      menuLabel={row.label}
      menuTestid={`account-menu-${id}`}
      menu={menu}
    >
      <span className="set-row-title">{row.label}</span>
      {sub.length > 0 ? <span className="set-sub">{sub.join(' · ')}</span> : null}
      {twin ? (
        <span className="set-sub warn" data-testid={`account-twin-${id}`}>
          Same {name} account as {twin.label}
        </span>
      ) : null}
      {reading?.summary.error ? (
        <p className="set-error" role="alert">
          {reading.summary.error}
        </p>
      ) : null}
      <UsageBars
        usage={reading?.summary.usage}
        testId={`account-usage-${id}`}
        testIdFor={(scope) => `account-usage-${scope}-${id}`}
      />
    </AccountRow>
  );
}

/** Add a Claude account from a pasted token, or adopt a host's own login. */
export function AddClaudeAccount(): JSX.Element {
  const hosts = usePresenceStore((s) => s.hosts);
  const online = sortHosts(Object.values(hosts)).filter((h) => h.online);
  return (
    <div className="set-inline">
      <button
        type="button"
        className="set-btn"
        data-testid="add-claude-account"
        onClick={() =>
          void (async () => {
            const token = await useUiStore.getState().prompt({
              title: 'Add a Claude account',
              message: 'Paste a token from `claude setup-token`:',
              placeholder: 'sk-ant-oat01-…',
              confirmLabel: 'Add',
            });
            if (token === null || token.trim() === '') return;
            await writeShared('add account', () =>
              api.addAccount('claude-code', { token: token.trim() }),
            );
          })()
        }
      >
        Add account
      </button>
      {online.map((h) => (
        <button
          key={h.daemonId}
          type="button"
          className="set-btn ghost"
          data-testid={`adopt-claude-${h.daemonId}`}
          onClick={() =>
            void writeShared(`use the login on ${hostLabel(h)}`, () =>
              api.adoptAccount('claude-code', h.daemonId),
            )
          }
        >
          Use the login on {hostLabel(h)}
        </button>
      ))}
    </div>
  );
}

/**
 * Add a ChatGPT account. A ChatGPT sign-in has to run on a machine — Codex
 * does the device flow — so one online host runs it and sends the login to
 * the server; an API key is added straight to the server.
 */
export function AddChatGPTAccount(): JSX.Element {
  const hosts = usePresenceStore((s) => s.hosts);
  const requested = useUiStore((s) => s.codexSignInHost);
  const online = sortHosts(Object.values(hosts)).filter((h) => h.online);
  const [hostId, setHostId] = useState<string | null>(null);
  useEffect(() => {
    if (requested !== null) setHostId(requested);
  }, [requested]);
  const host = online.find((h) => h.daemonId === hostId) ?? online[0] ?? null;
  const login = host?.accounts['codex']?.login;
  const pending = login?.status === 'pending';

  const send = (authMethod: 'device' | 'browser' | 'cancel', requestId?: string): void => {
    if (!host) return;
    setHostId(host.daemonId);
    const ws = getActiveWs();
    if (!ws) {
      useUiStore.getState().pushError('sign in: this surface has no link to the server');
      return;
    }
    sendToHost(host, {
      type: 'host.backend_add_account',
      daemonId: host.daemonId,
      backendId: 'codex',
      authMethod,
      requestId: requestId ?? `signin-${Date.now()}`,
    });
  };

  return (
    <div className="set-row stack" data-testid="add-chatgpt-account">
      <div className="set-inline">
        <button
          type="button"
          className="set-btn"
          data-testid="chatgpt-signin"
          disabled={host === null || pending}
          onClick={() => send('device')}
        >
          Sign in with ChatGPT
        </button>
        <button
          type="button"
          className="set-btn ghost"
          data-testid="chatgpt-add-api-key"
          onClick={() =>
            void (async () => {
              const key = await useUiStore.getState().prompt({
                title: 'Add an OpenAI API key',
                message: 'Paid per use. Paste the key:',
                placeholder: 'sk-…',
                confirmLabel: 'Add',
              });
              if (key === null || key.trim() === '') return;
              await writeShared('add API key', () =>
                api.addAccount('codex', { apiKey: key.trim() }),
              );
            })()
          }
        >
          Add API key
        </button>
      </div>
      {host === null ? <Note testid="chatgpt-no-host">Connect a host to sign in</Note> : null}
      {pending && login ? (
        <div className="set-inline" role="status" data-testid="chatgpt-login-pending">
          <span className="set-row-title">Waiting for sign-in…</span>
          {login.code ? <code className="set-code">{login.code}</code> : null}
          {login.url ? (
            <a className="set-btn" href={login.url} target="_blank" rel="noreferrer">
              Open sign-in
            </a>
          ) : null}
          <button
            type="button"
            className="set-btn ghost"
            onClick={() => send('cancel', login.requestId)}
          >
            Cancel sign-in
          </button>
        </div>
      ) : null}
      {login?.status === 'failed' && login.error ? (
        <p className="set-error" role="alert">
          {login.error}
        </p>
      ) : null}
    </div>
  );
}
