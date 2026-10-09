// Run: node scripts/crash-report.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCrashReporter } from './crash-report.mjs';

/** A reporter wired to spies, plus the record of what it did. */
function harness(commit = null) {
  const sent = [];
  const exits = [];
  const logged = [];
  const report = makeCrashReporter({
    notify: (title, message, priority) => sent.push({ title, message, priority }),
    currentCommit: () => commit,
    exit: (code) => exits.push(code),
    log: (line) => logged.push(line),
  });
  return { report, sent, exits, logged };
}

const COMMIT = { version: '0.1.858', gitSha: 'd936bd08' };

test('a gate failure notifies instead of dying silently', () => {
  // The lived failure: testGate() throws, the throw unwinds past the reporting
  // at the end of ship.mjs, and the detached run exits with nobody watching.
  const h = harness(COMMIT);
  h.report(new Error('Command failed: node scripts/verify.mjs'));

  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].title, 'Patch deploy FAILED');
  assert.match(h.sent[0].message, /scripts\/verify\.mjs/);
});

test('the notification names the commit that failed', () => {
  const h = harness(COMMIT);
  h.report(new Error('boom'));
  assert.match(h.sent[0].message, /0\.1\.858 \/ d936bd08/);
});

test('it goes out at high priority — a dead deploy is not an FYI', () => {
  const h = harness(COMMIT);
  h.report(new Error('boom'));
  assert.equal(h.sent[0].priority, 'high');
});

test('a crash before the commit is resolved still reports', () => {
  // Installed before `const info`, so there may be no sha to name. Saying so
  // beats "undefined / undefined", and beats saying nothing at all.
  const h = harness(null);
  h.report(new Error('build-tree pin died'));

  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].message, /before the commit was resolved/);
  assert.doesNotMatch(h.sent[0].message, /undefined/);
});

test('the run still dies non-zero — this reports, it does not rescue', () => {
  const h = harness(COMMIT);
  h.report(new Error('boom'));
  assert.deepEqual(h.exits, [1]);
});

test('a rejection carrying a non-Error is still readable', () => {
  // `unhandledRejection` can hand over anything at all.
  const h = harness(COMMIT);
  h.report('lane mac exited 255');
  assert.match(h.sent[0].message, /lane mac exited 255/);

  const h2 = harness(COMMIT);
  h2.report(undefined);
  assert.equal(h2.sent.length, 1);
});

test('the stack reaches the log, so the detached log says where it broke', () => {
  const h = harness(COMMIT);
  const err = new Error('Command failed: node scripts/verify.mjs');
  h.report(err);
  assert.match(h.logged.join('\n'), /DEPLOY FAILED/);
  assert.match(h.logged.join('\n'), /crash-report\.test\.mjs/);
});
