// Settings → Hosts (spec/02 § Host identity, spec/11 § Host installation).
//
// Every machine registered to the account, with its presence, and — for the
// one selected — its name, whether it is home, what it runs, and removing it.
//
// State comes from the live host reports. A machine that has not reported yet
// is shown as awaiting its first report rather than being given a fabricated
// name or an assumed platform: unknown must never render as known.

import type { JSX } from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/rest.js';
import { usePresenceStore, type HostPresence } from '../../stores/presenceStore.js';
import { useUiStore } from '../../stores/uiStore.js';
import { PairingCode } from '../../components/PairingCode.js';
import { isSubmitChord } from '../../lib/submitChord.js';
import { getDesktopBridge } from '../../lib/desktopBridge.js';
import { shortcutTitle } from '../../lib/shortcuts.js';
import { hostLabel, sortHosts, useSettingsHost } from './hostScope.js';
import { agoLabel, sendHostSettings, sendToHost, useHostUpdate } from './hostWrite.js';
import { writeShared } from './sharedWrite.js';
import { usePreferencesStore } from '../../stores/preferencesStore.js';
import { Group, Note, OnlineDot, Row, SettingsPage } from './ui.js';

/**
 * The server's refusal, said in words. It answers a machine-readable `error`
 * plus a human `message`; the client's ApiError carries only the code, so the
 * panel was rendering `no_build_for_os` at a person — a string that names the
 * problem to a program and nothing to anyone else.
 */
function installCommandProblem(err: unknown): string {
  const code = err instanceof Error ? err.message : String(err);
  if (code === 'nothing_published') {
    return 'No host build has been published yet, so there is no install command to give.';
  }
  if (code === 'no_build_for_os') {
    return 'No host build has been published for that operating system yet.';
  }
  if (code === 'no_public_url') {
    return 'This server has no public address configured, so it cannot say where a new machine should download from.';
  }
  return code;
}

const PLATFORM_LABEL: Record<string, string> = {
  darwin: 'macOS',
  linux: 'linux',
  win32: 'Windows',
};

export function HostsPage(): JSX.Element {
  const hosts = usePresenceStore((s) => s.hosts);
  const rows = sortHosts(Object.values(hosts));
  // Selecting a host here is the same choice the per-host pages' switcher
  // makes, so opening Agent next shows the machine just looked at.
  const { daemonId: selected, select } = useSettingsHost();
  const [adding, setAdding] = useState(false);
  const host = selected === null ? null : (hosts[selected] ?? null);

  return (
    <SettingsPage
      title="Hosts"
      testid="settings-hosts"
      actions={
        <button
          type="button"
          className="set-btn primary"
          data-testid="add-host"
          disabled={adding}
          onClick={() => setAdding(true)}
        >
          Add a host
        </button>
      }
    >
      {adding ? <AddHost onClose={() => setAdding(false)} /> : null}
      <ThisMac />
      <Group testid="hosts-list">
        {rows.length === 0 ? (
          <Note testid="hosts-empty">No hosts yet</Note>
        ) : (
          rows.map((h) => (
            <HostListRow
              key={h.daemonId}
              host={h}
              selected={h.daemonId === selected}
              onSelect={() => select(h.daemonId)}
            />
          ))
        )}
      </Group>
      {/* Keyed on the reported name too: the name field is seeded from the
          report, so a host that reports — or is renamed from another surface —
          while open must re-seed it, rather than keep showing a stale name or
          an empty one to be refused on blur. */}
      {host ? (
        <HostDetail key={`${host.daemonId}:${host.host?.hostName ?? ''}`} host={host} />
      ) : null}
    </SettingsPage>
  );
}

function HostListRow({
  host,
  selected,
  onSelect,
}: {
  host: HostPresence;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const report = host.host;
  const seen = host.online ? 'online' : `seen ${agoLabel(host.lastSeenAt)}`;
  const { updating, apply: applyUpdate } = useHostUpdate(host);
  return (
    <Row
      testid={`host-${host.daemonId}`}
      className={selected ? 'selected' : undefined}
      onClick={onSelect}
      title={
        <>
          <OnlineDot online={host.online} />{' '}
          {report ? (
            <span data-testid={`host-${host.daemonId}-label`}>{report.hostName}</span>
          ) : (
            <span className="mono" data-testid={`host-${host.daemonId}-id`}>
              {host.daemonId}
            </span>
          )}
          {report?.isHomeHost ? (
            <span className="set-chip g" data-testid={`host-${host.daemonId}-home`}>
              home
            </span>
          ) : null}
        </>
      }
      sub={
        <span data-testid={`host-${host.daemonId}-status`}>
          {report
            ? `${PLATFORM_LABEL[report.platform] ?? report.platform} · ${seen}`
            : 'awaiting first report'}
        </span>
      }
    >
      {report?.updateAvailable ? (
        <button
          type="button"
          className="set-btn"
          disabled={updating}
          onClick={applyUpdate}
          data-testid={`host-${host.daemonId}-update`}
        >
          {updating ? 'Updating…' : 'Update'}
        </button>
      ) : null}
      <span className="set-chev" aria-hidden="true">
        ›
      </span>
    </Row>
  );
}

function HostDetail({ host }: { host: HostPresence }): JSX.Element {
  const pushError = useUiStore((s) => s.pushError);
  const navigate = useNavigate();
  const report = host.host;
  const [draft, setDraft] = useState(report?.hostName ?? '');
  const name = hostLabel(host);

  function commitRename(): void {
    const next = draft.trim();
    if (next.length === 0) {
      // spec/02: a machine must always have a name; an empty rename is refused
      // rather than leaving a nameless row.
      pushError('a machine name cannot be empty');
      return;
    }
    if (next === report?.hostName) return;
    sendToHost(host, { type: 'host.rename', daemonId: host.daemonId, hostName: next });
  }

  /**
   * Set a backend's credential ON THAT MACHINE. A pasted token wins; leaving it
   * blank re-adopts whatever that machine's own agent CLI already holds — which
   * is the fix when a token expired and was renewed on the box itself.
   */
  async function connectBackend(backendId: string, backendLabel: string): Promise<void> {
    if (!host.online) {
      pushError(`${name} is offline. Sign in once it reconnects.`);
      return;
    }
    if (backendId === 'codex') {
      // ChatGPT sign-in is an account flow; it lives with the accounts.
      useUiStore.getState().setCodexSignInHost(host.daemonId);
      navigate('/settings/usage');
      return;
    }
    // A Claude account is shared by every host (spec/01 § Settings): a pasted
    // token is added for all of them, and a blank one adopts the login already
    // on this machine.
    const entered = await useUiStore.getState().prompt({
      title: `Sign in to ${backendLabel}`,
      message: `Paste a token from \`claude setup-token\`, or leave blank to use the login already on ${name}. Either way it is added for every host:`,
      placeholder: 'sk-ant-oat01-…',
      confirmLabel: 'Sign in',
    });
    if (entered === null) return;
    const token = entered.trim();
    await writeShared('sign in', () =>
      token
        ? api.addAccount('claude-code', { token })
        : api.adoptAccount('claude-code', host.daemonId),
    );
  }

  async function removeHost(): Promise<void> {
    const ok = await useUiStore.getState().confirm({
      title: `Remove ${name}`,
      message: `Remove ${name} from this account? Its chats stop, and it has to be added again to come back.`,
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.removeHost(host.daemonId);
      // The server also tells every surface (`host.removed`); dropping it here
      // too means this one does not wait on that frame to stop showing it.
      usePresenceStore.getState().removeHost(host.daemonId);
    } catch (e) {
      const unknown = e instanceof ApiError && e.status === 404;
      pushError(
        unknown
          ? `remove failed: the server has no host ${host.daemonId}`
          : `remove failed: ${(e as Error).message}`,
      );
    }
  }

  return (
    <section className="set-group" data-testid={`host-detail-${host.daemonId}`}>
      <h2 className="set-label">{name}</h2>
      <div className="set-card">
        {report ? (
          <>
            <Row title="Name">
              <input
                type="text"
                className="set-word"
                aria-label="Machine name"
                data-testid={`host-${host.daemonId}-name-input`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setDraft(report.hostName);
                    return;
                  }
                  // spec/14 § Keyboard shortcuts — `⌘↵` commits the field, and a
                  // single-line field takes a bare `↵` too.
                  if (e.key !== 'Enter' && !isSubmitChord(e)) return;
                  e.preventDefault();
                  commitRename();
                }}
                title={shortcutTitle('Save', '↵')}
              />
            </Row>
            <Row title="Home">
              {report.isHomeHost ? (
                <span className="set-val">This is home</span>
              ) : (
                <button
                  type="button"
                  className="set-btn"
                  data-testid={`host-${host.daemonId}-set-home`}
                  onClick={() =>
                    sendToHost(host, { type: 'host.set_home', daemonId: host.daemonId })
                  }
                >
                  Make home
                </button>
              )}
            </Row>
            <Row
              title="Host"
              sub={
                <>
                  <span data-testid={`host-${host.daemonId}-platform`}>
                    {report.platform} {report.arch}
                  </span>
                  {' · '}
                  <span data-testid={`host-${host.daemonId}-version`}>{report.daemonVersion}</span>
                </>
              }
            />
            <SettingsVersionRow host={host} />
            {report.permissionOverrides > 0 ? (
              <Row
                title="Permission mode"
                sub={
                  <span data-testid={`host-${host.daemonId}-permission-overrides`}>
                    {report.permissionOverrides} chats on their own mode
                  </span>
                }
              />
            ) : null}
          </>
        ) : (
          <Note testid={`host-${host.daemonId}-unreported`}>{name} hasn’t reported yet</Note>
        )}
      </div>

      {report && report.backends.length > 0 ? (
        <div className="set-card set-card-gap" data-testid={`host-${host.daemonId}-backends`}>
          {report.backends.map((b) => (
            <Row
              key={b.id}
              testid={`host-${host.daemonId}-backend-${b.id}`}
              title={b.label}
              sub={[b.version, b.state, b.error].filter(Boolean).join(' · ')}
            >
              {/* A backend that is logged out or absent is the ONE state a person
                  has to act on, and the row said so while offering nothing to
                  click — which is what sent someone to SSH into the machine and
                  run `claude login` by hand. The credential can be set over the
                  wire, so offer it here, on the machine it belongs to. */}
              {b.state !== 'present' ? (
                <button
                  type="button"
                  className="set-btn"
                  data-testid={`host-${host.daemonId}-backend-${b.id}-connect`}
                  onClick={() => void connectBackend(b.id, b.label)}
                >
                  Sign in
                </button>
              ) : null}
            </Row>
          ))}
        </div>
      ) : null}

      <ClaudeSettingsDrift host={host} />

      {report && report.components.length > 0 ? (
        <div className="set-card set-card-gap" data-testid={`host-${host.daemonId}-components`}>
          {report.components.map((c) => (
            <Row
              key={c.id}
              testid={`host-${host.daemonId}-component-${c.id}`}
              title={c.label}
              sub={[
                c.state === 'downloading' && c.progress !== undefined
                  ? `downloading ${Math.round(c.progress * 100)}%`
                  : c.state,
                c.state === 'not-installed' ? `${Math.round(c.bytes / 1_000_000)} MB` : null,
                c.error ?? null,
              ]
                .filter(Boolean)
                .join(' · ')}
            >
              {c.state === 'not-installed' || c.state === 'failed' ? (
                <button
                  type="button"
                  className="set-btn"
                  data-testid={`host-${host.daemonId}-component-${c.id}-install`}
                  onClick={() =>
                    sendToHost(host, {
                      type: 'host.component_install',
                      daemonId: host.daemonId,
                      componentId: c.id,
                    })
                  }
                >
                  Install
                </button>
              ) : c.state === 'installed' ? (
                <button
                  type="button"
                  className="set-btn ghost"
                  data-testid={`host-${host.daemonId}-component-${c.id}-remove`}
                  onClick={() =>
                    sendToHost(host, {
                      type: 'host.component_remove',
                      daemonId: host.daemonId,
                      componentId: c.id,
                    })
                  }
                >
                  Remove
                </button>
              ) : null}
            </Row>
          ))}
        </div>
      ) : null}

      {report ? <BrowserRouteThrough host={host} /> : null}

      <div className="set-card set-card-gap">
        <Row title="Remove this host">
          <button
            type="button"
            className="set-btn danger"
            data-testid={`host-${host.daemonId}-remove`}
            onClick={() => void removeHost()}
          >
            Remove
          </button>
        </Row>
      </div>
    </section>
  );
}

/**
 * Which version of the shared settings this host runs (spec/01 § Settings):
 * behind, or refusing part of it, is said by name rather than hidden.
 */
function SettingsVersionRow({ host }: { host: HostPresence }): JSX.Element | null {
  const shared = usePreferencesStore((s) => s.shared);
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
    <Row
      title="Settings"
      testid={`host-${host.daemonId}-settings-version`}
      sub={<span data-testid={`host-${host.daemonId}-settings-state`}>{text}</span>}
    />
  );
}

/**
 * This machine's Claude Code settings.json changed on the machine itself
 * (spec/02 § Claude Code settings). Nothing overwrites it until the change is
 * taken into the shared settings — for every host, or for this OS — or thrown away.
 */
function ClaudeSettingsDrift({ host }: { host: HostPresence }): JSX.Element | null {
  const drift = host.claudeSettings?.drift;
  if (drift === undefined) return null;
  const os =
    host.host?.platform === 'darwin' ? 'darwin' : host.host?.platform === 'linux' ? 'linux' : null;
  const id = `host-${host.daemonId}-claude-drift`;
  return (
    <div className="set-card set-card-gap" data-testid={id}>
      <Row title="Claude Code settings.json changed on this machine" />
      <pre className="claude-settings-json" data-testid={`${id}-text`}>
        {drift}
      </pre>
      <div className="set-actions">
        <button
          type="button"
          className="set-btn"
          data-testid={`${id}-keep-shared`}
          onClick={() =>
            void writeShared('keep settings.json', () =>
              api.adoptClaudeSettings(host.daemonId, 'shared'),
            )
          }
        >
          Keep for every host
        </button>
        {os ? (
          <button
            type="button"
            className="set-btn"
            data-testid={`${id}-keep-os`}
            onClick={() =>
              void writeShared('keep settings.json', () =>
                api.adoptClaudeSettings(host.daemonId, os),
              )
            }
          >
            Keep for {os === 'darwin' ? 'macOS' : 'Linux'}
          </button>
        ) : null}
        <button
          type="button"
          className="set-btn ghost"
          data-testid={`${id}-discard`}
          onClick={() =>
            sendToHost(host, { type: 'host.claude_settings_discard', daemonId: host.daemonId })
          }
        >
          Discard
        </button>
      </div>
    </div>
  );
}

/**
 * Settings → Hosts → <host> → Browser → "Route through" (spec/02 § Browser —
 * Route through). The picker offers every OTHER host that has reported — not
 * this one, and not one that has never reported (there is nothing to route
 * through yet). Picking one, or picking "None", writes straight through via
 * `host.settings`; the row never guesses, it shows whatever this host's next
 * `daemon.host` report says. While it is on, this host's browsing is "via
 * <that host>" everywhere that matters (the live view's later step reads the
 * same field) — stated here too, so it is never a surprise that pages are
 * loading from somewhere else.
 */
function BrowserRouteThrough({ host }: { host: HostPresence }): JSX.Element {
  const hosts = usePresenceStore((s) => s.hosts);
  const report = host.host!;
  const current = report.browserRouteThrough ?? null;
  const otherHosts = sortHosts(Object.values(hosts)).filter(
    (h) => h.daemonId !== host.daemonId && h.host !== null,
  );
  const routingHost = current === null ? null : (hosts[current] ?? null);
  const routingHostName = current === null ? null : routingHost ? hostLabel(routingHost) : current;

  return (
    <div className="set-card set-card-gap" data-testid={`host-${host.daemonId}-browser`}>
      <Row
        title="Route through"
        sub={
          current !== null ? (
            <span data-testid={`host-${host.daemonId}-routed-via`}>via {routingHostName}</span>
          ) : undefined
        }
      >
        <select
          aria-label="Route through"
          data-testid={`host-${host.daemonId}-route-through`}
          value={current ?? ''}
          onChange={(e) =>
            sendHostSettings(host, {
              browserRouteThrough: e.target.value === '' ? null : e.target.value,
            })
          }
        >
          <option value="">None</option>
          {otherHosts.map((h) => (
            <option key={h.daemonId} value={h.daemonId}>
              {hostLabel(h)}
            </option>
          ))}
        </select>
      </Row>
      {current !== null && routingHost && !routingHost.online ? (
        <Note testid={`host-${host.daemonId}-route-through-offline`}>
          {routingHostName} is offline — browsing on {hostLabel(host)} will fail until it
          reconnects. It never falls back to going direct.
        </Note>
      ) : null}
    </div>
  );
}

/** Which operating systems the server has actually published a build for. */
/**
 * The desktop app offering to make its own Mac a host (spec/02 § Desktop app
 * and the local host). Shown only in the desktop shell, and only while this
 * Mac has no host; once it has one it is a row in the list like any other.
 */
function ThisMac(): JSX.Element | null {
  const bridge = getDesktopBridge()?.localDaemon;
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['local-daemon-status'],
    queryFn: () => (bridge as NonNullable<typeof bridge>).status(),
    enabled: bridge !== undefined,
  });
  const [installing, setInstalling] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (!bridge || !status.data || status.data.installed) return null;

  async function install(): Promise<void> {
    setInstalling(true);
    setFailure(null);
    try {
      const { nonce } = await api.daemonPairStart();
      const result = await (bridge as NonNullable<typeof bridge>).install(nonce);
      if (!result.ok) setFailure(result.output.trim() || `the installer exited ${result.exitCode}`);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
      await qc.invalidateQueries({ queryKey: ['local-daemon-status'] });
    }
  }

  return (
    <Group label="This Mac" testid="this-mac">
      <div className="set-row">
        <div className="set-row-head">
          <div className="set-row-text">
            <span className="set-row-title">Host</span>
            <span className="set-sub">Not installed</span>
          </div>
          <button
            type="button"
            className="set-btn primary"
            data-testid="this-mac-install"
            disabled={installing}
            onClick={() => void install()}
          >
            {installing ? 'Installing…' : 'Install'}
          </button>
        </div>
      </div>
      {failure ? (
        <pre className="set-pre" data-testid="this-mac-error">
          {failure.split('\n').slice(-12).join('\n')}
        </pre>
      ) : null}
    </Group>
  );
}

function osOptionsFrom(targets: string[]): { value: 'macos' | 'linux'; label: string }[] {
  const out: { value: 'macos' | 'linux'; label: string }[] = [];
  if (targets.some((t) => t.startsWith('darwin-'))) out.push({ value: 'macos', label: 'macOS' });
  if (targets.some((t) => t.startsWith('linux-'))) out.push({ value: 'linux', label: 'Linux' });
  return out;
}

/**
 * Adding a machine. The registration code and the install command BOTH come
 * from the server — this screen mints nothing, and never composes the command
 * itself (spec/11 § Host installation).
 */
function AddHost({ onClose }: { onClose: () => void }): JSX.Element {
  // What is actually published. Offering an operating system with no build only
  // produces a refusal after the fact — the picker should not offer it at all.
  const manifest = useQuery({
    queryKey: ['daemon-manifest'],
    queryFn: () => api.daemonManifest(),
    retry: false,
  });
  // A manifest with no `artifacts` is a half-written or unreadable publish, not
  // a manifest with zero builds — both mean "nothing installable", and neither
  // should throw while rendering.
  const published = Array.isArray(manifest.data?.artifacts) ? manifest.data.artifacts : [];
  const options = manifest.data ? osOptionsFrom(published.map((a) => a.target)) : [];
  // Any published OS will do: the command is identical for all of them.
  const chosen = options[0]?.value ?? null;

  const install = useQuery({
    queryKey: ['daemon-install-command', chosen],
    queryFn: () => api.daemonInstallCommand(chosen as 'macos' | 'linux'),
    enabled: chosen !== null,
    retry: false,
  });

  // Nothing published: there is no command to run and no code worth showing, so
  // say the one true thing and stop. Rendering a pairing code here invited
  // someone to start a flow whose first step does not exist.
  const nothingPublished =
    manifest.isError || (manifest.data !== undefined && options.length === 0);

  return (
    <Group label="Add a host" testid="add-host-panel">
      {manifest.isPending ? <Note>…</Note> : null}
      {nothingPublished ? (
        <Note testid="add-host-error">
          No daemon build has been published yet. Publish one with <code>pnpm build:daemon</code>.
        </Note>
      ) : null}
      {!nothingPublished && options.length > 0 ? (
        <>
          {/* No operating-system picker. The install script detects the
              platform itself, so every OS produced the SAME command. What the
              OS actually decides is whether a build EXISTS, stated here. */}
          <div className="set-row stack">
            <span className="set-row-title">Run on the new machine</span>
            {install.data ? (
              <pre className="set-pre" data-testid="add-host-command">
                {install.data.command}
              </pre>
            ) : install.isError ? (
              <span className="set-sub" data-testid="add-host-error">
                {installCommandProblem(install.error)}
              </span>
            ) : (
              <span className="set-sub">…</span>
            )}
            <span className="set-sub" data-testid="add-host-platforms">
              Builds: {options.map((o) => o.label).join(', ')}
            </span>
          </div>
          <div className="set-row stack">
            <span className="set-row-title">Pairing code</span>
            <PairingCode />
          </div>
        </>
      ) : null}
      <div className="set-row set-form-actions">
        <button
          type="button"
          className="set-btn ghost"
          data-testid="add-host-close"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </Group>
  );
}
