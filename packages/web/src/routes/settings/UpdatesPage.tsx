// Settings → Updates: what is behind, what every layer is running, and when
// that was last checked (spec/11 § Version reporting).
//
// Problems first, each with its remedy: a machine with a newer host waiting,
// a disagreement between layers the server reports as drift, a desktop shell
// that cannot update itself. Empty in the normal case, so the page is a quiet
// list of versions until something actually needs doing — and the nav's pip
// says so from every other page.
//
// The version list is what caught a stale deploy in the first place: the
// window runs a UI build of its own, so "This app" states the window's build
// and "Server" the server's, side by side.

import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LayerBuild, VersionReport } from '@patch/wire';
import { api } from '../../api/rest.js';
import { BUILD_INFO } from '../../lib/buildInfo.js';
import { getDesktopBridge, type DesktopUpdaterState } from '../../lib/desktopBridge.js';
import { relativeIso } from '../../lib/relativeTime.js';
import { usePresenceStore, type HostPresence } from '../../stores/presenceStore.js';
import { hostLabel, sortHosts } from './hostScope.js';
import { useHostUpdate } from './hostWrite.js';
import { Group, Note, Row, SettingsPage } from './ui.js';

/** `0.1.317 · 9b8635f`. */
function stamp(build: Pick<LayerBuild, 'version' | 'gitSha'>): string {
  return build.gitSha ? `${build.version} · ${build.gitSha}` : build.version;
}

/**
 * What the desktop shell's row should say. Driven by the updater's last outcome
 * rather than by comparing versions, so "I couldn't check" never reads as "current".
 *
 * A staged update is REPORTED here and offered by the banner
 * (DesktopUpdateBanner), which is the one place that restarts the app — and only
 * when pressed.
 */
function shellStatus(state: DesktopUpdaterState): string {
  if (state.checking) return 'checking…';
  switch (state.lastResult) {
    case 'downloaded':
      return `${state.availableVersion} ready — restart to apply`;
    case 'update-available':
      return `downloading ${state.availableVersion}`;
    case 'up-to-date':
      return 'up to date';
    case 'error':
      return 'check failed';
    default:
      return 'not checked yet';
  }
}

function useVersionReport() {
  return useQuery<VersionReport>({ queryKey: ['version'], queryFn: () => api.version() });
}

/** The desktop shell's updater state, live; null outside the desktop app. */
function useShell(): { shell: DesktopUpdaterState | null; checkShell: () => void } {
  const bridge = getDesktopBridge();
  const [shell, setShell] = useState<DesktopUpdaterState | null>(null);
  // Subscribe to shell updater pushes (download finished, check failed) so the
  // row is live rather than a snapshot taken when Settings mounted.
  useEffect(() => {
    if (!bridge?.getUpdaterState) return;
    void bridge.getUpdaterState().then(setShell);
    return bridge.onUpdaterState?.(setShell);
  }, [bridge]);
  const checkShell = useCallback(() => {
    if (!bridge?.checkForUpdates) return;
    void bridge.checkForUpdates().then(setShell);
  }, [bridge]);
  return { shell, checkShell };
}

export type BehindItem =
  | { kind: 'host'; host: HostPresence }
  | { kind: 'drift'; key: string; driftKind: string; detail: string; remedy: string };

/** Everything that is behind — what the Updates page lists and the nav pip counts. */
export function useBehind(): BehindItem[] {
  const hosts = usePresenceStore((s) => s.hosts);
  const { data: report } = useVersionReport();
  const items: BehindItem[] = sortHosts(Object.values(hosts))
    .filter((h) => h.host?.updateAvailable === true)
    .map((host) => ({ kind: 'host' as const, host }));
  for (const d of report?.drift ?? []) {
    items.push({
      kind: 'drift',
      key: `${d.kind}-${d.detail}`,
      driftKind: d.kind,
      detail: d.detail,
      remedy: d.remedy,
    });
  }
  return items;
}

export function UpdatesPage(): JSX.Element {
  const { data: report, error, isFetching, refetch, dataUpdatedAt } = useVersionReport();
  const { shell, checkShell } = useShell();
  const behind = useBehind();
  const hosts = usePresenceStore((s) => s.hosts);
  // The host build the behind hosts would update TO: the published channel's
  // version. Only read while something is behind; unread, the row states just
  // the version the host runs rather than guessing a target.
  const hostsBehind = behind.some((b) => b.kind === 'host');
  const { data: published } = useQuery({
    queryKey: ['daemon-manifest'],
    queryFn: () => api.daemonManifest(),
    enabled: hostsBehind,
    retry: false,
  });

  const checkAll = (): void => {
    void refetch();
    checkShell();
  };

  return (
    <SettingsPage
      title="Updates"
      testid="settings-version"
      actions={
        <button
          type="button"
          className="set-btn primary"
          data-testid="version-check-now"
          disabled={isFetching}
          onClick={checkAll}
        >
          {isFetching ? 'Checking…' : 'Check now'}
        </button>
      }
    >
      {error ? (
        <Group>
          <Row
            title={<span data-testid="version-error">Could not read versions</span>}
            sub={(error as Error).message}
          >
            <button type="button" className="set-btn" onClick={() => void refetch()}>
              Retry
            </button>
          </Row>
        </Group>
      ) : null}

      {behind.length > 0 ||
      shell?.disabledReason ||
      (shell?.lastResult === 'error' && shell.lastError) ? (
        <Group label="Behind" testid="version-drift">
          {behind.map((b) =>
            b.kind === 'host' ? (
              <Row
                key={b.host.daemonId}
                title={`${hostLabel(b.host)} host`}
                sub={[
                  b.host.host && published?.version
                    ? `${b.host.host.daemonVersion} → ${published.version}`
                    : b.host.host?.daemonVersion,
                  b.host.online ? null : 'offline',
                ]
                  .filter(Boolean)
                  .join(' · ')}
                testid={`version-behind-${b.host.daemonId}`}
              >
                <HostUpdateButton host={b.host} />
              </Row>
            ) : (
              <Row
                key={b.key}
                title={b.detail}
                sub={<code>{b.remedy}</code>}
                testid={`version-drift-${b.driftKind}`}
              />
            ),
          )}
          {shell?.disabledReason ? (
            <Row
              title="Desktop app can’t self-update"
              sub={shell.disabledReason}
              testid="version-shell-disabled"
            />
          ) : null}
          {shell?.lastResult === 'error' && shell.lastError ? (
            <Row
              title="Last update check failed"
              sub={shell.lastError}
              testid="version-shell-error"
            />
          ) : null}
        </Group>
      ) : null}

      <Group label="Versions" testid="version-rows">
        <Row
          title="This app"
          testid="version-app"
          sub={
            <>
              <code>{stamp(BUILD_INFO)}</code>
              {report?.web ? ` · deployed ${relativeIso(report.web.deployedAt)}` : ''}
            </>
          }
        />
        {shell ? (
          <Row
            title="Desktop app"
            testid="version-shell"
            sub={
              <>
                <code>{shell.currentVersion}</code> · {shellStatus(shell)}
              </>
            }
          />
        ) : null}
        {report ? (
          <Row
            title="Server"
            testid="version-detail-server"
            sub={
              <>
                <code>{stamp(report.server)}</code> · up {relativeIso(report.server.startedAt)}
              </>
            }
          />
        ) : null}
        {sortHosts(Object.values(hosts)).map((h) => (
          <Row
            key={h.daemonId}
            title={`${hostLabel(h)} host`}
            testid={`version-host-${h.daemonId}`}
            sub={h.host ? <code>{h.host.daemonVersion}</code> : 'not reported'}
          />
        ))}
        {report?.desktop ? (
          <Row
            title="Desktop on the update feed"
            testid="version-detail-feed"
            sub={
              <>
                <code>{stamp(report.desktop)}</code> · published{' '}
                {relativeIso(report.desktop.publishedAt)}
              </>
            }
          />
        ) : null}
        {report?.android ? (
          <Row
            title="Android APK"
            testid="version-detail-android"
            sub={
              <>
                <code>{stamp(report.android)}</code> · published{' '}
                {relativeIso(report.android.publishedAt)}
              </>
            }
          />
        ) : null}
        {!report && !error ? <Note>Loading…</Note> : null}
      </Group>

      <Group>
        <Row title="Last checked" testid="version-checked">
          <span className="set-val">
            {report ? relativeIso(new Date(dataUpdatedAt).toISOString()) : '—'}
          </span>
        </Row>
      </Group>
    </SettingsPage>
  );
}

/** Split out from the `behind` list's `.map` — `useHostUpdate` is a hook, and the
 * list's length varies with what is behind. */
function HostUpdateButton({ host }: { host: HostPresence }): JSX.Element {
  const { updating, apply } = useHostUpdate(host);
  return (
    <button
      type="button"
      className="set-btn"
      disabled={updating}
      data-testid={`host-${host.daemonId}-update`}
      onClick={apply}
    >
      {updating ? 'Updating…' : 'Update'}
    </button>
  );
}
