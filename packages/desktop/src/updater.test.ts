// Unit tests for the desktop shell's update state machine.
//
// The shipped app's updater had never run once, for four independent reasons, none
// of them visible from inside the app. `diagnoseUpdater` is the fix for the
// invisibility: each historical breakage must produce a specific sentence a user
// can act on. The reducer tests then pin the rule that matters most — a failed
// check is never reported as "up to date".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diagnoseUpdater,
  emptyPersisted,
  initialUpdaterState,
  INSTALL_WATCHDOG_MS,
  parsePersisted,
  persistedOf,
  quitAndInstallNow,
  reduceUpdater,
  updateUrgency,
  URGENCY_DUE_MS,
  URGENCY_OVERDUE_MS,
  type UpdaterEvent,
  type UpdaterState,
} from './updater';

const AT = '2026-07-28T12:00:00.000Z';

/** A live, updatable shell — the baseline the reducer cases start from. */
function state(): UpdaterState {
  return initialUpdaterState({
    currentVersion: '0.1.317',
    gitSha: '9b8635f',
    builtAt: '2026-07-28T10:00:00.000Z',
    feedUrl: 'https://patch.tomchambers.me/api/desktop/',
    disabledReason: null,
    persisted: emptyPersisted(),
  });
}

// --- diagnoseUpdater: the four real breakages ------------------------------

test('a dev run cannot self-update, and says so', () => {
  const why = diagnoseUpdater({
    isPackaged: false,
    hasUpdateConfig: false,
    version: '0.1.317',
    signed: true,
  });
  assert.match(String(why), /pnpm dev/);
});

test('a --dir build has no app-update.yml — the exact reason the shipped app never checked', () => {
  const why = diagnoseUpdater({
    isPackaged: true,
    hasUpdateConfig: false,
    version: '0.1.317',
    signed: true,
  });
  assert.match(String(why), /app-update\.yml/);
  assert.match(String(why), /dist:dry|--dir/);
});

test('version 0.0.0 can never compare as older than a release', () => {
  const why = diagnoseUpdater({
    isPackaged: true,
    hasUpdateConfig: true,
    version: '0.0.0',
    signed: true,
  });
  assert.match(String(why), /0\.0\.0/);
});

test('an adhoc-signed build is told it can check and download but not install', () => {
  // Measured against the real feed: an adhoc build downloads the update and then
  // fails Squirrel's signature validation. Verified that a SELF-SIGNED cert is
  // sufficient — the designated requirement carries no `anchor apple` clause — so
  // the message must not claim a Developer ID is required (spec/11 § Desktop code
  // signing).
  const why = diagnoseUpdater({
    isPackaged: true,
    hasUpdateConfig: true,
    version: '0.1.317',
    signed: false,
  });
  assert.match(String(why), /adhoc/);
  assert.match(String(why), /same code-signing certificate/);
  assert.match(String(why), /not necessarily an Apple Developer ID/);
});

test('a properly packaged, versioned, signed build is not disabled', () => {
  assert.equal(
    diagnoseUpdater({
      isPackaged: true,
      hasUpdateConfig: true,
      version: '0.1.317',
      signed: true,
    }),
    null,
  );
});

test('breakages are reported in the order a user hits them', () => {
  // Unpackaged AND unversioned AND unsigned → the unpackaged reason wins, because
  // fixing anything else first would change nothing.
  const why = diagnoseUpdater({
    isPackaged: false,
    hasUpdateConfig: false,
    version: '0.0.0',
    signed: false,
  });
  assert.match(String(why), /pnpm dev/);
});

// --- the reducer ----------------------------------------------------------

test('a check in flight keeps the previous result visible', () => {
  const s = reduceUpdater(
    { ...state(), lastResult: 'up-to-date', lastCheckedAt: AT },
    { type: 'check-started' },
  );
  assert.equal(s.checking, true);
  assert.equal(s.lastResult, 'up-to-date', 'blanking it would look like "never checked"');
  assert.equal(s.lastCheckedAt, AT);
});

test('up-to-date records the check time and clears any prior availability', () => {
  const s = reduceUpdater(
    { ...state(), availableVersion: '0.1.318', downloaded: true },
    { type: 'up-to-date', at: AT },
  );
  assert.equal(s.lastResult, 'up-to-date');
  assert.equal(s.lastCheckedAt, AT);
  assert.equal(s.availableVersion, null);
  assert.equal(s.downloaded, false);
  assert.equal(s.checking, false);
});

test('an available update records the offered version', () => {
  const s = reduceUpdater(state(), { type: 'available', version: '0.1.318', at: AT });
  assert.equal(s.lastResult, 'update-available');
  assert.equal(s.availableVersion, '0.1.318');
  assert.equal(s.downloaded, false);
});

test('a downloaded update becomes installable', () => {
  const s = reduceUpdater(state(), { type: 'downloaded', version: '0.1.318', at: AT });
  assert.equal(s.lastResult, 'downloaded');
  assert.equal(s.downloaded, true);
  assert.equal(s.availableVersion, '0.1.318');
});

test('a FAILED check is never reported as up to date', () => {
  // The whole point: "I checked, nothing new" and "I could not check" must be
  // distinguishable. The old code swallowed the error entirely.
  const s = reduceUpdater(state(), { type: 'error', message: 'ENOTFOUND feed', at: AT });
  assert.equal(s.lastResult, 'error');
  assert.equal(s.lastError, 'ENOTFOUND feed');
  assert.equal(s.checking, false);
  assert.notEqual(s.lastResult, 'up-to-date');
});

test('an error after a successful download leaves the update installable', () => {
  const downloaded = reduceUpdater(state(), {
    type: 'downloaded',
    version: '0.1.318',
    at: AT,
  });
  const errored = reduceUpdater(downloaded, {
    type: 'error',
    message: 'could not get code signature for running application',
    at: AT,
  });
  assert.equal(errored.downloaded, true, 'a downloaded update is still on disk');
  assert.equal(errored.availableVersion, '0.1.318');
  assert.equal(errored.lastResult, 'error');
});

// --- persistence ---------------------------------------------------------

test('last-checked survives a relaunch', () => {
  const s = reduceUpdater(state(), { type: 'up-to-date', at: AT });
  const round = parsePersisted(JSON.stringify(persistedOf(s)));
  assert.equal(round.lastCheckedAt, AT);
  assert.equal(round.lastResult, 'up-to-date');
});

test('a corrupt state file reads as "never checked", not a fabricated time', () => {
  const p = parsePersisted('{oops');
  assert.equal(p.lastCheckedAt, null);
  assert.equal(p.lastResult, null);
});

test('a state file with junk fields is sanitised rather than trusted', () => {
  const p = parsePersisted(
    JSON.stringify({
      lastCheckedAt: 42,
      lastResult: 'nonsense',
      lastError: {},
      availableVersion: 7,
    }),
  );
  assert.equal(p.lastCheckedAt, null);
  assert.equal(p.lastResult, null);
  assert.equal(p.lastError, null);
  assert.equal(p.availableVersion, null);
});

test('initial state does not claim a downloaded update survived a relaunch', () => {
  const s = initialUpdaterState({
    currentVersion: '0.1.317',
    gitSha: '9b8635f',
    builtAt: null,
    feedUrl: null,
    disabledReason: null,
    persisted: {
      lastCheckedAt: AT,
      lastResult: 'downloaded',
      lastError: null,
      availableVersion: '0.1.318',
      staleSince: AT,
    },
  });
  assert.equal(s.downloaded, false, 'the downloaded file is not re-verified on boot');
  assert.equal(s.staleSince, AT, 'but being BEHIND does survive — same build, same lag');
  assert.equal(s.lastCheckedAt, AT, 'but the check history is preserved');
});

test('initial state carries the disabled reason through to the panel', () => {
  const s = initialUpdaterState({
    currentVersion: '0.0.0',
    gitSha: null,
    builtAt: null,
    feedUrl: null,
    disabledReason: 'no app-update.yml',
    persisted: emptyPersisted(),
  });
  assert.equal(s.disabledReason, 'no app-update.yml');
  assert.equal(s.checking, false);
});

// --- quit-and-install ---------------------------------------------------
//
// Regression: "restart to install" closed the window and left the shell running
// on the OLD build. quitAndInstall() closes every window and then quits, but
// main.ts's `close` handler preventDefault()s any close it hasn't been told is a
// real quit (Cmd+W hides; the tray app lives on), so the window hid, no window
// ever closed, and the quit never arrived.

test('quitAndInstallNow marks the app as quitting BEFORE asking the updater to quit', () => {
  const app = { isQuitting: false };
  const seen: Array<{ isQuitting: boolean; args: [boolean, boolean] }> = [];
  quitAndInstallNow({
    app,
    autoUpdater: {
      quitAndInstall: (isSilent, isForceRunAfter) =>
        seen.push({ isQuitting: app.isQuitting, args: [isSilent, isForceRunAfter] }),
    },
    onError: (err) => assert.fail(`unexpected install failure: ${err.message}`),
  });
  assert.deepEqual(
    seen,
    [{ isQuitting: true, args: [false, true] }],
    'without the flag the close handler hides the window and swallows the quit',
  );
});

test('quitAndInstallNow force-relaunches so the user gets the app back', () => {
  const app = { isQuitting: false };
  let args: [boolean, boolean] | null = null;
  quitAndInstallNow({
    app,
    autoUpdater: {
      quitAndInstall: (isSilent, isForceRunAfter) => (args = [isSilent, isForceRunAfter]),
    },
    onError: (err) => assert.fail(`unexpected install failure: ${err.message}`),
  });
  assert.deepEqual(args, [false, true], 'isForceRunAfter must be true, or the shell just dies');
  assert.equal(app.isQuitting, true, 'the flag stays set through the quit');
});

test('a refused install is surfaced verbatim, not swallowed', () => {
  // Squirrel.Mac refuses to apply an update to an adhoc-signed build, throwing
  // out of quitAndInstall. With the "restart to install" prompt gone, the
  // panel's error line is the ONLY place that can reach the user.
  const app = { isQuitting: false };
  const errors: string[] = [];
  quitAndInstallNow({
    app,
    autoUpdater: {
      quitAndInstall: () => {
        throw new Error('Could not get code signature for running application');
      },
    },
    onError: (err) => errors.push(err.message),
  });
  assert.deepEqual(errors, ['Could not get code signature for running application']);
  assert.equal(app.isQuitting, false, 'a failed install must not leave Cmd+W quitting the app');
});

// --- the stall watchdog: quitAndInstall() can return cleanly and still never
// quit. Found live — Squirrel.Mac's ShipIt helper took the install request,
// took a FileCoordination claim, and then wedged: no error, no relaunch, the
// old process just kept running. Nothing reported that as a failure, so
// "Restart now" looked like a dead button. -----------------------------

test('a quitAndInstall that returns but never actually quits is reported once the watchdog elapses', () => {
  const app = { isQuitting: false };
  const errors: string[] = [];
  let firedAfter: number | null = null;
  quitAndInstallNow({
    app,
    autoUpdater: { quitAndInstall: () => {} }, // returns cleanly; process just... stays up.
    onError: (err) => errors.push(err.message),
    setTimer: (fn, ms) => {
      firedAfter = ms;
      fn(); // simulate the watchdog elapsing, as it would in a real stalled install
      return {};
    },
  });
  assert.equal(firedAfter, INSTALL_WATCHDOG_MS);
  assert.deepEqual(errors, [
    'Restart did not finish — Patch is still running the old build. Quit it by hand (⌘Q) and reopen it.',
  ]);
  assert.equal(app.isQuitting, false, 'a stalled install must not leave Cmd+W quitting the app');
});

test('a real relaunch never lets the watchdog speak', () => {
  // The process that would fire this timer is the one that just exited, so in
  // the success case the scheduled callback is simply never invoked — this
  // pins that quitAndInstallNow does not call onError up front regardless.
  const app = { isQuitting: false };
  quitAndInstallNow({
    app,
    autoUpdater: { quitAndInstall: () => {} },
    onError: () => assert.fail('a healthy install must not report an error before its watchdog'),
    setTimer: () => ({}), // captured but never invoked, exactly as a real exit would leave it
  });
  assert.equal(app.isQuitting, true);
});

// --- escalation: the shell no longer restarts itself, so "how long have you
// been behind" is the only pressure the user ever feels. -------------------

test('a shell that is not behind has no urgency at all', () => {
  assert.equal(updateUrgency(null, Date.now()), 'none');
});

test('freshly behind is the quiet level', () => {
  const now = Date.parse('2026-09-17T12:00:00Z');
  assert.equal(updateUrgency('2026-09-17T11:00:00Z', now), 'ready');
});

test('escalates to due at 8 hours, and overdue at 3 days', () => {
  const now = Date.parse('2026-09-17T12:00:00Z');
  assert.equal(updateUrgency(new Date(now - URGENCY_DUE_MS + 1000).toISOString(), now), 'ready');
  assert.equal(updateUrgency(new Date(now - URGENCY_DUE_MS).toISOString(), now), 'due');
  assert.equal(updateUrgency(new Date(now - URGENCY_OVERDUE_MS + 1000).toISOString(), now), 'due');
  assert.equal(updateUrgency(new Date(now - URGENCY_OVERDUE_MS).toISOString(), now), 'overdue');
});

test('an unparseable staleSince still shows the banner, at its quietest', () => {
  // Never silently "not stale": we know the shell is behind, we just cannot age
  // it. Going silent here would hide a real pending update.
  assert.equal(updateUrgency('not-a-date', Date.now()), 'ready');
});

test('a second update does NOT restart the staleness clock', () => {
  // The bug this prevents: Patch ships ~20x/day, so a clock reset per download
  // can never age past a few minutes and the banner would never escalate.
  let s = initialUpdaterState({
    currentVersion: '0.1.900',
    gitSha: null,
    builtAt: null,
    feedUrl: 'https://example.invalid/feed',
    disabledReason: null,
    persisted: emptyPersisted(),
  });
  s = reduceUpdater(s, { type: 'available', version: '0.1.901', at: '2026-09-14T09:00:00Z' });
  s = reduceUpdater(s, { type: 'downloaded', version: '0.1.901', at: '2026-09-14T09:01:00Z' });
  // …a day and twenty deploys later…
  s = reduceUpdater(s, { type: 'available', version: '0.1.921', at: '2026-09-15T09:00:00Z' });
  s = reduceUpdater(s, { type: 'downloaded', version: '0.1.921', at: '2026-09-15T09:01:00Z' });

  assert.equal(s.staleSince, '2026-09-14T09:00:00Z');
  assert.equal(s.availableVersion, '0.1.921', 'but the OFFERED version is the newest');
  assert.equal(updateUrgency(s.staleSince, Date.parse('2026-09-17T10:00:00Z')), 'overdue');
});

test('being up to date clears the clock, so the next lapse starts fresh', () => {
  let s = initialUpdaterState({
    currentVersion: '0.1.900',
    gitSha: null,
    builtAt: null,
    feedUrl: 'https://example.invalid/feed',
    disabledReason: null,
    persisted: emptyPersisted(),
  });
  s = reduceUpdater(s, { type: 'available', version: '0.1.901', at: '2026-09-14T09:00:00Z' });
  assert.equal(s.staleSince, '2026-09-14T09:00:00Z');
  s = reduceUpdater(s, { type: 'up-to-date', at: '2026-09-14T10:00:00Z' });
  assert.equal(s.staleSince, null);
  assert.equal(updateUrgency(s.staleSince, Date.now()), 'none');
});

test('a failed check does not clear a pending update or its clock', () => {
  // An update already on disk stays installable, and stays aged — a flaky feed
  // must not quietly reset the nag to zero.
  let s = initialUpdaterState({
    currentVersion: '0.1.900',
    gitSha: null,
    builtAt: null,
    feedUrl: 'https://example.invalid/feed',
    disabledReason: null,
    persisted: emptyPersisted(),
  });
  s = reduceUpdater(s, { type: 'downloaded', version: '0.1.901', at: '2026-09-14T09:00:00Z' });
  s = reduceUpdater(s, { type: 'error', message: 'ENOTFOUND', at: '2026-09-16T09:00:00Z' });
  assert.equal(s.downloaded, true);
  assert.equal(s.staleSince, '2026-09-14T09:00:00Z');
});

test('staleness survives a relaunch — the same build is still behind', () => {
  // Quitting and reopening Patch for some unrelated reason is not an install,
  // so it must not look like one and reset the nag.
  const persisted = parsePersisted(
    JSON.stringify({
      lastCheckedAt: '2026-09-14T09:00:00Z',
      lastResult: 'downloaded',
      lastError: null,
      availableVersion: '0.1.901',
      staleSince: '2026-09-14T09:00:00Z',
    }),
  );
  const s = initialUpdaterState({
    currentVersion: '0.1.900',
    gitSha: null,
    builtAt: null,
    feedUrl: 'https://example.invalid/feed',
    disabledReason: null,
    persisted,
  });
  assert.equal(s.staleSince, '2026-09-14T09:00:00Z');
  assert.equal(updateUrgency(s.staleSince, Date.parse('2026-09-17T10:00:00Z')), 'overdue');
});

test('persisted state written back carries the clock', () => {
  let s = initialUpdaterState({
    currentVersion: '0.1.900',
    gitSha: null,
    builtAt: null,
    feedUrl: 'https://example.invalid/feed',
    disabledReason: null,
    persisted: emptyPersisted(),
  });
  s = reduceUpdater(s, { type: 'downloaded', version: '0.1.901', at: '2026-09-14T09:00:00Z' });
  assert.equal(persistedOf(s).staleSince, '2026-09-14T09:00:00Z');
});

test('older persisted state (no staleSince) parses as not-behind rather than throwing', () => {
  const persisted = parsePersisted(
    JSON.stringify({ lastCheckedAt: '2026-09-14T09:00:00Z', lastResult: 'up-to-date' }),
  );
  assert.equal(persisted.staleSince, null);
});

test('an app that runs its own server has no feed to update from, and says so', () => {
  const reason = diagnoseUpdater({
    isPackaged: true,
    hasUpdateConfig: true,
    version: '0.1.5',
    signed: true,
    noFeedReason: 'This app runs its own server, so it has no feed to update from.',
  });
  assert.equal(reason, 'This app runs its own server, so it has no feed to update from.');
});

// "Patch sometimes locks up, maybe after an update" (Todoist 6hh3QMg45hVwMxp6).
// `await autoUpdater.checkForUpdates()` had no time limit: a feed that never
// answered left `checking: true` for good and the panel's "Check now" awaiting
// forever, and every hourly re-check piled another call on top.
test('createCheckRunner: a check that never answers ends as a recorded error, not a hang', async () => {
  const { createCheckRunner } = await import('./updater');
  const events: UpdaterEvent[] = [];
  const run = createCheckRunner({
    start: () => events.push({ type: 'check-started' }),
    record: (e) => events.push(e),
    check: () => new Promise<void>(() => {}),
    hasOutcomeSinceStart: () => false,
    timeoutMs: 30,
  });
  await run();
  const last = events[events.length - 1];
  assert.equal(last?.type, 'error');
  assert.match((last as { message: string }).message, /timed out/);
});

test('createCheckRunner: overlapping calls join one check', async () => {
  const { createCheckRunner } = await import('./updater');
  let calls = 0;
  let release!: () => void;
  const run = createCheckRunner({
    start: () => {},
    record: () => {},
    check: () => {
      calls += 1;
      return new Promise<void>((r) => (release = r));
    },
    hasOutcomeSinceStart: () => true,
    timeoutMs: 1000,
  });
  const a = run();
  const b = run();
  release();
  await Promise.all([a, b]);
  assert.equal(calls, 1);
});

test('createCheckRunner: a check that resolves silently is an error, never up to date', async () => {
  const { createCheckRunner } = await import('./updater');
  const events: UpdaterEvent[] = [];
  const run = createCheckRunner({
    start: () => {},
    record: (e) => events.push(e),
    check: async () => {},
    hasOutcomeSinceStart: () => false,
    timeoutMs: 1000,
  });
  await run();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'error');
});
