// The judgement inside the Android surface smoke (scripts/mobile-surface-smoke.mjs).
//
// The device half needs a device; this covers the half that decides pass or
// fail, and the cases here are the ones the real bugs walked through: a screen
// that renders NOTHING (no crash, no exception, no exit code — just no text),
// a logcat full of render-loop errors that no step was looking for, and — the
// reason the judgement was rewritten — a harness that could only ask "is this
// string on screen", so a renamed tab and a genuinely dead app were the same
// verdict. Nothing here names a screen of the app: every assertion has to hold
// for any version of it.
//
// Run: node scripts/mobile-surface-smoke.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  runningVersion,
  LOG_INVARIANTS,
  MIN_TEXTS_PER_SCREEN,
  MIN_TEXTS_SOMEWHERE,
  scanLog,
  pairingLink,
  deviceArg,
  visibleText,
  findTap,
  discoverNav,
  openDestination,
  openSettled,
  judgeScreen,
  judgeWalk,
  pickAvd,
  uninstallLoop,
  splitDevices,
  foregroundPackage,
  DEDICATED_AVD,
  runAdb,
  ADB_TIMEOUT_MS,
} from './mobile-surface-smoke.mjs';

const node = (attrs) => `<node ${attrs} />`;

const screenful = (n, prefix = 'row') => Array.from({ length: n }, (_, i) => `${prefix} ${i}`);

test('a blank render fails, and says it was blank rather than naming a missing string', () => {
  const verdict = judgeScreen('chats', []);
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /NO text at all/);
});

test('a nearly-blank screen fails too — one stray label is not a painted screen', () => {
  const verdict = judgeScreen('chats', ['Chats']);
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /blank render/);
});

// The whole point of the rewrite: renaming things must not fail the smoke.
test('a screen passes on CONTENT, never on particular words — a rename cannot fail it', () => {
  assert.equal(judgeScreen('x', ['Chats', 'Settings', 'New chat']).ok, true);
  assert.equal(judgeScreen('x', ['Threads', 'Preferences', 'Start something']).ok, true);
});

test('duplicates do not count towards a screen being painted', () => {
  const verdict = judgeScreen('x', ['Chats', 'Chats', 'Chats', 'Chats']);
  assert.equal(verdict.ok, false);
});

test('a generic error screen fails, and quotes the line that gave it away', () => {
  const verdict = judgeScreen('chats', ['Chats', 'Something went wrong', 'Retry']);
  assert.equal(verdict.ok, false);
  assert.match(verdict.why, /error screen/);
  assert.match(verdict.why, /Something went wrong/);
});

test('the threshold is the exported constant, so the rule is stated once', () => {
  assert.equal(judgeScreen('x', screenful(MIN_TEXTS_PER_SCREEN)).ok, true);
  assert.equal(judgeScreen('x', screenful(MIN_TEXTS_PER_SCREEN - 1)).ok, false);
});

test('discovers the navigation from the bottom of the screen, left to right', () => {
  const xml = [
    node('text="some chat" bounds="[0,200][1080,300]"'),
    node('content-desc="Settings" bounds="[800,2200][1000,2300]"'),
    node('content-desc="Chats" bounds="[100,2200][300,2300]"'),
    node('content-desc="New chat" bounds="[400,2200][600,2300]"'),
  ].join('');
  assert.deepEqual(
    discoverNav(xml).map((n) => n.label),
    ['Chats', 'New chat', 'Settings'],
  );
});

// A renamed or added tab is covered without anyone touching this file, which is
// the property the old hardcoded journey did not have.
test('a renamed tab is still discovered — nothing here knows what tabs are called', () => {
  const xml = [
    node('content-desc="Threads" bounds="[100,2200][300,2300]"'),
    node('content-desc="Inbox" bounds="[400,2200][600,2300]"'),
  ].join('');
  assert.deepEqual(
    discoverNav(xml).map((n) => n.label),
    ['Threads', 'Inbox'],
  );
});

test('content above the nav band is not mistaken for navigation', () => {
  const xml = [
    node('text="a chat title" bounds="[0,100][1080,200]"'),
    node('content-desc="Chats" bounds="[100,2200][300,2300]"'),
  ].join('');
  assert.deepEqual(
    discoverNav(xml).map((n) => n.label),
    ['Chats'],
  );
});

test('a truncation ellipsis in the nav band is not a destination', () => {
  const xml = [
    node('text="…" bounds="[300,2200][340,2300]"'),
    node('content-desc="Chats" bounds="[100,2200][300,2300]"'),
  ].join('');
  assert.deepEqual(
    discoverNav(xml).map((n) => n.label),
    ['Chats'],
  );
});

test('an untappable zero-area nav node is not offered as a destination', () => {
  const xml = node('content-desc="Chats" bounds="[100,2300][100,2300]"');
  assert.deepEqual(discoverNav(xml), []);
});

test('an app that paints no navigation at all discovers nothing, rather than guessing', () => {
  assert.deepEqual(discoverNav(node('text="hello" bounds="[0,0][1080,100]"')), []);
});

// The shape of the real chat list on 2026-09-23 (uiautomator, 1080x2400): the
// last row of a ScrollView reaches the tab bar, so its title, its buttons and
// its swipe tray all sit in the bottom band. The walk "discovered" them as
// destinations and tapped Pin / Snooze / Archive on a real chat.
const TAB_BAR = [
  '<node class="android.view.View" content-desc="Chats" clickable="true" bounds="[0,2170][216,2337]">',
  node('class="android.widget.TextView" text="Chats" bounds="[73,2257][144,2294]"'),
  '</node>',
  node('class="android.view.View" content-desc="Jobs" bounds="[216,2170][432,2337]"'),
  // The raised centre button: shorter than its neighbours, still the bar.
  node('class="android.view.ViewGroup" content-desc="New chat" bounds="[456,2170][624,2296]"'),
  node('class="android.view.View" content-desc="Settings" bounds="[864,2170][1080,2337]"'),
].join('');

const chatRow = (scrollable) =>
  [
    `<node class="android.widget.ScrollView" scrollable="${scrollable}" bounds="[0,252][1080,2169]">`,
    '<node class="android.view.ViewGroup" bounds="[0,2087][1080,2169]">',
    node(
      'class="android.widget.Button" content-desc="Open chat Rubber" bounds="[76,2121][909,2169]"',
    ),
    node('class="android.widget.TextView" text="Rubber" bounds="[160,2121][737,2169]"'),
    node(
      'class="android.widget.Button" content-desc="Chat actions for Rubber" bounds="[930,2126][1004,2169]"',
    ),
    node('class="android.widget.Button" content-desc="Pin chat" bounds="[42,2087][189,2169]"'),
    node('class="android.widget.Button" content-desc="Archive chat" bounds="[336,2087][483,2169]"'),
    '</node>',
    '</node>',
  ].join('');

const screenWith = (...parts) =>
  `<hierarchy><node class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">${parts.join('')}</node></hierarchy>`;

test('a list row that reaches the tab bar is content, not navigation — its buttons are never tapped as tabs', () => {
  assert.deepEqual(
    discoverNav(screenWith(chatRow(true), TAB_BAR)).map((n) => n.label),
    ['Chats', 'Jobs', 'New chat', 'Settings'],
  );
});

test('a row that is not in a scrolling list is still not the nav bar — the bar is one row, raised button included', () => {
  assert.deepEqual(
    discoverNav(screenWith(chatRow(false), TAB_BAR)).map((n) => n.label),
    ['Chats', 'Jobs', 'New chat', 'Settings'],
  );
});

test('a screen with no tab bar offers only its bottom row, never a list above it', () => {
  // A chat: its messages scroll, its composer is the bottom row.
  const xml = screenWith(
    '<node class="android.widget.ScrollView" scrollable="true" bounds="[0,200][1080,2200]">',
    node('text="a message" bounds="[40,2100][1000,2190]"'),
    '</node>',
    node('content-desc="Send message" bounds="[900,2220][1060,2380]"'),
  );
  assert.deepEqual(
    discoverNav(xml).map((n) => n.label),
    ['Send message'],
  );
});

// A device double for the step logic. `screens` is what each dump returns in
// turn; `restartsOnTap` lists the taps (1-based) under which the app process
// is replaced, which is what a real restart looks like from outside.
function fakeDevice({ screens, restartsOnTap = [] }) {
  const state = { pid: 100, taps: 0, relaunches: 0, said: [], queue: [...screens] };
  const home = screens[screens.length - 1];
  state.io = {
    screen: async () => (state.queue.length > 0 ? state.queue.shift() : home),
    relaunch: async () => {
      state.relaunches++;
      state.pid++; // a cold start is a new process, always
      state.queue = [];
    },
    pid: () => String(state.pid),
    tap: async () => {
      state.taps++;
      if (restartsOnTap.includes(state.taps)) state.pid++;
    },
    say: (msg) => state.said.push(msg),
  };
  return state;
}

const HOME = screenWith(TAB_BAR);
const IN_A_CHAT = screenWith(node('content-desc="Send message" bounds="[900,2220][1060,2380]"'));

test('THE 2026-09-23 FALSE ALARM: a step that has to cold-start its way home is not an app restart', async () => {
  // The previous step left a chat open, so "Jobs" is not on screen and the
  // harness force-stops and relaunches to get back to the tabs. That new pid
  // is the harness's own doing; it used to be reported on 10 of 11 steps.
  const dev = fakeDevice({ screens: [IN_A_CHAT, HOME] });
  assert.equal(await openSettled('Jobs', dev.io), null);
  assert.equal(dev.relaunches, 1);
  assert.equal(dev.taps, 1);
  assert.deepEqual(dev.said, []);
});

test('openDestination takes its pid baseline after its own cold start, at the tap', async () => {
  const dev = fakeDevice({ screens: [IN_A_CHAT, HOME] });
  const opened = await openDestination('Jobs', dev.io);
  assert.equal(opened.why, null);
  assert.equal(opened.pid, dev.io.pid());
});

test('a real restart under the step is still caught, said, and retried once', async () => {
  const dev = fakeDevice({ screens: [HOME], restartsOnTap: [1] });
  assert.equal(await openSettled('Jobs', dev.io), null);
  assert.equal(dev.said.length, 1);
  assert.match(dev.said[0], /restarted under this step/);
  assert.equal(dev.taps, 2);
});

test('an app that restarts again on the retry fails, and says it is not staying up', async () => {
  const dev = fakeDevice({ screens: [HOME], restartsOnTap: [1, 2] });
  assert.match(await openSettled('Jobs', dev.io), /^Jobs: the app restarted again/);
});

test('a destination that is not offered even after a cold start fails with what WAS offered', async () => {
  const dev = fakeDevice({ screens: [HOME] });
  assert.match(
    await openSettled('Voice', dev.io),
    /^Voice: "Voice" is not in the navigation.*Chats, Jobs/,
  );
});

test('a walk that reached one destination fails — navigation that goes nowhere is broken', () => {
  const failures = judgeWalk([{ label: 'Chats', distinct: screenful(12) }]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /no reachable navigation/);
});

test('every destination painting the SAME screen fails — the tabs do not navigate', () => {
  const same = screenful(12);
  const failures = judgeWalk([
    { label: 'Chats', distinct: same },
    { label: 'Settings', distinct: same },
  ]);
  assert.ok(failures.some((f) => /does not navigate/.test(f)));
});

test('chrome with no content anywhere fails — that is what a signed-out app looks like', () => {
  const failures = judgeWalk([
    { label: 'Chats', distinct: screenful(4, 'a') },
    { label: 'Settings', distinct: screenful(4, 'b') },
  ]);
  assert.ok(failures.some((f) => /chrome and no content/.test(f)));
  assert.ok(MIN_TEXTS_SOMEWHERE > MIN_TEXTS_PER_SCREEN);
});

test('a healthy walk over distinct, populated screens passes', () => {
  assert.deepEqual(
    judgeWalk([
      { label: 'Chats', distinct: screenful(12, 'chat') },
      { label: 'Settings', distinct: screenful(12, 'setting') },
    ]),
    [],
  );
});

test('the render loop that shipped is an invariant violation, counted, with an example', () => {
  const log = [
    'I ReactNativeJS: Running "main"',
    'E ReactNativeJS: [Error: Maximum update depth exceeded. This can happen...]',
    'E ReactNativeJS: [Error: Maximum update depth exceeded. This can happen...]',
  ].join('\n');
  const [v] = scanLog(log);
  assert.match(v.why, /render loop/);
  assert.equal(v.count, 2);
  assert.match(v.example, /Maximum update depth/);
});

test('a healthy log violates nothing', () => {
  assert.deepEqual(
    scanLog('I ReactNativeJS: Running "main"\nI ActivityTaskManager: Displayed'),
    [],
  );
});

test('crashes, ANRs and unhandled JS errors are invariants too — not just the render loop', () => {
  assert.equal(scanLog('E AndroidRuntime: FATAL EXCEPTION: main').length, 2);
  assert.equal(scanLog('W ActivityManager: Application com.x is not responding').length, 1);
  assert.equal(scanLog('E ReactNativeJS: Unhandled promise rejection').length, 1);
});

test('a native crash carries its stack — the count alone does not say what threw', () => {
  const log = [
    '10-05 15:19:59.355  4148  4201 E AndroidRuntime: FATAL EXCEPTION: mqt_native_modules',
    '10-05 15:19:59.355  4148  4201 E AndroidRuntime: Process: io.github.tomchambers2.patch, PID: 4148',
    '10-05 15:19:59.355  4148  4201 E AndroidRuntime: java.lang.IllegalStateException: boom',
    '10-05 15:19:59.355  4148  4201 E AndroidRuntime: \tat com.x.Foo.bar(Foo.kt:12)',
    '10-05 15:19:59.400  4148  4148 I Other: unrelated',
  ].join('\n');
  const v = scanLog(log).find((x) => /native crash/.test(x.why));
  assert.match(v.detail, /IllegalStateException: boom/);
  assert.match(v.detail, /Foo\.kt:12/);
  assert.doesNotMatch(v.detail, /unrelated/);
});

test('every invariant carries a human reason — the message is the whole diagnosis', () => {
  for (const inv of LOG_INVARIANTS) {
    assert.ok(inv.why.length > 10, `${inv.pattern} has no useful why`);
  }
});

test('reads tab labels out of content-desc, not just text — tabs carry no text node', () => {
  const xml = node('text="" content-desc="New chat" bounds="[540,2200][810,2264]"');
  assert.deepEqual(visibleText(xml), ['New chat']);
});

test('decodes XML entities so an escaped label still matches', () => {
  assert.deepEqual(visibleText(node('text="Tom &amp; Co" bounds="[0,0][1,1]"')), ['Tom & Co']);
});

test('finds the centre of a labelled node to tap', () => {
  const xml = node('text="New chat" bounds="[540,2200][810,2264]"');
  assert.deepEqual(findTap(xml, 'New chat'), { x: 675, y: 2232 });
});

test('matches a truncated label by substring', () => {
  const xml = node('text="Weekend Meal Plan T…" bounds="[0,100][100,200]"');
  assert.ok(findTap(xml, 'Weekend Meal Plan'));
});

test('will not tap a zero-area node — an invisible match is not an affordance', () => {
  assert.equal(findTap(node('text="New chat" bounds="[10,10][10,10]"'), 'New chat'), null);
});

test('an absent affordance is null, never a guessed coordinate', () => {
  assert.equal(findTap(node('text="Chats" bounds="[0,0][10,10]"'), 'New chat'), null);
});

// These replace "the journey visits every tab". There is no journey to assert
// against any more: the walk is whatever the app paints, so what has to hold is
// that discovery finds it — which the discoverNav tests above cover — and that
// nothing in the judgement depends on a particular product word.
test('no screen name of the app is baked into the judgement', () => {
  const source = readFileSync(new URL('./mobile-surface-smoke.mjs', import.meta.url), 'utf8');
  const judgement = source.slice(
    source.indexOf('MIN_TEXTS_PER_SCREEN'),
    source.indexOf('// -------------------------------------------------------------- the driver'),
  );
  for (const word of ['Pick a folder', 'New chat', 'Account', 'Manager']) {
    assert.ok(
      !judgement.includes(`'${word}'`) && !judgement.includes(`"${word}"`),
      `the judgement hardcodes the product string ${word}; it will rot the next time someone renames it`,
    );
  }
});

test("picks the machine's first AVD when none is named — no hardcoded device", () => {
  assert.deepEqual(pickAvd(undefined, ['Pixel_7', 'gp-e2e']), { avd: 'Pixel_7' });
});

test('an explicitly named AVD is honoured', () => {
  assert.deepEqual(pickAvd('gp-e2e', ['Pixel_7', 'gp-e2e']), { avd: 'gp-e2e' });
});

test('a named AVD that does not exist lists what does, rather than "no device"', () => {
  const res = pickAvd('Pixel_9', ['Pixel_7']);
  assert.match(res.why, /no AVD named "Pixel_9"/);
  assert.match(res.why, /Pixel_7/);
});

test('a machine with no emulator says so and says how to fix it', () => {
  const res = pickAvd(undefined, []);
  assert.match(res.why, /no Android emulator/);
  assert.match(res.why, /Device Manager/);
});

// The uninstall that precedes the install. It is housekeeping, not the
// assertion — but a package left behind IS the thing this layer tests for, so
// it may not be shrugged off either.
test('nothing installed is nothing to do', async () => {
  let removes = 0;
  await uninstallLoop({
    installed: () => false,
    remove: () => (removes += 1),
    wait: async () => {},
  });
  assert.equal(removes, 0);
});

test('a refusal is retried while the device settles, and passes once it takes', async () => {
  // DELETE_FAILED_INTERNAL_ERROR from a package manager that has only just
  // booted — it failed a whole deploy on 8 Sep 2026, one that had shipped every
  // surface correctly.
  let present = true;
  let tries = 0;
  const said = [];
  await uninstallLoop({
    installed: () => present,
    remove: () => {
      tries += 1;
      if (tries < 3) throw new Error('Failure [DELETE_FAILED_INTERNAL_ERROR]');
      present = false;
    },
    wait: async () => {},
    log: (m) => said.push(m),
  });
  assert.equal(tries, 3);
  assert.equal(present, false);
  assert.equal(said.length, 2);
  assert.match(said[0], /DELETE_FAILED_INTERNAL_ERROR/);
});

test('a package that will not go fails LOUDLY rather than installing over it', async () => {
  await assert.rejects(
    uninstallLoop({
      installed: () => true,
      remove: () => {
        throw new Error('Failure [DELETE_FAILED_INTERNAL_ERROR]');
      },
      wait: async () => {},
      attempts: 2,
    }),
    /still installed after 2 uninstall attempts/,
  );
});

// ---------------------------------------------------------------- the device

test('splitDevices tells an emulator from the phone on the same cable', () => {
  const out = 'List of devices attached\nd0380211\tdevice\nemulator-5554\tdevice\n';
  assert.deepEqual(splitDevices(out), {
    emulators: ['emulator-5554'],
    physical: ['d0380211'],
  });
});

test('splitDevices ignores anything that is not ready', () => {
  const out =
    'List of devices attached\nemulator-5554\toffline\nd0380211\tunauthorized\nemulator-5556\tdevice\n';
  assert.deepEqual(splitDevices(out), { emulators: ['emulator-5556'], physical: [] });
});

test('splitDevices on an empty list finds nothing rather than throwing', () => {
  assert.deepEqual(splitDevices('List of devices attached\n\n'), {
    emulators: [],
    physical: [],
  });
});

test('foregroundPackage names the app owning the focused window', () => {
  assert.equal(
    foregroundPackage('  mCurrentFocus=Window{9f0 u0 io.github.tomchambers2.patch/com.x.MainActivity}'),
    'io.github.tomchambers2.patch',
  );
  // The case that misled a whole deploy: a different app in front.
  assert.equal(
    foregroundPackage('  mCurrentFocus=Window{1a2 u0 ai.wpp.agents/ai.wpp.agents.MainActivity}'),
    'ai.wpp.agents',
  );
  assert.equal(foregroundPackage('  mCurrentFocus=null'), null);
});

test("pickAvd prefers the harness's own AVD over whatever is first on the machine", () => {
  assert.deepEqual(pickAvd(undefined, ['Pixel_7', 'gp-e2e', DEDICATED_AVD]), {
    avd: DEDICATED_AVD,
  });
  // No dedicated one → the old behaviour, first on the machine.
  assert.deepEqual(pickAvd(undefined, ['Pixel_7', 'gp-e2e']), { avd: 'Pixel_7' });
  // An explicit choice still wins over both.
  assert.deepEqual(pickAvd('gp-e2e', ['Pixel_7', 'gp-e2e', DEDICATED_AVD]), { avd: 'gp-e2e' });
});

test('the pairing link names the server — the app has none built in, so a bare credential crashes every chat screen', () => {
  const link = pairingLink('a.b.c', 'https://patch.example.test/api/download/patch.apk');
  const u = new URL(link);
  assert.equal(u.protocol, 'patch:');
  assert.equal(u.searchParams.get('credential'), 'a.b.c');
  assert.equal(u.searchParams.get('server'), 'https://patch.example.test');
});

test('a local APK path has no origin to derive, so the server must be given — never guessed', () => {
  assert.throws(() => pairingLink('a.b.c', '/tmp/patch.apk'), /--server/);
  assert.equal(
    new URL(pairingLink('a.b.c', '/tmp/patch.apk', 'https://s.test')).searchParams.get('server'),
    'https://s.test',
  );
});

test('the pairing link is quoted for the DEVICE shell — an unquoted & split the command and failed the deploy', () => {
  // `adb shell a b c` does not exec a b c: it joins them and hands the string
  // to /system/bin/sh on the device. The pairing link carries both a
  // credential and a server, so it has an `&` in it — unquoted, the device
  // shell backgrounded the first half and tried to RUN the package name
  // ("io.github.tomchambers2.patch: inaccessible or not found", exit 127). Every
  // deploy failed at smoke, saying nothing about why.
  const link = pairingLink('a.b.c', 'https://patch.example.test/api/download/patch.apk');
  assert.match(link, /&/);
  const quoted = deviceArg(link);
  assert.equal(quoted, `'${link}'`);
  // Round-trip through a real POSIX shell: what the device runs must be
  // exactly the link, metacharacters and all.
  assert.equal(execFileSync('sh', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' }), link);
});

test('deviceArg survives the characters a shell would otherwise act on', () => {
  for (const value of ["it's", 'a b; rm -rf /nope', 'x&y', '$(whoami)', '`id`', 'plain']) {
    assert.equal(
      execFileSync('sh', ['-c', `printf %s ${deviceArg(value)}`], { encoding: 'utf8' }),
      value,
    );
  }
});

test('running version comes from This app inside Updates, not another host', () => {
  const xml =
    '<hierarchy><node resource-id="version-this-app"><node text="This app"/><node text="0.1.12 · abc12345"/></node><node text="Server 0.1.13 · def67890"/></hierarchy>';
  assert.equal(runningVersion(xml), '0.1.12 · abc12345');
  assert.equal(runningVersion('<node text="Server 0.1.13 · def67890"/>'), null);
});

// ---- a hung adb call is a verdict, not a 15-minute silence ----------------
//
// 2026-10-06 13:11 → 13:26: the walk reached New chat and then nothing — no
// verdict, no stack, just "Command failed" when the deploy's own timeout killed
// it. Every adb call is synchronous, so one that never returned froze the whole
// run before it could say what it was doing.

test('an adb call is given a timeout, so one that hangs cannot freeze the run', () => {
  let seen;
  const out = runAdb(
    (cmd, args, opts) => {
      seen = { cmd, args, opts };
      return 'ok';
    },
    'emulator-5554',
    ['shell', 'input', 'tap', '1', '2'],
  );
  assert.equal(out, 'ok');
  assert.deepEqual(seen.args, ['-s', 'emulator-5554', 'shell', 'input', 'tap', '1', '2']);
  assert.equal(seen.opts.timeout, ADB_TIMEOUT_MS);
});

test('a hung adb call fails naming the command and how long it waited', () => {
  const hung = () => {
    throw Object.assign(new Error('spawnSync adb ETIMEDOUT'), { code: 'ETIMEDOUT' });
  };
  assert.throws(
    () => runAdb(hung, null, ['exec-out', 'uiautomator', 'dump', '/dev/tty'], 5000),
    /adb exec-out uiautomator dump \/dev\/tty hung — no answer after 5s/,
  );
});

test('an adb call that fails for another reason keeps its own error', () => {
  const boom = new Error('device offline');
  assert.throws(
    () =>
      runAdb(
        () => {
          throw boom;
        },
        null,
        ['devices'],
      ),
    (err) => err === boom,
  );
});
