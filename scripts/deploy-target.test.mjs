// Where a deploy runs (scripts/deploy-target.mjs).
//
// Two failures are being guarded, and they pull in opposite directions:
//
//   1. A Mac running the deploy ITSELF. ship.mjs's `onMac()` path skips the test
//      gate, the lock and the pinned build tree, then rsyncs into /srv/patch —
//      a path a Mac does not have. Ungated, and shipping nowhere.
//   2. A Mac bouncing its own sub-step back to the box. The box delegates
//      `--only=desktop` here precisely because only this machine holds the
//      signing key; sending it back would be an infinite round trip.
//
// So every case below is really asking: is this a person, or is this the box?
//
// Run: node scripts/deploy-target.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deployTarget, parseOnly, publishPlan } from './deploy-target.mjs';

const mac = (over = {}) => deployTarget({ platform: 'darwin', ...over });
const box = (over = {}) => deployTarget({ platform: 'linux', ...over });

test('the box runs its own deploys, whatever the flags', () => {
  assert.equal(box({ only: undefined }), 'here');
  assert.equal(box({ only: 'web,server' }), 'here');
  assert.equal(box({ only: 'desktop' }), 'here');
});

test('a full deploy typed on a Mac goes to the box', () => {
  assert.equal(mac({ only: undefined }), 'box');
});

test('the sub-steps the box delegates to the Mac stay on the Mac', () => {
  // The signing key is here and nowhere else; bouncing these back is a loop.
  assert.equal(mac({ only: 'desktop' }), 'here');
  assert.equal(mac({ only: 'smoke' }), 'here');
  assert.equal(mac({ only: 'desktop,smoke' }), 'here');
});

test('a Mac asked for a box surface hands the whole thing over', () => {
  // `--only=web` on a Mac would otherwise rsync into a /srv/patch that is not
  // there, having skipped the gate on the way.
  assert.equal(mac({ only: 'web' }), 'box');
  assert.equal(mac({ only: 'server,daemon' }), 'box');
});

test('a mixed --only goes to the box, which owns the whole run', () => {
  // The box will delegate the desktop half back here itself.
  assert.equal(mac({ only: 'desktop,web' }), 'box');
});

test('a lane child never bounces — its parent already decided', () => {
  assert.equal(mac({ only: 'web', prepared: true }), 'here');
  assert.equal(mac({ only: undefined, prepared: true }), 'here');
});

test('an empty --only is the box’s to refuse, not something to run here', () => {
  assert.equal(mac({ only: '' }), 'box');
});

test('parseOnly separates "everything" from "nothing"', () => {
  assert.equal(parseOnly(undefined), null, 'absent means every surface');
  assert.deepEqual(parseOnly(''), []);
  assert.deepEqual(parseOnly('web, server ,'), ['web', 'server'], 'tolerates spacing and trailing');
});

// --- what the Mac must publish first ---------------------------------------

const plan = (over) =>
  publishPlan({
    head: 'aaa',
    origin: 'aaa',
    originIsAncestorOfHead: false,
    headIsAncestorOfOrigin: false,
    ...over,
  });

test('nothing to do when origin already has this commit', () => {
  assert.equal(plan({}).action, 'none');
});

test('commits made here and nowhere else are published, then shipped', () => {
  const p = plan({ head: 'bbb', origin: 'aaa', originIsAncestorOfHead: true });
  assert.equal(p.action, 'push');
  assert.equal(p.sha, 'bbb', 'and it is YOUR commit that ships, not origin');
});

test('being behind origin ships origin, and says what came with it', () => {
  const p = plan({ head: 'aaa', origin: 'ccc', headIsAncestorOfOrigin: true });
  assert.equal(p.action, 'ship-origin');
  assert.equal(p.sha, 'ccc');
  assert.ok(
    p.notes.some((n) => n.includes('behind origin/main')),
    'silently shipping other people’s commits is the thing to avoid',
  );
});

test('a diverged checkout is refused rather than guessed at', () => {
  // The box ships origin/main here and leaves local commits alone, because it is
  // shared scratch space. On a Mac there is a person waiting for THEIR change.
  const p = plan({ head: 'bbb', origin: 'ccc' });
  assert.equal(p.action, 'refuse');
  assert.equal(p.sha, null);
});

test('uncommitted work is reported every time, and blocks nothing', () => {
  // "I deployed and my change isn't in it" is the confusion this prevents.
  const p = plan({ dirty: ' M packages/web/src/App.tsx' });
  assert.equal(p.action, 'none', 'a dirty tree is not a reason to refuse');
  assert.ok(p.notes.some((n) => n.includes('NOT in this deploy')));
});

test('a clean tree says nothing about uncommitted work', () => {
  assert.deepEqual(plan({ dirty: '' }).notes, []);
});

test('a dirty tree is reported even when the commit itself is refused', () => {
  const p = plan({ head: 'bbb', origin: 'ccc', dirty: ' M x.ts' });
  assert.equal(p.action, 'refuse');
  assert.ok(p.notes.some((n) => n.includes('NOT in this deploy')));
});
