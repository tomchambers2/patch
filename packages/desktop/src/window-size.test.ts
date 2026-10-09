// spec/14 § New windows — the size a renderer asks a new window to open at.
// The detached sidebar asks for a sidebar's width; a chat window asks for
// nothing and keeps the shell's ordinary size.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWindowSize } from './window-size';

test('passes a real size through', () => {
  assert.deepEqual(parseWindowSize({ width: 360, height: 800 }), { width: 360, height: 800 });
});

test('asking for no size is not an error — the shell uses its own default', () => {
  assert.equal(parseWindowSize(undefined), undefined);
  assert.equal(parseWindowSize(null), undefined);
});

test('refuses a size Electron would throw on, rather than opening a broken window', () => {
  assert.equal(parseWindowSize({ width: Number.NaN, height: 800 }), undefined);
  assert.equal(parseWindowSize({ width: Number.POSITIVE_INFINITY, height: 800 }), undefined);
  assert.equal(parseWindowSize({ width: 0, height: 800 }), undefined);
  assert.equal(parseWindowSize({ width: -360, height: 800 }), undefined);
  assert.equal(parseWindowSize({ width: '360', height: 800 }), undefined);
  assert.equal(parseWindowSize({ height: 800 }), undefined);
  assert.equal(parseWindowSize('360x800'), undefined);
});

test('rounds — a window is whole pixels', () => {
  assert.deepEqual(parseWindowSize({ width: 360.6, height: 799.4 }), { width: 361, height: 799 });
});
