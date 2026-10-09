// The desktop app carries the Mac host build (stage-resources.cjs), so the
// deploy must build the host before it builds or packages the desktop shell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./ship.mjs', import.meta.url), 'utf8');
const desktopFn = src.slice(src.indexOf('function desktop(info)'));

test('desktop() builds the darwin-arm64 host before the desktop build', () => {
  const daemon = desktopFn.indexOf("['build:daemon']");
  const build = desktopFn.indexOf("'@patch/desktop', 'build'");
  const dist = desktopFn.indexOf("'@patch/desktop', 'dist'");
  assert.ok(daemon > 0, 'desktop() never runs build:daemon');
  assert.ok(daemon < build && build < dist);
  assert.match(desktopFn.slice(daemon, build), /PATCH_BUILD_TARGETS: 'darwin-arm64'/);
});
