// Run: node scripts/same-commit.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameCommit } from './same-commit.mjs';

test('two different abbreviation LENGTHS of one commit match', () => {
  // The lived failure: the Mac stamps 7, the box stamps 8.
  assert.equal(sameCommit('64782ae', '64782aef'), true);
  assert.equal(sameCommit('64782aef', '64782ae'), true);
});

test('the same abbreviation matches itself', () => {
  assert.equal(sameCommit('64782aef', '64782aef'), true);
});

test('different commits do not match, however similar', () => {
  assert.equal(sameCommit('64782aef', '64782abf'), false);
  assert.equal(sameCommit('64782ae', '64782ab'), false);
});

test('a stamp shorter than a real abbreviation never passes', () => {
  // Otherwise a surface reporting "64782" — or nothing much — would verify
  // against anything starting with it.
  assert.equal(sameCommit('64782', '64782aef'), false);
  assert.equal(sameCommit('', '64782aef'), false);
});

test('a missing or non-sha stamp is not a match', () => {
  assert.equal(sameCommit(undefined, '64782aef'), false);
  assert.equal(sameCommit('no update on production', '64782aef'), false);
  assert.equal(sameCommit(null, null), false);
});
