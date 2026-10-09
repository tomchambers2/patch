// spec/05 § Window placement — the main window reopens where it was left.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSavedPlacement, resolvePlacement, type DisplayInfo } from './window-bounds';

const primary: DisplayInfo = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
const second: DisplayInfo = { id: 2, workArea: { x: 1920, y: 0, width: 1440, height: 900 } };
const DEFAULT = { width: 1200, height: 800 };

const saved = { x: 2000, y: 50, width: 1000, height: 700, displayId: 2, maximized: false };

test('parses what it wrote', () => {
  assert.deepEqual(parseSavedPlacement(JSON.stringify(saved)), saved);
});

test('missing or corrupt file is first-run, not an error', () => {
  assert.equal(parseSavedPlacement(undefined), undefined);
  assert.equal(parseSavedPlacement('{nope'), undefined);
  assert.equal(parseSavedPlacement('{"x":1}'), undefined);
  assert.equal(parseSavedPlacement(JSON.stringify({ ...saved, width: 0 })), undefined);
  assert.equal(parseSavedPlacement(JSON.stringify({ ...saved, x: 'a' })), undefined);
});

test('same position, size and display when that display is still there', () => {
  assert.deepEqual(resolvePlacement(saved, [primary, second], DEFAULT), {
    x: 2000,
    y: 50,
    width: 1000,
    height: 700,
    maximized: false,
  });
});

test('restores on the saved display even when another display is primary', () => {
  const r = resolvePlacement(saved, [second, primary], DEFAULT);
  assert.equal(r.x, 2000);
});

test('display gone: default size, centred on the primary display', () => {
  assert.deepEqual(resolvePlacement(saved, [primary], DEFAULT), {
    x: 360,
    y: 140,
    width: 1200,
    height: 800,
    maximized: false,
  });
});

test('no saved placement: default size, centred on primary', () => {
  assert.deepEqual(resolvePlacement(undefined, [primary], DEFAULT), {
    x: 360,
    y: 140,
    width: 1200,
    height: 800,
    maximized: false,
  });
});

test('display shrank: size and position are pulled into its work area', () => {
  const smaller: DisplayInfo = { id: 2, workArea: { x: 1920, y: 0, width: 800, height: 600 } };
  assert.deepEqual(resolvePlacement(saved, [primary, smaller], DEFAULT), {
    x: 1920,
    y: 0,
    width: 800,
    height: 600,
    maximized: false,
  });
});

test('maximised flag survives', () => {
  assert.equal(
    resolvePlacement({ ...saved, maximized: true }, [primary, second], DEFAULT).maximized,
    true,
  );
});
