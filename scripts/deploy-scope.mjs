// Which surfaces of a deploy a given diff can possibly affect.
//
// Split out of ship.mjs so the mapping is importable and therefore testable:
// getting it wrong means a deploy that silently does not ship the thing you
// changed, which is the worst failure this whole area has.
//
// A one-line server fix used to rebuild and code-sign the Mac desktop shell,
// rebuild the SPA, publish an Expo OTA bundle and queue an Android APK — about
// 5.5 minutes of a 13.5-minute deploy spent republishing what the diff could not
// have touched. The server's own build and restart is 5 seconds of it.

// `smoke` is not a thing that ships — it is the mobile SURFACE check, and it
// runs last of the mobile steps because it can only judge an OTA that has
// already been published. It lives here so `--only=smoke` is addressable and so
// a diff that cannot touch the phone does not spend four minutes booting an
// emulator to prove it.
export const ALL_SURFACES = [
  'web',
  'server',
  'daemon',
  'daemon-mac',
  'ota',
  'apk',
  'smoke',
  'desktop',
  'apply',
];

/**
 * Which surfaces a changed path can possibly affect.
 *
 * A one-line server fix used to rebuild and code-sign the Mac desktop shell,
 * rebuild the SPA, publish an Expo OTA bundle and queue an Android APK — about
 * 5.5 minutes of a 13.5-minute deploy spent republishing things the diff could
 * not have touched. The server's own build and restart is 5 seconds of it.
 *
 * Ordered longest-prefix-first so `packages/web/e2e` matches before
 * `packages/web`. A path matching NOTHING here is deliberately treated as
 * "could affect anything" — see `surfacesForDiff`.
 */
export const SURFACE_PATHS = [
  ['packages/web/', ['web']],
  ['packages/server/', ['server']],
  ['packages/daemon/', ['daemon', 'daemon-mac', 'apply']],
  // The host installer lays the patch CLI down, so it ships with the host.
  ['packages/cli/', ['daemon', 'daemon-mac', 'apply']],
  ['packages/desktop/', ['desktop']],
  ['apps/mobile/', ['ota', 'apk', 'smoke']],
  // Shared libs: everything that resolves them at build or run time.
  ['packages/wire/', ['web', 'server', 'daemon', 'daemon-mac', 'apply', 'ota', 'apk', 'smoke']],
  ['packages/auth/', ['server', 'daemon', 'daemon-mac', 'apply']],
  // Docs and specs ship nothing on their own.
  ['spec/', []],
  ['docs/', []],
  ['testing/', []],
  // Deploy's own docs.
  ['deploy.md', []],
];

/**
 * Split changed paths into the surfaces they need and the ones nothing could
 * attribute.
 *
 * A non-empty `unattributed` means the caller must ship EVERYTHING: a root
 * config, the lockfile, turbo.json or a deploy script can reach anything, and
 * "I could not attribute it" must never read as "nothing to do".
 */
export function surfacesForChangedFiles(changed) {
  const needed = new Set();
  const unattributed = [];
  for (const file of changed) {
    const hit = SURFACE_PATHS.find(([prefix]) => file.startsWith(prefix));
    if (!hit) {
      unattributed.push(file);
      continue;
    }
    for (const s of hit[1]) needed.add(s);
  }
  return {
    surfaces: ALL_SURFACES.filter((s) => needed.has(s)),
    unattributed,
  };
}

/**
 * The server and every host run ONE version. They speak one wire protocol and
 * each side's schema is only proven against the other at the same commit, so a
 * deploy that ships either ships both — and applies the host, because a
 * published build nobody runs is not shipped.
 *
 * This is not a diff question. On 2026-09-30 a `--only=server` run shipped a
 * server whose `auth.ok` host roster the published host could not decode; the
 * Mac host wedged on the greeting and every chat on it read as
 * `daemon_unavailable` until the host was published by hand. So it holds for
 * an explicit `--only` as much as for a diff-derived scope.
 */
export const LOCKSTEP = ['server', 'daemon', 'daemon-mac', 'apply'];

export function withLockstep(surfaces) {
  if (!surfaces.some((s) => LOCKSTEP.includes(s))) return surfaces;
  return ALL_SURFACES.filter((s) => surfaces.includes(s) || LOCKSTEP.includes(s));
}

/** Paths that can change what the browser layer of the test gate would report. */
export const BROWSER_GATE_PATHS = ['packages/web/', 'packages/wire/'];

/**
 * The surfaces, grouped into the units that can run at the same time.
 *
 * Three couplings are real and stay sequential INSIDE a lane:
 *   - `verifyWeb` reads the SPA back off the box, so it needs web's bundle
 *     rsynced AND the server restarted to be serving it.
 *   - `apply` restarts the host at the version `daemon` just published.
 *   - `desktop` and `smoke` both ssh into the same Mac and each checks out a
 *     build tree there; two at once would race on one checkout.
 *
 * Desktop used to run first so a live Electron shell would notice the deploy
 * on the server's reconnect — but a shell that misses it finds the build on
 * its next hourly check, and paying for that with the slowest, most remote
 * surface at the head of the queue is a bad trade.
 *
 * One coupling is real ACROSS lanes and is enforced by the caller, not by this
 * map: `daemon` (with `apply`) must run LAST, never concurrently with the
 * others. `apply`'s host restart tears down this deploy's whole cgroup, and
 * a detached deploy process still lives inside it — so racing `daemon`
 * against `box` let a fast host restart kill the still-running box lane
 * before it shipped, leaving the host on the new commit and the server
 * silently stuck on the old one (2026-09-17). See ship.mjs's lane dispatch.
 */
export const LANES = {
  box: ['web', 'server'],
  daemon: ['daemon', 'daemon-mac', 'apply'],
  mobile: ['ota', 'apk'],
  mac: ['desktop', 'smoke'],
};

/**
 * The lanes needed to ship `wanted`, each carrying only the surfaces asked for
 * and in the order LANES names them. A lane nothing is wanted from is dropped,
 * so a scoped deploy fans out no wider than its scope.
 */
export function lanesFor(wanted) {
  return Object.entries(LANES)
    .map(([name, surfaces]) => [name, surfaces.filter((s) => wanted.includes(s))])
    .filter(([, surfaces]) => surfaces.length > 0);
}

/**
 * Flags a lane child must see exactly as the caller typed them. A lane is a
 * fresh `ship.mjs` process; a flag that is not forwarded is a flag silently
 * ignored — which is how `pnpm run deploy --apk-local` once queued an EAS build
 * anyway and failed on the free plan's quota (2026-09-25).
 */
export const LANE_FLAGS = ['--apk-local', '--apk-here'];

/** The argv a lane child is started with. */
export function laneArgs(surfaces, argv) {
  return [
    `--only=${surfaces.join(',')}`,
    '--foreground',
    '--prepared',
    ...argv.filter((a) => LANE_FLAGS.includes(a)),
  ];
}
