#!/usr/bin/env node
// Drive the SHIPPED Android app on a real Android runtime and assert it works.
//
//   node scripts/mobile-surface-smoke.mjs --apk <path> --sha <gitSha> [--avd Pixel_7]
//
// Why this exists.
//
// `scripts/verify.mjs` says the Surface layer "needs an emulator, a device or a
// display, so it cannot run unattended. It is run explicitly instead." Nothing
// ever ran it explicitly, and the one maestro flow deliberately avoids the
// new-chat screen so that store changes "don't rot it". So on 1 Sep the app
// shipped with its New chat tab redirecting to itself — an infinite
// mount→replace loop that rendered a blank screen and wedged every other tab —
// past 1320 green unit tests, a clean typecheck, a clean lint, and a deploy gate
// that verified only that an APK had been uploaded and a manifest returned 200.
//
// A headless emulator boots on this machine in about a minute (`-no-window`),
// so the premise was simply wrong: the surface layer CAN run unattended, and
// this is it.
//
// What it asserts, in the two flavours CLAUDE.md asks for:
//
//   Expectations — each destination in the journey actually PAINTED the text it
//   is supposed to paint. A screen that renders nothing fails here even when
//   nothing throws, which is exactly the shape of the bug that got through.
//
//   Invariants — nothing in logcat may report a React render loop, a fatal, or
//   an unhandled JS error, at ANY point in the run, whether or not a step
//   expected it. These catch failures nobody thought to write a step for.
//
// It also asserts the running build IS the build under test. The app OTAs on
// launch, so a freshly installed APK is replaced by whatever JS the channel
// serves within seconds — which is why "I installed the latest APK and it is
// still broken" was true and confusing. A smoke that does not check this can
// pass while testing a bundle from last week.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isMain } from './lib/is-main.mjs';

// ---------------------------------------------------------------- pure core

/**
 * Lines that must never appear, whatever the run was doing.
 *
 * `Maximum update depth exceeded` is first because it is the one that shipped:
 * React logs it and renders NOTHING, so the app is dead while every process is
 * healthy and every screen "exists". No crash, no ANR, no exit code.
 */
export const LOG_INVARIANTS = [
  {
    pattern: /Maximum update depth exceeded/,
    why: 'a React render loop — the screen paints nothing',
  },
  { pattern: /FATAL EXCEPTION/, why: 'a native crash' },
  { pattern: /E AndroidRuntime/, why: 'an unhandled Android exception' },
  { pattern: /Unhandled (?:JS Exception|promise rejection)/, why: 'an unhandled JS error' },
  { pattern: /Application .* is not responding/, why: 'an ANR — the UI thread is blocked' },
];

/** Every invariant the log violated, with how many times and one example line. */
export function scanLog(log) {
  const lines = log.split('\n');
  const out = [];
  for (const { pattern, why } of LOG_INVARIANTS) {
    const hits = lines.filter((l) => pattern.test(l));
    if (hits.length === 0) continue;
    const entry = { why, count: hits.length, example: hits[0].trim() };
    if (pattern.test('FATAL EXCEPTION')) {
      // The count says THAT it crashed, not what threw. Keep the first crash's
      // AndroidRuntime block (header + exception + frames) so the deploy log is
      // enough to diagnose it without re-running an emulator.
      const start = lines.indexOf(hits[0]);
      const block = [];
      for (const l of lines.slice(start)) {
        if (!/E AndroidRuntime/.test(l)) break;
        block.push(l.trim());
        if (block.length >= 40) break;
      }
      entry.detail = block.join('\n');
    }
    out.push(entry);
  }
  return out;
}

/**
 * Every piece of text a `uiautomator dump` shows, including content-desc.
 *
 * Tab bar buttons carry their label in `content-desc` rather than `text`, so
 * reading only `text=` would miss every tab and make the journey untappable.
 */
export function visibleText(xml) {
  const out = [];
  for (const attr of ['text', 'content-desc']) {
    for (const m of xml.matchAll(new RegExp(`${attr}="([^"]*)"`, 'g'))) {
      if (m[1].length > 0) out.push(decodeXml(m[1]));
    }
  }
  return out;
}

/** Read only this app's stamp, never the server/host stamps beside it. */
export function runningVersion(xml) {
  let start = -1;
  let depth = 0;
  for (const match of xml.matchAll(/<node\b(?:[^>"]|"[^"]*")*\/?>|<\/node>/g)) {
    const tag = match[0];
    if (start < 0) {
      if (!/resource-id="(?:[^" ]*\/)?version-this-app"/.test(tag)) continue;
      start = match.index;
    }
    if (tag === '</node>') depth--;
    else if (!tag.endsWith('/>')) depth++;
    if (depth === 0) {
      return (
        visibleText(xml.slice(start, match.index + tag.length)).find((text) =>
          /\d+\.\d+\.\d+/.test(text),
        ) ?? null
      );
    }
  }
  return null;
}

function decodeXml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Centre point of the first node whose text or content-desc matches `label`.
 * Matching is substring so a truncated chat title ("Weekend Meal Plan T…")
 * still resolves; `null` when nothing matches, which the caller reports as a
 * missing affordance rather than tapping blind coordinates.
 */
export function findTap(xml, label) {
  for (const node of xml.split('<node ').slice(1)) {
    // `(?:^|\s)` and not a bare space: after the split on `<node ` the first
    // attribute has no leading whitespace, and it is `text` often enough that a
    // leading-space regex silently matched nothing on real dumps.
    const text = decodeXml(/(?:^|\s)text="([^"]*)"/.exec(node)?.[1] ?? '');
    const desc = decodeXml(/(?:^|\s)content-desc="([^"]*)"/.exec(node)?.[1] ?? '');
    if (!text.includes(label) && !desc.includes(label)) continue;
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    if (x2 <= x1 || y2 <= y1) continue; // a zero-area node cannot be tapped
    return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
  }
  return null;
}

/**
 * WHAT THIS ASSERTS, AND WHY IT STOPPED BEING A LIST OF SCREEN NAMES.
 *
 * It used to be a journey table: tap "Settings" expect "Account", tap "New
 * chat" expect "Pick a folder". Two things were wrong with that.
 *
 * IT ROTS. Every one of those strings is a UI decision someone is entitled to
 * change. Rename a tab, reword an empty state, and a correct build fails —
 * which trains everyone to read a red smoke as "probably the test again", and
 * that is the day it is not the test again.
 *
 * IT ASKED THE WRONG QUESTION. On 2026-09-11 it reported `no tappable "Chats"
 * on screen` three times, on a build whose app cold-started fine and navigated
 * fine by hand. What had actually happened was that the app restarted
 * underneath the walk (the OTA applying on the next launch, exactly as designed)
 * and the harness read a screen mid-restart. It had no way to say that, because
 * "is the string there" cannot express "the app went away".
 *
 * So the destinations are DISCOVERED from the navigation the app actually
 * paints, and what is asserted about each is only what must be true of any
 * version of this app:
 *
 *   IT IS STILL THERE   — our package is still in the foreground, and the
 *                         process did not restart under the step.
 *   IT PAINTED          — the screen carries real content, not nothing. A
 *                         blank render is the failure this whole layer exists
 *                         for: no crash, no exception, no exit code.
 *   IT IS NOT BROKEN    — no error screen, in the generic shapes React Native
 *                         and the app itself produce.
 *   IT DOES SOMETHING   — the destinations are not all the same dead screen,
 *                         and at least one of them has substantial content, so
 *                         "every tab renders an empty shell" cannot pass.
 *
 * Plus the two invariants that were always right and are kept: the running
 * bundle IS the build under test, and logcat reports no render loop, crash,
 * unhandled error or ANR at any point.
 */

/** Distinct on-screen strings below which a screen counts as blank. */
export const MIN_TEXTS_PER_SCREEN = 3;

/**
 * At least one destination must clear this, or the app is painting chrome and
 * no content — which is what a signed-out or wedged app looks like when every
 * individual screen still has a title and a tab bar.
 */
export const MIN_TEXTS_SOMEWHERE = 8;

/** How far up from the bottom of the display to look for a navigation bar. */
export const NAV_BAND = 0.86;

/**
 * Generic "this screen is an error" markers.
 *
 * Deliberately not app copy: these are the shapes a React Native app produces
 * when something has gone wrong, so they keep working when the product's own
 * wording changes. App-specific copy belongs in the app's own tests, which can
 * be updated in the same commit that changes it.
 */
export const ERROR_MARKERS = [
  /\bunhandled\b.*\b(error|exception|rejection)\b/i,
  /\brender error\b/i,
  /\bsomething went wrong\b/i,
  /\bapplication error\b/i,
  /\bkeeps stopping\b/i,
  /\bisn't responding\b/i,
];

/**
 * The navigation the app paints, read off the screen rather than declared here.
 *
 * A nav bar is a row of tappable, labelled nodes along the bottom of the
 * display. That is a structural fact about the app, not a naming one, so it
 * survives every rename — and when it finds nothing it says so, which is itself
 * a real failure: an app with no reachable navigation is broken however nice
 * its first screen looks.
 *
 * Labels are deduped and returned left to right, so the walk is deterministic.
 *
 * "Along the bottom" is NOT "anything in the bottom band". A chat list that
 * reaches the tab bar puts its last row in that band, and a row carries its
 * own labelled controls — on 2026-09-23 that was "Open chat …", "Chat actions
 * for …" and the swipe tray's "Pin chat" / "Snooze chat" / "Archive chat",
 * which the walk then TAPPED against the real account as if they were tabs
 * (the row on top happened to swallow the taps; a row with its tray open
 * would not have). So two structural rules, neither of which names anything:
 *
 *   NAVIGATION DOES NOT SCROLL — a node inside a scrollable container is
 *                                content, however low it sits.
 *   IT IS ONE ROW              — only nodes sharing the bottom-most labelled
 *                                node's vertical span. A raised centre button
 *                                still overlaps it; a list row ending where
 *                                the bar starts does not.
 */
export function discoverNav(xml) {
  const nodes = [];
  let displayBottom = 0;
  // Depth of scrollable ancestors, tracked through the tree: uiautomator
  // writes children INSIDE their parent's element, so "is this in a list" is
  // a question about nesting, not position.
  const scrollStack = [];
  let insideScroll = 0;
  const tag = /<node\b((?:[^>"]|"[^"]*")*?)(\/?)>|<\/node>/g;
  for (let m = tag.exec(xml); m !== null; m = tag.exec(xml)) {
    if (m[0] === '</node>') {
      if (scrollStack.pop()) insideScroll--;
      continue;
    }
    const node = m[1];
    const selfClosing = m[2] === '/';
    const scrollable = /(?:^|\s)scrollable="true"/.test(node);
    const inList = insideScroll > 0;
    if (!selfClosing) {
      scrollStack.push(scrollable);
      if (scrollable) insideScroll++;
    }
    const b = /bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/.exec(node);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    displayBottom = Math.max(displayBottom, y2);
    if (inList) continue; // content, however low it sits
    if (x2 <= x1 || y2 <= y1) continue; // a zero-area node cannot be tapped
    const text = decodeXml(/(?:^|\s)text="([^"]*)"/.exec(node)?.[1] ?? '').trim();
    const desc = decodeXml(/(?:^|\s)content-desc="([^"]*)"/.exec(node)?.[1] ?? '').trim();
    const label = text || desc;
    if (label.length === 0 || label.length > 40) continue;
    // A destination has a NAME. Truncation ellipses, separators and bare
    // punctuation sit in the same band and are not places to go — one run
    // discovered "…" as a fifth tab and then judged the app by wherever
    // tapping it landed.
    if (!/[\p{L}\p{N}]/u.test(label)) continue;
    nodes.push({ label, x1, y1, x2, y2 });
  }
  if (displayBottom === 0) return [];

  const cutoff = displayBottom * NAV_BAND;
  const band = nodes.filter((n) => n.y1 >= cutoff);
  if (band.length === 0) return [];
  const anchor = band.reduce((low, n) => (n.y2 > low.y2 ? n : low));
  const seen = new Set();
  return band
    .filter((n) => n.y1 < anchor.y2 && n.y2 > anchor.y1)
    .sort((a, b) => a.x1 - b.x1)
    .filter((n) => (seen.has(n.label) ? false : (seen.add(n.label), true)))
    .map((n) => ({
      label: n.label,
      x: Math.round((n.x1 + n.x2) / 2),
      y: Math.round((n.y1 + n.y2) / 2),
    }));
}

/**
 * Is what this destination painted acceptable — for any version of the app?
 *
 * Pure, so every verdict below is testable without a device.
 */
export function judgeScreen(label, texts) {
  const distinct = [...new Set(texts.map((t) => t.trim()).filter(Boolean))];
  if (distinct.length < MIN_TEXTS_PER_SCREEN) {
    return {
      ok: false,
      why: `${label}: painted ${summarise(texts)} — under ${MIN_TEXTS_PER_SCREEN} distinct strings is a blank render, whatever it was meant to say`,
    };
  }
  for (const marker of ERROR_MARKERS) {
    const hit = distinct.find((t) => marker.test(t));
    if (hit !== undefined) return { ok: false, why: `${label}: an error screen — "${hit}"` };
  }
  return { ok: true, distinct };
}

/**
 * The verdict on the walk as a whole, once every destination has been visited.
 *
 * `visits` is `[{ label, distinct }]` for the ones that painted. These are the
 * two things no single screen can tell you: that the navigation went anywhere,
 * and that the app has content in it at all.
 */
export function judgeWalk(visits) {
  const failures = [];
  if (visits.length < 2) {
    failures.push(
      `only ${visits.length} destination painted — an app with no reachable navigation is broken however good that one screen looks`,
    );
    return failures;
  }
  const signatures = new Set(visits.map((v) => [...v.distinct].sort().join('\u0000')));
  if (signatures.size < 2) {
    failures.push(
      `every destination painted the SAME screen (${visits.map((v) => v.label).join(', ')}) — the navigation does not navigate`,
    );
  }
  const richest = Math.max(...visits.map((v) => v.distinct.length));
  if (richest < MIN_TEXTS_SOMEWHERE) {
    failures.push(
      `no destination painted more than ${richest} distinct strings — the app is drawing chrome and no content (a signed-out or wedged app looks exactly like this)`,
    );
  }
  return failures;
}

function summarise(texts) {
  const uniq = [...new Set(texts)].filter(Boolean);
  if (uniq.length === 0) return 'a screen with NO text at all (a blank render)';
  return `[${uniq.slice(0, 12).join(', ')}${uniq.length > 12 ? ', …' : ''}]`;
}

// -------------------------------------------------------------- the driver

const PKG = 'io.github.tomchambers2.patch';
const ACTIVITY = `${PKG}/.MainActivity`;

/**
 * The device every adb call in this file is addressed to.
 *
 * Unset, `adb` talks to "the only attached device", which is a lie the moment a
 * phone is plugged in — and on this Mac one usually is, because `bin/phone`
 * lives on the same cable. On 9 Sep a deploy's smoke ran with a Fairphone AND
 * an emulator attached and drove neither reliably: it read a completely
 * different app's screen and reported the shipped build broken. Worse than the
 * wrong verdict is what it nearly did — install a test build over the app on a
 * real, in-use phone and start tapping it.
 *
 * So the target is CHOSEN (see `device`), never inferred, and it is always an
 * emulator.
 */
let TARGET = null;

/**
 * How long any one adb call may take. Every call here is synchronous, so one
 * that never returns freezes the whole run — on 2026-10-06 the walk reached
 * New chat and then said nothing for 15 minutes, until the deploy's own
 * timeout killed it with a bare "Command failed" and no verdict. A call that
 * hangs is a failure of the step that made it, said in words.
 */
export const ADB_TIMEOUT_MS = 90_000;

/** Run adb through `exec` (execFileSync's shape) with a timeout; name a hang. */
export function runAdb(exec, target, args, timeoutMs = ADB_TIMEOUT_MS) {
  try {
    return exec('adb', target === null ? args : ['-s', target, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: timeoutMs,
    });
  } catch (err) {
    if (err?.code === 'ETIMEDOUT') {
      throw new Error(`adb ${args.join(' ')} hung — no answer after ${timeoutMs / 1000}s`, {
        cause: err,
      });
    }
    throw err;
  }
}

const adb = (...args) => runAdb(execFileSync, TARGET, args);
const shell = (cmd) => adb('shell', cmd);

/**
 * One argument, safe for the DEVICE's shell.
 *
 * `adb shell a b c` does not exec a b c — it joins them into one string and
 * hands that to /system/bin/sh on the device. So an argument carrying shell
 * metacharacters is interpreted there, however carefully execFileSync avoided
 * a shell on this side. The pairing deep link has `&` in it (it carries both
 * a credential and a server), which split the command in half and left the
 * device trying to run the package name as a program: "inaccessible or not
 * found", exit 127, and a deploy that failed with no sign of what it meant.
 */
export function deviceArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Serials of everything adb can see, split by what it is. */
export function splitDevices(devicesOutput) {
  const serials = devicesOutput
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => /\tdevice$/.test(l))
    .map((l) => l.split('\t')[0]);
  return {
    emulators: serials.filter((s) => s.startsWith('emulator-')),
    physical: serials.filter((s) => !s.startsWith('emulator-')),
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function say(msg) {
  process.stdout.write(`${msg}\n`);
}

/**
 * Remove any existing install, so the smoke starts from nothing.
 *
 * The clean install is the point — stale JS in the updates store is the trap
 * this whole layer exists to catch — but the uninstall itself is housekeeping,
 * not the assertion. A package manager that has only just finished booting
 * answers `DELETE_FAILED_INTERNAL_ERROR` and settles seconds later, which
 * failed a deploy on 8 Sep 2026 that had shipped every surface correctly.
 *
 * So: nothing installed is success, a refusal is retried while the device
 * settles, and a package still there at the end fails loudly — because THEN
 * the install really would be layered on someone else's state.
 *
 * Takes its device operations, so the decision can be tested without one.
 */
export async function uninstallLoop({ installed, remove, wait, log = () => {}, attempts = 6 }) {
  for (let i = 0; i < attempts; i++) {
    if (!installed()) return;
    try {
      remove();
    } catch (err) {
      log(
        `==> uninstall refused (${String(err).split('\n')[0]}); the device may still be settling`,
      );
    }
    if (!installed()) return;
    await wait();
  }
  throw new Error(
    `${PKG} is still installed after ${attempts} uninstall attempts — refusing to install over ` +
      'it, because stale JS in the updates store is exactly what this layer tests for',
  );
}

const uninstall = () =>
  uninstallLoop({
    installed: () => shell(`pm list packages ${PKG}`).includes(PKG),
    remove: () => adb('uninstall', PKG),
    wait: () => sleep(5000),
    log: say,
  });

/** The package owning the focused window, from `dumpsys window`. */
export function foregroundPackage(dump) {
  const m = dump.match(/mCurrentFocus=Window\{[^}]*\s+([A-Za-z0-9_.]+)\//);
  return m ? m[1] : null;
}

/**
 * Pick the emulator to drive, booting `avd` headless if none is running.
 *
 * A physical device is never a candidate, even when it is the only thing
 * attached: this harness uninstalls the app, reinstalls it and taps its way
 * through it, and the phone on the other end of that cable is the one Tom
 * carries. It is not a fallback — it is the thing we are avoiding.
 */
async function device(avd) {
  const { emulators, physical } = splitDevices(adb('devices'));
  // Reuse a running emulator only when it IS this AVD. Any other emulator is
  // somebody else's session — on this Mac, usually a work app being driven by
  // another agent — and grabbing it means uninstalling, reinstalling and
  // tapping through whatever they were doing. Which is how a smoke came to read
  // an unrelated app's screen and call the shipped build broken.
  for (const serial of emulators) {
    let running = null;
    try {
      running = execFileSync('adb', ['-s', serial, 'emu', 'avd', 'name'], { encoding: 'utf8' })
        .split('\n')[0]
        .trim();
    } catch {
      /* an emulator that will not name itself is not one we can claim */
    }
    if (running === avd) {
      TARGET = serial;
      say(`==> driving ${TARGET} (${avd}, already up)`);
      return null;
    }
  }
  if (emulators.length > 0) {
    say(`==> leaving ${emulators.join(', ')} alone — not this AVD`);
  }
  if (physical.length > 0) {
    say(`==> ignoring physical device(s) ${physical.join(', ')} — this harness drives emulators`);
  }
  if (!avd) {
    throw new Error(
      physical.length > 0
        ? `only physical devices are attached (${physical.join(', ')}) and this harness will not ` +
            'reinstall and drive the app on a real phone. Pass --avd.'
        : 'no emulator to drive and no --avd given',
    );
  }
  say(`==> booting ${avd} headless`);
  const emu = spawn(
    `${process.env['HOME']}/Library/Android/sdk/emulator/emulator`,
    ['-avd', avd, '-no-window', '-no-audio', '-no-snapshot-load', '-gpu', 'swiftshader_indirect'],
    { detached: true, stdio: 'ignore' },
  );
  emu.unref();
  // Resolve the serial the new emulator came up on before waiting on it, and
  // resolve it BY NAME: "the first emulator in the list" is someone else's
  // session whenever one is already running, and an unqualified
  // `wait-for-device` would return instantly for it.
  for (let i = 0; i < 120 && TARGET === null; i++) {
    for (const serial of splitDevices(adb('devices')).emulators) {
      try {
        const name = execFileSync('adb', ['-s', serial, 'emu', 'avd', 'name'], {
          encoding: 'utf8',
        })
          .split('\n')[0]
          .trim();
        if (name === avd) {
          TARGET = serial;
          break;
        }
      } catch {
        /* still coming up */
      }
    }
    if (TARGET === null) await sleep(1000);
  }
  if (TARGET === null) throw new Error(`${avd} never appeared in \`adb devices\``);
  say(`==> driving ${TARGET}`);
  adb('wait-for-device');
  // `boot_completed` is not enough: wifi attaches after it, and an app that
  // launches into a network-less device takes a different (and untested) path.
  for (let i = 0; i < 120; i++) {
    try {
      if (
        shell('getprop sys.boot_completed').trim() === '1' &&
        shell('ping -c1 -W1 8.8.8.8').includes('1 received')
      ) {
        return emu;
      }
    } catch {
      /* still booting */
    }
    await sleep(2000);
  }
  throw new Error(`${avd} did not reach a networked boot within 4 minutes`);
}

/**
 * Read the screen.
 *
 * `uiautomator dump` loses races: it fails outright while a transition is in
 * flight and on a tree that is still settling. Retry generously — a flaky read
 * reported as a product failure is worse than a slow one.
 */
async function screen() {
  let last = null;
  for (let i = 0; i < 8; i++) {
    try {
      const xml = runAdb(execFileSync, TARGET, ['exec-out', 'uiautomator', 'dump', '/dev/tty'], 25_000);
      if (xml.includes('<node ')) return xml;
    } catch (err) {
      last = err; // retry, but say what the last attempt died of
    }
    await sleep(1500);
  }
  throw new Error(
    `uiautomator never produced a usable dump after 8 tries${last ? ` — last: ${last.message}` : ''}`,
  );
}

/**
 * Tap a labelled affordance. Returns why it could not, rather than throwing:
 * one unreachable control must not abandon the run, because the logcat
 * invariant scan at the end is the half that catches what no step looked for.
 */
async function tap(xml, label) {
  const at = findTap(xml, label);
  if (at === null) {
    return `no tappable "${label}" on screen — saw ${summarise(visibleText(xml))}`;
  }
  adb('shell', 'input', 'tap', String(at.x), String(at.y));
  await sleep(2500);
  return null;
}

/**
 * The app's process id, or null when it is not running.
 *
 * The one fact that separates "this screen is wrong" from "there was no app to
 * read a screen from". Without it a restart mid-walk is indistinguishable from
 * a missing button, which is exactly how a healthy build was reported broken.
 */
function appPid() {
  try {
    const out = shell(`pidof ${PKG}`).trim();
    return out.length > 0 ? out.split(/\s+/)[0] : null;
  } catch {
    return null;
  }
}

/**
 * Open a destination by label, from a screen that currently offers it.
 *
 * The coordinates are re-read every time rather than captured once, because
 * some destinations are ROOT routes that replace the navigation instead of
 * sitting beside it. Reusing the first screen's coordinates after opening one
 * of those taps blind: on the first run of this rewrite it landed on an
 * attachment control and put the system photo picker in the foreground, and
 * then judged the app by that.
 *
 * When the navigation is not on screen at all, the way back is a cold start —
 * which is the honest way home from a root route anyway, and the state the app
 * is most often opened in.
 *
 * Returns `{ why }` — why it could not, rather than throwing — and `{ pid }`,
 * the process id read at the moment of the tap. That is the baseline for "did
 * the app restart under this step", and it has to be taken HERE, after the
 * cold start above: a baseline read before it compares against a process this
 * function killed itself. That is what reported "the app restarted under this
 * step" on 10 of 11 steps on 2026-09-23 — every step that followed one landing
 * off the tab bar (a chat, a root route) cold-started to get home, and then
 * blamed the app for the new pid.
 *
 * `io` is the device: `{ screen, relaunch, tap, pid }`, injected so the
 * decision is testable without one.
 */
export async function openDestination(label, io) {
  let nav = discoverNav(await io.screen());
  if (!nav.some((n) => n.label === label)) {
    await io.relaunch();
    nav = discoverNav(await io.screen());
  }
  const target = nav.find((n) => n.label === label);
  if (target === undefined) {
    return {
      why: `"${label}" is not in the navigation even after a cold start — the app offered ${nav.map((n) => n.label).join(', ') || 'nothing'}`,
      pid: null,
    };
  }
  const pid = io.pid();
  await io.tap(target.x, target.y);
  return { why: null, pid };
}

/**
 * Open a destination and make sure the app stayed up while it did.
 *
 * An app that restarted under the step has not failed to paint a screen — it
 * has gone away and come back, and reading whatever was on the display
 * mid-restart produced three confident, wrong failures on 2026-09-11. An OTA
 * applying is the ordinary cause and is not a fault, so the step is retried
 * once from a settled app; a SECOND restart is reported as what it is.
 *
 * Returns the failure, or null.
 */
export async function openSettled(label, io) {
  const first = await openDestination(label, io);
  if (first.why !== null) return `${label}: ${first.why}`;
  if (io.pid() === first.pid) return null;
  io.say(`    (the app restarted under this step — settling and retrying once)`);
  await io.relaunch();
  const again = await openDestination(label, io);
  if (again.why !== null) return `${label}: ${again.why}`;
  if (io.pid() !== again.pid) {
    return `${label}: the app restarted again while opening it — it is not staying up long enough to be used`;
  }
  return null;
}

/** Cold-start the app. The way home from a root route, and a state worth revisiting. */
async function relaunch() {
  shell(`am force-stop ${PKG}`);
  adb('shell', 'am', 'start', '-n', ACTIVITY);
  await sleep(12000);
}

/**
 * The AVD to boot. `--avd`/`PATCH_SMOKE_AVD` wins; otherwise the first one this
 * machine has. NOT hardcoded to any particular device name — a committed script
 * that assumes one developer's emulator list fails for everyone else, and fails
 * as "no device attached", which reads like a broken app.
 */
export const DEDICATED_AVD = 'patch-smoke';

export function pickAvd(explicit, available) {
  if (explicit) {
    if (!available.includes(explicit)) {
      return {
        why: `no AVD named "${explicit}". This machine has: ${available.join(', ') || 'none'}`,
      };
    }
    return { avd: explicit };
  }
  if (available.length === 0) {
    return {
      why:
        'this machine has no Android emulator. Create one (Android Studio → Device Manager) or ' +
        `run \`avdmanager create avd -n ${DEDICATED_AVD} …\`; the surface layer cannot be judged ` +
        'without one.',
    };
  }
  // An AVD kept for this harness wins, when there is one. Otherwise a deploy
  // reaches for whatever is first on the machine — which is the emulator
  // someone is working in, and this harness uninstalls the app and taps
  // through it.
  if (available.includes(DEDICATED_AVD)) return { avd: DEDICATED_AVD };
  return { avd: available[0] };
}

function listAvds() {
  try {
    return execFileSync(
      `${process.env['HOME']}/Library/Android/sdk/emulator/emulator`,
      ['-list-avds'],
      {
        encoding: 'utf8',
      },
    )
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * A local path for the APK under test, downloading it first when `apk` is a URL.
 *
 * The deploy runs this against the APK the BOX published, which is the one a
 * phone would install — fetching it here rather than shipping a path around
 * means the thing tested is the thing served. The download is authenticated with
 * the same surface JWT the pairing step uses; no second secret.
 */
async function resolveApk(apk, credential, fetchImpl = fetch) {
  if (!/^https?:/.test(apk)) {
    if (!existsSync(apk)) throw new Error(`no APK at ${apk}`);
    return apk;
  }
  const res = await fetchImpl(apk, { headers: { authorization: `Bearer ${credential}` } });
  if (!res.ok) throw new Error(`could not download ${apk}: HTTP ${res.status}`);
  const file = join(mkdtempSync(join(tmpdir(), 'patch-smoke-')), 'patch.apk');
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  say(`==> downloaded ${apk}`);
  return file;
}

/**
 * The deep link that pairs the app. No server is built into the app, so the
 * link must name one or every screen that talks to it throws ("This device is
 * not paired to a server yet"). Derived from the APK's own URL — the box that
 * published it is the box under test — or given explicitly for a local file.
 */
export function pairingLink(credential, apk, server) {
  let origin = server;
  if (origin === undefined) {
    try {
      origin = new URL(apk).origin;
    } catch {
      throw new Error(`no server to pair against: ${apk} is not a URL — pass --server <origin>`);
    }
  }
  const bare = origin.replace(/\/$/, '');
  return `patch://x?credential=${credential}&server=${encodeURIComponent(bare)}`;
}

async function run({ apk, sha, avd, credential, server }) {
  const apkPath = await resolveApk(apk, credential);
  // A downloaded APK sits in its own mkdtemp dir. Every deploy's smoke used to
  // leave one behind (~96 MB each, in the Mac's $TMPDIR); it goes when the run
  // does, whatever happened.
  const tempDir = apkPath === apk ? null : dirname(apkPath);
  try {
    return await drive({
      apkPath,
      sha,
      avd,
      credential,
      link: pairingLink(credential, apk, server),
    });
  } finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  }
}

async function drive({ apkPath, sha, avd, link }) {
  const emu = await device(avd);
  try {
    say(`==> installing ${apkPath}`);
    await uninstall();
    adb('install', '-r', apkPath);
    for (const p of ['RECORD_AUDIO', 'POST_NOTIFICATIONS', 'CAMERA']) {
      try {
        shell(`pm grant ${PKG} android.permission.${p}`);
      } catch {
        // Not every permission is grantable on every image; priming will ask.
      }
    }

    say('==> pairing');
    adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', deviceArg(link), PKG);
    await sleep(10000);
    shell(`am force-stop ${PKG}`);

    adb('logcat', '-c');
    say('==> launching');
    // `-S` force-stops first, so a half-live process from the pairing intent
    // cannot resume into a stale screen.
    adb('shell', 'am', 'start', '-S', '-n', ACTIVITY);
    await sleep(15000);

    const failures = [];
    const io = {
      screen,
      relaunch,
      pid: appPid,
      say,
      tap: async (x, y) => {
        adb('shell', 'input', 'tap', String(x), String(y));
        await sleep(2500);
      },
    };

    // Everything below reads the screen, so it is only ever about this app if
    // this app is the one on it. Say that in its own words: a run that read
    // another app's UI once reported four "the screen does not paint" failures
    // against a build that was fine.
    const front = foregroundPackage(shell('dumpsys window'));
    if (front !== PKG) {
      throw new Error(
        `${front ?? 'something else'} is in the foreground on ${TARGET}, not ${PKG} — the app did ` +
          'not come up, so nothing below would be a judgement of it',
      );
    }

    // The app OTAs on launch. If the channel serves different JS, everything
    // below tests THAT bundle and not the one being shipped — silently. Settings
    // → Version is where the running build names itself.
    say('==> checking the running build is the build under test');
    let sawSha = false;
    // Keep what the version line DID say: "does not report <sha>" alone leaves
    // you unable to tell a stale bundle from a screen that never reached the
    // version line at all, and those want opposite fixes.
    let saidInstead = null;
    // expo-updates fetches in the background and applies on the NEXT launch, so
    // the first launch after a fresh install ALWAYS runs the APK's own bundle.
    // Checking once therefore fails on a cold emulator (which is the only kind
    // a deploy has) and passes on a warm one — a harness that reports the build
    // broken depending on how recently it last ran is worse than none. Give the
    // update the relaunch it is waiting for, twice, before believing it.
    //
    // Updates is a nested settings page. Open its public route directly;
    // scanning only tabs no longer reaches it after the Settings redesign.
    for (let launch = 0; launch < 3 && !sawSha; launch++) {
      await relaunch();
      adb(
        'shell',
        'am',
        'start',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        'patch://settings/updates',
        PKG,
      );
      await sleep(2500);
      for (let i = 0; i < 6 && !sawSha; i++) {
        const version = runningVersion(await screen());
        if (version !== null) saidInstead = version;
        sawSha = version?.includes(sha) === true;
        if (version !== null) break;
        adb('shell', 'input', 'swipe', '540', '1800', '540', '700', '250');
        await sleep(800);
      }
    }
    await relaunch();
    if (!sawSha) {
      failures.push(
        `the running app reports ${saidInstead ?? 'no version at all'}, not ${sha}, after three ` +
          'launches. It is running whatever the channel serves, so this run tested a different ' +
          'bundle. Publish the OTA for this commit first, or disable updates for the test build.',
      );
    }

    // Pair the version actually being tested. The APK may predate persisted
    // server routes and ignore that part of the initial link before its OTA.
    // A cold link gives the updated bootstrap the full pairing payload.
    if (sawSha) {
      say('==> pairing the updated runtime');
      adb(
        'shell',
        'am',
        'start',
        '-S',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        deviceArg(link),
        PKG,
      );
      await sleep(10000);
      await relaunch();
    }

    // ---- the walk -------------------------------------------------------
    //
    // Discovered, not declared. Whatever navigation this build paints is what
    // gets visited, so a renamed tab is not a failure and a NEW tab is covered
    // the day it ships without anyone remembering to add it here.
    const nav = discoverNav(await screen());
    if (nav.length === 0) {
      failures.push(
        `no navigation found along the bottom of the screen — saw ${summarise(visibleText(await screen()))}`,
      );
    }
    say(`==> walking ${nav.length} destination(s): ${nav.map((n) => n.label).join(', ')}`);

    const visits = [];
    for (const dest of nav) {
      say(`==> ${dest.label}`);
      // A step that BLOWS UP is a failure like any other, not the end of the
      // run: the logcat scan below is the half that catches what no step was
      // looking for, and it must happen whatever the walk did.
      try {
        const failed = await openSettled(dest.label, io);
        if (failed !== null) {
          failures.push(failed);
          continue;
        }

        const front = foregroundPackage(shell('dumpsys window'));
        if (front !== PKG) {
          failures.push(
            `${dest.label}: opening it put ${front ?? 'something else'} in the foreground, not ${PKG}`,
          );
          // Recover, or every destination after this one is judged by whatever
          // app we wandered into — which is a wrong verdict, not a missing one.
          await relaunch();
          continue;
        }

        const verdict = judgeScreen(dest.label, visibleText(await screen()));
        if (!verdict.ok) failures.push(verdict.why);
        else visits.push({ label: dest.label, distinct: verdict.distinct });
      } catch (err) {
        failures.push(`${dest.label}: ${err.message}`);
      }
    }
    failures.push(...judgeWalk(visits));

    // A cold start is the state the app is usually opened in, and the one the
    // shipped render loop wedged. Assert it separately from the walk.
    try {
      await relaunch();
      const verdict = judgeScreen('cold start', visibleText(await screen()));
      if (!verdict.ok) failures.push(verdict.why);
    } catch (err) {
      failures.push(`cold start: ${err.message}`);
    }

    const violations = scanLog(adb('logcat', '-d'));
    for (const v of violations) {
      failures.push(`${v.why} (${v.count}×): ${v.example}${v.detail ? `\n${v.detail}` : ''}`);
    }
    return failures;
  } finally {
    if (emu) {
      try {
        adb('emu', 'kill');
      } catch {
        /* already gone */
      }
    }
  }
}

if (isMain(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`);
    return i < 0 ? undefined : process.argv[i + 1];
  };
  const apk = arg('apk');
  const sha = arg('sha');
  // NO FALLBACK: without a credential the app sits on the pairing camera and
  // every step below fails for a reason that has nothing to do with the build.
  const credential = process.env['PATCH_SMOKE_CREDENTIAL'];
  if (!apk || !sha || !credential) {
    process.stderr.write(
      'usage: PATCH_SMOKE_CREDENTIAL=<surface jwt> mobile-surface-smoke.mjs --apk <path|url> --sha <gitSha> [--avd <name>] [--server <origin>]\n',
    );
    process.exit(2);
  }
  const chosen = pickAvd(arg('avd') ?? process.env['PATCH_SMOKE_AVD'], listAvds());
  if (chosen.why !== undefined) {
    process.stderr.write(`mobile-surface-smoke: ${chosen.why}\n`);
    process.exit(2);
  }
  const failures = await run({
    apk,
    sha,
    avd: chosen.avd,
    credential,
    server: arg('server') ?? process.env['PATCH_SMOKE_SERVER'],
  });
  if (failures.length > 0) {
    process.stderr.write(`\nmobile surface smoke FAILED (${failures.length}):\n`);
    for (const f of failures) process.stderr.write(`  - ${f}\n`);
    process.exit(1);
  }
  process.stdout.write(
    '\nmobile surface smoke: every destination the app offers painted, no invariant violated\n',
  );
}
