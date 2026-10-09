// Agent-notification log + REST (spec/09 § bell).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';
import { NotificationLog, NOTIFICATION_LOG_CAP } from '../src/notifications/log.js';

describe('NotificationLog', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-nlog-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const logger = pino({ level: 'silent' });
  const e = (message: string) => ({ chatId: 'c1', message, importance: 'normal' as const });

  it('lists newest first, tracks unread, and persists read state', () => {
    const a = new NotificationLog({ dataDir: dir, logger });
    const first = a.add(e('one'));
    a.add(e('two'));
    expect(a.snapshot().items.map((i) => i.message)).toEqual(['two', 'one']);
    expect(a.snapshot().unread).toBe(2);
    a.markRead({ ids: [first.id] });
    expect(a.snapshot().unread).toBe(1);
    const b = new NotificationLog({ dataDir: dir, logger });
    expect(b.snapshot().unread).toBe(1);
    expect(b.snapshot().items.find((i) => i.id === first.id)?.readAt).not.toBeNull();
    b.markRead({ all: true });
    expect(b.snapshot().unread).toBe(0);
  });

  it('caps at 200, dropping read entries before unread ones', () => {
    const l = new NotificationLog({ logger });
    const keep = l.add(e('unread-oldest'));
    const read = l.add(e('read'));
    l.markRead({ ids: [read.id] });
    for (let i = 0; i < NOTIFICATION_LOG_CAP - 1; i++) l.add(e(`n${i}`));
    const items = l.snapshot().items;
    expect(items).toHaveLength(NOTIFICATION_LOG_CAP);
    expect(items.some((i) => i.id === keep.id)).toBe(true);
    expect(items.some((i) => i.id === read.id)).toBe(false);
  });

  it('reads a corrupt file as empty instead of throwing, and rewrites atomically', () => {
    writeFileSync(join(dir, 'notifications.json'), '{not json');
    const l = new NotificationLog({ dataDir: dir, logger });
    expect(l.snapshot()).toEqual({ items: [], unread: 0 });
    l.add(e('x'));
    expect(JSON.parse(readFileSync(join(dir, 'notifications.json'), 'utf8'))).toHaveLength(1);
  });

  it('calls onChange with the unread count', () => {
    const seen: number[] = [];
    const l = new NotificationLog({ logger, onChange: (s) => seen.push(s.unread) });
    l.add(e('x'));
    l.markRead({ all: true });
    expect(seen).toEqual([1, 0]);
  });
});

describe('notification REST', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-nlog-routes-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function boot() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(22));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-n',
      surfaceKind: 'terminal',
      label: 'cli',
      issuedAt: 1,
    });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-n',
      surfaceKind: 'terminal',
      label: 'cli',
    });
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink });
    return { jwt, built, daemonLink };
  }

  it('records agent notifies (not call rings), serves them and marks them read', async () => {
    const { jwt, built, daemonLink } = await boot();
    const auth = { authorization: `Bearer ${jwt}` };
    try {
      expect(
        (await built.app.inject({ method: 'GET', url: '/api/notifications' })).statusCode,
      ).toBe(401);
      daemonLink.emit({
        type: 'notify',
        chatId: 'chat-a',
        message: 'washing done',
        priority: 'urgent',
        deepLink: 'x://y',
        channel: 'speakers',
      });
      daemonLink.emit({
        type: 'notify',
        chatId: 'chat-a',
        message: 'ring',
        kind: 'call',
        channel: 'speakers',
      });
      let res = await built.app.inject({ method: 'GET', url: '/api/notifications', headers: auth });
      const body = res.json();
      expect(body.unread).toBe(1);
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        chatId: 'chat-a',
        message: 'washing done',
        importance: 'urgent',
        deepLink: 'x://y',
        readAt: null,
      });
      res = await built.app.inject({
        method: 'POST',
        url: '/api/notifications/read',
        headers: auth,
        payload: { ids: [body.items[0].id] },
      });
      expect(res.json().unread).toBe(0);
      expect(res.json().items[0].readAt).toEqual(expect.any(Number));
      res = await built.app.inject({
        method: 'POST',
        url: '/api/notifications/read',
        headers: auth,
        payload: { bogus: 1 },
      });
      expect(res.statusCode).toBe(400);
      res = await built.app.inject({
        method: 'POST',
        url: '/api/notifications/read',
        headers: auth,
        payload: { all: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().unread).toBe(0);
    } finally {
      await built.app.close();
    }
  });
});
