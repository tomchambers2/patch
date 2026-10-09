// Unit tests for the desktop shell's browser-permission gate.
//
// Registering ANY permission handler replaces Electron's own defaults, so this
// gate decides every permission the renderer asks for, not just the one it was
// first written for. Two things depend on it:
//   - the mic — getUserMedia({ audio: true }) for voice notes
//     (lib/voiceRecorder) and voice calls (lib/audioSession), which Electron
//     denies by default ("Voice not working yet");
//   - the clipboard WRITE — navigator.clipboard.writeText() behind the code
//     block copy control and Copy report, which a registered handler denied
//     until it was allowlisted, so both buttons showed "Copy failed" in the
//     packaged app while working perfectly in a browser.
// decidePermission is the pure, electron-runtime-free decision;
// configurePermissions wires it onto a session's request/check handlers so we
// can assert on it WITHOUT booting Electron (same seam-and-fake pattern as
// context-menu).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_PERMISSIONS,
  decidePermission,
  configurePermissions,
  type PermissionSession,
} from './permissions';

const APP = 'https://patch.tomchambers.me';

test('grants the microphone (media) permission for the app origin', () => {
  assert.equal(decidePermission('media', 'https://patch.tomchambers.me', APP), true);
});

test('grants media when the requesting URL carries a path/query under the app origin', () => {
  assert.equal(
    decidePermission('media', 'https://patch.tomchambers.me/app/?credential=x', APP),
    true,
  );
});

test('denies media from a foreign origin (NO blanket approval)', () => {
  assert.equal(decidePermission('media', 'https://evil.example.com', APP), false);
});

test('grants a clipboard WRITE for the app origin (the copy button)', () => {
  // clipboard-sanitized-write is the only name Electron 33 surfaces for a
  // clipboard write, on either handler.
  assert.equal(decidePermission('clipboard-sanitized-write', APP, APP), true);
  assert.equal(
    decidePermission('clipboard-sanitized-write', 'https://patch.tomchambers.me/app/#/chats', APP),
    true,
  );
  assert.ok(ALLOWED_PERMISSIONS.includes('clipboard-sanitized-write'));
});

test('denies a clipboard write from a foreign origin', () => {
  assert.equal(
    decidePermission('clipboard-sanitized-write', 'https://evil.example.com', APP),
    false,
  );
  assert.equal(decidePermission('clipboard-sanitized-write', 'file:///tmp/x.html', APP), false);
  assert.equal(decidePermission('clipboard-sanitized-write', '', APP), false);
});

test('denies READING the clipboard from EVERY origin, including the app itself', () => {
  // A different privilege — it hands the page whatever the user last copied —
  // and nothing in Patch needs it. Only the write side is allowed.
  for (const origin of [APP, 'https://patch.tomchambers.me/app/', 'https://evil.example.com']) {
    assert.equal(decidePermission('clipboard-read', origin, APP), false);
    assert.equal(decidePermission('deprecated-sync-clipboard-read', origin, APP), false);
  }
  assert.ok(!ALLOWED_PERMISSIONS.includes('clipboard-read'));
  assert.ok(!ALLOWED_PERMISSIONS.includes('clipboard-read-write'));
});

test('denies every other permission even from the app origin', () => {
  for (const permission of [
    'geolocation',
    'notifications',
    'openExternal',
    'midi',
    'midiSysex',
    'hid',
    'usb',
    'serial',
    'idle-detection',
    'window-management',
    'storage-access',
    'fullscreen',
    'pointerLock',
    'display-capture',
    'unknown',
  ]) {
    assert.equal(decidePermission(permission, APP, APP), false, `${permission} must be denied`);
  }
});

/** A fake Electron session that captures the handlers configurePermissions registers. */
function fakeSession(): PermissionSession & {
  requestHandler: Parameters<PermissionSession['setPermissionRequestHandler']>[0];
  checkHandler: Parameters<PermissionSession['setPermissionCheckHandler']>[0];
} {
  const s = {
    requestHandler: null as Parameters<PermissionSession['setPermissionRequestHandler']>[0],
    checkHandler: null as Parameters<PermissionSession['setPermissionCheckHandler']>[0],
    setPermissionRequestHandler(
      h: Parameters<PermissionSession['setPermissionRequestHandler']>[0],
    ) {
      s.requestHandler = h;
    },
    setPermissionCheckHandler(h: Parameters<PermissionSession['setPermissionCheckHandler']>[0]) {
      s.checkHandler = h;
    },
  };
  return s;
}

/** Ask the registered REQUEST handler for a decision. */
function request(
  s: ReturnType<typeof fakeSession>,
  permission: string,
  requestingUrl: string,
): boolean | undefined {
  let granted: boolean | undefined;
  s.requestHandler!({}, permission, (ok: boolean) => (granted = ok), { requestingUrl });
  return granted;
}

test('configurePermissions registers BOTH the request and check handlers', () => {
  const s = fakeSession();
  configurePermissions(s, APP);
  assert.equal(typeof s.requestHandler, 'function');
  assert.equal(typeof s.checkHandler, 'function');
});

test('the registered request handler approves a mic request from the app origin', () => {
  const s = fakeSession();
  configurePermissions(s, APP);
  assert.equal(request(s, 'media', 'https://patch.tomchambers.me/app/'), true);
});

test('the registered request handler refuses a mic request from a foreign origin', () => {
  const s = fakeSession();
  configurePermissions(s, APP);
  assert.equal(request(s, 'media', 'https://evil.example.com/app/'), false);
});

test('the registered request handler approves a clipboard write from the app origin', () => {
  const s = fakeSession();
  configurePermissions(s, APP);
  assert.equal(request(s, 'clipboard-sanitized-write', 'https://patch.tomchambers.me/app/'), true);
});

test('the registered request handler refuses a clipboard write from a foreign origin', () => {
  const s = fakeSession();
  configurePermissions(s, APP);
  assert.equal(request(s, 'clipboard-sanitized-write', 'https://evil.example.com/'), false);
});

test('the registered request handler refuses a clipboard READ from the app origin', () => {
  const s = fakeSession();
  configurePermissions(s, APP);
  assert.equal(request(s, 'clipboard-read', 'https://patch.tomchambers.me/app/'), false);
});

test('the registered request handler refuses a non-allowlisted permission', () => {
  const s = fakeSession();
  configurePermissions(s, APP);
  assert.equal(request(s, 'geolocation', 'https://patch.tomchambers.me/app/'), false);
});

test('the registered check handler mirrors the same decision', () => {
  const s = fakeSession();
  configurePermissions(s, APP);
  assert.equal(
    s.checkHandler!({}, 'media', 'https://patch.tomchambers.me', { securityOrigin: APP }),
    true,
  );
  assert.equal(
    s.checkHandler!({}, 'media', 'https://evil.example.com', {
      securityOrigin: 'https://evil.example.com',
    }),
    false,
  );
});

test('the registered check handler approves a clipboard write from the app origin', () => {
  // A clipboard write is decided HERE: writeText() asks Chromium to check the
  // permission rather than prompting, so a check handler that says no is the
  // rejected promise behind "Copy failed".
  const s = fakeSession();
  configurePermissions(s, APP);
  assert.equal(
    s.checkHandler!({}, 'clipboard-sanitized-write', APP, { securityOrigin: APP }),
    true,
  );
  assert.equal(
    s.checkHandler!({}, 'clipboard-sanitized-write', 'https://evil.example.com', {
      securityOrigin: 'https://evil.example.com',
    }),
    false,
  );
  assert.equal(s.checkHandler!({}, 'clipboard-read', APP, { securityOrigin: APP }), false);
});
