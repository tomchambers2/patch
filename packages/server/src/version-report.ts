// `GET /api/version` — what every layer of Patch is running, and where they disagree.
//
// spec/11 § Version reporting. Patch ships five independently-deployable layers
// (server, host, web SPA, desktop shell, Android app) down two unrelated
// delivery paths, and until this existed the only version anywhere was the
// SERVER's own sha on /api/healthz. That is how prod came to serve an 8-day-old
// SPA while healthz reported the newest commit: a server-only deploy bumps the
// sha, leaves the mounted web-dist untouched, and nothing notices.
//
// So this module's job is not really "report versions" — it is "make disagreement
// impossible to miss". Every comparison that could hide a stale layer becomes an
// explicit `VersionDrift` with a remedy the user can act on.
//
// NO FALLBACK: an unreadable/absent artifact is reported as `null` (unknown), never
// as "probably fine". Unknown and current must never render the same.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MIN_SUPPORTED_DAEMON_VERSION, type DaemonSupport } from './daemon-compat.js';
import type {
  ClientBuild,
  LayerBuild,
  PublishedLayer,
  VersionDrift,
  VersionReport,
  WebLayer,
} from '@patch/wire';

/**
 * Provenance sidecar written next to a published artifact by the delivery script
 * (`scripts/local/deliver.mjs`). electron-updater's own `latest-mac.yml` carries a
 * version but no git sha, and an APK carries neither, so the sidecar is what lets
 * a published binary be traced back to a commit.
 */
export interface ArtifactSidecar {
  version: string;
  gitSha: string;
  builtAt: string;
  /** Artifact filename, resolved relative to the downloads dir. */
  file: string;
}

/** Parsed numeric triple of a `major.minor.patch` version, or null if not semver. */
export function parseVersion(v: string | null | undefined): [number, number, number] | null {
  if (!v) return null;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Compare two versions: negative if `a` is older, 0 if equal, positive if newer.
 * Returns null when either side isn't parseable semver — callers MUST treat null
 * as "can't tell" and say so, rather than assuming equality.
 */
export function compareVersions(
  a: string | null | undefined,
  b: string | null | undefined,
): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  const [aMaj, aMin, aPatch] = pa;
  const [bMaj, bMin, bPatch] = pb;
  if (aMaj !== bMaj) return aMaj - bMaj;
  if (aMin !== bMin) return aMin - bMin;
  return aPatch - bPatch;
}

/**
 * Whether this server can speak to a machine on `version` (spec/11
 * § Deployment). An UNKNOWN version is NOT treated as supported — a machine
 * that cannot say what it runs is exactly the one most likely to be too old.
 */
export function daemonSupport(version: string | null | undefined): DaemonSupport {
  if (!version) {
    return {
      supported: false,
      reason: 'this machine does not report a host version',
      remedy: `reinstall the host (this server supports ${MIN_SUPPORTED_DAEMON_VERSION} and newer)`,
    };
  }
  const cmp = compareVersions(version, MIN_SUPPORTED_DAEMON_VERSION);
  if (cmp === null) {
    return {
      supported: false,
      reason: `unrecognised host version: ${version}`,
      remedy: `reinstall the host (this server supports ${MIN_SUPPORTED_DAEMON_VERSION} and newer)`,
    };
  }
  if (cmp < 0) {
    return {
      supported: false,
      reason: `host ${version} is older than this server supports (${MIN_SUPPORTED_DAEMON_VERSION})`,
      remedy: 'update this machine (Settings → Hosts → Update)',
    };
  }
  return { supported: true };
}

/**
 * Read an artifact sidecar from the downloads dir and turn it into a
 * `PublishedLayer`. `publishedAt` comes from the artifact's own mtime, not the
 * sidecar — when it landed on the box is a different fact from when it was built,
 * and conflating them is what made the stale SPA look fresh.
 *
 * Returns null when the sidecar or its artifact is missing/unparseable: nothing is
 * published, which is a legitimate state and must not read as "up to date".
 */
export function readPublishedArtifact(
  downloadsDir: string,
  sidecarName: string,
  urlFor: (file: string) => string,
): PublishedLayer | null {
  const sidecarPath = join(downloadsDir, sidecarName);
  if (!existsSync(sidecarPath)) return null;
  let sidecar: ArtifactSidecar;
  try {
    sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) as ArtifactSidecar;
  } catch {
    return null; // corrupt sidecar → unknown, not current.
  }
  if (!sidecar.version || !sidecar.file) return null;
  const artifact = join(downloadsDir, sidecar.file);
  if (!existsSync(artifact)) return null; // sidecar without its binary → nothing to install.
  return {
    version: sidecar.version,
    gitSha: sidecar.gitSha ?? null,
    builtAt: sidecar.builtAt ?? null,
    publishedAt: statSync(artifact).mtime.toISOString(),
    url: urlFor(sidecar.file),
  };
}

/**
 * Provenance of the SPA this server is serving, read from the mounted web-dist.
 *
 * `deployedAt` is the index.html mtime — the moment this bundle landed on the box.
 * That single number is what would have exposed the original bug at a glance: a
 * `deployedAt` eight days behind the server's `startedAt`.
 */
export function readWebLayer(webRoot: string): WebLayer | null {
  const indexPath = join(webRoot, 'index.html');
  if (!existsSync(indexPath)) return null;
  const indexHtml = readFileSync(indexPath, 'utf8');
  const bundle = /assets\/index-[A-Za-z0-9_-]+\.js/.exec(indexHtml)?.[0];
  if (!bundle) return null;
  const deployedAt = statSync(indexPath).mtime.toISOString();
  // version.json is emitted by the web build (packages/web/vite.config.ts). An SPA
  // built before that plugin existed has none — report the bundle hash with null
  // provenance rather than pretending to know its commit.
  const versionPath = join(webRoot, 'version.json');
  if (!existsSync(versionPath)) {
    return {
      version: 'unstamped',
      gitSha: null,
      builtAt: null,
      bundle,
      deployedAt,
      expectedServerSha: null,
    };
  }
  try {
    const v = JSON.parse(readFileSync(versionPath, 'utf8')) as Partial<LayerBuild> & {
      serverSha?: string;
    };
    return {
      version: v.version ?? 'unstamped',
      gitSha: v.gitSha ?? null,
      builtAt: v.builtAt ?? null,
      bundle,
      deployedAt,
      expectedServerSha: v.serverSha ?? null,
    };
  } catch {
    return {
      version: 'unstamped',
      gitSha: null,
      builtAt: null,
      bundle,
      deployedAt,
      expectedServerSha: null,
    };
  }
}

export interface DriftInput {
  server: LayerBuild & { serverSha?: string | null };
  web: WebLayer | null;
  daemon: (LayerBuild & { online: boolean }) | null;
  /** Every registered machine and the build it is on (spec/11 § Version reporting). */
  hosts: VersionReport['hosts'];
  desktop: PublishedLayer | null;
  android: PublishedLayer | null;
  clients: ClientBuild[];
}

/**
 * Every disagreement between layers worth a human's attention, most severe first.
 * Empty means genuinely everything agrees.
 */
export function computeDrift(input: DriftInput): VersionDrift[] {
  const drift: VersionDrift[] = [];

  // --- Machines disagreeing with each other (spec/11: the host layer can
  // differ from host to host). With one `daemon` field this was invisible:
  // five machines on 0.1.374 and four on 0.1.375 reported as one version and
  // looked like agreement. Unknown stays unknown — a machine that has never
  // reported a build is called out separately, never folded in as "same".
  const online = input.hosts.filter((h) => h.online);
  const stamped = online.filter((h) => h.version !== null);
  const versions = [...new Set(stamped.map((h) => h.version))];
  if (versions.length > 1) {
    const byVersion = versions
      .map(
        (v) =>
          `${v} (${stamped
            .filter((h) => h.version === v)
            .map((h) => h.daemonId)
            .join(', ')})`,
      )
      .join(' vs ');
    drift.push({
      kind: 'hosts-disagree',
      detail: `connected machines are on different host builds: ${byVersion}`,
      remedy: 'update the machines that are behind (Settings → Hosts → Update)',
    });
  }
  for (const h of online.filter((x) => x.version === null)) {
    drift.push({
      kind: 'host-unstamped',
      detail: `machine ${h.hostName ?? h.daemonId} is connected but reports no build version`,
      remedy: 'reinstall the host on that machine from a published artifact',
    });
  }
  // The wire protocol is the compatibility contract (spec/11): a machine
  // outside the range this server supports is SHOWN as needing an update rather
  // than left to misbehave quietly against frame shapes it cannot speak.
  for (const h of stamped) {
    const support = daemonSupport(h.version);
    if (support.supported) continue;
    drift.push({
      kind: 'host-unsupported',
      detail: `machine ${h.hostName ?? h.daemonId}: ${support.reason}`,
      remedy: support.remedy,
    });
  }

  // --- The original bug: server and deployed UI from different commits. ---
  //
  // Wording note: these strings are shown to a USER, so they name versions and say
  // what to run. They deliberately do NOT explain why two delivery paths exist or
  // quote git shas — that's architecture commentary, and it belongs in the panel's
  // Details block, not in the line telling someone their UI is stale.
  if (!input.web) {
    drift.push({
      kind: 'web-missing',
      detail: 'no UI is deployed on this server',
      remedy: 'check the web-dist mount on the box',
    });
  } else if (input.web.gitSha === null) {
    drift.push({
      kind: 'web-unstamped',
      detail: 'the deployed UI has no version stamp, so its build is unknown',
      remedy: 'pnpm ship web',
    });
  } else if (
    // Compare the SAME kind of value on both sides: "newest commit touching server
    // code". Comparing against the server's build sha can never match on a web-only
    // release, which is how this reported drift nobody could act on.
    input.web.expectedServerSha !== null && input.server.serverSha !== null
      ? input.web.expectedServerSha !== input.server.serverSha
      : input.web.gitSha !== input.server.gitSha
  ) {
    const cmp = compareVersions(input.web.version, input.server.version);
    const direction =
      cmp !== null && cmp < 0
        ? 'is older than'
        : cmp !== null && cmp > 0
          ? 'is newer than'
          : 'is a different build to';
    drift.push({
      kind: 'web-server-mismatch',
      detail: `the UI (${input.web.version}) ${direction} the server (${input.server.version})`,
      remedy: 'pnpm ship all',
    });
  }

  // --- Same commit, different version number. ---
  // Not pedantry: it means a layer isn't deriving its version from
  // scripts/version.mjs, which makes every OTHER comparison here untrustworthy —
  // "is this device behind?" is answered by comparing versions. Caught in the
  // wild: the server read its permanent `0.0.0` package.json placeholder while the
  // SPA reported a real version, and the panel cheerfully said "all layers agree
  // on 0.0.0". Shas matching is exactly what hides it.
  if (
    input.web &&
    input.web.gitSha !== null &&
    input.web.gitSha === input.server.gitSha &&
    input.web.version !== input.server.version
  ) {
    drift.push({
      kind: 'version-scheme-mismatch',
      detail:
        `the UI and server are the same build but report different versions ` +
        `(server ${input.server.version}, UI ${input.web.version})`,
      remedy: 'check PATCH_VERSION in the deploy — both must come from scripts/version.mjs',
    });
  }

  // --- Host out of step with the server it links to. ---
  if (input.daemon && input.daemon.gitSha !== null && input.daemon.gitSha !== input.server.gitSha) {
    drift.push({
      kind: 'daemon-server-mismatch',
      detail: `the agent (${input.daemon.version}) is a different build to the server (${input.server.version})`,
      remedy: 'pnpm ship server',
    });
  }

  // --- A device running something older than what's deployed/published. ---
  for (const c of input.clients) {
    if (!c.online) continue; // an offline device's staleness isn't actionable now.
    // Web + desktop surfaces load the SPA, so the deployed SPA is their target.
    const target =
      c.surfaceKind === 'mobile'
        ? input.android
        : input.web
          ? { version: input.web.version }
          : null;
    if (!target) continue;
    const cmp = compareVersions(c.version, target.version);
    // Name the DEVICE, not its surfaceId — "mobile \"srf_01J9…\"" told the user
    // nothing they could act on.
    const who = c.surfaceKind === 'mobile' ? 'your phone' : `a ${c.surfaceKind} window`;
    if (cmp === null) {
      drift.push({
        kind: 'client-version-unknown',
        detail: `${who} reports version "${c.version}", which can't be compared to ${target.version}`,
        remedy: c.surfaceKind === 'mobile' ? 'reinstall the app' : 'reload it (Cmd+R)',
      });
      continue;
    }
    if (cmp < 0) {
      drift.push({
        kind: 'client-behind',
        detail: `${who} is on ${c.version}, but ${target.version} is available`,
        remedy: c.surfaceKind === 'mobile' ? 'install the newer APK' : 'reload it (Cmd+R)',
      });
    }
  }

  return drift;
}

export interface BuildReportInput extends DriftInput {
  server: LayerBuild & { startedAt: string; serverSha: string | null };
  /** Injected for determinism in tests. */
  now: Date;
}

/** Assemble the full report, drift included. */
export function buildVersionReport(input: BuildReportInput): VersionReport {
  return {
    checkedAt: input.now.toISOString(),
    server: input.server,
    web: input.web,
    daemon: input.daemon,
    hosts: input.hosts,
    desktop: input.desktop,
    android: input.android,
    clients: input.clients,
    drift: computeDrift(input),
  };
}
