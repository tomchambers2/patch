// The host's local control key (spec/02 § Control IPC, spec/10 § The
// authority of a turn).
//
// A turn runs with the host user's full authority. The control socket is an
// entry point to that authority — `/internal/*` is the MCP child's surface, and
// it spawns chats, fires notifications and edits jobs — so every route on it is
// gated. Same user, same machine remains the real boundary; the key closes the
// case where some OTHER process running as that user reaches the socket.
//
// The host is the only party that mints it. There is deliberately no way to
// supply one from outside: a configured key would outlive restarts and be
// readable wherever the config lives, neither of which is true of a value
// generated on each start.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localKeyPath, mintLocalKey } from '../src/localKey.js';
import { buildControl } from '../src/control.js';
import { Daemon } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import pino from 'pino';

const silent = pino({ level: 'silent' });

describe('mintLocalKey', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'patch-localkey-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('leaves no temp file behind when the rename fails, and rethrows', () => {
    // A non-empty directory at the key path makes rename() fail after the temp
    // file has already been created.
    mkdirSync(join(localKeyPath(home), 'blocker'), { recursive: true });
    expect(() => mintLocalKey(home)).toThrow();
    expect(readdirSync(home).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('leaves no temp file behind when the write fails, and rethrows', () => {
    // Temp path is a directory, so writeFileSync itself throws.
    mkdirSync(`${localKeyPath(home)}.${process.pid}.tmp`);
    expect(() => mintLocalKey(home)).toThrow();
  });

  it('removes stale temp files left by earlier runs', () => {
    writeFileSync(join(home, 'local.key.12345.tmp'), '');
    writeFileSync(join(home, 'local.key.67890.tmp'), '');
    writeFileSync(join(home, 'other.tmp'), '');
    mintLocalKey(home);
    expect(readdirSync(home).sort()).toEqual(['local.key', 'other.tmp']);
  });

  it('writes the key beside the socket at owner-only permissions', () => {
    const key = mintLocalKey(home);
    const path = localKeyPath(home);
    expect(path).toBe(join(home, 'local.key'));
    expect(readFileSync(path, 'utf8')).toBe(key);
    // 0600. Anything wider and any process on the box could read it, which is
    // the case the key exists to close.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('mints a fresh key on every start, replacing the previous one', () => {
    // Rotation is the point: a key from a previous run stops working the moment
    // the host it belonged to is gone, so a leaked value has the lifetime of
    // one host process rather than of the install.
    const first = mintLocalKey(home);
    const second = mintLocalKey(home);
    expect(second).not.toBe(first);
    expect(readFileSync(localKeyPath(home), 'utf8')).toBe(second);
  });

  it('creates the patch home when it does not exist yet', () => {
    const fresh = join(home, 'nested', '.patch');
    const key = mintLocalKey(fresh);
    expect(readFileSync(join(fresh, 'local.key'), 'utf8')).toBe(key);
  });

  it('produces a key with enough entropy to be worth having', () => {
    // 32 random bytes, base64url — not a guessable or enumerable value.
    const key = mintLocalKey(home);
    expect(key.length).toBeGreaterThanOrEqual(40);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('the control socket is gated as a whole', () => {
  let home: string;
  let folder: string;
  const KEY = 'the-daemons-minted-key';

  function setup() {
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: createMockSdkBackend(),
      oauthAccessToken: 'fake',
      emit: () => {},
      logger: silent,
    });
    return daemon;
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'patch-gate-home-'));
    folder = mkdtempSync(join(tmpdir(), 'patch-gate-folder-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  // `/internal/*` is where the authority is: patch_spawn starts a turn,
  // patch_notify fans a message out, patch_job_create writes a durable
  // schedule. These were reachable by any local process that could open the
  // socket while the read-only /chats listing beside them was gated.
  const authorityRoutes: Array<[string, 'GET' | 'POST']> = [
    ['/internal/chats', 'GET'],
    ['/internal/spawn', 'POST'],
    ['/internal/send-to', 'POST'],
    ['/internal/notify', 'POST'],
    ['/internal/jobs', 'POST'],
    ['/internal/wake', 'POST'],
    ['/internal/devices', 'GET'],
  ];

  it('refuses every authority-bearing route with no bearer', async () => {
    const app = await buildControl({ daemon: setup(), localKey: KEY });
    try {
      for (const [url, method] of authorityRoutes) {
        const res = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
        expect(res.statusCode, `${method} ${url} must refuse an unauthenticated caller`).toBe(401);
        expect(res.json().error).toBe('missing bearer');
      }
    } finally {
      await app.close();
    }
  });

  it('refuses every authority-bearing route with the WRONG bearer', async () => {
    const app = await buildControl({ daemon: setup(), localKey: KEY });
    try {
      for (const [url, method] of authorityRoutes) {
        const res = await app.inject({
          method,
          url,
          headers: { authorization: 'Bearer a-key-from-some-other-daemon' },
          payload: method === 'POST' ? {} : undefined,
        });
        expect(res.statusCode, `${method} ${url} must refuse a wrong key`).toBe(401);
        expect(res.json().error).toBe('bad key');
      }
    } finally {
      await app.close();
    }
  });

  it('refuses everything when the host has no key at all', async () => {
    // The safe direction. An unconfigured gate must not mean an open gate.
    const app = await buildControl({ daemon: setup() });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/chats',
        headers: { authorization: `Bearer ${KEY}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('local-key not configured');
    } finally {
      await app.close();
    }
  });

  it('lets /healthz through — it carries no authority and a service manager probes it', async () => {
    const app = await buildControl({ daemon: setup(), localKey: KEY });
    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('admits the caller presenting the daemon-minted key', async () => {
    const daemon = setup();
    const app = await buildControl({ daemon, localKey: KEY });
    try {
      await daemon.spawnChat({ folder });
      const res = await app.inject({
        method: 'GET',
        url: '/internal/chats',
        headers: { authorization: `Bearer ${KEY}` },
      });
      expect(res.statusCode).toBe(200);
      expect(Array.isArray(res.json().chats)).toBe(true);
    } finally {
      await app.close();
    }
  });

  // End-to-end of the documented flow: the host writes the key, and a caller
  // on that machine reads it from the file rather than being told it.
  it('a caller that reads ~/.patch/local.key is admitted', async () => {
    const patchHome = join(home, '.patch');
    mkdirSync(patchHome, { recursive: true });
    const minted = mintLocalKey(patchHome);
    const app = await buildControl({ daemon: setup(), localKey: minted });
    try {
      const fromFile = readFileSync(localKeyPath(patchHome), 'utf8').trim();
      const res = await app.inject({
        method: 'GET',
        url: '/internal/chats',
        headers: { authorization: `Bearer ${fromFile}` },
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  // A stale key is exactly what rotation is meant to invalidate.
  it('a key from the PREVIOUS start no longer opens the socket', async () => {
    const patchHome = join(home, '.patch');
    mkdirSync(patchHome, { recursive: true });
    const previousRun = mintLocalKey(patchHome);
    const thisRun = mintLocalKey(patchHome);
    const app = await buildControl({ daemon: setup(), localKey: thisRun });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/chats',
        headers: { authorization: `Bearer ${previousRun}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('bad key');
    } finally {
      await app.close();
    }
  });

  it('an empty local.key file leaves the socket shut, not open', async () => {
    const patchHome = join(home, '.patch');
    mkdirSync(patchHome, { recursive: true });
    mintLocalKey(patchHome);
    writeFileSync(localKeyPath(patchHome), '', { mode: 0o600 });
    const app = await buildControl({ daemon: setup(), localKey: 'a-real-key' });
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/internal/chats',
        headers: { authorization: 'Bearer ' },
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
