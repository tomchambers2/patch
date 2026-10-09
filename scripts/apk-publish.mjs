// The decisions behind publishing an APK, kept apart from ship.mjs (which
// deploys the moment it is imported) so each one can be asserted without
// building or shipping anything.
//
// An APK reaches the box three ways — an EAS cloud build that a detached follower
// downloads, a gradle build on the Mac (`--apk-local`) that the deploy copies
// back, or a capped gradle build on the box itself (`--apk-here`) — and ALL go
// through the one publish in ship.mjs (`publishApk`). What
// that publish has to get right is here:
//
//   * the name — Android decides a download is new by its filename, so an
//     overwritten file is a build that never arrives;
//   * the signer — Android refuses an update signed by a different key, and it
//     refuses it on the phone, later, rather than here;
//   * the version — read out of the APK itself, not from what we meant to build;
//   * whether a build is needed at all, and whether EAS said no because the free
//     plan's Android builds are used up.

/**
 * A filename no previous build has had: `patch-<sha7>.apk`, or with a counter
 * when that commit has already been published once (a rebuild of the same
 * commit — e.g. on the Mac after a cloud build of it).
 *
 * `exists(name)` says whether `name` is already in the downloads directory.
 */
export function apkFileName(gitSha, exists) {
  const sha = String(gitSha ?? '').slice(0, 7);
  if (!/^[0-9a-f]{7}$/.test(sha)) throw new Error(`not a commit sha: ${JSON.stringify(gitSha)}`);
  let name = `patch-${sha}.apk`;
  for (let n = 2; exists(name); n++) {
    if (n > 99)
      throw new Error(`${sha} has been published 99 times — refusing to invent a 100th name`);
    name = `patch-${sha}-${n}.apk`;
  }
  return name;
}

/**
 * The signing certificates' SHA-256 digests out of `apksigner verify
 * --print-certs`. Every scheme (v1/v2/v3) prints its own line for the same
 * certificate, so this is a set.
 */
export function signerDigests(apksignerOutput) {
  const out = new Set();
  for (const m of String(apksignerOutput).matchAll(
    /certificate SHA-256 digest:\s*([0-9a-f]{64})/gi,
  )) {
    out.add(m[1].toLowerCase());
  }
  return out;
}

/**
 * Would a phone that has `live` installed accept `candidate` as an update?
 *
 * Both are apksigner outputs. No live APK at all (the first publish) is the
 * only case that passes without a comparison, and it says so.
 */
export function signerCheck({ candidate, live }) {
  const next = signerDigests(candidate);
  if (next.size === 0) {
    return { ok: false, why: 'the new APK carries no signing certificate apksigner could read' };
  }
  if (live === null || live === undefined) {
    return { ok: true, why: `no live APK to compare with; signed by ${[...next].join(', ')}` };
  }
  const now = signerDigests(live);
  if (now.size === 0) {
    return { ok: false, why: 'could not read the signing certificate of the APK that is live now' };
  }
  const same = next.size === now.size && [...next].every((d) => now.has(d));
  if (!same) {
    return {
      ok: false,
      why:
        `signed by ${[...next].join(', ')} but the live APK is signed by ${[...now].join(', ')} — ` +
        'Android refuses an update signed with a different key, so every installed phone would ' +
        'reject it. Build with the release keystore from ~/.patch-mobile-credentials.',
    };
  }
  return { ok: true, why: `same signer as the live APK (${[...next][0].slice(0, 16)}…)` };
}

/** `{ packageName, versionName, versionCode }` out of `aapt2 dump badging`. */
export function apkBadging(aaptOutput) {
  const line = String(aaptOutput)
    .split('\n')
    .find((l) => l.startsWith('package:'));
  if (!line) throw new Error('aapt2 printed no package line — is this an APK?');
  const field = (k) => new RegExp(`${k}='([^']*)'`).exec(line)?.[1];
  const packageName = field('name');
  const versionName = field('versionName');
  const versionCode = field('versionCode');
  if (!packageName || !versionName || !versionCode) {
    throw new Error(`aapt2 package line is missing name/versionName/versionCode: ${line}`);
  }
  return { packageName, versionName, versionCode: Number(versionCode) };
}

/**
 * The EAS refusal that means "free plan, no Android builds left this month".
 * Anything else EAS says is a different failure and must not be read as this.
 */
export function easQuotaExhausted(text) {
  return /used its Android builds from the Free plan/i.test(String(text ?? ''));
}

/**
 * Does this deploy need a new APK?
 *
 *   recorded   ~/.patch-deploy/apk-fingerprint.json — what the last deploy built or queued
 *   current    this commit's native fingerprint
 *   statusOf   buildId → EAS build status, only consulted for a cloud build
 *
 * `{ build: true|false, why }`. A local (Mac) build is recorded with
 * `local: true` and is never looked up on EAS: it is not there, and an unknown
 * build would otherwise read as "still queued" forever.
 */
export function apkBuildDecision({ recorded, current, statusOf }) {
  const prev = recorded?.fingerprint;
  if (prev !== current) {
    return {
      build: true,
      why: `native changed (${prev?.slice(0, 12) ?? 'none'} → ${current.slice(0, 12)})`,
    };
  }
  if (recorded.local) {
    return {
      build: false,
      why:
        `already built on ${recorded.builtOn === 'box' ? 'this box' : 'the Mac'} for this fingerprint (${current.slice(0, 12)}) and published ` +
        `as ${recorded.file}`,
    };
  }
  const state = String(statusOf(recorded.buildId) ?? 'UNKNOWN').toUpperCase();
  if (state === 'ERRORED' || state === 'CANCELED' || state === 'CANCELLED') {
    return {
      build: true,
      why:
        `previous build ${String(recorded.buildId).slice(0, 8)} is ${state} for this ` +
        `fingerprint (${current.slice(0, 12)}) — building a replacement`,
    };
  }
  return {
    build: false,
    why:
      `already ${state.toLowerCase()} for this fingerprint (${current.slice(0, 12)}) as build ` +
      `${String(recorded.buildId).slice(0, 8)} — not queueing a duplicate`,
  };
}

/** The `##apk <path>` line the Mac build prints as its last word. */
export function builtApkPath(output) {
  const lines = [...String(output).matchAll(/^##apk (\S+)\s*$/gm)];
  if (lines.length === 0)
    throw new Error('the Mac build never said where it put the APK (no ##apk line)');
  return lines[lines.length - 1][1];
}

/**
 * Where this deploy builds an APK, from its flags: `eas` (the default), `mac`
 * (`--apk-local`) or `box` (`--apk-here`). Never more than one, and never chosen
 * for you — asking for both is a mistake to name, not a tie to break.
 */
export function apkBuilder(argv) {
  const mac = argv.includes('--apk-local');
  const box = argv.includes('--apk-here');
  if (mac && box) {
    throw new Error('--apk-local and --apk-here both given — say where the APK is built, once');
  }
  return box ? 'box' : mac ? 'mac' : 'eas';
}
