#!/usr/bin/env node
// Prove the OTA the phone will actually DOWNLOAD is the build we just published.
//
//   node scripts/verify-ota-bundle.mjs <projectId> <runtime> <channel> <version> <gitSha>
//
// The sibling check (`verify-apk-bundle.mjs`) does this for the APK and says
// why: `EXPO_PUBLIC_*` vars are inlined by Metro at build time, and Metro's
// transform cache is NOT keyed on their values — so a cached transform of
// `src/lib/buildInfo.ts` is reused and the bundle carries whatever stamps were
// set the day that cache entry was written.
//
// `eas update` has the same hazard and had no check at all. What it had was a
// probe that the manifest endpoint returns HTTP 200, which proves only that
// SOMETHING is published. On 1 Sep an update published at 16:29 served JS
// stamped `0.1.713 / a307cac` — five days stale. Every surface believed it:
// `GET /api/version` reported the phone three days behind its own APK, Settings
// → Version said the same, and installing a fresh APK "did nothing" because the
// app OTAs into that bundle seconds after launch. The white screen underneath
// was diagnosed as a delivery problem for a day because of it.
//
// So: fetch the manifest the way the installed APK does, download the launch
// asset with the per-asset authorization the manifest hands out, and read the
// stamps out of the bytecode. A published update whose JS does not carry this
// commit fails the deploy instead of silently becoming what the phone runs.

import { isMain } from './lib/is-main.mjs';

const UPDATES_HOST = 'https://u.expo.dev';

/**
 * The headers expo-updates sends. EAS requires all of them; a request missing
 * the channel is refused outright, which is the failure `apk-update-identity`
 * exists to catch — here we simply send what a correct APK sends.
 */
export function manifestHeaders(runtime, channel) {
  return {
    'expo-platform': 'android',
    'expo-runtime-version': runtime,
    'expo-channel-name': channel,
    'expo-protocol-version': '1',
    'expo-api-version': '1',
    accept: 'multipart/mixed',
  };
}

/**
 * Pull the JSON parts out of EAS's multipart/mixed manifest response.
 *
 * Returns `{ manifest, extensions }`. `extensions.assetRequestHeaders` is the
 * only way to fetch the bundle: the CDN refuses an unauthenticated asset
 * request with an HTML page, so a naive GET "succeeds" with 1.7KB of markup
 * that contains neither stamp — which would fail this check for the wrong
 * reason. Parsed by hand rather than pulling a MIME dependency into the deploy
 * path; the shape is fixed and two parts deep.
 */
export function parseManifestResponse(body, contentType) {
  const boundary = /boundary=("?)([^";]+)\1/.exec(contentType ?? '')?.[2];
  if (!boundary) return { why: `no multipart boundary in content-type: ${contentType}` };
  const parts = body.split(`--${boundary}`).filter((p) => p.trim() && !p.startsWith('--'));
  const out = {};
  for (const part of parts) {
    const name = /name="([^"]+)"/.exec(part)?.[1];
    const blank = part.indexOf('\r\n\r\n');
    if (name === undefined || blank < 0) continue;
    try {
      out[name] = JSON.parse(part.slice(blank + 4).trim());
    } catch {
      return { why: `part "${name}" was not JSON` };
    }
  }
  if (!out['manifest']) return { why: 'response carried no "manifest" part' };
  return { manifest: out['manifest'], extensions: out['extensions'] ?? {} };
}

/**
 * The stamps this bundle carries, judged against the build being shipped.
 *
 * Reads the bundle as latin1 so Hermes bytecode can be scanned for its string
 * table the same way `verify-apk-bundle.mjs` scans the APK's — the stamps are
 * plain literals either way.
 */
export function checkStamps(bundle, expected) {
  const text = Buffer.isBuffer(bundle) ? bundle.toString('latin1') : String(bundle);
  const missing = [];
  if (!text.includes(expected.version)) missing.push(`version ${expected.version}`);
  if (!text.includes(expected.gitSha)) missing.push(`gitSha ${expected.gitSha}`);
  if (missing.length > 0) {
    return {
      ok: false,
      why:
        `the PUBLISHED OTA bundle does not contain ${missing.join(' or ')}. Metro reused a cached ` +
        'transform of the module that carries them (its cache is not keyed on EXPO_PUBLIC_* ' +
        'values), so the update the phone downloads reports a different build than it contains — ' +
        'and every version panel will believe it. Clear the cache and republish: ' +
        '`cd apps/mobile && npx expo start --clear` once, or delete node_modules/.cache/metro ' +
        'and $TMPDIR/metro-*, then ship ota again.',
    };
  }
  return { ok: true };
}

/**
 * End to end: what EAS serves to a client identical to the installed APK.
 *
 * `fetchImpl` is injectable so the parsing and judgement above are testable
 * without a network or a published update.
 */
export async function verifyOtaBundle(
  { projectId, runtime, channel, version, gitSha },
  fetchImpl = fetch,
) {
  const url = `${UPDATES_HOST}/${projectId}`;
  let res;
  try {
    res = await fetchImpl(url, { headers: manifestHeaders(runtime, channel) });
  } catch (err) {
    return { ok: false, why: `could not reach ${url}: ${err.message}` };
  }
  if (!res.ok) {
    return {
      ok: false,
      why:
        `EAS returned HTTP ${res.status} for runtime ${runtime} / channel ${channel}. Nothing is ` +
        `deliverable to that build. Likely the "${channel}" channel is missing or unmapped: ` +
        `cd apps/mobile && eas channel:create ${channel}`,
    };
  }
  const parsed = parseManifestResponse(
    await res.text(),
    res.headers.get('content-type') ?? undefined,
  );
  if (parsed.why !== undefined) return { ok: false, why: `malformed manifest: ${parsed.why}` };

  const { manifest, extensions } = parsed;
  const asset = manifest.launchAsset;
  if (!asset?.url || !asset.key) {
    return { ok: false, why: 'manifest carried no launchAsset url/key — nothing to verify' };
  }
  // NO FALLBACK on the asset authorization: without it the CDN answers 200 with
  // an HTML "unauthorized" page, and scanning that for stamps fails with a
  // misleading reason. Say plainly that the manifest did not carry one.
  const auth = extensions.assetRequestHeaders?.[asset.key];
  if (!auth) {
    return { ok: false, why: `manifest carried no assetRequestHeaders for ${asset.key}` };
  }
  let bundle;
  try {
    const bundleRes = await fetchImpl(asset.url, { headers: auth });
    if (!bundleRes.ok) {
      return { ok: false, why: `launch asset returned HTTP ${bundleRes.status}` };
    }
    bundle = Buffer.from(await bundleRes.arrayBuffer());
  } catch (err) {
    return { ok: false, why: `could not download the launch asset: ${err.message}` };
  }
  const stamps = checkStamps(bundle, { version, gitSha });
  return stamps.ok ? { ok: true, createdAt: manifest.createdAt, id: manifest.id } : stamps;
}

if (isMain(import.meta.url)) {
  const [projectId, runtime, channel, version, gitSha] = process.argv.slice(2);
  if (!projectId || !runtime || !channel || !version || !gitSha) {
    process.stderr.write(
      'usage: verify-ota-bundle.mjs <projectId> <runtime> <channel> <version> <gitSha>\n',
    );
    process.exit(2);
  }
  const res = await verifyOtaBundle({ projectId, runtime, channel, version, gitSha });
  if (!res.ok) {
    process.stderr.write(`verify-ota-bundle: ${res.why}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `verify-ota-bundle: update ${res.id} (${res.createdAt}) carries ${version} / ${gitSha}\n`,
  );
}
