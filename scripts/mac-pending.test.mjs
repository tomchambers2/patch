import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MacUnreachable,
  addPending,
  attemptDue,
  clearPending,
  describePending,
  markAttempt,
  readPending,
  settle,
} from './mac-pending.mjs';

const file = () => join(mkdtempSync(join(tmpdir(), 'mac-pending-')), 'nested', 'mac-pending.json');

test('nothing is owed until something is recorded', () => {
  assert.equal(readPending(file()), null);
  assert.equal(describePending(null), '');
});

test('surfaces for one commit accumulate in a fixed order', () => {
  const f = file();
  addPending(f, 'smoke', 'abc', 1);
  addPending(f, 'desktop', 'abc', 2);
  assert.deepEqual(readPending(f), { sha: 'abc', surfaces: ['desktop', 'smoke'], at: 2 });
});

test('a newer commit replaces what an older one owed', () => {
  const f = file();
  addPending(f, 'desktop', 'old', 1);
  addPending(f, 'smoke', 'new', 2);
  assert.deepEqual(readPending(f).surfaces, ['smoke']);
  assert.equal(readPending(f).sha, 'new');
});

test('clearing finished work leaves the rest, and the last one removes the record', () => {
  const f = file();
  addPending(f, 'desktop', 'abc');
  addPending(f, 'daemon-mac', 'abc');
  assert.deepEqual(clearPending(f, 'abc', ['desktop']).surfaces, ['daemon-mac']);
  assert.equal(clearPending(f, 'abc', ['daemon-mac']), null);
  assert.equal(readPending(f), null);
});

test('finishing an old commit does not clear debt for a newer one', () => {
  const f = file();
  addPending(f, 'desktop', 'new');
  assert.deepEqual(clearPending(f, 'old', ['desktop']).surfaces, ['desktop']);
});

test('a surface that is not Mac-only is refused, and a corrupt record is loud', () => {
  const f = file();
  assert.throws(() => addPending(f, 'web', 'abc'), /not a Mac surface/);
  addPending(f, 'desktop', 'abc');
  writeFileSync(f, '{"nope":1}');
  assert.throws(() => readPending(f), /not a pending record/);
});

test('MacUnreachable is distinguishable from a build failure', () => {
  const e = new MacUnreachable('asleep');
  assert.ok(e instanceof Error && e.name === 'MacUnreachable');
  assert.ok(!(new Error('x') instanceof MacUnreachable));
});

test('building a surface for the newest commit settles it whatever commit it was owed for', () => {
  const f = file();
  addPending(f, 'desktop', 'old');
  addPending(f, 'daemon-mac', 'old');
  assert.deepEqual(settle(f, 'desktop').surfaces, ['daemon-mac']);
  assert.equal(settle(f, 'daemon-mac'), null);
  assert.equal(settle(f, 'daemon-mac'), null); // nothing owed: no error
});

test('a catch-up that just ran is not repeated until the gap has passed', () => {
  const f = file();
  addPending(f, 'desktop', 'abc');
  assert.equal(attemptDue(readPending(f), 1000, 60_000), true);
  markAttempt(f, 1000);
  assert.equal(attemptDue(readPending(f), 30_000, 60_000), false);
  assert.equal(attemptDue(readPending(f), 61_000, 60_000), true);
  assert.equal(markAttempt(file(), 1), null);
});
