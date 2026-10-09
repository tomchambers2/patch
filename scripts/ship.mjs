#!/usr/bin/env node
// Patch deploy — one command, every surface.
//
//   pnpm run deploy              ship everything, detached (the normal case)
//   pnpm run deploy --foreground run inline and watch it
//   pnpm run deploy --only=web   one surface (web|server|daemon|ota|apk|desktop|smoke)
//   pnpm run deploy --only=ota,apk --apk-local
//                                build the APK on the Mac with gradle, not on EAS
//   pnpm run deploy --only=ota,apk --apk-here
//                                build the APK on THIS box, capped (Mac off, EAS out)
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
//
// The server and SPA ship as ONE release (scripts/build-server.mjs), installed into
// ~/.patch-server by its own installer — the same path a self-hoster uses. The
// live app never runs out of a git checkout.
//   desktop                         macOS only (codesigning) — driven over ssh
//
// NO FALLBACK: every step either proves it worked or throws. A surface that
// cannot be built here is an error, never a silent skip. Surfaces are, however,
// independent of one another — one that throws is reported and the rest still
// ship, so a broken desktop shell cannot strand the mobile OTA behind it.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import {
  ALL_SURFACES,
  laneArgs,
  lanesFor,
  surfacesForChangedFiles,
  withLockstep,
} from './deploy-scope.mjs';
import { verifyOtaBundle } from './verify-ota-bundle.mjs';
import { mergeDaemonArtifact } from './daemon-manifest.mjs';
import {
  MAC_SURFACES,
  MacUnreachable,
  addPending,
  describePending,
  readPending,
  settle,
} from './mac-pending.mjs';
import { apkUpdateIdentity } from './apk-update-identity.mjs';
import {
  apkBadging,
  apkBuildDecision,
  apkBuilder,
  apkFileName,
  builtApkPath,
  easQuotaExhausted,
  signerCheck,
} from './apk-publish.mjs';
import { verifyApkBundle } from './verify-apk-bundle.mjs';
import { APK_OUTPUT, boxBuildCommand } from './build-apk-local.mjs';
import { prepareWorktree } from './build-tree.mjs';
import { recordDeployTree } from './deploy-lock.mjs';
import { apkOutputDirs, formatCleanup, runCleanup } from './deploy-cleanup.mjs';
import { deployTarget, publishPlan } from './deploy-target.mjs';
import { sameCommit } from './same-commit.mjs';
import { classifyUpdate, patchCliCommand, updateLine } from './daemon-apply.mjs';
import { buildServerRelease, writeInstallChannel } from './build-server.mjs';
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
const BOX = '/srv/patch'; // the box's source checkout, where a deploy is typed
// The RUNNING app on the box: the server's install home (packages/server/release/install
// lays it out — versions/, current, data/, downloads/, server.env, logs/). Never a git
// checkout, so nothing an agent does to source can touch what is live.
const SERVER_HOME = '/home/claude-dev/.patch-server';
const DOWNLOADS = `${SERVER_HOME}/downloads`; // the update channel the server serves
// The deploy's own bookkeeping (logs, the APK fingerprint, APKs in transit).
const DEPLOY_STATE = '/home/claude-dev/.patch-deploy';
// What the Mac still owes for a commit when it was asleep (mac-pending.mjs).
const MAC_PENDING = `${DEPLOY_STATE}/mac-pending.json`;
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
// A deploy is something an AGENT ran, and its progress belongs where that agent
// (or the app's own job log) can read it — not on Tom's phone, which got a push
// for every deploy of a thing that updates itself. Empty by default: set
// PATCH_NTFY_URL to a topic to put deploy pushes back on a device.
const NTFY = process.env['PATCH_NTFY_URL'] ?? '';
// The ONE push that does go to Tom's phone: a new APK. Android cannot install it
// by itself, so unlike every other deploy result it needs a human, and the phone
// is where he installs it. Same topic bin/publish uses for every other app.
const APK_NTFY =
  process.env['PATCH_APK_NTFY_URL'] ?? 'https://ntfy.sh/tomchambers-phone-hgzsxwk9kah';
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

// --- cleaning up after ourselves ---------------------------------------------
//
// Every run cleans the machine it ran on when it ends, success or failure
// (scripts/deploy-cleanup.mjs says what, and what never). A cleanup that fails
// is named, loudly, in the deploy's summary — and changes nothing about whether
// the deploy succeeded.

/** Cleanup trouble met along the way (APK outputs, the Mac), for the summary. */
const cleanupWarnings = [];
let cleanupLine = null;

/**
 * Clean this machine, once. Called at the end of a run and again from the exit
 * handler, so a run that dies on an uncaught throw still cleans up; whichever
 * comes first does the work.
 */
function cleanupOnce() {
  if (cleanupLine) return cleanupLine;
  try {
    const report = runCleanup({
      current: onMac() ? REPO : BUILD_TREE,
      downloads: onMac() ? null : DOWNLOADS,
      deployState: onMac() ? null : DEPLOY_STATE,
      lockPath: DEPLOY_LOCK,
      repo: REPO,
    });
    report.errors.push(...cleanupWarnings);
    cleanupLine = formatCleanup(report);
  } catch (err) {
    // runCleanup does not throw; this is for the case where it somehow does.
    cleanupLine = `CLEANUP FAILED on this ${onMac() ? 'Mac' : 'box'} (the deploy result stands): ${err.message}`;
  }
  if (cleanupLine.startsWith('CLEANUP FAILED')) console.error(`\n  WARNING: ${cleanupLine}`);
  else log(cleanupLine);
  return cleanupLine;
}

/**
 * Delete the android build output in `tree` once its APK is published (or its
 * build has failed — either way it is dead weight: ~2 GB of gradle and CMake).
 */
function dropApkOutputs(tree) {
  try {
    for (const dir of apkOutputDirs(tree)) rmSync(dir, { recursive: true, force: true });
    log(`apk → removed the android build output in ${tree}`);
  } catch (err) {
    cleanupWarnings.push(`APK build output in ${tree}: ${err.message.split('\n')[0]}`);
  }
}

const curlJson = (u) => JSON.parse(out('curl', ['-sf', u]));

function waitFor(label, check, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (check()) return;
    execFileSync('sleep', ['2']);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function notify(title, message, priority = 'default') {
  // ALWAYS on this run's own output first. This is the only channel that is
  // guaranteed to exist, and it is the one the agent driving the deploy reads;
  // dropping a result because no push topic is configured would make a failed
  // deploy silent, which is the one thing this must never be.
  log(`${title}: ${message.replace(/\n/g, ' — ')}`);
  if (!NTFY) return;
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

/** Push a tappable link to Tom's phone. Loud on failure, never fatal: the APK is already published. */
function notifyPhone(title, message, link) {
  if (
    !ok('curl', [
      '-sf',
      '-o',
      '/dev/null',
      '-H',
      `Title: ${title}`,
      '-H',
      `Click: ${link}`,
      '-H',
      'Priority: high',
      '-d',
      message,
      APK_NTFY,
    ])
  ) {
    console.error(
      `    WARNING: ntfy to the phone failed — "${title}" not delivered; the link is ${link}`,
    );
    return;
  }
  log(`apk → phone told over ntfy`);
}

// --- preflight --------------------------------------------------------------

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
  // Publishing an APK reads its signer and version with the SDK's build-tools —
  // better named now than after a fifteen-minute build on the Mac.
  if (want('apk')) {
    buildTool('apksigner');
    buildTool('aapt2');
  }
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
  // is installed as a release into ${SERVER_HOME} (outside every checkout), and
  // build identity is stamped into that release rather than read from HEAD —
  // see release(). So the only thing a fast-forward here bought was a tidy
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
  // Link it to the live server's config rather than copy, so the box keeps one
  // source of those secrets.
  const serverEnv = `${SERVER_HOME}/server.env`;
  if (!existsSync(serverEnv)) {
    throw new Error(`no ${serverEnv} — the build tree needs it for the integration tests`);
  }
  sh('ln', ['-sfn', serverEnv, `${BUILD_TREE}/deploy/.env`]);
  log('build → installing dependencies');
  sh('pnpm', ['install', '--frozen-lockfile', '--silent'], { cwd: BUILD_TREE });
  BUILD = BUILD_TREE;
  process.chdir(BUILD);
}

/**
 * Rebuild the shared libraries every host-side surface consumes.
 *
 * These are resolved through their package `main` — their DIST — by the web
 * bundler, the host's esbuild, Metro and the desktop build alike, and nothing
 * in those builds regenerates it. A dist lagging its own src either fails loudly
 * on a missing export or, far worse, silently bundles the OLD implementation of
 * one it still exports, which is how a "deployed" surface ends up running code
 * that is not in the commit it claims.
 *
 * Runs before the gate, not just before the surfaces: typecheck resolves them
 * the same way, so a stale dist fails the gate for a reason that has nothing to
 * do with the commit under test.
 *
 * EVERY shared library a surface imports has to be listed here. @patch/relay
 * was added to the workspace and consumed by desktop, server and mobile without
 * being added, so the desktop build failed on nine "Cannot find module
 * '@patch/relay'" errors — in a lane that runs on the Mac, fifteen minutes into
 * a deploy. If you add a package under packages/ that a surface imports, add it
 * to this list in the same commit.
 */
function buildWorkspaceLibs() {
  const libs = ['@patch/wire', '@patch/auth', '@patch/relay'];
  log(`libs → rebuilding ${libs.join(' + ')}`);
  sh('pnpm', [...libs.flatMap((l) => ['--filter', l]), 'build']);
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
 * Build the server + SPA as one release and install it, exactly as a self-hoster
 * would (scripts/build-server.mjs, packages/server/release/install). The
 * installer copies it into ${SERVER_HOME}/versions, swaps `current`, restarts
 * patch-server.service and waits for /api/healthz to report the release's commit.
 *
 * A web-only deploy reuses the RUNNING release's server — its code and its
 * identity — around the new SPA, so a UI change never ships a new server version
 * (which would drag every host along with it: deploy-scope.mjs § LOCKSTEP).
 * It still restarts the server, because the server serves the SPA out of the
 * release it booted from.
 *
 * The previous two releases stay in ${SERVER_HOME}/versions for a hand rollback.
 */
function release(info) {
  const reuseServer = want('server') ? null : realpathSync(`${SERVER_HOME}/current`);
  const out = `${BUILD}/dist/server`;
  const { dir, bundle } = buildServerRelease({ root: BUILD, info, out, reuseServer, log });
  log(`release → installing into ${SERVER_HOME}`);
  sh(`${dir}/install`, ['--home', SERVER_HOME]);
  // The relay phones reach a desktop-hosted server through (wss://patch.tomchambers.me/relay).
  if (want('server')) sh('node', ['scripts/install-relay.mjs'], { cwd: BUILD });
  // The one-command install channel (install.sh + tarball + checksum), served at
  // /api/server-release/ so a stranger's box can `curl | sudo sh` it. Files in
  // place before the old ones are replaced, checksum last.
  const tarball = `${dir}.tar.gz`;
  sh('tar', ['-czf', tarball, '-C', out, basename(dir)]);
  const channel = writeInstallChannel({ root: BUILD, out, tarball });
  const chanDir = `${DOWNLOADS}/server-release`;
  mkdirSync(chanDir, { recursive: true });
  sh('cp', [channel.installer, channel.stable, `${chanDir}/`]);
  sh('cp', [`${channel.stable}.sha256`, `${chanDir}/`]);
  rmSync(out, { recursive: true, force: true });
  // The host reconnects on its own; prove it did rather than assuming.
  waitFor('host re-linked', () =>
    ok('sh', ['-c', `tail -n 200 ${DAEMON_LOG} | grep -q "server-link: authenticated"`]),
  );
  return bundle;
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
  for (const f of ['install.sh', 'patch-server.tar.gz.sha256']) {
    if (!ok('curl', ['-sf', '-o', '/dev/null', `${URL}/api/server-release/${f}`])) {
      throw new Error(
        `${URL}/api/server-release/${f} is not being served — the one-command install is broken`,
      );
    }
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
    `cp ${dist}/daemon-latest.json ${dist}/install.sh ${dist}/*.tar.gz ${dist}/*.tar.gz.sig ${DOWNLOADS}/`,
  ]);
  sh('rm', ['-rf', dist]);
  log(`host → published ${version}`);
  return version;
}

/**
 * The darwin-arm64 host, built on the Mac (its codesigning identity lives
 * there) from a tree pinned to this commit, and added to the manifest the box
 * just published. A separate surface from `daemon` so a sleeping laptop fails
 * THIS step, loudly, without holding back hetzner's own host update — a Mac
 * host meanwhile reports "no artifact for darwin-arm64" in Settings → Hosts
 * rather than updating to something else.
 */
function daemonMac(info) {
  if (onMac()) throw new Error('daemon-mac is driven from the box; run the deploy there');
  if (!ok('ssh', ['-o', 'ConnectTimeout=10', MAC_HOST, 'true'])) {
    throw new MacUnreachable(`Mac (${MAC_HOST}) unreachable — the macOS host can only be built there.`);
  }
  const target = 'darwin-arm64';
  const staging = `/tmp/patch-daemon-${target}-${info.gitSha}`;
  const macOut = `/tmp/patch-daemon-${target}-${info.gitSha}`;
  sh('rm', ['-rf', staging]);
  mkdirSync(staging, { recursive: true });
  log(`daemon-mac → building ${target} on the Mac`);
  sh('ssh', [
    MAC_HOST,
    macCommand(
      `corepack pnpm turbo build --filter=@patch/daemon... --output-logs=errors-only && ` +
        `rm -rf ${macOut} && ` +
        `PATCH_BUILD_VENDOR=~/.patch-daemon-build/vendor ` +
        `PATCH_ARTIFACT_SIGNING_KEY=~/.patch-daemon-build/artifact-signing.key ` +
        `PATCH_CODESIGN_IDENTITY="${CSC_NAME}" PATCH_BUILD_TARGETS=${target} ` +
        `PATCH_BUILD_OUT=${macOut} node scripts/build-daemon.mjs && ` +
        `scp -q ${macOut}/daemon-latest.json ${macOut}/*.tar.gz ${macOut}/*.tar.gz.sig ${BOX_HOST}:${staging}/ && ` +
        `rm -rf ${macOut}`,
      info.gitSha,
    ),
  ]);
  const downloads = DOWNLOADS;
  const published = JSON.parse(readFileSync(`${downloads}/daemon-latest.json`, 'utf8'));
  const built = JSON.parse(readFileSync(`${staging}/daemon-latest.json`, 'utf8'));
  const merged = mergeDaemonArtifact(published, built, target);
  const artifact = merged.artifacts.find((a) => a.target === target);
  // Files first, manifest last: a manifest naming a tarball not yet there is a
  // failed update on every Mac that reads it in between.
  sh('cp', [`${staging}/${artifact.file}`, `${staging}/${artifact.file}.sig`, `${downloads}/`]);
  writeFileSync(`${downloads}/daemon-latest.json.tmp`, `${JSON.stringify(merged, null, 2)}\n`);
  renameSync(`${downloads}/daemon-latest.json.tmp`, `${downloads}/daemon-latest.json`);
  sh('rm', ['-rf', staging]);
  const served = curlJson(`${URL}/api/daemon/daemon-latest.json`);
  const listed = served.artifacts?.find((a) => a.target === target);
  if (served.version !== info.version || listed?.sha256 !== artifact.sha256) {
    throw new Error(`the server is not serving the ${target} build just published`);
  }
  if (!ok('curl', ['-sfI', '-o', '/dev/null', `${URL}/api/daemon/${artifact.file}`])) {
    throw new Error(`${URL}/api/daemon/${artifact.file} is not being served`);
  }
  log(`daemon-mac → published ${target} ${info.version}`);
}

/**
 * THE DESTRUCTIVE STEP. Restarts the host service, dropping every live chat on
 * this host — including the chat that started this deploy. Runs last, and only
 * from a detached process that can outlive it.
 */
function daemonApply(expectedVersion) {
  log(`host → applying ${expectedVersion} (restarts the host, drops live chats)`);
  // Not `|| true`: the output says whether we lost the race with the host's own
  // self-update, and the exit code is not trusted either way — the host restarting
  // under the call looks like a failure too. The version check below is the verdict.
  const update = patchCliCommand(REPO, ['hosts', 'update', '--json']);
  const res = spawnSync(update.cmd, update.args, { encoding: 'utf8' });
  const kind = classifyUpdate(res.stdout, res.status);
  log(updateLine(kind, expectedVersion, res.stdout || res.stderr));
  // A deferred update has not restarted anything yet — it is still holding for
  // this machine's running turns to finish (selfUpdate.ts's own poll), which
  // reads the CURRENT, pre-update host. Checking "back up" / "re-linked"
  // here would just observe that unchanged state and pass at once, so skip
  // straight to waiting out the version, which is the only check that means
  // anything until the hold clears.
  if (kind !== 'deferred') {
    waitFor('host back up', () =>
      ok('sh', ['-c', 'systemctl --user is-active --quiet patch-daemon']),
    );
    waitFor('host re-linked', () =>
      ok('sh', ['-c', `tail -n 200 ${DAEMON_LOG} | grep -q "server-link: authenticated"`]),
    );
  }
  let running;
  try {
    waitFor(
      `host running ${expectedVersion}`,
      () => {
        const get = patchCliCommand(REPO, ['hosts', 'get', '--json']);
        const r = spawnSync(get.cmd, get.args, { encoding: 'utf8' });
        try {
          running = JSON.parse(r.stdout).daemonVersion;
        } catch {
          running = undefined;
        }
        return running === expectedVersion;
      },
      // A deferred update applies itself the moment no turn is left running —
      // and this deploy's own turn is usually one of them, ending as soon as
      // this call returns. 30 minutes, not 2, gives the hold room to clear
      // instead of this deploy declaring failure on an update still correctly
      // in flight.
      kind === 'deferred' ? 900 : 60,
    );
  } catch {
    throw new Error(
      `host is on ${running ?? 'an unknown version'}, not ${expectedVersion} (update call: ${kind})`,
    );
  }
  if (kind !== 'applied') log(`host → already on ${expectedVersion}`);
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
      throw new MacUnreachable(
        `Mac (${MAC_HOST}) unreachable — the mobile surface layer needs an emulator and this box ` +
          'has none. Nothing is wrong with the build; nothing has proved it right either.',
      );
    }
    sh('ssh', [MAC_HOST, macShip('smoke', info.gitSha)]);
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
const APK_STATE = `${DEPLOY_STATE}/apk-fingerprint.json`;

/**
 * A new APK is only needed when the NATIVE layer changes; everything else rides
 * the OTA. So compare the project's native fingerprint against the last one we
 * built and only build when they actually differ.
 *
 * Three ways to build it, and the deploy never picks between them by itself:
 *
 *   default      an EAS cloud build, NOT awaited: free-tier queues have run to
 *                ~4 hours, and a detached follower publishes the APK when it
 *                lands.
 *   --apk-local  a gradle release build on the Mac, over ssh, awaited, then
 *                copied back and published by this run. Free, no quota.
 *   --apk-here   the same gradle build on THIS box, capped (apkHere). For when
 *                the Mac is off and EAS is out of builds; slow, and only when asked.
 *
 * When EAS refuses because the free plan's Android builds are used up, the
 * default lane FAILS and names the other two. It does not switch on its
 * own: that would be a fallback, and a build that went somewhere nobody asked
 * for is exactly the kind of surprise a deploy must not spring.
 */
function apk(info) {
  // What we last built or queued FOR, recorded locally.
  //
  // This used to compare the local fingerprint against the one EAS records on
  // its builds, and those two numbers do not agree: on this box
  // `fingerprint:generate` returns 7723ec5a26ea while every build EAS has —
  // including one queued minutes earlier from the same tree — records
  // 2819346fcbe5. So the comparison could never match, and every deploy queued
  // another Android build. The authority is therefore a local record of what WE
  // built, which cannot disagree with itself. A build that errored or was
  // cancelled does not count, so a genuine failure is retried rather than
  // remembered as done. (Decision: apk-publish.mjs apkBuildDecision.)
  let recorded = null;
  try {
    recorded = JSON.parse(readFileSync(APK_STATE, 'utf8'));
  } catch {
    recorded = null;
  }
  const current = easJson(['fingerprint:generate', '-p', 'android', '--non-interactive']).hash;
  const decision = apkBuildDecision({
    recorded,
    current,
    statusOf: (id) => {
      const recent = easJson([
        'build:list',
        '--platform',
        'android',
        '--limit',
        '10',
        '--non-interactive',
      ]);
      return (Array.isArray(recent) ? recent : []).find((b) => b?.id === id)?.status;
    },
  });
  if (!decision.build) {
    log(`apk → ${decision.why}`);
    return null;
  }
  const builder = apkBuilder(argv);
  if (builder === 'mac') {
    log(`apk → ${decision.why}, building on the Mac (--apk-local)`);
    return apkOnMac(info, current);
  }
  if (builder === 'box') {
    log(`apk → ${decision.why}, building on this box, capped (--apk-here)`);
    return apkHere(info, current);
  }
  log(`apk → ${decision.why}, starting EAS build`);
  linkMobileCredentials();
  let started;
  try {
    started = easJson([
      'build',
      '--platform',
      'android',
      '--profile',
      'preview',
      '--no-wait',
      '--non-interactive',
    ]);
  } catch (err) {
    const said = `${err.message}\n${err.stdout ?? ''}\n${err.stderr ?? ''}`;
    if (easQuotaExhausted(said)) {
      throw new Error(
        "EAS refused the build: the free plan has used this month's Android builds. " +
          'Do not upgrade — build it on the Mac instead, which is free and signs with the same key:\n' +
          '  pnpm run deploy --only=ota,apk --apk-local\n' +
          'or, if the Mac is off, on this box under caps (slow; see deploy.md):\n' +
          '  pnpm run deploy --only=ota,apk --apk-here\n' +
          `(EAS said: ${said.match(/This account has used[^\n]*/)?.[0] ?? 'free plan quota exhausted'})`,
      );
    }
    throw err;
  }
  const id = Array.isArray(started) ? started[0].id : started.id;
  // Recorded BEFORE the follower is detached: if this process dies between the
  // queue and the record, the next deploy queues a duplicate — which is the bug
  // being fixed, so the window is closed as tightly as possible.
  writeFileSync(
    APK_STATE,
    `${JSON.stringify({ fingerprint: current, buildId: id, queuedAt: new Date().toISOString() }, null, 2)}\n`,
  );
  log(`apk → build ${id} queued; a detached follower will publish it`);
  detach([`--follow-apk=${id}`], `apk-${id.slice(0, 8)}`);
  return id;
}

/**
 * Build the release APK on the Mac (scripts/build-apk-local.mjs, in a worktree
 * pinned to this commit), copy it back, and publish it like any other.
 *
 * On the Mac, not here: an uncapped React Native build took
 * this box and everything it serves off the network for half an hour.
 */
function apkOnMac(info, fingerprint) {
  if (!ok('ssh', ['-o', 'ConnectTimeout=10', MAC_HOST, 'true'])) {
    throw new Error(
      `Mac (${MAC_HOST}) unreachable — --apk-local builds there. Wake the Mac, wait for EAS, ` +
        'or build on this box under caps with --apk-here.',
    );
  }
  log(`apk → gradle release build on the Mac (${info.version} / ${info.gitSha})`);
  const built = execFileSync(
    'ssh',
    [
      MAC_HOST,
      macCommand(
        `node scripts/build-apk-local.mjs --version ${info.version} --sha ${info.gitSha} ` +
          `--built-at ${info.builtAt}`,
        info.gitSha,
      ),
    ],
    // Streamed to the log as it happens (stderr) AND captured (stdout), since
    // the path the APK landed at is on stdout.
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 },
  );
  process.stdout.write(built);
  const remote = builtApkPath(built);
  const local = `${DEPLOY_STATE}/apk-incoming-${info.gitSha}.apk`;
  // Pushed FROM the Mac rather than pulled from here: this box reaches the Mac
  // through a reverse tunnel that moves ~120 KB/s (a 96 MB APK in 13 minutes),
  // while the Mac's own route to the box does it in ~20 seconds.
  try {
    sh('ssh', [MAC_HOST, `scp -q ${remote} ${BOX_HOST}:${local}`]);
    if (!existsSync(local))
      throw new Error(`the Mac said it sent ${remote}, but ${local} is not here`);
    return publishGradleBuild({ info, fingerprint, apkPath: local, builtOn: MAC_HOST });
  } finally {
    rmSync(local, { force: true });
    cleanupMacApkTree(remote);
  }
}

/**
 * Once the APK is off the Mac, clean the Mac: the build's android output in the
 * tree it built in, and the Mac's own sweep (deploy-cleanup.mjs, run from that
 * tree so it is the script at the shipped commit).
 */
function cleanupMacApkTree(remote) {
  const tree = remote.slice(0, -(APK_OUTPUT.length + 1));
  try {
    const said = out('ssh', [
      MAC_HOST,
      `bash -lc '${MAC_SHELL} cd ${tree} && node scripts/deploy-cleanup.mjs --current=${tree} --apk-outputs=${tree}'`,
    ]);
    log(`apk → ${said}`);
  } catch (err) {
    const said = String(err.stdout ?? '').trim() || err.message.split('\n')[0];
    cleanupWarnings.push(`Mac after --apk-local: ${said}`);
  }
}

/**
 * Publish a gradle build (Mac or box) and record it as the build for this
 * fingerprint, so the next deploy neither rebuilds it nor looks it up on EAS.
 * Stamps are checked: this machine set them, so the bundle must carry them.
 */
function publishGradleBuild({ info, fingerprint, apkPath, builtOn }) {
  const file = publishApk({
    apkPath,
    gitSha: info.gitSha,
    builtAt: info.builtAt,
    stamps: { version: info.version, gitSha: info.gitSha },
    builtWhere: builtOn === 'box' ? 'this box (--apk-here)' : 'the Mac',
  });
  writeFileSync(
    APK_STATE,
    `${JSON.stringify(
      {
        fingerprint,
        local: true,
        builtOn,
        gitSha: info.gitSha,
        file,
        publishedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

/**
 * Build the release APK on THIS box — only because `--apk-here` asked.
 *
 * The same scripts/build-apk-local.mjs the Mac runs, in the build tree pinned to
 * this commit, wrapped by boxBuildCommand: a systemd scope capped at 5G / 300%
 * CPU, nice 19 + idle IO, gradle at a 3g heap and two workers with no daemon.
 * That is because patch, the bridges and the APK downloads all serve
 * from here, and an uncapped React Native build took them off the network.
 *
 * The build's own output goes to a log of its own (named below) as it happens,
 * so an hour-long cold build can be watched; the `##apk` line is read back from
 * it. The scope is stopped afterwards whatever happened, so nothing the build
 * started outlives it.
 */
function apkHere(info, fingerprint) {
  const unit = `patch-apk-build-${info.gitSha.slice(0, 7)}-${Date.now()}`;
  const logDir = `${DEPLOY_STATE}/logs`;
  mkdirSync(logDir, { recursive: true });
  const buildLog = `${logDir}/${unit}.log`;
  const { cmd, args, env } = boxBuildCommand({
    node: process.execPath,
    script: `${BUILD}/scripts/build-apk-local.mjs`,
    info,
    unit,
    baseGradleOpts: process.env.GRADLE_OPTS,
  });
  log(`apk → gradle release build on this box in scope ${unit} (${info.version} / ${info.gitSha})`);
  log(`apk → build output: ${buildLog}`);
  const started = Date.now();
  try {
    const fd = openSync(buildLog, 'a');
    try {
      execFileSync(cmd, args, {
        cwd: BUILD,
        env: { ...process.env, ...env },
        stdio: ['ignore', fd, fd],
      });
    } catch (err) {
      throw new Error(
        `the box build failed after ${Math.round((Date.now() - started) / 60000)} min ` +
          `(${err.message.split('\n')[0]}) — see ${buildLog}`,
      );
    } finally {
      closeSync(fd);
      // A scope whose processes have all exited is already gone; that is fine.
      ok('systemctl', ['--user', 'stop', `${unit}.scope`]);
    }
    log(`apk → built in ${Math.round((Date.now() - started) / 60000)} min`);
    const apkPath = builtApkPath(readFileSync(buildLog, 'utf8'));
    if (apkPath !== `${BUILD}/${APK_OUTPUT}`) {
      throw new Error(`the box build reported ${apkPath}, not ${BUILD}/${APK_OUTPUT}`);
    }
    return publishGradleBuild({ info, fingerprint, apkPath, builtOn: 'box' });
  } finally {
    // publishApk has copied the APK into downloads by now (or the build is
    // dead): the gigabytes gradle and CMake left in the tree are waste.
    dropApkOutputs(BUILD);
  }
}

/** The newest Android build-tools binary on this box (apksigner, aapt2). */
function buildTool(name) {
  const root = `${process.env.ANDROID_HOME ?? `${process.env.HOME}/Android/sdk`}/build-tools`;
  const versions = existsSync(root)
    ? readdirSync(root).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    : [];
  const bin = versions.length > 0 ? `${root}/${versions[versions.length - 1]}/${name}` : null;
  if (!bin || !existsSync(bin)) {
    throw new Error(`no ${name} under ${root} — cannot check the APK before publishing it`);
  }
  return bin;
}

/**
 * Publish an APK the phone can install. The ONE publish, whichever machine built
 * the APK (followApk for EAS, apkOnMac for the Mac, apkHere for this box).
 *
 * Refuses before anything is visible unless: the APK is signed by the same key
 * as the one live now (Android refuses an update otherwise — on the phone, days
 * later), it is the right package, and — when the caller knows what it stamped —
 * its JS bundle carries this build's version and sha. Then: a filename no
 * previous build has had (Android decides a download is new by its name),
 * `patch.apk` as the stable alias, `android-latest.json`, and proof over the
 * public URL that both are served. Last, Tom's phone is told, because a new APK
 * is the one thing a deploy produces that needs a human to install it.
 *
 * `stamps` is null for an EAS build: the cloud build does not see this
 * machine's EXPO_PUBLIC_* stamps, so its bundle has none to check. The app OTAs
 * into the stamped bundle on first launch.
 */
function publishApk({ apkPath, gitSha, builtAt, stamps, builtWhere }) {
  const downloads = DOWNLOADS;
  const badge = apkBadging(out(buildTool('aapt2'), ['dump', 'badging', apkPath]));
  if (badge.packageName !== 'io.github.tomchambers2.patch') {
    throw new Error(
      `refusing to publish: ${apkPath} is ${badge.packageName}, not io.github.tomchambers2.patch`,
    );
  }
  const apksigner = buildTool('apksigner');
  const live = existsSync(`${downloads}/patch.apk`)
    ? out(apksigner, ['verify', '--print-certs', `${downloads}/patch.apk`])
    : null;
  const signer = signerCheck({
    candidate: out(apksigner, ['verify', '--print-certs', apkPath]),
    live,
  });
  if (!signer.ok) throw new Error(`refusing to publish: ${signer.why}`);
  log(`apk → ${signer.why}`);
  if (stamps) {
    const bundle = verifyApkBundle(apkPath, stamps);
    if (!bundle.ok) throw new Error(`refusing to publish: ${bundle.why}`);
    log(`apk → bundle carries ${stamps.version} / ${stamps.gitSha}`);
  }

  const file = apkFileName(gitSha, (n) => existsSync(`${downloads}/${n}`));
  sh('cp', [apkPath, `${downloads}/${file}`]);
  sh('cp', [`${downloads}/${file}`, `${downloads}/patch.apk`]);
  const manifest = {
    version: badge.versionName,
    gitSha: String(gitSha).slice(0, 7),
    builtAt,
    file,
  };
  writeFileSync(`${downloads}/android-latest.json`, JSON.stringify(manifest, null, 2));

  // Proof, over the URL the phone uses — a file on disk the server does not
  // serve is a build that never arrives.
  const served = curlJson(`${URL}/api/download/android-latest.json`);
  if (served.file !== file) {
    throw new Error(
      `published ${file} but ${URL}/api/download/android-latest.json names ${served.file}`,
    );
  }
  for (const name of [file, 'patch.apk']) {
    if (!ok('curl', ['-sfI', '-o', '/dev/null', `${URL}/api/download/${name}`])) {
      throw new Error(`published ${name} but ${URL}/api/download/${name} does not serve it`);
    }
  }
  prune();
  const link = `${URL}/api/download/${file}`;
  log(
    `apk → published ${badge.versionName} (${manifest.gitSha}, built on ${builtWhere}) at ${link}`,
  );
  notify('Patch: new APK ready', `${badge.versionName} — ${link}`, 'high');
  notifyPhone('Patch: new APK', `Patch ${badge.versionName} — tap to install.`, link);
  return file;
}

/**
 * Wait for a queued EAS build, publish the APK to the box, and tell the phone.
 * Runs as its own detached process so the deploy never blocks on the build queue.
 */
function followApk(buildId) {
  for (;;) {
    const b = easJson(['build:view', buildId]);
    if (b.status === 'FINISHED') {
      const incoming = `${DEPLOY_STATE}/apk-incoming-${buildId}.apk`;
      sh('curl', ['-sfL', '-o', incoming, b.artifacts.applicationArchiveUrl]);
      try {
        publishApk({
          apkPath: incoming,
          gitSha: b.gitCommitHash,
          builtAt: b.completedAt,
          stamps: null,
          builtWhere: `EAS (${easBuildUrl(buildId)})`,
        });
      } finally {
        rmSync(incoming, { force: true });
      }
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
function macCommand(command, sha) {
  if (command.includes("'")) throw new Error(`macCommand cannot carry a single quote: ${command}`);
  return (
    `bash -lc '${MAC_SHELL} cd ${MAC_REPO} && git fetch origin --quiet && ` +
    `cd "$(node scripts/build-tree.mjs ${sha})" && ` +
    `corepack pnpm install --frozen-lockfile --silent && ` +
    `${command}'`
  );
}
const macShip = (surface, sha) =>
  macCommand(`node scripts/ship.mjs --only=${surface} --foreground`, sha);

/**
 * macOS only — the Electron shell must be codesigned, and Squirrel refuses to
 * apply an update to an adhoc-signed app. From the box this is driven over ssh.
 */
function desktop(info) {
  if (!onMac()) {
    log('desktop → delegating to the Mac over ssh');
    if (!ok('ssh', ['-o', 'ConnectTimeout=10', MAC_HOST, 'true'])) {
      throw new MacUnreachable(
        `Mac (${MAC_HOST}) unreachable — the desktop shell cannot be built anywhere else.`,
      );
    }
    sh('ssh', [MAC_HOST, macShip('desktop', info.gitSha)]);
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
  // The app carries this Mac's host build (stage-resources.cjs refuses to package
  // without dist/daemon), so it is built first, here, from the same commit.
  const home = process.env.HOME;
  sh('pnpm', ['build:daemon'], {
    env: {
      ...env,
      PATCH_BUILD_VENDOR: `${home}/.patch-daemon-build/vendor`,
      PATCH_ARTIFACT_SIGNING_KEY: `${home}/.patch-daemon-build/artifact-signing.key`,
      PATCH_CODESIGN_IDENTITY: CSC_NAME,
      PATCH_BUILD_TARGETS: 'darwin-arm64',
    },
  });
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
  if (/Signature=adhoc/.test(sig) || !/Identifier=io\.github\.tomchambers2\.patch/.test(sig)) {
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
  const dest = `${BOX_HOST}:${DOWNLOADS}`;
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
    console.log(out('node', ['scripts/prune-downloads.mjs', DOWNLOADS]));
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
  const dir = `${DEPLOY_STATE}/logs`;
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
  // A follower is a deploy run of its own, and cleans up like one — after it
  // publishes or fails. Its own tree becomes collectible once it has exited.
  try {
    followApk(val('follow-apk'));
  } finally {
    cleanupOnce();
  }
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
    baseline = JSON.parse(readFileSync(`${SERVER_HOME}/current/build-info.json`, 'utf8')).web
      ?.gitSha;
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

/** Single-quote a string for `bash -lc`. */
function shq(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

/**
 * Publish what this Mac is asking to ship, so the box can actually ship it.
 *
 * The decision itself lives in deploy-target.mjs, where it can be asserted
 * without deploying anything; this only carries it out.
 */
function publishForBoxDeploy() {
  sh('git', ['fetch', 'origin', 'main', '--quiet']);
  const head = out('git', ['rev-parse', 'HEAD']);
  const origin = out('git', ['rev-parse', 'origin/main']);
  const plan = publishPlan({
    head,
    origin,
    originIsAncestorOfHead: ok('git', ['merge-base', '--is-ancestor', origin, head]),
    headIsAncestorOfOrigin: ok('git', ['merge-base', '--is-ancestor', head, origin]),
    dirty: out('git', ['status', '--porcelain', '--untracked-files=no']),
  });
  for (const note of plan.notes) log(`NOTE: ${note}`);
  if (plan.action === 'refuse') {
    throw new Error(
      `Refusing to deploy: this checkout has diverged from origin/main, so it is not clear ` +
        `what you mean to ship.\nOnly here:\n${out('git', ['log', '--oneline', `${origin}..HEAD`])}\n` +
        `Rebase onto origin/main (git pull --rebase) and run it again.`,
    );
  }
  if (plan.action === 'push') {
    log('pushing local commits so the box can ship them');
    sh('git', ['push', 'origin', 'HEAD:main']);
  }
  return plan.sha;
}

/**
 * Run the deploy on the box, from the Mac.
 *
 * A thin remote trigger on purpose. The box already knows how to deploy — the
 * lock, the pinned tree, the gate, the systemd restarts, and delegating the
 * signed desktop shell back to this Mac over ssh — and a second, ssh-shaped copy
 * of any of that here would be two descriptions of one process, drifting apart.
 * So the Mac publishes the commit and hands over.
 */
function deployOnBox() {
  log(`this is a Mac — the live stack runs on ${BOX_HOST}, so the deploy runs there`);
  if (!ok('ssh', ['-o', 'ConnectTimeout=10', BOX_HOST, 'true'])) {
    throw new Error(
      `${BOX_HOST} is unreachable, and it is the only machine that can deploy: the server and ` +
        `host are systemd units there, installed under ${SERVER_HOME} and ~/.patch. ` +
        `Check your ssh config and network, then run it again.`,
    );
  }
  publishForBoxDeploy();
  // Forward the caller's own flags verbatim, so `--only=web`, `--foreground` and
  // anything added later behave identically wherever they are typed.
  const forwarded = argv.map(shq).join(' ');
  sh('ssh', [BOX_HOST, `bash -lc ${shq(`cd ${BOX} && pnpm run deploy ${forwarded}`)}`]);
}

const only = val('only');
// Where an APK would be built — checked now, so conflicting flags fail before
// the gate rather than an hour into a deploy.
apkBuilder(argv);
// A lane child: the parent has already pinned the build tree, rebuilt the
// workspace libs and run the gate, so this process does its surfaces and
// nothing else. Never passed by hand.
const prepared = flag('prepared');
// Provisional until the commit is resolved: an explicit --only is authoritative,
// and without one we assume EVERY surface so the detach decision below (which
// runs before the sha is known) stays conservative. `surfacesForDiff` narrows it
// once there is a sha to diff.
// The server and the hosts always ship together (deploy-scope.mjs
// § LOCKSTEP), so `--only=server` also publishes and applies the host. Exempt:
// a lane child, whose parent already widened the scope and split it into lanes,
// and the Mac, which only ever runs the one sub-step the box handed it (a deploy
// TYPED on the Mac is forwarded to the box verbatim and widened there).
let wanted = only ? only.split(',') : ALL_SURFACES;
if (!prepared && !onMac()) wanted = withLockstep(wanted);
const want = (s) => wanted.includes(s);

// A deploy typed on a Mac runs on the box (deploy-target.mjs). This sits
// ABOVE the detach below deliberately: the box detaches its own run and reports
// the log path, so detaching here too would leave a backgrounded Mac process
// waiting on an ssh that has already returned.
if (deployTarget({ platform: process.platform, only, prepared }) === 'box') {
  deployOnBox();
  process.exit(0);
}

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

// From here this process is a deploy run on this machine (a lane child is part
// of its parent's run and leaves the cleanup to it). Whatever ends it — the
// summary below, a refused gate, an uncaught throw — the machine is cleaned.
if (!prepared) process.on('exit', () => cleanupOnce());

requireExternalTools();
if (!onMac()) mkdirSync(DEPLOY_STATE, { recursive: true });
// The Mac is a SUB-STEP of a deploy that already resolved the commit and checked
// it out over ssh, so it builds in place; the box pins a build tree to the commit.
// A lane child inherits the tree the parent pinned; re-resolving would re-sync
// the checkout under three siblings mid-build.
const shipSha = onMac() || prepared ? out('git', ['rev-parse', 'HEAD']) : resolveShipCommit();
// Record the tree this deploy builds in, so cleanup does not sweep it from
// under us. NOT a lock — a concurrent deploy is allowed and simply builds in
// its own tree (see deploy-lock.mjs). Not on the Mac (a sub-step that builds in
// place) and not in a lane child (it inherits its parent's tree).
if (!onMac() && !prepared) {
  recordDeployTree({ path: DEPLOY_LOCK, sha: shipSha, tree: BUILD_TREE });
}
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
if (!only && !onMac()) wanted = withLockstep(surfacesForDiff(shipSha));
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
    // Built for the newest commit, so whatever the Mac owed for it is paid.
    if (!onMac() && MAC_SURFACES.includes(name)) settle(MAC_PENDING, name);
    return result;
  } catch (err) {
    // Nothing was tried: the Mac was not there. That is work owed, not work
    // that failed, so it is recorded for mac-catch-up.mjs and does not fail the
    // deploy. Anything that goes wrong while the Mac IS reachable still does.
    if (err instanceof MacUnreachable) {
      addPending(MAC_PENDING, name, info.gitSha);
      console.log(`\n  PENDING ${name}: ${err.message}`);
      return undefined;
    }
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
  // One release carries both: `server` builds the server and the SPA, `web`
  // alone rebuilds the SPA around the running server (see release()).
  let bundle;
  if (want('web') || want('server')) {
    bundle = await surface(want('server') ? 'server' : 'web', () => release(info));
    if (bundle) shipped.add('web');
  }
  // Serving the new bundle is the other half of shipping web, but it can only be
  // checked once the server that serves it has restarted.
  if (bundle) {
    try {
      verifyWeb(bundle);
    } catch (err) {
      console.error(`\n  FAILED web: ${err.message}`);
      failures.push(`web: ${err.message.split('\n')[0]}`);
      shipped.delete('web');
    }
  }
  daemonVersion = (await surface('daemon', () => daemonPublish())) ?? null;
  await surface('daemon-mac', () => daemonMac(info));
  await surface('ota', () => ota(info));
  await surface('apk', () => apk(info));
  await surface('desktop', () => desktop(info));
  await surface('smoke', () => smoke(info));
  // Clearing superseded host artifacts belongs with the host, not to every
  // lane that happens to be running.
  if (!onMac() && want('daemon')) prune();
  // The host restart can take this whole process tree down with it (see the
  // lanes below), so clean up BEFORE it rather than after.
  if (daemonVersion && want('apply') && !prepared && !onMac()) cleanupOnce();
  if (daemonVersion) await surface('apply', () => daemonApply(daemonVersion));
  // A lane child reports what it managed upward; the parent cannot see this
  // process's `shipped` set, and marking a whole lane failed because one of its
  // surfaces was would hide the one that worked.
  if (prepared) {
    console.log(
      `##lane ${JSON.stringify({ shipped: [...shipped], daemonVersion, cleanupWarnings })}`,
    );
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
            // laneArgs forwards the flags a lane must honour (--apk-local,
            // --apk-here); it once dropped them, and a full deploy asked to
            // build on the Mac queued an EAS build instead.
            [`${BUILD}/scripts/ship.mjs`, ...laneArgs(surfaces, argv)],
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
      const { shipped: got, daemonVersion: v, cleanupWarnings: warned } = JSON.parse(reported[1]);
      for (const sfc of got) shipped.add(sfc);
      if (v) daemonVersion = v;
      cleanupWarnings.push(...(warned ?? []));
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
  // `daemon` (with `apply`) runs LAST, on its own, after every other lane has
  // already finished — never concurrently with them. `apply` restarts
  // patch-daemon.service, and this whole detached process tree lives inside
  // that service's systemd cgroup (re-exec/setsid detaches from the terminal
  // and the launching chat's process group, not from the cgroup a restart
  // tears down). Racing it against `box` used to let the restart kill this
  // process — and everything still in flight under it — before `web`/`server`
  // had finished and reported, leaving the host on the new commit and the
  // server silently stuck on the old one (2026-09-17). Running it after
  // everything else has resolved means the one surface capable of taking this
  // process down with it is the one surface left with nothing more to lose.
  const daemonLane = lanesToRun.filter(([name]) => name === 'daemon');
  const otherLanes = lanesToRun.filter(([name]) => name !== 'daemon');
  if (otherLanes.length > 0) await runLanes(otherLanes);
  // Clean up before the lane that can kill this process, not after it.
  if (daemonLane.length > 0) cleanupOnce();
  if (daemonLane.length > 0) await runLanes(daemonLane);
}

if (prepared) process.exit(failures.length ? 1 : 0);

if (onMac()) {
  cleanupOnce();
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

// Cleanup is reported IN the summary but never decides it: a ship that worked
// and a directory that would not delete are two separate facts.
const cleaned = cleanupOnce();
if (failures.length) {
  const detail = `shipped: ${[...shipped].join(', ') || 'nothing'}\n${failures.join('\n')}\n${cleaned}`;
  console.error(`\nDEPLOY FAILED\n${detail}`);
  notify('Patch deploy FAILED', `${info.version} / ${info.gitSha}\n${detail}`, 'high');
  process.exit(1);
}
console.log(`\n${cleaned}`);
const owed = describePending(readPending(MAC_PENDING));
if (owed) console.log(`\n${owed}`);
notify(
  cleaned.startsWith('CLEANUP FAILED') ? 'Patch deployed (cleanup FAILED)' : 'Patch deployed',
  `${info.version} / ${info.gitSha}\n${summary}\n${cleaned}${owed ? `\n${owed}` : ''}`,
);
log('done');
