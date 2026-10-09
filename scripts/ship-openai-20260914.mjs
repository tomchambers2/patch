#!/usr/bin/env node
// Patch deploy — one command, every surface.
//
//   pnpm run deploy              ship everything, detached (the normal case)
//   pnpm run deploy --foreground run inline and watch it
//   pnpm run deploy --only=web   one surface (web|server|daemon|ota|apk|desktop)
//
// A full run resolves the commit, pins a build tree and runs the gate ONCE, then
// ships the surfaces as concurrent LANES — each its own child process, because
// every step here shells out synchronously and nothing inside one process can
// overlap. Wall clock is the slowest lane rather than the sum of all of them.
//
// Detached is the DEFAULT because the last step applies the host update, which
// restarts the host and kills every chat on this host — including the agent
// chat that started the deploy. A detached run outlives that, finishes the
// verification, and reports the result over ntfy.
//
// Surfaces and where they can be built:
//   web, server, host, ota, apk   this box (Hetzner)
//   desktop                         macOS only (codesigning) — driven over ssh
//
// NO FALLBACK: every step either proves it worked or throws. A surface that
// cannot be built here is an error, never a silent skip. Surfaces are, however,
// independent of one another — one that throws is reported and the rest still
// ship, so a broken desktop shell cannot strand the mobile OTA behind it.

import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ALL_SURFACES, lanesFor, surfacesForChangedFiles } from './deploy-scope.mjs';
import { verifyOtaBundle } from './verify-ota-bundle.mjs';
import { apkUpdateIdentity } from './apk-update-identity.mjs';
import { prepareWorktree } from './build-tree.mjs';
import { recordDeployTree } from './deploy-lock.mjs';
import { sameCommit } from './same-commit.mjs';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(REPO);

// The tree the build actually runs in. Set to a worktree pinned at the shipped
// commit by prepareBuildTree(); stays REPO on the Mac, which has already checked
// that commit out before invoking us.
let BUILD = REPO;

// The box's globally-installed CLIs (eas, vercel) live in ~/.local/bin, which a
// LOGIN shell has on PATH and a plain `ssh host 'cmd'` does not. The systemd
// units carry it explicitly, so a deploy started from a Patch chat inherits it
// and one started by hand over ssh does not — and the only symptom is
// `spawnSync eas ENOENT` four minutes in, after the whole test gate has run.
// Same class of problem as MAC_SHELL below, which loads nvm because the Mac has
// no node on a non-interactive PATH; fix it the same way, at the one place that
// spawns everything.
const LOCAL_BIN = `${process.env.HOME}/.local/bin`;
if (!(process.env.PATH ?? '').split(':').includes(LOCAL_BIN)) {
  process.env.PATH = `${LOCAL_BIN}:${process.env.PATH ?? ''}`;
}

// --- the deployment's specifics (the only place these live) -----------------
const URL = 'https://patch.tomchambers.me';
const BOX_HOST = 'hetzner'; // ssh alias for the box, used from the Mac
const BOX = '/srv/patch'; // the checkout the live stack runs from
const MAC_HOST = 'mac'; // ssh alias for the Mac, used from the box
const MAC_REPO = '~/projects/patch';
const DAEMON_LOG = '/home/claude-dev/.patch/logs/daemon.log';
const EAS_PROJECT_ID = '07ef948a-199a-4689-ad8b-24d6b87300c4';
const EAS_CHANNEL = 'preview';
// Signing material lives OUTSIDE the repo: /srv/patch is a shared checkout that
// other agents reset and clean, and these are gitignored so a clone never has them.
const DAEMON_BUILD = `${process.env.HOME}/.patch-daemon-build`; // vendor/ + artifact-signing.key
// Reused between deploys so node_modules survives; see prepareBuildTree().
const BUILD_TREE =
  process.env.PATCH_DEPLOY_BUILD_TREE ??
  `${process.env.HOME}/.patch-deploy-build/tree-${Date.now()}-${process.pid}`;
process.env.PATCH_DEPLOY_BUILD_TREE = BUILD_TREE;
// Beside the tree it guards, so the claim and the thing claimed live together.
const DEPLOY_LOCK = `${process.env.HOME}/.patch-deploy-build/deploy.lock`;
const MOBILE_CREDS = `${process.env.HOME}/.patch-mobile-credentials`; // keystore + credentials.json
// The Mac's self-signed code-signing cert. Not an Apple Developer ID: Squirrel
// only requires an update to carry the SAME certificate as the installed app,
// and it must be signed with something (it refuses to update an adhoc-signed
// app). Expires 2027-07-28.
const CSC_NAME = 'Patch Self-Signed Test';
const NTFY = process.env['PATCH_NTFY_URL'] ?? 'https://ntfy.sh/tomchambers-phone-hgzsxwk9kah';
// nvm means the Mac has no node on a non-interactive PATH; load it explicitly.
const MAC_SHELL = 'source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use default >/dev/null 2>&1;';

// --- tiny helpers -----------------------------------------------------------
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const out = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();
const ok = (cmd, args) => {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const onMac = () => process.platform === 'darwin';
const curlJson = (u) => JSON.parse(out('curl', ['-sf', u]));

function waitFor(label, check, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    execFileSync('sleep', ['2']);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function notify(title, message, priority = 'default') {
  if (
    !ok('curl', [
      '-sf',
      '-o',
      '/dev/null',
      '-H',
      `Title: ${title}`,
      '-H',
      `Priority: ${priority}`,
      '-d',
      message,
      NTFY,
    ])
  ) {
    console.error(`    WARNING: ntfy failed — "${title}" not delivered`);
  }
}

// --- preflight --------------------------------------------------------------

/**
 * Same tree, allowing for symlinks.
 *
 * `REPO` is derived from `import.meta.url`, which Node has already resolved
 * through symlinks, so a plain `===` against a literal path is false whenever
 * anything on the way is a link. `/srv/patch` is now exactly that: a symlink to
 * the checkout inside projects/portfolio. Resolve both sides instead — a real
 * worktree still has a genuinely different realpath and is still refused.
 */
function isSameTree(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false; // an unresolvable path is not the canonical checkout
  }
}

/**
 * On the box, deploy from the canonical checkout and nowhere else.
 *
 * The live systemd units (patch-server, patch-daemon) serve out of it, and the
 * deploy writes its artifacts into ./deploy/web-dist, ./deploy/downloads and
 * ./deploy/data there. Ship from a temporary worktree and those artifacts land
 * somewhere that is about to be removed while the live services keep serving the
 * old tree — a deploy that reports success and changes nothing.
 *
 * `/srv/patch` reaching the checkout through a symlink is fine and expected; a
 * different tree is not.
 */
function requireCanonicalCheckout() {
  if (onMac()) return;
  if (!isSameTree(REPO, BOX)) {
    throw new Error(
      `Refusing to deploy from ${REPO}: that is not the checkout the live stack runs from ` +
        `(${BOX}). The deploy would write web-dist, downloads and data into a tree the live ` +
        `systemd services do not serve, then report success.\n` +
        `Run it there:  cd ${BOX} && git merge --ff-only origin/main && pnpm run deploy`,
    );
  }
}

/**
 * A deploy must map to a real, pushed commit. Otherwise prod silently diverges
 * from git and the next image rebuild reverts whatever was rsynced by hand.
 */
/**
 * The external CLIs the selected surfaces shell out to must exist BEFORE the
 * test gate runs, not four minutes later. `spawnSync eas ENOENT` mid-deploy
 * names a symptom; this names the tool, the surface that needs it, and the way
 * out.
 */
function requireExternalTools() {
  // The Mac only ever runs the surfaces delegated to it, and `smoke` needs adb —
  // an emulator that cannot be driven fails four minutes in, looking like the app.
  if (onMac()) {
    if (want('smoke') && !ok('sh', ['-c', 'command -v adb >/dev/null 2>&1'])) {
      throw new Error(
        'Refusing to deploy: `adb` is not on PATH, and the mobile surface layer drives an ' +
          'emulator through it. Install the Android platform tools, or run the deploy with ' +
          '--only excluding smoke.',
      );
    }
    return;
  }
  const needed = [
    ...(want('ota') || want('apk') ? [{ bin: 'eas', why: 'the mobile OTA + APK surfaces' }] : []),
  ];
  const missing = needed.filter((t) => !ok('sh', ['-c', `command -v ${t.bin} >/dev/null 2>&1`]));
  if (missing.length > 0) {
    throw new Error(
      missing
        .map(
          (t) =>
            `Refusing to deploy: \`${t.bin}\` is not on PATH, and ${t.why} shell out to it.\n` +
            `It is installed at ${LOCAL_BIN}/${t.bin} on this box — a non-login shell just does not see it.\n` +
            `Run the deploy from a login shell, or skip that surface:  pnpm run deploy --only=web,server,daemon`,
        )
        .join('\n\n'),
    );
  }
}

/**
 * Decide WHICH COMMIT this deploy ships, and make sure origin has it.
 *
 * `/srv/patch` is a shared checkout, and other agents routinely leave modified
 * tracked files in it. That used to hard-fail the deploy, which meant one agent's
 * half-finished work blocked everybody else's releases for hours. It no longer
 * does: the build runs in a separate tree pinned to this commit
 * (prepareBuildTree), so uncommitted work cannot reach an artifact and nobody has
 * to stash or commit someone else's files to unblock a ship.
 *
 * HEAD must still BE the shipped commit. start-server.sh derives the version the
 * server reports from `git HEAD` in this checkout, so shipping anything else
 * would make /api/healthz describe code that isn't running.
 */
function resolveShipCommit() {
  log('syncing with origin/main');
  sh('git', ['fetch', 'origin', 'main', '--quiet']);
  const head = out('git', ['rev-parse', 'HEAD']);
  const origin = out('git', ['rev-parse', 'origin/main']);
  if (head === origin) return head;

  if (ok('git', ['merge-base', '--is-ancestor', origin, head])) {
    // Local commits nobody has pushed yet — publish them, then ship them.
    sh('git', ['push', 'origin', 'HEAD:main']);
    return head;
  }
  if (!ok('git', ['merge-base', '--is-ancestor', head, origin])) {
    // Diverged: the shared checkout carries local commits nobody has pushed.
    // Ship origin/main and leave them exactly where they are — reconciling
    // someone else's unpushed work IS a human call, but refusing to deploy over
    // it is not the way to ask for one. It just blocks every unrelated change
    // until a human notices, and what ships is built from a pinned worktree at
    // the shipped sha anyway (see prepareBuildTree + server), so this tree's
    // HEAD has no bearing on it.
    const unpushed = out('git', ['log', '--oneline', `${origin}..HEAD`]);
    log(
      `${BOX} has unpushed commits, left untouched — they are NOT in this deploy:\n${unpushed}\n` +
        `Shipping origin/main (${origin.slice(0, 7)}) from a pinned worktree instead.`,
    );
    return origin;
  }
  // Behind origin/main. Ship origin/main WITHOUT moving the shared checkout.
  //
  // Nothing deployed comes from this working tree: every surface builds in the
  // pinned worktree prepareBuildTree() checks out at the shipped sha, the server
  // dist is rsynced into ${BOX} (gitignored, so no tracked file is touched), and
  // build identity is stamped into deploy/build-info.json rather than read from
  // HEAD — see server(). So the only thing a fast-forward here bought was a tidy
  // checkout, and it cost the deploy entirely whenever another agent had work in
  // progress on a file the incoming commits also touch. Leave their work alone
  // and ship anyway; the next clean checkout fast-forwards on its own.
  const dirty = out('git', ['status', '--porcelain', '--untracked-files=no']);
  if (!ok('git', ['merge', '--ff-only', 'origin/main'])) {
    log(
      `${BOX} kept where it is — work in progress there would be overwritten by the ` +
        `fast-forward:\n${dirty}\nBuilding ${origin.slice(0, 7)} from a pinned worktree instead.`,
    );
  }
  return origin;
}

/**
 * Check out the shipped commit into the tree we build from.
 *
 * Building in `/srv/patch` bundles whatever uncommitted work is sitting there
 * into the artifact, while /api/healthz reports a gitSha describing only the
 * committed part — a deploy that silently doesn't match any commit. Building here
 * means every artifact maps to a real commit, and the shared checkout (modified
 * tracked files and untracked files alike) is left completely alone.
 *
 * The worktree is REUSED between deploys so node_modules survives. A cold install
 * of this monorepo costs minutes and buys nothing.
 */
function prepareBuildTree(sha) {
  // Shared with the Mac (scripts/build-tree.mjs) so both machines pin their tree
  // the same way rather than from two descriptions of it that drift.
  log(`build → pinning build worktree at ${BUILD_TREE} to ${sha}`);
  prepareWorktree({ tree: BUILD_TREE, sha });
  // The integration tests read real secrets from deploy/.env, which is gitignored
  // and so absent from a fresh worktree — and removed again by the clean above.
  // Link rather than copy so the box stays the single source of those secrets.
  if (!existsSync(`${BOX}/deploy/.env`)) {
    throw new Error(`no ${BOX}/deploy/.env — the build tree needs it for the integration tests`);
  }
  sh('ln', ['-sfn', `${BOX}/deploy/.env`, `${BUILD_TREE}/deploy/.env`]);
  log('build → installing dependencies');
  sh('pnpm', ['install', '--frozen-lockfile', '--silent'], { cwd: BUILD_TREE });
  BUILD = BUILD_TREE;
  process.chdir(BUILD);
}

/**
 * Rebuild the shared libraries every host-side surface consumes.
 *
 * @patch/wire and @patch/auth are resolved through their package `main` — their
 * DIST — by the web bundler, the host's esbuild, Metro and the desktop build
 * alike, and nothing in those builds regenerates it. A dist lagging its own src
 * either fails loudly on a missing export or, far worse, silently bundles the OLD
 * implementation of one it still exports, which is how a "deployed" surface ends
 * up running code that is not in the commit it claims.
 *
 * Runs before the gate, not just before the surfaces: typecheck resolves
 * @patch/wire the same way, so a stale dist fails the gate for a reason that has
 * nothing to do with the commit under test.
 */
function buildWorkspaceLibs() {
  log('libs → rebuilding @patch/wire + @patch/auth');
  sh('pnpm', ['--filter', '@patch/wire', '--filter', '@patch/auth', 'build']);
}

/**
 * THE gate (spec/19-testing.md § Verification). Every test layer that runs
 * unattended has to be green before anything ships.
 *
 * Not skippable: there is no flag and no env var for it, because a gate with an
 * override is not a gate.
 *
 * Skipped on the Mac only because the Mac run is a SUB-STEP of a deploy that
 * already ran the gate on the box (desktop() drives `--only=desktop` over ssh),
 * so running it again would just re-prove the same commit slowly.
 */
function testGate() {
  if (onMac()) return;
  log('verify → running the test gate (lint, types, unit, contract, integration, browser)');
  // The diff goes with it so the gate can skip the browser layer when the SPA
  // cannot be affected. Passed ONLY when the diff was fully attributed — absent,
  // verify.mjs runs every layer, which is what "we do not know" has to mean.
  const args = ['scripts/verify.mjs'];
  if (changedFiles && changedFiles.length > 0) args.push(`--changed=${changedFiles.join(',')}`);
  sh('node', args, { cwd: BUILD });
  log('verify → green');
}

// --- surfaces ---------------------------------------------------------------

/**
 * The SPA is served from the ./web-dist BIND MOUNT, which the server image knows
 * nothing about. So this must run BEFORE the server recreate: rsyncing after (or
 * alone) publishes a new UI against the still-old server, and the mount is live,
 * so that takes effect immediately.
 */
function web(info) {
  log(`web → building SPA ${info.version} / ${info.gitSha}`);
  sh('pnpm', ['--filter', '@patch/web', 'build'], {
    env: {
      ...process.env,
      PATCH_VERSION: info.version,
      PATCH_GIT_SHA: info.gitSha,
      PATCH_BUILT_AT: info.builtAt,
    },
  });
  const built = readFileSync('packages/web/dist/index.html', 'utf8').match(
    /assets\/index-[A-Za-z0-9_-]+\.js/,
  );
  if (!built) throw new Error('no entry bundle in packages/web/dist/index.html');
  sh('sh', [
    '-c',
    `rm -rf ${BOX}/deploy/web-dist.bak && cp -r ${BOX}/deploy/web-dist ${BOX}/deploy/web-dist.bak`,
  ]);
  sh('rsync', ['-a', '--delete', 'packages/web/dist/', `${BOX}/deploy/web-dist/`]);
  return built[0];
}

/**
 * Build and restart the server as a native systemd user service.
 * The server is no longer a Docker container — it runs as patch-server.service
 * under systemd --user, matching the pattern already used by patch-daemon.
 */
function server(info) {
  log(`server → building @patch/server ${info.version} / ${info.gitSha}`);
  sh('pnpm', ['--filter', '@patch/server', 'build']);
  // patch-server.service execs ${BOX}/packages/server/dist/index.js, so the build
  // has to land THERE and not just in the tree it was built in. dist/ is
  // gitignored, so this never touches a tracked file in the shared checkout.
  //
  // The workspace libs ship WITH it. packages/server/dist is tsc output, not a
  // bundle: it resolves @patch/wire and @patch/auth at RUNTIME, out of ${BOX}'s
  // dist dirs. buildWorkspaceLibs() regenerates those in the BUILD tree, so
  // rsyncing only the server left ${BOX} running a fresh server against a wire
  // dist from whenever that tree was last built by hand. A wire schema is
  // `.strict()`, so the mismatch surfaces as the server DROPPING valid host
  // frames ("Unrecognized key(s)") and every round-trip RPC timing out — which
  // is how `/api/skills` started 504-ing `daemon_timeout` after `paths` was
  // added to patch.skills.response.
  if (!isSameTree(BUILD, BOX)) {
    for (const pkg of ['wire', 'auth', 'server']) {
      sh('rsync', ['-a', '--delete', `packages/${pkg}/dist/`, `${BOX}/packages/${pkg}/dist/`]);
    }
  }
  // Identity comes from the BUILD, not from whatever ${BOX} happens to be sitting
  // on when systemd next starts us. Another agent can move that HEAD any second,
  // and start-server.sh used to read it — so a restart could stamp the server with
  // a commit that was never built or deployed. Written next to the dist it
  // describes, so the two can only ever be replaced together.
  writeFileSync(`${BOX}/deploy/build-info.json`, `${JSON.stringify(info, null, 2)}\n`);
  log('server → restarting patch-server.service');
  sh('systemctl', ['--user', 'restart', 'patch-server']);
  waitFor('server healthy', () => ok('curl', ['-sf', `${URL}/api/healthz`]));
  // The host reconnects on its own; prove it did rather than assuming.
  waitFor('host re-linked', () =>
    ok('sh', ['-c', `tail -n 200 ${DAEMON_LOG} | grep -q "server-link: authenticated"`]),
  );
}

/**
 * Prove the SPA the box serves is the one we just built, AND that it is really
 * JavaScript: a bundle that falls through to the SPA catch-all comes back as a
 * 200 text/html, which every other check reads as green while the app is a blank
 * window.
 */
function verifyWeb(expectedBundle) {
  const served = out('sh', [
    '-c',
    `curl -sf ${URL}/app/ | grep -oE 'assets/index-[A-Za-z0-9_-]+\\.js' | head -1`,
  ]);
  if (served !== expectedBundle) {
    throw new Error(`box serves ${served} but we built ${expectedBundle}`);
  }
  const type = out('curl', [
    '-sf',
    '-o',
    '/dev/null',
    '-w',
    '%{content_type}',
    `${URL}/app/${served}`,
  ]);
  if (!type.includes('javascript')) {
    throw new Error(
      `box serves ${served} as "${type}", not JavaScript — the SPA would load a blank window.\n` +
        `Usually the server is running against a dist it did not see at boot: systemctl --user restart patch-server`,
    );
  }
}

/**
 * Build + publish the host artifact. Publishing only makes the build VISIBLE
 * at /api/daemon/daemon-latest.json; applyDaemon() is what restarts anything.
 */
function daemonPublish() {
  if (!existsSync(`${DAEMON_BUILD}/artifact-signing.key`)) {
    throw new Error(`no host signing key at ${DAEMON_BUILD}/artifact-signing.key`);
  }
  log('host → building linux-x64 artifact');
  const dist = `${BUILD}/dist/daemon`;
  sh('rm', ['-rf', dist]);
  sh('pnpm', ['build:daemon'], {
    env: {
      ...process.env,
      PATCH_BUILD_VENDOR: `${DAEMON_BUILD}/vendor`,
      PATCH_ARTIFACT_SIGNING_KEY: `${DAEMON_BUILD}/artifact-signing.key`,
      // linux-x64 only: the darwin target is the only one that needs macOS
      // codesigning, so restricting targets keeps this box self-sufficient.
      PATCH_BUILD_TARGETS: 'linux-x64',
    },
  });
  const version = JSON.parse(readFileSync(`${dist}/daemon-latest.json`, 'utf8')).version;
  sh('sh', [
    '-c',
    `cp ${dist}/daemon-latest.json ${dist}/install.sh ${dist}/*.tar.gz ${dist}/*.tar.gz.sig ${BOX}/deploy/downloads/`,
  ]);
  sh('rm', ['-rf', dist]);
  log(`host → published ${version}`);
  return version;
}

/**
 * THE DESTRUCTIVE STEP. Restarts the host service, dropping every live chat on
 * this host — including the chat that started this deploy. Runs last, and only
 * from a detached process that can outlive it.
 */
function daemonApply(expectedVersion) {
  log(`host → applying ${expectedVersion} (restarts the host, drops live chats)`);
  sh('sh', ['-c', 'patch hosts update --json || true']);
  waitFor('host back up', () =>
    ok('sh', ['-c', 'systemctl --user is-active --quiet patch-daemon']),
  );
  waitFor('host re-linked', () =>
    ok('sh', ['-c', `tail -n 200 ${DAEMON_LOG} | grep -q "server-link: authenticated"`]),
  );
}

/**
 * EAS needs the release keystore to sign, and it must be the SAME key the
 * installed APK carries or Android refuses the upgrade in place. The key is
 * gitignored, so materialise it from outside the repo for the build.
 */
function linkMobileCredentials() {
  if (!existsSync(`${MOBILE_CREDS}/patch-upload.keystore`)) {
    throw new Error(`no release keystore at ${MOBILE_CREDS}/patch-upload.keystore`);
  }
  mkdirSync('apps/mobile/credentials', { recursive: true });
  sh('cp', [
    `${MOBILE_CREDS}/patch-upload.keystore`,
    'apps/mobile/credentials/patch-upload.keystore',
  ]);
  sh('cp', [`${MOBILE_CREDS}/credentials.json`, 'apps/mobile/credentials.json']);
}

/**
 * JS-only update for already-installed APKs. This is how a code change normally
 * reaches the phone — a new APK is only needed when NATIVE code changes.
 */
async function ota(info) {
  log(`ota → publishing to EAS channel ${EAS_CHANNEL}`);
  // `eas update` runs Metro, which inlines EXPO_PUBLIC_* into the bundle. Without
  // these the OTA JS reports version 'dev', and since the app auto-OTAs on launch,
  // even a correctly stamped fresh APK reloads into this bundle and loses its version.
  // `--clear-cache` is not belt-and-braces, it is the fix.
  //
  // Metro inlines EXPO_PUBLIC_* at transform time and its cache key does NOT
  // include their values, so the module carrying the version and sha is served
  // from cache with whatever stamps were set when that entry was written. Every
  // deploy after the first therefore publishes JS stamped with an older commit —
  // which is precisely what happened on 1 Sep, and again on the very next deploy
  // after the cache was cleared BY HAND. A manual clear fixes one publish; the
  // cache is stale again by the next one. The check below still stands behind
  // this, because a gate that trusts a flag is not a gate.
  sh(
    'eas',
    [
      'update',
      '--branch',
      EAS_CHANNEL,
      '--message',
      `ota ${info.gitSha}`,
      '--clear-cache',
      '--non-interactive',
    ],
    {
      cwd: 'apps/mobile',
      env: {
        ...process.env,
        EXPO_PUBLIC_PATCH_SERVER_URL: URL,
        EXPO_PUBLIC_PATCH_VERSION: info.version,
        EXPO_PUBLIC_PATCH_GIT_SHA: info.gitSha,
        EXPO_PUBLIC_PATCH_BUILT_AT: info.builtAt,
      },
    },
  );
  // Publishing to a BRANCH is not the same as the phone being able to FETCH it,
  // and BOTH of those are weaker than "the JS it fetches is this commit".
  //
  // This used to probe for HTTP 200 and stop there. A 200 says only that
  // something is published: on 1 Sep an update published minutes earlier served
  // JS stamped `0.1.713 / a307cac`, five days old, because Metro's transform
  // cache is not keyed on EXPO_PUBLIC_* values and reused a stale transform of
  // the module carrying the stamps. The deploy went green, `GET /api/version`
  // reported the phone days behind its own APK, and a fresh APK "changed
  // nothing" because the app OTAs into that bundle seconds after launch.
  //
  // So verify the artifact, not the endpoint: fetch the manifest exactly as the
  // installed APK does, download the launch asset, and read this commit's stamps
  // out of it. NO FALLBACK — a mismatch throws and nothing downstream ships.
  //
  // Runtime and channel come from the committed Android project, not from
  // literals here: they are what the INSTALLED APK actually asks EAS for, and a
  // check that asks a different question can pass while the phone gets nothing.
  const identity = apkUpdateIdentity('apps/mobile/android');
  if (!identity.deliverable) {
    throw new Error(`OTA NOT DELIVERABLE: ${identity.why}`);
  }
  const verdict = await verifyOtaBundle({
    projectId: EAS_PROJECT_ID,
    runtime: identity.runtime,
    channel: identity.channel,
    version: info.version,
    gitSha: info.gitSha,
  });
  if (!verdict.ok) {
    throw new Error(`OTA NOT DELIVERABLE: ${verdict.why}`);
  }
  log(`ota → published update ${verdict.id} carries ${info.version} / ${info.gitSha}`);
}

/**
 * Judge the phone build on a real Android runtime, after it has been published.
 *
 * This is the layer whose absence let a blank New chat screen ship: the unit
 * suite renders every screen against a STUBBED router, so a route table with two
 * files on one URL — and a `<Redirect>` that resolves back to itself — are
 * invisible to it by construction. Only a real navigator has that opinion.
 *
 * It runs AFTER `ota`, and that ordering is the point. What a phone runs is the
 * OTA, not the APK: the app checks the channel on launch and reloads into
 * whatever it serves, within seconds. Smoking the APK before the OTA exists
 * grades a bundle nobody will run; smoking it after grades the real thing, and
 * the harness fails the run if the app does not report this commit.
 *
 * It needs an emulator, and this box has none — so, exactly like the desktop
 * shell, it delegates to the Mac over ssh. That makes a deploy depend on the Mac
 * being awake, which it already did.
 */
/**
 * Block until the channel actually serves this commit's bundle.
 *
 * `smoke` "runs AFTER ota, and that ordering is the point" — but ota lives in
 * the `mobile` lane and smoke in the `mac` lane, and lanes run CONCURRENTLY.
 * The ordering was therefore documented and not enforced: on 9 Sep the smoke
 * launched the app before the update existed, the app reloaded into the
 * previous bundle, and the run failed with "the running app does not report
 * <sha>" — a true statement about a race, reported as if the build were broken.
 *
 * Waiting on the real artifact rather than on an inter-lane handshake also
 * covers the hand-run case (`--only=smoke`), where the publish belongs to some
 * earlier deploy entirely.
 */
async function waitForOta(info, timeoutMs = 8 * 60 * 1000) {
  const identity = apkUpdateIdentity('apps/mobile/android');
  if (!identity.deliverable) throw new Error(`OTA NOT DELIVERABLE: ${identity.why}`);
  const deadline = Date.now() + timeoutMs;
  let why = 'never checked';
  while (Date.now() < deadline) {
    const verdict = await verifyOtaBundle({
      projectId: EAS_PROJECT_ID,
      runtime: identity.runtime,
      channel: identity.channel,
      version: info.version,
      gitSha: info.gitSha,
    });
    if (verdict.ok) return;
    why = verdict.why;
    log(`smoke → waiting for the ${identity.channel} channel to carry ${info.gitSha}`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  throw new Error(
    `the ${identity.channel} channel never carried ${info.gitSha} within ${Math.round(
      timeoutMs / 60000,
    )} minutes, so there is nothing for the smoke to grade: ${why}`,
  );
}

async function smoke(info) {
  // The app OTAs on launch, so the bundle under test must be published before
  // the emulator is even booted — on the box AND before delegating to the Mac,
  // which would otherwise sit holding an emulator open through the wait.
  await waitForOta(info);
  if (!onMac()) {
    log('smoke → delegating the mobile surface layer to the Mac over ssh');
    if (!ok('ssh', ['-o', 'ConnectTimeout=10', MAC_HOST, 'true'])) {
      throw new Error(
        `Mac (${MAC_HOST}) unreachable — the mobile surface layer needs an emulator and this box ` +
          'has none. Nothing is wrong with the build; nothing has proved it right either.',
      );
    }
    sh('ssh', [MAC_HOST, macCommand('smoke', info.gitSha)]);
    return;
  }
  // On the Mac. Test the APK the BOX published, fetched from the box, so what is
  // judged is byte-for-byte what a phone would install — not a local rebuild
  // that happens to share a commit.
  log(`smoke → driving the published app on an emulator (${info.gitSha})`);
  const credential = `${process.env['HOME']}/.patch/credential.jwt`;
  if (!existsSync(credential)) {
    throw new Error(
      `no ${credential} — the smoke has to pair a surface before it can drive one. ` +
        'Pair this Mac (`patch pair`) or run the deploy with --only excluding smoke.',
    );
  }
  sh(
    'node',
    [
      'scripts/mobile-surface-smoke.mjs',
      '--apk',
      `${URL}/api/download/patch.apk`,
      '--sha',
      info.gitSha,
    ],
    { env: { ...process.env, PATCH_SMOKE_CREDENTIAL: readFileSync(credential, 'utf8').trim() } },
  );
}

// `eas build:view` rejects --non-interactive ("Nonexistent flag"), unlike every
// other eas subcommand — so the flag is per-call, not baked in here.
const easJson = (args) => JSON.parse(out('eas', [...args, '--json'], { cwd: 'apps/mobile' }));
const easBuildUrl = (id) => `https://expo.dev/accounts/tomchambers/projects/patch/builds/${id}`;

/**
 * A new APK is only needed when the NATIVE layer changes; everything else rides
 * the OTA. So compare the project's native fingerprint against the last finished
 * build's and only spend a cloud build when they actually differ.
 *
 * The build is NOT awaited: EAS free-tier queues have run to ~4 hours, and
 * blocking the deploy on that would mean the server, web and host sat unshipped
 * behind a phone build. A detached follower publishes the APK when it lands.
 */
function apk(info) {
  linkMobileCredentials();
  // What we last queued a build FOR, recorded locally.
  //
  // This used to compare the local fingerprint against the one EAS records on
  // its builds, and those two numbers do not agree: on this box
  // `fingerprint:generate` returns 7723ec5a26ea while every build EAS has —
  // including one queued minutes earlier from the same tree — records
  // 2819346fcbe5. So the comparison could never match, and EVERY deploy logged
  //   apk → native changed (2819346fcbe5 → 7723ec5a26ea)
  // and queued another Android build. Three of today's deploys did exactly that
  // for one native change.
  //
  // Fixing it by looking at more EAS build states did not help and could not:
  // the mismatch is between two different fingerprint computations, not a race
  // with an in-flight build. So the authority is a local record of what WE
  // queued, which cannot disagree with itself. A build that errored or was
  // cancelled clears it, so a genuine failure is retried rather than remembered
  // as done.
  const statePath = `${BOX}/deploy/apk-fingerprint.json`;
  let queued = null;
  try {
    queued = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    queued = null;
  }
  const current = easJson(['fingerprint:generate', '-p', 'android', '--non-interactive']).hash;
  if (queued?.fingerprint === current) {
    const recent = easJson([
      'build:list',
      '--platform',
      'android',
      '--limit',
      '10',
      '--non-interactive',
    ]);
    const mine = (Array.isArray(recent) ? recent : []).find((b) => b?.id === queued.buildId);
    const state = String(mine?.status ?? 'UNKNOWN').toUpperCase();
    const dead = state === 'ERRORED' || state === 'CANCELED' || state === 'CANCELLED';
    if (!dead) {
      log(
        `apk → already ${state.toLowerCase()} for this fingerprint (${current.slice(0, 12)}) ` +
          `as build ${String(queued.buildId).slice(0, 8)} — not queueing a duplicate`,
      );
      return null;
    }
    log(
      `apk → previous build ${String(queued.buildId).slice(0, 8)} is ${state} for this ` +
        `fingerprint (${current.slice(0, 12)}) — queueing a replacement`,
    );
  }
  const previous = queued?.fingerprint;
  log(
    `apk → native changed (${previous?.slice(0, 12) ?? 'none'} → ${current.slice(0, 12)}), starting EAS build`,
  );
  const started = easJson([
    'build',
    '--platform',
    'android',
    '--profile',
    'preview',
    '--no-wait',
    '--non-interactive',
  ]);
  const id = Array.isArray(started) ? started[0].id : started.id;
  // Recorded BEFORE the follower is detached: if this process dies between the
  // queue and the record, the next deploy queues a duplicate — which is the bug
  // being fixed, so the window is closed as tightly as possible.
  writeFileSync(
    statePath,
    `${JSON.stringify({ fingerprint: current, buildId: id, queuedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  log(`apk → build ${id} queued; a detached follower will publish it`);
  detach([`--follow-apk=${id}`], `apk-${id.slice(0, 8)}`);
  return id;
}

/**
 * Wait for a queued EAS build, publish the APK to the box, and tell the phone.
 * Runs as its own detached process so the deploy never blocks on the build queue.
 */
function followApk(buildId) {
  for (;;) {
    const b = easJson(['build:view', buildId]);
    if (b.status === 'FINISHED') {
      const file = `patch-${b.gitCommitHash.slice(0, 7)}.apk`;
      sh('curl', [
        '-sfL',
        '-o',
        `${BOX}/deploy/downloads/${file}`,
        b.artifacts.applicationArchiveUrl,
      ]);
      sh('cp', [`${BOX}/deploy/downloads/${file}`, `${BOX}/deploy/downloads/patch.apk`]);
      writeFileSync(
        `${BOX}/deploy/downloads/android-latest.json`,
        JSON.stringify(
          {
            version: b.appVersion,
            gitSha: b.gitCommitHash.slice(0, 7),
            builtAt: b.completedAt,
            file,
          },
          null,
          2,
        ),
      );
      prune();
      notify('Patch: new APK ready', `${b.appVersion} — ${URL}/api/download/${file}`, 'high');
      return;
    }
    if (b.status === 'ERRORED' || b.status === 'CANCELED') {
      notify('Patch: APK build failed', `${b.status} — ${easBuildUrl(buildId)}`, 'high');
      throw new Error(`EAS build ${buildId} ${b.status}: ${easBuildUrl(buildId)}`);
    }
    execFileSync('sleep', ['60']);
  }
}

/**
 * What the box runs on the Mac for a delegated surface.
 *
 * It used to `git checkout <sha>` inside `${MAC_REPO}` — which is a SYMLINK to
 * the Mac's working checkout. Every deploy left that checkout on a detached
 * HEAD, and any uncommitted edit sitting in it was either enough to block the
 * deploy or got signed into the shipped Electron shell under a commit that does
 * not contain it. The box has refused to build in a shared checkout for exactly
 * that reason since prepareBuildTree() existed; the Mac never did, and the Mac
 * is the one machine a human is actually typing in.
 *
 * So it prepares a worktree pinned to the commit and runs from THERE. The
 * checkout is only ever read: a fetch, and the worktree bookkeeping. That also
 * fixes a second thing quietly — ship.mjs now runs from the shipped commit
 * rather than whatever the working checkout happened to have, so a change to
 * this file takes effect on the Mac in the deploy that introduces it.
 */
function macCommand(surface, sha) {
  return (
    `bash -lc '${MAC_SHELL} cd ${MAC_REPO} && git fetch origin --quiet && ` +
    `cd "$(node scripts/build-tree.mjs ${sha})" && ` +
    `corepack pnpm install --frozen-lockfile --silent && ` +
    `node scripts/ship.mjs --only=${surface} --foreground'`
  );
}

/**
 * macOS only — the Electron shell must be codesigned, and Squirrel refuses to
 * apply an update to an adhoc-signed app. From the box this is driven over ssh.
 */
function desktop(info) {
  if (!onMac()) {
    log('desktop → delegating to the Mac over ssh');
    if (!ok('ssh', ['-o', 'ConnectTimeout=10', MAC_HOST, 'true'])) {
      throw new Error(
        `Mac (${MAC_HOST}) unreachable — the desktop shell cannot be built anywhere else.`,
      );
    }
    sh('ssh', [MAC_HOST, macCommand('desktop', info.gitSha)]);
    return;
  }
  log(`desktop → building signed shell ${info.version} / ${info.gitSha}`);
  if (process.env.PATCH_MAC_GUI_JOB !== '1') {
    log('desktop → signing in the logged-in Mac session');
    sh(process.execPath, [
      'scripts/mac-gui-run.mjs',
      process.execPath,
      fileURLToPath(import.meta.url),
      '--only=desktop',
      '--foreground',
    ]);
    return;
  }
  const identities = out('security', ['find-identity', '-v', '-p', 'codesigning']);
  if (!identities.includes(CSC_NAME)) {
    throw new Error(
      `code-signing identity "${CSC_NAME}" not found. Squirrel cannot apply an update to an ` +
        `adhoc-signed app, so publishing one is pointless.\nFound:\n${identities}`,
    );
  }
  const env = {
    ...process.env,
    PATCH_VERSION: info.version,
    PATCH_GIT_SHA: info.gitSha,
    PATCH_BUILT_AT: info.builtAt,
    CSC_NAME,
    PATCH_SKIP_NOTARIZE: '1', // no Apple account; these install by direct copy, never quarantined
  };
  sh('pnpm', ['--filter', '@patch/desktop', 'build'], { env });
  sh('pnpm', ['--filter', '@patch/desktop', 'dist'], { env });

  const rel = 'packages/desktop/release';
  const zip = `Patch-${info.version}-arm64-mac.zip`;
  // electron-updater needs BOTH the manifest and the artifact it names; one
  // without the other is an updater that finds a version it can never download.
  for (const f of ['latest-mac.yml', zip]) {
    if (!existsSync(`${rel}/${f}`)) throw new Error(`missing build artifact ${rel}/${f}`);
  }
  const app = `${rel}/mac-arm64/Patch.app`;
  const sig = out('sh', ['-c', `codesign -dv "${app}" 2>&1 || true`]);
  if (/Signature=adhoc/.test(sig) || !/Identifier=com\.tomchambers\.patch/.test(sig)) {
    throw new Error(`refusing to publish: ${app} is not properly signed.\n${sig}`);
  }
  if (!ok('codesign', ['--verify', '--deep', '--strict', app])) {
    throw new Error(`refusing to publish: ${app} fails codesign --verify --deep --strict`);
  }
  sh(process.execPath, ['--test', 'packages/desktop/scripts/single-instance.test.cjs'], {
    env: {
      ...env,
      PATCH_REAL_DESKTOP: '1',
      PATCH_TEST_DESKTOP_BINARY: resolve(app, 'Contents/MacOS/Patch'),
    },
  });
  const dest = `${BOX_HOST}:${BOX}/deploy/downloads`;
  sh('rsync', ['-az', `${rel}/latest-mac.yml`, `${dest}/latest-mac.yml`]);
  sh('rsync', ['-az', `${rel}/${zip}`, `${dest}/${zip}`]);
  if (existsSync(`${rel}/${zip}.blockmap`)) {
    sh('rsync', ['-az', `${rel}/${zip}.blockmap`, `${dest}/${zip}.blockmap`]);
  }
  // electron-builder's yml carries a version but no git sha; this sidecar is what
  // lets /api/version trace the published binary back to a commit.
  writeFileSync('/tmp/desktop-latest.json', JSON.stringify({ ...info, file: zip }, null, 2));
  sh('rsync', ['-az', '/tmp/desktop-latest.json', `${dest}/desktop-latest.json`]);
}

/** Keep the box's downloads to the current build of each surface. */
function prune() {
  try {
    console.log(out('node', ['scripts/prune-downloads.mjs', `${BOX}/deploy/downloads`]));
  } catch (err) {
    // Never fail a deploy over housekeeping — the artifacts are published and the
    // surfaces are live. Say so loudly instead.
    console.error(`    WARNING: prune failed (${err.message.split('\n')[0]}) — disk not reclaimed`);
  }
}

// --- verification -----------------------------------------------------------

/**
 * Every layer must report the commit we just shipped. This is the check whose
 * absence let a stale SPA sit in prod for eight days while /api/healthz reported
 * a newer commit and nobody compared the two.
 */
function verify(info, expectedDaemon, expectOta) {
  // A surface this deploy did not SHIP cannot be expected to report this commit —
  // it is correctly still serving the last one that touched it. `desktop` and
  // `apk` already worked this way for exactly that reason; surface scoping made
  // it true of every surface, and these rows did not know.
  //
  // The result was a deploy that shipped perfectly and then failed its own
  // verification: `FAIL web 2665b1d` while the host row read `ok 0.1.752`. Both
  // scoped deploys did it. Worse than noise — a failure signal that fires on
  // success is one nobody reads, and this check exists because a stale SPA once
  // sat in prod for eight days.
  const expected = (name) => !shipped.has(name);
  const rows = [];
  const health = curlJson(`${URL}/api/healthz`);
  rows.push([
    'server',
    health.gitSha,
    expected('server') || sameCommit(health.gitSha, info.gitSha),
  ]);

  const spa = curlJson(`${URL}/app/version.json`);
  rows.push(['web', spa.gitSha, expected('web') || sameCommit(spa.gitSha, info.gitSha)]);

  if (expectedDaemon) {
    const d = curlJson(`${URL}/api/daemon/daemon-latest.json`);
    rows.push(['daemon', d.version, d.version === expectedDaemon]);
  }
  // The OTA is the mobile surface that actually carries this commit's JS, so it
  // IS required to match -- unlike the APK below. Without this row a failed or
  // silently-stale `eas update` looks identical to a good deploy, because the
  // apk row reports the older native build and passes regardless.
  if (expectOta) {
    const latest = easJson([
      'update:list',
      '--branch',
      EAS_CHANNEL,
      '--limit',
      '1',
      '--non-interactive',
    ]).currentPage?.[0];
    // `message` reads: "ota <sha>" (2 minutes ago by <user>)
    const sha = /ota ([0-9a-f]{7,40})/.exec(latest?.message ?? '')?.[1];
    rows.push([
      'ota',
      sha ?? `no update on ${EAS_CHANNEL}`,
      expected('ota') || sameCommit(sha, info.gitSha),
    ]);
  }

  // The APK legitimately lags: it only rebuilds on a native change, and that
  // build is still queueing. Report what is published, don't require a match.
  if (ok('curl', ['-sf', '-o', '/dev/null', `${URL}/api/download/android-latest.json`])) {
    const a = curlJson(`${URL}/api/download/android-latest.json`);
    rows.push(['apk', `${a.version} / ${a.gitSha}`, true]);
  }
  // Like the APK, the desktop shell legitimately lags a deploy that did not build
  // it: `--only=web,server` never touches the Mac, so requiring a match there made
  // every partial deploy report FAILED after shipping perfectly well. Same for a
  // desktop build that was attempted and threw — already counted in `failures`.
  if (ok('curl', ['-sf', '-o', '/dev/null', `${URL}/api/desktop/desktop-latest.json`])) {
    const d = curlJson(`${URL}/api/desktop/desktop-latest.json`);
    rows.push(['desktop', d.gitSha, expected('desktop') || sameCommit(d.gitSha, info.gitSha)]);
  }
  const failed = rows.filter(([, , good]) => !good);
  const summary = rows
    .map(
      ([n, v, good]) =>
        `${good ? 'ok' : 'FAIL'} ${n} ${v}${shipped.has(n) ? '' : ' (not shipped by this deploy)'}`,
    )
    .join('\n');
  console.log(`\n${summary}`);
  if (failed.length) throw new Error(`surfaces did not converge on ${info.gitSha}:\n${summary}`);
  return summary;
}

// --- detaching --------------------------------------------------------------

/**
 * Re-exec ourselves fully detached, so the run survives the host restart that
 * ends the chat which started it.
 */
function detach(args, tag) {
  const dir = `${BOX}/deploy/logs`;
  mkdirSync(dir, { recursive: true });
  const file = `${dir}/${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
  const fd = openSync(file, 'a');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    detached: true,
    stdio: ['ignore', fd, fd],
    cwd: REPO,
  });
  child.unref();
  return file;
}

// --- entrypoint -------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const val = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];

if (val('follow-apk')) {
  followApk(val('follow-apk'));
  process.exit(0);
}

/**
 * The surfaces this commit needs, from the diff against what is already live.
 *
 * Conservative by construction: a path outside every prefix above — a root
 * config, the lockfile, turbo.json, this script — returns ALL of them, because
 * "I could not attribute it" must not read as "nothing to do". Same for a
 * missing or unrelated baseline: with nothing to diff against, everything ships.
 */
let changedFiles = null;
function surfacesForDiff(shipSha) {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(`${BOX}/deploy/build-info.json`, 'utf8')).gitSha;
  } catch {
    log('scope → no build-info.json to diff against; shipping every surface');
    return ALL_SURFACES;
  }
  if (!baseline || !ok('git', ['cat-file', '-e', `${baseline}^{commit}`])) {
    log(`scope → baseline ${baseline ?? 'none'} is not a commit here; shipping every surface`);
    return ALL_SURFACES;
  }
  if (baseline === shipSha) {
    log('scope → already live; shipping every surface (a re-deploy is a repair, not a no-op)');
    return ALL_SURFACES;
  }
  let changed;
  try {
    changed = out('git', ['diff', '--name-only', `${baseline}..${shipSha}`])
      .split('\n')
      .filter(Boolean);
  } catch {
    log('scope → could not diff; shipping every surface');
    return ALL_SURFACES;
  }
  if (changed.length === 0) {
    log('scope → no files changed; shipping every surface');
    return ALL_SURFACES;
  }
  // Recorded for the test gate, which uses the same diff to decide whether the
  // browser layer can possibly be affected. Set only on the path where the diff
  // is fully attributed: every early return above leaves it null, and null means
  // "run the whole gate".
  const { surfaces, unattributed } = surfacesForChangedFiles(changed);
  if (unattributed.length > 0) {
    log(
      `scope → ${unattributed.length} path(s) outside any surface (${unattributed
        .slice(0, 3)
        .join(', ')}${unattributed.length > 3 ? ', …' : ''}); shipping every surface`,
    );
    return ALL_SURFACES;
  }
  changedFiles = changed;
  const list = surfaces;
  log(
    `scope → ${changed.length} file(s) changed since ${baseline.slice(0, 7)}; ` +
      `shipping ${list.length > 0 ? list.join(', ') : 'nothing'} ` +
      `(skipping ${ALL_SURFACES.filter((s) => !surfaces.includes(s)).join(', ') || 'nothing'})`,
  );
  return list;
}

const only = val('only');
// A lane child: the parent has already pinned the build tree, rebuilt the
// workspace libs and run the gate, so this process does its surfaces and
// nothing else. Never passed by hand.
const prepared = flag('prepared');
// Provisional until the commit is resolved: an explicit --only is authoritative,
// and without one we assume EVERY surface so the detach decision below (which
// runs before the sha is known) stays conservative. `surfacesForDiff` narrows it
// once there is a sha to diff.
let wanted = only ? only.split(',') : ALL_SURFACES;
const want = (s) => wanted.includes(s);

// Detached by default: the host apply kills this chat, so the deploy must
// outlive it. --only runs that exclude the apply are safe inline.
if (!flag('foreground') && want('apply')) {
  const file = detach([...argv, '--foreground'], 'deploy');
  console.log(
    `deploy running detached → ${file}\n` +
      `It ships web, server, host, OTA, APK and desktop, then verifies every surface\n` +
      `and reports over ntfy. The host restart at the end WILL kill this chat — that is\n` +
      `expected; do not wait for it and do not re-run.`,
  );
  process.exit(0);
}

if (!prepared) requireCanonicalCheckout();
requireExternalTools();
// The Mac is a SUB-STEP of a deploy that already resolved the commit and checked
// it out over ssh, so it builds in place; the box pins a build tree to the commit.
// A lane child inherits the tree the parent pinned; re-resolving would re-sync
// the checkout under three siblings mid-build.
const shipSha = onMac() || prepared ? out('git', ['rev-parse', 'HEAD']) : resolveShipCommit();
// Claim the box before touching the shared build tree. Not on the Mac (it is a
// sub-step of a deploy that already holds the lock and builds in place), and not
// in a lane child (it inherits the tree its parent pinned and locked).
if (!onMac() && !prepared) recordDeployTree({ path: DEPLOY_LOCK, sha: shipSha });
if (!onMac() && !prepared) prepareBuildTree(shipSha);
if (prepared) {
  BUILD = BUILD_TREE;
  process.chdir(BUILD);
}
// AFTER the build tree exists, and read FROM it — the sync above can move HEAD,
// and every surface must be stamped with the commit actually being built.
/**
 * Say so, loudly, when the script RUNNING is not the script being shipped.
 *
 * A deploy executes `/srv/patch/scripts/ship.mjs` — the shared checkout's copy —
 * while every artifact is built from a worktree pinned to the shipped commit. So
 * a change to this file does not take effect until someone checks it out into
 * that shared tree, and until then the deploy silently behaves like an older
 * version of itself.
 *
 * That is not hypothetical: the APK duplicate-build fix sat in three consecutive
 * deploys' commits without ever running, because the box was still executing a
 * copy from before it existed. Nothing said a word — the fix looked shipped and
 * the duplicate builds kept being queued.
 *
 * A warning rather than a refusal: the running script is usually the right one,
 * and blocking every deploy on an out-of-date checkout would be worse than
 * naming it. Refusing is also useless here, because whatever refuses is itself
 * the stale copy.
 */
function warnIfShipScriptIsStale() {
  const mine = `${REPO}/scripts/ship.mjs`;
  const shipped = `${BUILD_TREE}/scripts/ship.mjs`;
  try {
    if (readFileSync(mine, 'utf8') === readFileSync(shipped, 'utf8')) return;
  } catch {
    return; // Cannot compare (no build tree yet) — not a finding.
  }
  log(
    `WARNING: this deploy is running ${mine}, which DIFFERS from the same file at the ` +
      `commit being shipped. Changes to ship.mjs in that commit are NOT in effect. ` +
      `Sync it with:  git -C ${BOX} checkout origin/main -- scripts/`,
  );
}

const info = JSON.parse(out('node', ['scripts/version.mjs', '--json']));
log(`deploying ${info.version} / ${info.gitSha}`);
if (!onMac() && !prepared) warnIfShipScriptIsStale();
// Narrow to the surfaces this commit can actually affect. Only now — it needs
// the resolved sha, and the Mac runs as a `--only=desktop` sub-step that has
// already been scoped by the box.
if (!only && !onMac()) wanted = surfacesForDiff(shipSha);
if (!prepared) {
  buildWorkspaceLibs();
  testGate();
}

/**
 * Run one surface, recording its failure instead of propagating it.
 *
 * The surfaces are independent of each other: the mobile OTA and APK build
 * entirely on this box and share nothing with the Mac that codesigns the desktop
 * shell. Aborting the whole run at the first throw meant one broken surface
 * stranded all the rest — a Mac keychain password held 35 commits of mobile
 * fixes for a day. This is NOT a fallback: nothing is retried, nothing degrades
 * silently, and the run still ends FAILED. It just finishes shipping the
 * surfaces that had nothing wrong with them first, and names every one that
 * broke rather than only the earliest.
 */
const failures = [];
const shipped = new Set();
// `await`s the step whether or not it is async. `ota` verifies the PUBLISHED
// bundle over the network and is therefore a promise; a bare `fn()` here would
// mark it shipped the instant it started and let its rejection escape this
// try/catch entirely — a failed OTA reported as a successful deploy, which is
// the exact class of lie this file exists to prevent.
async function surface(name, fn) {
  if (!want(name)) return undefined;
  try {
    const result = await fn();
    shipped.add(name);
    return result;
  } catch (err) {
    console.error(`\n  FAILED ${name}: ${err.message}`);
    failures.push(`${name}: ${err.message.split('\n')[0]}`);
    return undefined;
  }
}

/**
 * Run one lane's surfaces in this process, in order. Only the couplings named on
 * LANES are sequential; a lane never waits on another lane.
 */
let daemonVersion = null;

async function runLane() {
  const bundle = await surface('web', () => web(info));
  await surface('server', () => server(info));
  // Serving the new bundle is the other half of shipping web, but it can only be
  // checked once the server that serves it has restarted.
  if (bundle && want('server')) {
    try {
      verifyWeb(bundle);
    } catch (err) {
      console.error(`\n  FAILED web: ${err.message}`);
      failures.push(`web: ${err.message.split('\n')[0]}`);
      shipped.delete('web');
    }
  }
  daemonVersion = (await surface('daemon', () => daemonPublish())) ?? null;
  await surface('ota', () => ota(info));
  await surface('apk', () => apk(info));
  await surface('desktop', () => desktop(info));
  await surface('smoke', () => smoke(info));
  // Clearing superseded host artifacts belongs with the host, not to every
  // lane that happens to be running.
  if (!onMac() && want('daemon')) prune();
  if (daemonVersion) await surface('apply', () => daemonApply(daemonVersion));
  // A lane child reports what it managed upward; the parent cannot see this
  // process's `shipped` set, and marking a whole lane failed because one of its
  // surfaces was would hide the one that worked.
  if (prepared) {
    console.log(`##lane ${JSON.stringify({ shipped: [...shipped], daemonVersion })}`);
  }
}

/**
 * Run the lanes at the same time, each as a child of this process.
 *
 * A child rather than a promise because every step in this file shells out
 * SYNCHRONOUSLY — `execFileSync` holds the event loop for the whole of a build,
 * so two surfaces in one process can only ever take turns however they are
 * written. Separate processes also mean a lane that dies takes nothing with it.
 *
 * Each child's output is captured and replayed under its lane name when it
 * finishes, so four concurrent builds do not interleave into an unreadable log.
 */
async function runLanes(lanes) {
  log(`lanes → ${lanes.map(([n, ss]) => `${n} (${ss.join(', ')})`).join('  |  ')}`);
  const results = await Promise.all(
    lanes.map(
      ([name, surfaces]) =>
        new Promise((resolve) => {
          const child = spawn(
            process.execPath,
            [
              `${BUILD}/scripts/ship.mjs`,
              `--only=${surfaces.join(',')}`,
              '--foreground',
              '--prepared',
            ],
            { cwd: BUILD, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
          );
          let output = '';
          child.stdout.on('data', (d) => (output += d));
          child.stderr.on('data', (d) => (output += d));
          child.on('close', (code) => resolve({ name, surfaces, code, output }));
        }),
    ),
  );
  for (const r of results) {
    console.log(`\n──────── lane ${r.name} ────────`);
    process.stdout.write(r.output);
    const reported = r.output.match(/^##lane (.*)$/m);
    if (reported) {
      const { shipped: got, daemonVersion: v } = JSON.parse(reported[1]);
      for (const sfc of got) shipped.add(sfc);
      if (v) daemonVersion = v;
    } else if (r.code === 0) {
      // Exited clean without saying what it did — treat the lane as shipped
      // rather than silently reporting nothing.
      for (const sfc of r.surfaces) shipped.add(sfc);
    }
    // The child already named which of its surfaces broke, in the output above;
    // this row exists so a lane that died without reaching that never passes for
    // a success.
    if (r.code !== 0) failures.push(`lane ${r.name} (${r.surfaces.join(', ')}) exited ${r.code}`);
  }
}

// A lane child ships its own surfaces inline. The parent fans them out — unless
// an explicit --only asked for a subset, which is a hand-run of one thing and
// stays inline so its output is not buffered behind a lane wrapper.
const lanesToRun = lanesFor(wanted);
if (prepared || only || onMac() || lanesToRun.length <= 1) {
  await runLane();
} else {
  await runLanes(lanesToRun);
}

if (prepared) process.exit(failures.length ? 1 : 0);

if (onMac()) {
  if (failures.length) {
    console.error(`\nDEPLOY FAILED\n${failures.join('\n')}`);
    process.exit(1);
  }
  // Name what this run actually did. The Mac is now delegated TWO different
  // steps, and a smoke-only run that reported "desktop published" would be the
  // same species of lie as an OTA that reports the wrong commit.
  log(`${[...shipped].join(' + ') || 'nothing'} done on the Mac`);
  process.exit(0);
}

let summary = '';
try {
  // A surface that threw above did not ship, so don't also demand it converged:
  // it is already named in `failures`, and a second row for it just buries the
  // surfaces that are genuinely wrong.
  summary = verify(info, daemonVersion, shipped.has('ota'));
} catch (err) {
  failures.push(err.message);
}

if (failures.length) {
  const detail = `shipped: ${[...shipped].join(', ') || 'nothing'}\n${failures.join('\n')}`;
  console.error(`\nDEPLOY FAILED\n${detail}`);
  notify('Patch deploy FAILED', `${info.version} / ${info.gitSha}\n${detail}`, 'high');
  process.exit(1);
}
notify('Patch deployed', `${info.version} / ${info.gitSha}\n${summary}`);
log('done');
