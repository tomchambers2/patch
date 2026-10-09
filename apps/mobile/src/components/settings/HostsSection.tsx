// Settings → Hosts and Settings → Keys (design/settings-redesign; spec/02 §
// Host identity, § Provider keys).
//
// Hosts — Add a host (the server's install command and a single-use pairing
// code), then one row per machine: a presence dot, its name, platform and when
// it was last seen, Update when it is behind. Tapping a row opens that host
// (app/hosts/[daemonId]/index.tsx → HostDetail): its name, Make home, the
// state of its agent backends with Sign in, its optional components, its Files
// and Terminal, and Remove this host.
//
// Keys — the picked host's provider keys, then the account's Secrets.
//
// A machine that has not reported yet is shown as awaiting its first report,
// never given a fabricated name or platform. Every edit is addressed to that
// machine and refused up front, naming it, when it cannot hear it.

import React from 'react';
import { Alert, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { providerKeyInfo, type ProviderKeyId } from '@patch/wire';
import { api, ApiError, type SharedState } from '../../api/rest';
import { useSettingsStore } from '../../stores/settingsStore';
import { writeShared } from './sharedWrite';
import { filesRoute, formatSize, terminalRoute } from '../../lib/hostFiles';
import { fonts, space, typography, useTheme } from '../../lib/theme';
import { usePresenceStore, type HostPresence } from '../../stores/presenceStore';
import { useUiStore } from '../../stores/uiStore';
import { SettingsSection } from '../SettingsSection';
import { agoLabel, sendToHost } from './hostSend';
import { NoticeRow, hostName, sortedHosts } from './HostSwitcher';
import { SecretsSection } from './SecretsSection';
import { SettingsPage } from './SettingsPage';
import {
  ButtonRow,
  Chevron,
  Dot,
  ErrorLine,
  Field,
  Muted,
  Row,
  RowValue,
  SettingsButton,
} from './ui';

/** How a host's `platform` reads: macOS, Linux, Windows, else as reported. */
export function platformLabel(platform: string): string {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'linux') return 'Linux';
  if (platform === 'win32') return 'Windows';
  return platform;
}

/** `macOS · online` / `Linux · seen 3h ago` — a host row's second line. */
export function hostSubtitle(h: HostPresence, now: number = Date.now()): string {
  if (!h.host) return 'awaiting first report';
  const where = platformLabel(h.host.platform);
  const home = h.host.isHomeHost ? 'home · ' : '';
  return `${home}${where} · ${h.online ? 'online' : `seen ${agoLabel(h.lastSeenAt, now)}`}`;
}

// ── Hosts ────────────────────────────────────────────────────────────────────

export function HostsPage(): React.ReactElement {
  const [adding, setAdding] = React.useState(false);
  return (
    <SettingsPage
      title="Hosts"
      testID="settings-page-hosts"
      right={
        adding ? null : (
          <SettingsButton testID="add-host" label="Add a host" onPress={() => setAdding(true)} />
        )
      }
    >
      {adding ? <AddHost onClose={() => setAdding(false)} /> : null}
      <HostsSection />
    </SettingsPage>
  );
}

/** Every registered host, one row each, opening its own page. */
export function HostsSection(): React.ReactElement {
  const router = useRouter();
  const hosts = usePresenceStore((s) => s.hosts);
  const rows = sortedHosts(hosts);
  return (
    <SettingsSection testID="settings-hosts">
      {rows.length === 0 ? (
        <NoticeRow testID="hosts-empty" text="No hosts yet" />
      ) : (
        rows.map((h) => (
          <Row
            key={h.daemonId}
            testID={`host-${h.daemonId}`}
            accessibilityLabel={hostName(h)}
            onPress={() =>
              router.push({ pathname: '/hosts/[daemonId]', params: { daemonId: h.daemonId } })
            }
            leading={<Dot on={h.online} />}
            title={hostName(h)}
            titleTestID={`host-${h.daemonId}-name`}
            subtitle={hostSubtitle(h)}
            subtitleTestID={`host-${h.daemonId}-status`}
            right={
              <>
                {h.host?.updateAvailable ? (
                  <SettingsButton
                    testID={`host-${h.daemonId}-update`}
                    label="Update"
                    variant="quiet"
                    onPress={() =>
                      void sendToHost(
                        h.daemonId,
                        { type: 'host.update', daemonId: h.daemonId },
                        'Update',
                      )
                    }
                  />
                ) : null}
                <Chevron />
              </>
            }
          />
        ))
      )}
    </SettingsSection>
  );
}

/**
 * One host's own page. Its name (renamable), Make home, Update, the state of
 * its agent backends with Sign in on any that needs one, its optional
 * components, Files and Terminal, and Remove this host.
 */
export function HostDetail({ daemonId }: { daemonId: string }): React.ReactElement {
  const router = useRouter();
  const host = usePresenceStore((s) => s.hosts[daemonId] ?? null);
  const seen = React.useRef(false);
  if (host !== null) seen.current = true;

  // Removed while open (here, or by another surface's `host.removed`): there
  // is nothing left to show, so go back to the list.
  React.useEffect(() => {
    if (host === null && seen.current) router.back();
  }, [host, router]);

  if (host === null) {
    return (
      <SettingsPage title={daemonId} testID="settings-host-detail">
        <SettingsSection>
          <NoticeRow testID="host-detail-gone" text="This host is no longer on the account" />
        </SettingsSection>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title={hostName(host)} testID="settings-host-detail">
      {host.host === null ? (
        <SettingsSection>
          <Row
            title={daemonId}
            subtitle="awaiting first report"
            subtitleTestID={`host-${daemonId}-status`}
          />
        </SettingsSection>
      ) : (
        <>
          <HostIdentity host={host} />
          <HostSettingsState host={host} />
          <ClaudeSettingsDrift host={host} />
          <HostBackends host={host} />
          <HostComponents host={host} />
          <HostTools host={host} />
        </>
      )}
      <RemoveHost host={host} />
    </SettingsPage>
  );
}

/**
 * Which version of the shared settings this host runs (spec/01 § Settings):
 * behind, or refusing part of it, is said by name.
 */
function HostSettingsState({ host }: { host: HostPresence }): React.ReactElement | null {
  const shared = useSettingsStore((s) => s.data?.shared ?? null);
  if (shared === null) return null;
  const state = shared.hosts.find((h) => h.daemonId === host.daemonId);
  const text = state?.error
    ? `Could not apply: ${state.error}`
    : state?.appliedVersion === undefined
      ? host.online
        ? 'Not applied yet'
        : 'Gets them when it reconnects'
      : state.appliedVersion === shared.version
        ? 'Up to date'
        : host.online
          ? 'Updating'
          : 'Gets the latest when it reconnects';
  return (
    <SettingsSection testID={`host-${host.daemonId}-settings-version`}>
      <Row
        title="Settings"
        subtitle={text}
        subtitleTestID={`host-${host.daemonId}-settings-state`}
      />
    </SettingsSection>
  );
}

/**
 * This machine's Claude Code settings.json changed on the machine itself
 * (spec/02 § Claude Code settings): shown, and kept for every host, kept for
 * this OS, or discarded. Nothing overwrites it until one is chosen.
 */
function ClaudeSettingsDrift({ host }: { host: HostPresence }): React.ReactElement | null {
  const drift = host.claudeSettings?.drift;
  if (drift === undefined) return null;
  const daemonId = host.daemonId;
  const platform = host.host?.platform;
  const os = platform === 'darwin' || platform === 'linux' ? platform : null;
  return (
    <SettingsSection
      title="settings.json changed on this machine"
      testID={`host-${daemonId}-claude-drift`}
    >
      <Muted testID={`host-${daemonId}-claude-drift-text`}>{drift}</Muted>
      <ButtonRow>
        <SettingsButton
          testID={`host-${daemonId}-claude-drift-keep-shared`}
          label="Keep for every host"
          onPress={() =>
            void writeShared('Keep settings.json', () =>
              api.adoptClaudeSettings(daemonId, 'shared'),
            )
          }
        />
        {os ? (
          <SettingsButton
            testID={`host-${daemonId}-claude-drift-keep-os`}
            label={`Keep for ${os === 'darwin' ? 'macOS' : 'Linux'}`}
            variant="quiet"
            onPress={() =>
              void writeShared('Keep settings.json', () => api.adoptClaudeSettings(daemonId, os))
            }
          />
        ) : null}
        <SettingsButton
          testID={`host-${daemonId}-claude-drift-discard`}
          label="Discard"
          variant="quiet"
          onPress={() =>
            void sendToHost(daemonId, { type: 'host.claude_settings_discard', daemonId }, 'Discard')
          }
        />
      </ButtonRow>
    </SettingsSection>
  );
}

/** Name (renamable), presence, platform and version with Update, and home. */
function HostIdentity({ host }: { host: HostPresence }): React.ReactElement | null {
  const report = host.host;
  const daemonId = host.daemonId;
  const [draft, setDraft] = React.useState(report?.hostName ?? '');
  React.useEffect(() => setDraft(report?.hostName ?? ''), [report?.hostName]);
  if (!report) return null;

  const commitRename = (): void => {
    const next = draft.trim();
    if (next.length === 0) {
      // A machine must always have a name.
      Alert.alert('Rename failed', 'A machine name cannot be empty.');
      setDraft(report.hostName);
      return;
    }
    if (next === report.hostName) return;
    if (!sendToHost(daemonId, { type: 'host.rename', daemonId, hostName: next }, 'Rename')) {
      setDraft(report.hostName);
    }
  };

  return (
    <SettingsSection testID={`host-${daemonId}`}>
      <Row
        title="Name"
        right={
          <>
            <Field
              testID={`host-${daemonId}-name-input`}
              accessibilityLabel="Machine name"
              value={draft}
              onChangeText={setDraft}
              onSubmitEditing={commitRename}
              style={{ width: 150 }}
            />
            {draft.trim() !== report.hostName ? (
              <SettingsButton
                testID={`host-${daemonId}-rename-save`}
                label="Save"
                disabled={draft.trim() === ''}
                onPress={commitRename}
              />
            ) : null}
          </>
        }
      />
      <Row
        leading={<Dot on={host.online} />}
        title={host.online ? 'Online' : 'Offline'}
        subtitle={host.online ? undefined : `seen ${agoLabel(host.lastSeenAt)}`}
        titleTestID={`host-${daemonId}-status`}
      />
      <Row
        title={`${platformLabel(report.platform)} ${report.arch}`}
        titleTestID={`host-${daemonId}-platform`}
        subtitle={`Host ${report.daemonVersion}`}
        right={
          report.updateAvailable ? (
            <SettingsButton
              testID={`host-${daemonId}-update`}
              label="Update"
              variant="quiet"
              onPress={() => void sendToHost(daemonId, { type: 'host.update', daemonId }, 'Update')}
            />
          ) : null
        }
      />
      <Row
        title="Home"
        right={
          report.isHomeHost ? (
            <RowValue testID={`host-${daemonId}-home`}>This is home</RowValue>
          ) : (
            <SettingsButton
              testID={`host-${daemonId}-set-home`}
              label="Make home"
              variant="quiet"
              onPress={() =>
                void sendToHost(daemonId, { type: 'host.set_home', daemonId }, 'Make home')
              }
            />
          )
        }
      />
    </SettingsSection>
  );
}

/** The host's agent backends and their state, with Sign in where one is needed. */
function HostBackends({ host }: { host: HostPresence }): React.ReactElement | null {
  const router = useRouter();
  const report = host.host;
  const daemonId = host.daemonId;
  const [signingIn, setSigningIn] = React.useState<string | null>(null);
  const [token, setToken] = React.useState('');
  if (!report || report.backends.length === 0) return null;
  return (
    <SettingsSection title="Agents" testID={`host-${daemonId}-backends`}>
      {report.backends.map((b) => (
        <Row
          key={b.id}
          title={b.label}
          subtitle={`${b.version ? `${b.version} · ` : ''}${b.state}${b.error ? ` — ${b.error}` : ''}`}
          subtitleTestID={`host-${daemonId}-backend-${b.id}`}
          right={
            // A backend that is logged out or absent is the one state to act on.
            b.state !== 'present' ? (
              <SettingsButton
                testID={`host-${daemonId}-backend-${b.id}-connect`}
                label="Sign in"
                variant="quiet"
                accessibilityLabel={`Sign in to ${b.label}`}
                onPress={() => {
                  if (!host.online) {
                    Alert.alert(
                      'Sign in failed',
                      `${report.hostName} is offline. Sign in once it reconnects.`,
                    );
                    return;
                  }
                  if (b.id === 'codex') {
                    // OpenAI sign-in lives on Usage → ChatGPT, where its form is.
                    useUiStore.getState().setCodexSignInHost(daemonId);
                    router.push({ pathname: '/settings/[page]', params: { page: 'usage' } });
                    return;
                  }
                  setToken('');
                  setSigningIn((cur) => (cur === b.id ? null : b.id));
                }}
              />
            ) : null
          }
        >
          {signingIn === b.id ? (
            <View style={{ marginTop: space.sm, gap: space.sm }}>
              <Field
                testID={`host-${daemonId}-signin-token`}
                accessibilityLabel="Token"
                value={token}
                onChangeText={setToken}
                placeholder="sk-ant-oat01-… (empty uses this machine's own login)"
                secureTextEntry
              />
              <SettingsButton
                testID={`host-${daemonId}-signin-submit`}
                label="Sign in"
                onPress={() => {
                  // A Claude account is shared by every host (spec/01 § Settings):
                  // a pasted token is added for all of them; an empty one adopts
                  // the login already on this machine.
                  const t = token.trim();
                  void writeShared('Sign in', () =>
                    t
                      ? api.addAccount('claude-code', { token: t })
                      : api.adoptAccount('claude-code', daemonId),
                  ).then((ok) => {
                    if (ok) {
                      setSigningIn(null);
                      setToken('');
                    }
                  });
                }}
              />
            </View>
          ) : null}
        </Row>
      ))}
    </SettingsSection>
  );
}

/** The host's optional components (spec/02 § Optional components). */
function HostComponents({ host }: { host: HostPresence }): React.ReactElement | null {
  const report = host.host;
  const daemonId = host.daemonId;
  if (!report || report.components.length === 0) return null;
  return (
    <SettingsSection title="Components" testID={`host-${daemonId}-components`}>
      {report.components.map((c) => {
        const state =
          c.state === 'downloading'
            ? `downloading ${Math.round((c.progress ?? 0) * 100)}%`
            : c.state === 'failed'
              ? `failed${c.error ? ` — ${c.error}` : ''}`
              : c.state === 'installed'
                ? 'installed'
                : formatSize(c.bytes);
        return (
          <Row
            key={c.id}
            testID={`host-${daemonId}-component-${c.id}`}
            title={c.label}
            subtitle={state}
            right={
              c.state === 'installed' ? (
                <SettingsButton
                  testID={`host-${daemonId}-component-${c.id}-remove`}
                  label="Remove"
                  variant="danger"
                  onPress={() =>
                    Alert.alert(`Remove ${c.label}?`, `Delete it from ${report.hostName}.`, [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Remove',
                        style: 'destructive',
                        onPress: () =>
                          void sendToHost(
                            daemonId,
                            { type: 'host.component_remove', daemonId, componentId: c.id },
                            'Remove',
                          ),
                      },
                    ])
                  }
                />
              ) : c.state === 'downloading' ? null : (
                <SettingsButton
                  testID={`host-${daemonId}-component-${c.id}-install`}
                  label={c.state === 'failed' ? 'Retry' : 'Install'}
                  variant="quiet"
                  onPress={() =>
                    void sendToHost(
                      daemonId,
                      { type: 'host.component_install', daemonId, componentId: c.id },
                      'Install',
                    )
                  }
                />
              )
            }
          />
        );
      })}
    </SettingsSection>
  );
}

/**
 * Files and Terminal for this machine (spec/15 § Host files and terminal).
 * Unpressable while the machine or the link is down: a screen that opened only
 * to fail would be a worse answer than a dimmed row.
 */
function HostTools({ host }: { host: HostPresence }): React.ReactElement {
  const router = useRouter();
  const colors = useTheme();
  const conn = usePresenceStore((s) => s.connection);
  const reachable = conn === 'connected' && host.online;
  const tool = (key: 'files' | 'terminal', label: string, go: () => void): React.ReactElement => (
    <Row
      testID={`host-${host.daemonId}-${key}`}
      accessibilityLabel={label}
      title={label}
      titleColor={reachable ? colors.ink : colors.inkFaint}
      onPress={reachable ? go : undefined}
      right={<Chevron />}
    />
  );
  return (
    <SettingsSection title="Tools" testID={`host-${host.daemonId}-tools`}>
      {tool('files', 'Files', () => router.push(filesRoute(host.daemonId)))}
      {tool('terminal', 'Terminal', () => router.push(terminalRoute(host.daemonId)))}
    </SettingsSection>
  );
}

/**
 * Remove this host from the account (`DELETE /api/hosts/:daemonId`). Its
 * credential is revoked, so it cannot reconnect without being paired again —
 * asked first. The host is dropped here as soon as the server says so (every
 * surface is also sent `host.removed`).
 */
function RemoveHost({ host }: { host: HostPresence }): React.ReactElement {
  const [busy, setBusy] = React.useState(false);
  const name = hostName(host);
  const remove = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.removeHost(host.daemonId);
      usePresenceStore.getState().removeHost(host.daemonId);
    } catch (e) {
      const message =
        e instanceof ApiError && e.status === 404
          ? `${name} is not on this account any more.`
          : (e as Error).message;
      Alert.alert('Remove failed', message);
      setBusy(false);
    }
  };
  return (
    <SettingsSection>
      <Row
        title="Remove this host"
        right={
          <SettingsButton
            testID={`host-${host.daemonId}-remove`}
            label={busy ? 'Removing…' : 'Remove'}
            variant="danger"
            disabled={busy}
            onPress={() =>
              Alert.alert(
                `Remove ${name}?`,
                `${name} is signed out and has to be paired again to come back.`,
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Remove', style: 'destructive', onPress: () => void remove() },
                ],
              )
            }
          />
        }
      />
    </SettingsSection>
  );
}

// ── Add a host ───────────────────────────────────────────────────────────────

/** The server's refusal, said in words rather than as a code. */
function installCommandProblem(message: string): string {
  if (message.startsWith('nothing_published')) {
    return 'No host build has been published yet.';
  }
  if (message.startsWith('no_build_for_os')) {
    return 'No host build has been published for that operating system yet.';
  }
  if (message.startsWith('no_public_url')) {
    return 'This server has no public address configured.';
  }
  return message;
}

/** Which operating systems the server has actually published a build for. */
function osOptionsFrom(targets: string[]): { value: 'macos' | 'linux'; label: string }[] {
  const out: { value: 'macos' | 'linux'; label: string }[] = [];
  if (targets.some((t) => t.startsWith('darwin-'))) out.push({ value: 'macos', label: 'macOS' });
  if (targets.some((t) => t.startsWith('linux-'))) out.push({ value: 'linux', label: 'Linux' });
  return out;
}

type Loaded<T> =
  | { state: 'loading' }
  | { state: 'ok'; value: T }
  | { state: 'error'; error: string };

/**
 * Add a host: the install command and the single-use pairing code BOTH come
 * from the server — this screen mints nothing and composes no command. Nothing
 * published means nothing to install, and it says so rather than showing a code
 * for a flow whose first step does not exist.
 */
function AddHost({ onClose }: { onClose: () => void }): React.ReactElement {
  const theme = useTheme();
  const [platforms, setPlatforms] = React.useState<
    Loaded<{ value: 'macos' | 'linux'; label: string }[]>
  >({ state: 'loading' });
  const [command, setCommand] = React.useState<Loaded<string>>({ state: 'loading' });
  const [code, setCode] = React.useState<Loaded<string>>({ state: 'loading' });

  const mintCode = React.useCallback(() => {
    setCode({ state: 'loading' });
    void api
      .daemonPairStart()
      .then((r) => setCode({ state: 'ok', value: r.nonce }))
      .catch((e: Error) => setCode({ state: 'error', error: e.message }));
  }, []);

  React.useEffect(() => {
    let live = true;
    void api
      .daemonManifest()
      .then((m) => {
        if (!live) return;
        const published = Array.isArray(m.artifacts) ? m.artifacts : [];
        const options = osOptionsFrom(published.map((a) => a.target));
        setPlatforms({ state: 'ok', value: options });
        const chosen = options[0];
        if (!chosen) return;
        mintCode();
        void api
          .daemonInstallCommand(chosen.value)
          .then((r) => live && setCommand({ state: 'ok', value: r.command }))
          .catch((e: Error) => live && setCommand({ state: 'error', error: e.message }));
      })
      .catch((e: Error) => live && setPlatforms({ state: 'error', error: e.message }));
    return () => {
      live = false;
    };
  }, [mintCode]);

  // Codes last five minutes; re-mint just before that while one is on screen.
  const showingCode = platforms.state === 'ok' && platforms.value.length > 0;
  React.useEffect(() => {
    if (!showingCode) return;
    const timer = setInterval(mintCode, 4.5 * 60 * 1000);
    return () => clearInterval(timer);
  }, [showingCode, mintCode]);

  const nothingPublished =
    platforms.state === 'error' || (platforms.state === 'ok' && platforms.value.length === 0);

  return (
    <SettingsSection title="Add a host" testID="add-host-panel">
      {platforms.state === 'loading' ? <NoticeRow text="…" /> : null}
      {nothingPublished ? (
        <NoticeRow testID="add-host-error" text="No host build has been published yet" />
      ) : null}
      {platforms.state === 'ok' && platforms.value.length > 0 ? (
        <>
          <Row
            title="Run on the new machine"
            subtitle={`Builds: ${platforms.value.map((o) => o.label).join(', ')}`}
            subtitleTestID="add-host-platforms"
            stack
          >
            {command.state === 'ok' ? (
              <Text
                testID="add-host-command"
                selectable
                style={{ ...typography.code, color: theme.ink, marginTop: space.sm }}
              >
                {command.value}
              </Text>
            ) : command.state === 'error' ? (
              <ErrorLine
                testID="add-host-command-error"
                message={installCommandProblem(command.error)}
              />
            ) : (
              <Muted>…</Muted>
            )}
          </Row>
          <Row
            title="Pairing code"
            right={
              code.state === 'ok' ? (
                <Text
                  testID="pairing-code"
                  selectable
                  style={{
                    fontFamily: fonts.bodyMedium,
                    fontSize: 20,
                    letterSpacing: 2,
                    color: theme.ink,
                  }}
                >
                  {code.value}
                </Text>
              ) : code.state === 'loading' ? (
                <Muted testID="pairing-code-loading">Issuing…</Muted>
              ) : null
            }
          >
            {code.state === 'error' ? (
              <ErrorLine
                testID="pairing-code-error"
                message={`Couldn’t issue a pairing code: ${code.error}`}
                onRetry={mintCode}
              />
            ) : null}
          </Row>
        </>
      ) : null}
      <View
        style={{
          padding: space.md,
          flexDirection: 'row',
          justifyContent: 'flex-end',
          borderTopWidth: 1,
          borderColor: theme.lineSoft,
        }}
      >
        <SettingsButton testID="add-host-close" label="Close" variant="quiet" onPress={onClose} />
      </View>
    </SettingsSection>
  );
}

// ── Keys ─────────────────────────────────────────────────────────────────────

export function KeysPage(): React.ReactElement {
  return (
    <SettingsPage title="Keys" testID="settings-page-keys">
      <ProviderKeys />
      <SecretsSection />
    </SettingsPage>
  );
}

/**
 * The account's provider keys (spec/02 § Provider keys) — Gemini, OpenAI
 * Realtime, Groq — shared settings held on the server and sent to every host,
 * each stating whether it is set and its last four characters, never the
 * value. A key only some hosts' environments supply names them and can be
 * used for every host. Separate from Secrets (which are injected into chats).
 */
export function ProviderKeys(): React.ReactElement {
  const conn = usePresenceStore((s) => s.connection);
  const hosts = usePresenceStore((s) => s.hosts);
  const shared = useSettingsStore((s) => s.data?.shared ?? null);
  const [editing, setEditing] = React.useState<ProviderKeyId | null>(null);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  if (shared === null) {
    return (
      <SettingsSection title="Provider keys" testID="providers-keys">
        <NoticeRow testID="providers-keys-loading" text="Settings haven’t loaded yet" />
      </SettingsSection>
    );
  }
  const reachable = conn === 'connected';
  const envHosts = (id: ProviderKeyId): HostPresence[] =>
    Object.values(hosts).filter(
      (h) => h.online && h.host?.providerKeys?.some((k) => k.id === id && k.envSet),
    );
  const run = async (what: string, call: () => Promise<SharedState>): Promise<boolean> => {
    setBusy(true);
    try {
      return await writeShared(what, call);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="Provider keys" testID="providers-keys">
      {shared.secrets.providerKeys.map((k) => {
        const { label, envVar } = providerKeyInfo(k.id);
        const row = `provider-key-${k.id}`;
        const env = envHosts(k.id);
        const status = k.set
          ? `Set${k.last4 ? ` · ends ${k.last4}` : ''}`
          : env.length > 0
            ? `From the environment on ${env.map((h) => hostName(h)).join(', ')}`
            : 'Not set';
        return (
          <Row
            key={k.id}
            testID={row}
            title={label}
            subtitle={status}
            subtitleTestID={`${row}-status`}
            right={
              editing === k.id ? null : (
                <>
                  {!k.set && env[0] ? (
                    <SettingsButton
                      testID={`${row}-adopt`}
                      label="Use for all"
                      variant="quiet"
                      disabled={!reachable || busy}
                      onPress={() =>
                        void run(`${label} key`, () => api.adoptProviderKey(k.id, env[0]!.daemonId))
                      }
                    />
                  ) : null}
                  <SettingsButton
                    testID={`${row}-edit`}
                    label={k.set ? 'Replace' : 'Add'}
                    variant="quiet"
                    accessibilityLabel={`${k.set ? 'Replace' : 'Add'} ${label} key`}
                    disabled={!reachable || busy}
                    onPress={() => {
                      setEditing(k.id);
                      setDraft('');
                    }}
                  />
                  {k.set ? (
                    <SettingsButton
                      testID={`${row}-revoke`}
                      label="Revoke"
                      variant="danger"
                      accessibilityLabel={`Revoke ${label} key`}
                      disabled={!reachable || busy}
                      onPress={() =>
                        Alert.alert(
                          `Revoke ${label} key?`,
                          'It is deleted from every host; a host with one in its own environment goes back to that.',
                          [
                            { text: 'Cancel', style: 'cancel' },
                            {
                              text: 'Revoke',
                              style: 'destructive',
                              onPress: () =>
                                void run(`${label} key`, () => api.revokeProviderKey(k.id)),
                            },
                          ],
                        )
                      }
                    />
                  ) : null}
                </>
              )
            }
          >
            {editing === k.id ? (
              <View style={{ marginTop: space.sm }}>
                <Field
                  testID={`${row}-input`}
                  accessibilityLabel={`${label} key`}
                  placeholder={envVar}
                  value={draft}
                  onChangeText={setDraft}
                  secureTextEntry
                  autoFocus
                />
                <ButtonRow>
                  <SettingsButton
                    testID={`${row}-save`}
                    label="Save"
                    disabled={!reachable || busy || draft.trim() === ''}
                    onPress={() =>
                      void run(`${label} key`, () => api.setProviderKey(k.id, draft.trim())).then(
                        (ok) => {
                          if (ok) {
                            setEditing(null);
                            setDraft('');
                          }
                        },
                      )
                    }
                  />
                  <SettingsButton
                    testID={`${row}-cancel`}
                    label="Cancel"
                    variant="quiet"
                    onPress={() => {
                      setEditing(null);
                      setDraft('');
                    }}
                  />
                </ButtonRow>
              </View>
            ) : null}
          </Row>
        );
      })}
    </SettingsSection>
  );
}
