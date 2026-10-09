// Unit tests for the tray-icon click decision (menu-bar open/close toggle).
//
// Regression: patch/todo.md "Second click of Patch menu bar opens it — should
// just close the menu bar app." The naive toggle `isVisible() ? hide() : show()`
// races the popover's blur-driven auto-hide: clicking the tray while the popover
// is open ALSO blurs it, and when the blur-hide lands before the click reads
// isVisible() the click RE-OPENS a popover the user was closing. decideTrayClick
// is a pure, deterministic decision we can assert on WITHOUT booting Electron.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideTrayClick } from './tray-toggle';

test('visible popover → hide (the normal "second click closes it")', () => {
  assert.equal(decideTrayClick({ visible: true, hiddenAt: 0, now: 1_000 }), 'hide');
});

test('a visible popover always hides, even right after being shown', () => {
  // hiddenAt is stale (long ago) but the popover is visible now → hide wins.
  assert.equal(decideTrayClick({ visible: true, hiddenAt: 10, now: 5_000 }), 'hide');
});

test('hidden popover, never shown before (hiddenAt 0) → show', () => {
  assert.equal(decideTrayClick({ visible: false, hiddenAt: 0, now: 5_000 }), 'show');
});

test('hidden popover, closed long ago → show (legitimate reopen)', () => {
  // 5s since it was hidden — the user is intentionally reopening it.
  assert.equal(
    decideTrayClick({ visible: false, hiddenAt: 0, now: 5_000, recentHideMs: 300 }),
    'show',
  );
  assert.equal(decideTrayClick({ visible: false, hiddenAt: 1_000, now: 5_000 }), 'show');
});

test('hidden popover, closed just now by this same click gesture → noop (do NOT reopen)', () => {
  // The blur from THIS click already hid it; reopening is the reported bug.
  assert.equal(decideTrayClick({ visible: false, hiddenAt: 1_000, now: 1_050 }), 'noop');
  assert.equal(
    decideTrayClick({ visible: false, hiddenAt: 1_000, now: 1_299, recentHideMs: 300 }),
    'noop',
  );
});

test('recentHideMs is the boundary: at/after the window it reopens, before it stays closed', () => {
  // now - hiddenAt === recentHideMs is NOT recent (boundary is exclusive) → show.
  assert.equal(
    decideTrayClick({ visible: false, hiddenAt: 1_000, now: 1_300, recentHideMs: 300 }),
    'show',
  );
  // one ms inside the window → noop.
  assert.equal(
    decideTrayClick({ visible: false, hiddenAt: 1_000, now: 1_299, recentHideMs: 300 }),
    'noop',
  );
});

test('recentHideMs defaults to a value larger than the blur grace period (200ms)', () => {
  // Without an explicit recentHideMs, a click 250ms after the hide must still be
  // treated as the same close gesture (blur grace is 200ms), so: noop, not show.
  assert.equal(decideTrayClick({ visible: false, hiddenAt: 1_000, now: 1_250 }), 'noop');
});

test('custom recentHideMs is honoured', () => {
  assert.equal(
    decideTrayClick({ visible: false, hiddenAt: 1_000, now: 1_050, recentHideMs: 40 }),
    'show',
  );
  assert.equal(
    decideTrayClick({ visible: false, hiddenAt: 1_000, now: 1_030, recentHideMs: 40 }),
    'noop',
  );
});
