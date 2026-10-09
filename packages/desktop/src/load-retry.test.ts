// A transient 502 must not leave the desktop shell on an error page for ever.
//
// Every real 502 on patch.tomchambers.me since 13 Sep 2026 is in the caddy
// journal in the same second as a `patch-server` restart, with
// `dial tcp [::1]:3000: connection refused`. The server heals in a second or
// two; the desktop shell does not, because a failed DOCUMENT load leaves
// Chromium's own error page and nothing retries it. That is the whole of "prod
// app failing with 502 on desktop" — the same fault as an in-chat error that
// never clears, one layer down.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ERR_ABORTED, LOAD_RETRY_BACKOFF_MS, loadRetryDelay, shouldRetryLoad } from './load-retry';

test('the first retry lands inside the window a server restart takes', () => {
  // A restart is out for ~1-2s. A first step longer than that would show the
  // error page for the whole outage and then some.
  assert.ok(loadRetryDelay(1)! <= 500);
});

test('the ladder widens and then stops — a dead server looks dead', () => {
  const steps = LOAD_RETRY_BACKOFF_MS.map((_, i) => loadRetryDelay(i + 1));
  assert.deepEqual(steps, [...LOAD_RETRY_BACKOFF_MS]);
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i]! > steps[i - 1]!);
  // NO FALLBACK to an endless silent loop: past the end, the failure stands.
  assert.equal(loadRetryDelay(LOAD_RETRY_BACKOFF_MS.length + 1), null);
});

test('a 502 on the main frame is retried', () => {
  // ERR_CONNECTION_REFUSED / a 5xx-backed failed load.
  assert.equal(shouldRetryLoad(-102, true), true);
});

test('a cancelled navigation is not a failure', () => {
  // ERR_ABORTED fires when `loadURL` supersedes an in-flight load — retrying
  // would fight the navigation that replaced it.
  assert.equal(shouldRetryLoad(ERR_ABORTED, true), false);
});

test('a broken subframe never re-dials the whole window', () => {
  // The app LOADED; throwing it away to fix an image inside it is worse.
  assert.equal(shouldRetryLoad(-102, false), false);
});

test('the main window arms the retry, and a completed load resets the ladder', () => {
  // The reset is what makes the error state CLEAR itself: without it, a second
  // blip hours later resumes at the ceiling and looks stuck.
  const src = readFileSync(join(__dirname, 'main.ts'), 'utf8');
  assert.match(src, /attachLoadRetry\(win, SERVER_URL\)/);
  assert.match(src, /did-fail-load/);
  assert.match(src, /win\.webContents\.on\('did-finish-load', \(\) => \{\s*attempt = 0;/);
});

test('a renderer crash ("white screen and needs refreshing") reloads the window, not just a failed navigation', () => {
  // did-fail-load only fires for a failed DOCUMENT LOAD. A renderer that dies
  // after the document already loaded (OOM, GPU fault) fires
  // render-process-gone instead, and nothing reloaded the window for that
  // case — it sat blank until Tom refreshed it himself.
  const src = readFileSync(join(__dirname, 'main.ts'), 'utf8');
  assert.match(src, /win\.webContents\.on\('render-process-gone', \(_event, details\) => \{/);
  // A deliberate/clean exit isn't a crash — must not reload over it.
  assert.match(src, /if \(details\.reason === 'clean-exit'\) return;/);
  const body = src.slice(
    src.indexOf("win.webContents.on('render-process-gone'"),
    src.indexOf("win.webContents.on('render-process-gone'") + 1200,
  );
  assert.match(body, /win\.loadURL\(url\)/);
});
