// Settings → Updates (design/settings-redesign; spec/11 § Mobile OTA, § Version
// reporting; project rule: every app surfaces its current version, the running
// build, the last check date, and a manual check).
//
// Check now at the top; Behind — each thing that is behind, with the action
// that fixes it (Restart to update, Download APK, a host's Update, and any
// drift between layers with its remedy); Versions — every layer; and when the
// last check ran, with what it found. The Settings list puts a pip on Updates
// whenever something is behind (useUpdatesBehind).
//
// Three cases look alike from the OTA's own point of view and have to be told
// apart: an update downloaded but not yet launched (`checkForUpdateAsync` then
// reports nothing further, so the page must say "restart", not "up to date");
// no update channel at all; and a phone stuck on an old native runtime, for
// which OTA correctly reports nothing FOR THAT RUNTIME forever.
// `fetchPublishedApk`'s build-time comparison is what tells the last one apart
// from genuinely current, so it runs whether or not this build has a channel.

import React from 'react';
import { Linking } from 'react-native';
import * as Updates from 'expo-updates';
import { useUpdates } from 'expo-updates';
import type { VersionReport } from '@patch/wire';
import { api } from '../../api/rest';
import { mobileBuildInfo } from '../../lib/buildInfo';
import {
  fetchPublishedApk,
  getLastCheckedAt,
  runUpdateCheck,
  type PublishedApk,
  type UpdateCheckResult,
} from '../../lib/updateCheck';
import { isRelayed } from '../../lib/servedFile';
import { usePresenceStore } from '../../stores/presenceStore';
import { SettingsSection } from '../SettingsSection';
import { sendToHost } from './hostSend';
import { hostName, sortedHosts } from './HostSwitcher';
import { SettingsPage } from './SettingsPage';
import { ErrorLine, Row, RowValue, SettingsButton, ValueRow } from './ui';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Short absolute timestamp, e.g. "31 Jul 2026, 14:07". Manual (not toLocale*,
 *  which is unreliable under Hermes) so it renders identically on every device. */
export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Unavailable';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `0.1.317 · 9b8635f`, or the bare version when the layer carries no sha. */
function stamp(b: { version: string | null; gitSha: string | null }): string {
  const v = b.version ?? 'unknown';
  return b.gitSha ? `${v} · ${b.gitSha}` : v;
}

/** The newest published APK, read once per mount; null until (or unless) known. */
function usePublishedApk(): PublishedApk | null {
  const [apk, setApk] = React.useState<PublishedApk | null>(null);
  React.useEffect(() => {
    let live = true;
    // Failure here is not worth a message of its own: the OTA-based status
    // line already covers this build's own update path.
    void fetchPublishedApk()
      .then((a) => live && setApk(a))
      .catch(() => live && setApk(null));
    return () => {
      live = false;
    };
  }, []);
  return apk;
}

/**
 * Whether anything is behind — an update downloaded and waiting for a restart,
 * a newer APK than this phone runs, or a host with a host update. Drives the
 * pip on the Settings list's Updates row.
 */
export function useUpdatesBehind(): boolean {
  const { isUpdatePending } = useUpdates();
  const apk = usePublishedApk();
  const hostBehind = usePresenceStore((s) =>
    Object.values(s.hosts).some((h) => h.host?.updateAvailable === true),
  );
  return isUpdatePending || (apk?.newer ?? false) || hostBehind;
}

export function UpdatesPage(): React.ReactElement {
  // What this phone is EXECUTING. version/gitSha/builtAt are inlined into that
  // one bundle together (buildInfo.ts), so they always agree with each other.
  const build = React.useMemo(() => mobileBuildInfo(), []);
  const { isUpdatePending, isChecking, isDownloading, checkError } = useUpdates();
  const [lastChecked, setLastChecked] = React.useState<string | null>(() => getLastCheckedAt());
  const [checking, setChecking] = React.useState(false);
  const [checkedResult, setCheckedResult] = React.useState<UpdateCheckResult | null>(null);
  const apk = usePublishedApk();
  const hosts = usePresenceStore((s) => s.hosts);
  const [report, setReport] = React.useState<VersionReport | null>(null);
  const [reportError, setReportError] = React.useState<string | null>(null);

  const canOta = Updates.isEnabled && Boolean(Updates.channel);

  const readReport = React.useCallback(() => {
    setReportError(null);
    void api
      .version()
      .then(setReport)
      .catch((e: Error) => setReportError(e.message));
  }, []);
  React.useEffect(readReport, [readReport]);

  const check = React.useCallback(async () => {
    setChecking(true);
    setCheckedResult(null);
    const res = await runUpdateCheck();
    setLastChecked(getLastCheckedAt());
    setCheckedResult(res);
    setChecking(false);
    readReport();
  }, [readReport]);

  const busy = checking || isChecking || isDownloading;
  const pending = isUpdatePending || checkedResult?.status === 'downloaded';
  // The APK is a download from the server's own address, which a phone reached
  // through a relay does not have: it takes its updates over the air.
  const apkAvailable = !pending && !isRelayed() && (apk?.newer ?? false);
  const failure =
    checkedResult?.status === 'error'
      ? checkedResult.message
      : checkError
        ? checkError.message
        : null;

  let sentence: string;
  if (busy) sentence = isDownloading ? 'Downloading update…' : 'Checking for updates…';
  else if (pending) sentence = 'An update is downloaded and ready to install.';
  else if (!canOta)
    sentence = __DEV__
      ? 'Updates are off in development.'
      : 'This build cannot update itself — it has no update channel. Install the latest APK.';
  else if (apkAvailable) sentence = 'A newer build is out. Install it directly.';
  else if (failure) sentence = `Couldn't check for updates: ${failure}`;
  else if (checkedResult?.status === 'current') sentence = 'Up to date.';
  else sentence = '';

  const behindHosts = sortedHosts(hosts).filter((h) => h.host?.updateAvailable === true);
  const drift = report?.drift ?? [];
  const anyBehind = pending || apkAvailable || behindHosts.length > 0 || drift.length > 0;
  const appStamp = build.gitSha ? `${build.version} · ${build.gitSha}` : build.version;

  return (
    <SettingsPage
      title="Updates"
      testID="settings-version"
      right={
        <SettingsButton
          testID="check-updates"
          label={busy ? 'Checking…' : 'Check now'}
          onPress={() => void check()}
          disabled={busy}
        />
      }
    >
      {anyBehind ? (
        <SettingsSection title="Behind" testID="updates-behind">
          {pending ? (
            <Row
              title="This app"
              subtitle="Downloaded"
              right={
                <SettingsButton
                  testID="restart-to-update"
                  label="Restart to update"
                  variant="quiet"
                  onPress={() => void Updates.reloadAsync()}
                />
              }
            />
          ) : null}
          {apkAvailable && apk ? (
            <Row
              title="This app"
              subtitle={`${build.version} → ${apk.version}`}
              right={
                <SettingsButton
                  testID="download-apk"
                  label="Download APK"
                  variant="quiet"
                  onPress={() => void Linking.openURL(apk.url)}
                />
              }
            />
          ) : null}
          {behindHosts.map((h) => (
            <Row
              key={h.daemonId}
              testID={`updates-host-${h.daemonId}`}
              title={`${hostName(h)} host`}
              subtitle={h.host?.daemonVersion}
              right={
                <SettingsButton
                  testID={`updates-host-${h.daemonId}-update`}
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
              }
            />
          ))}
          {drift.map((d) => (
            <Row
              key={`${d.kind}-${d.detail}`}
              testID={`version-drift-${d.kind}`}
              title={d.detail}
              subtitle={d.remedy}
            />
          ))}
        </SettingsSection>
      ) : null}

      <SettingsSection title="Versions" testID="updates-versions">
        <ValueRow
          label="This app"
          value={appStamp}
          subtitle={build.builtAt ? `built ${formatWhen(build.builtAt)}` : undefined}
          testID="version-this-app"
        />
        {reportError ? (
          <Row title="Other layers">
            <ErrorLine
              testID="version-error"
              message={`Couldn’t read versions: ${reportError}`}
              onRetry={readReport}
            />
          </Row>
        ) : report ? (
          layerRows(report).map((r) => (
            <ValueRow key={r.id} label={r.name} value={r.value} testID={`version-detail-${r.id}`} />
          ))
        ) : (
          <ValueRow label="Server" value={null} loading testID="version-loading" />
        )}
      </SettingsSection>

      <SettingsSection testID="updates-last-checked">
        <Row
          title="Last checked"
          subtitle={sentence}
          subtitleTestID="update-status"
          right={
            <RowValue testID="update-last-checked">
              {lastChecked ? formatWhen(lastChecked) : 'Never'}
            </RowValue>
          }
        />
      </SettingsSection>
    </SettingsPage>
  );
}

/** Every layer the server reports (`GET /api/version`), as rows. */
function layerRows(report: VersionReport): Array<{ id: string; name: string; value: string }> {
  return [
    ...(report.web ? [{ id: 'web', name: 'Web UI', value: stamp(report.web) }] : []),
    { id: 'server', name: 'Server', value: stamp(report.server) },
    ...report.hosts.map((h) => ({
      id: `host-${h.daemonId}`,
      name: `${h.hostName ?? h.daemonId} host`,
      value: `${stamp(h)}${h.online ? '' : ' · offline'}`,
    })),
    ...(report.android
      ? [{ id: 'android', name: 'Android APK', value: stamp(report.android) }]
      : []),
    ...report.clients.map((c) => ({
      id: `client-${c.surfaceId}`,
      name: c.surfaceKind,
      value: `${stamp(c)}${c.online ? '' : ' · offline'}`,
    })),
  ];
}
