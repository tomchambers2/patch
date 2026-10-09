import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RETRY_GAP_MS, planCatchUp } from './mac-catch-up.mjs';

const rec = (surfaces, extra = {}) => ({ sha: 'abc', surfaces, at: 1, ...extra });

test('nothing owed means nothing to do', () => {
  assert.equal(planCatchUp(null, 'abc', 10).action, 'none');
});

test('owed surfaces are run', () => {
  const p = planCatchUp(rec(['daemon-mac', 'desktop']), 'abc', 10);
  assert.deepEqual([p.action, p.run, p.moot], ['run', ['daemon-mac', 'desktop'], []]);
});

test('a catch-up that just started is left alone until the gap passes', () => {
  const r = rec(['desktop'], { attemptedAt: 1000 });
  assert.equal(planCatchUp(r, 'abc', 1000 + RETRY_GAP_MS - 1).action, 'wait');
  assert.equal(planCatchUp(r, 'abc', 1000 + RETRY_GAP_MS).action, 'run');
});

test('smoke is only paid while its commit is still live', () => {
  const live = planCatchUp(rec(['desktop', 'smoke']), 'abc', 10);
  assert.deepEqual(live.run, ['desktop', 'smoke']);
  const moved = planCatchUp(rec(['desktop', 'smoke']), 'newer', 10);
  assert.deepEqual([moved.action, moved.run, moved.moot], ['run', ['desktop'], ['smoke']]);
});

test('when only superseded work is left it is dropped, not run', () => {
  const p = planCatchUp(rec(['smoke']), 'newer', 10);
  assert.deepEqual([p.action, p.moot], ['settle', ['smoke']]);
});
