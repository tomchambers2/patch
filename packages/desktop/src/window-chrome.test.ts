// spec/05 § Desktop packaging (Electron) → Window chrome. The main window and
// every child window drop the native title bar so the SPA reaches the top edge
// (Tom, App Updates: "clean at top, no patch top bar"), and the renderer keeps
// the traffic lights' strip clear.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  overlayTitleBarSupported,
  windowChrome,
  TRAFFIC_LIGHT_DIAMETER,
  TRAFFIC_LIGHT_INSET,
  TRAFFIC_LIGHT_POSITION,
} from './window-chrome';

/** The renderer's stylesheet — the far side of every mirrored constant here. */
function readCss(): string {
  return readFileSync(join(__dirname, '..', '..', 'web', 'src', 'index.css'), 'utf8');
}

test('macOS hides the title bar so the window content starts at the top edge', () => {
  assert.equal(overlayTitleBarSupported('darwin'), true);
  assert.deepEqual(windowChrome('darwin'), {
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 18, y: 31 },
  });
});

test('hidden, NOT frameless — the traffic lights survive, so the window can still be closed', () => {
  // `frame: false` would remove close/minimise/zoom outright, and Patch's ⌘W
  // only hides the main window. Whatever else this config says, it must never
  // be the frameless variant.
  const chrome = windowChrome('darwin') as Record<string, unknown>;
  assert.equal(chrome['frame'], undefined, 'must not set frame — that drops the traffic lights');
  assert.equal(chrome['titleBarStyle'], 'hidden');
});

test('other platforms keep their native frame rather than lose every window control', () => {
  // On Windows/Linux `titleBarStyle: 'hidden'` removes the controls and puts
  // nothing back, so a window opened that way cannot be closed at all.
  for (const platform of ['linux', 'win32', 'freebsd']) {
    assert.equal(overlayTitleBarSupported(platform), false, platform);
    assert.deepEqual(windowChrome(platform), {}, platform);
  }
});

test('the traffic-light strip is wide enough for the lights it has to clear', () => {
  // Three 12px buttons on a 20px pitch from x, i.e. x + 52 is their right edge.
  const lightsEnd = TRAFFIC_LIGHT_POSITION.x + 52;
  assert.ok(
    TRAFFIC_LIGHT_INSET > lightsEnd,
    `inset ${TRAFFIC_LIGHT_INSET} must clear the lights (they end at ${lightsEnd})`,
  );
});

test('the preload duplicates the platform rule rather than importing it', () => {
  // preload.ts runs in a SANDBOXED renderer, where `require` resolves only
  // `electron` and a handful of Node builtins. Importing this module there
  // throws, and the throw kills the ENTIRE bridge: `window.patch` is never
  // exposed, so notifications, voice hotkeys, open-in-new-window and the
  // updater panel all stop at once with no error anyone sees. (Caught exactly
  // that way — smoke-integration's `preload-exposes-patch-bridge` went red.)
  // So the rule is copied, and this is what keeps the copy honest.
  const preload = readFileSync(join(__dirname, 'preload.ts'), 'utf8');
  assert.doesNotMatch(
    preload,
    /from '\.\/window-chrome'/,
    'preload must not require a relative module — it is sandboxed',
  );
  assert.match(preload, /overlayTitleBar:\s*process\.platform === 'darwin'/);
  // ...and that the copy still says the same thing as the original.
  assert.equal(overlayTitleBarSupported('darwin'), true);
  assert.equal(overlayTitleBarSupported('linux'), false);
});

test("the window controls sit on the brand row's centre-line, not above it", () => {
  // `y` is the lights' TOP; the stylesheet records where the brand row's
  // centre-line actually falls. Mirrored by hand for the same reason the inset
  // is — the renderer cannot import this module.
  const css = readCss();
  const declared = /--overlay-titlebar-lights-centre:\s*(\d+)px/.exec(css);
  assert.ok(declared, '--overlay-titlebar-lights-centre not found in packages/web/src/index.css');
  assert.equal(TRAFFIC_LIGHT_POSITION.y + TRAFFIC_LIGHT_DIAMETER / 2, Number(declared[1]));
});

test('the stylesheet knows where the lights end, not just where they centre', () => {
  // A banner sized only against the centre-line can still fall short of the
  // lights' BOTTOM edge and cut them at the seam with whatever renders next
  // (Tom, App Updates: "window controls are overlapped by the green banner").
  // This is the number that guards against that regression.
  const css = readCss();
  const declared = /--overlay-titlebar-lights-bottom:\s*(\d+)px/.exec(css);
  assert.ok(declared, '--overlay-titlebar-lights-bottom not found in packages/web/src/index.css');
  assert.equal(TRAFFIC_LIGHT_POSITION.y + TRAFFIC_LIGHT_DIAMETER, Number(declared[1]));
});

test('the renderer reserves exactly the strip this module claims', () => {
  // The SPA is a separate bundle served over HTTP and cannot import
  // TRAFFIC_LIGHT_INSET, so the number is duplicated in its stylesheet. This is
  // the guard that stops the two drifting: a shifted traffic-light position
  // with a stale CSS inset puts the lights back on top of the wordmark, which
  // no test in packages/web could notice.
  const css = readCss();
  const declared = /--overlay-titlebar-inset:\s*(\d+)px/.exec(css);
  assert.ok(declared, '--overlay-titlebar-inset not found in packages/web/src/index.css');
  assert.equal(Number(declared[1]), TRAFFIC_LIGHT_INSET);
});
