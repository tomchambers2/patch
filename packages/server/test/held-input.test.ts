// A person's message to a chat whose host is offline is held by the server and
// delivered when the host comes back. It has to survive a server restart.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import { decode, type WireEvent } from '@patch/wire';
import { InboundDaemonLink } from '../src/daemon-link.js';
import { HeldInputStore, HELD_INPUT_MAX_AGE_MS } from '../src/held-input-store.js';

const logger = pino({ level: 'silent' });

class FakeSocket extends EventEmitter {
  sent: WireEvent[] = [];
  send(data: string | Buffer): void {
    this.sent.push(decode(Buffer.from(data)));
  }
  close(): void {
    this.emit('close');
  }
}

const input = (localId: string): WireEvent =>
  ({
    type: 'chat.input',
    chatId: 'c1',
    message: `text ${localId}`,
    localId,
  }) as WireEvent;

describe('messages held for an offline host', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-held-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const makeLink = (now?: () => number) =>
    new InboundDaemonLink({
      logger,
      heldInputs: new HeldInputStore({ dataDir: dir, logger, ...(now ? { now } : {}) }),
    });

  it('delivers a message sent while the host was offline once it attaches', () => {
    const link = makeLink();
    link.sendTo('d1', 'srf-1', input('L1'));
    const socket = new FakeSocket();
    link.attach(socket as never, 'd1');
    expect(socket.sent.map((e) => (e as { localId: string }).localId)).toEqual(['L1']);
  });

  it('still delivers it after the server restarted in between', () => {
    makeLink().sendTo('d1', 'srf-1', input('L1'));
    makeLink().sendTo('d1', 'srf-1', input('L2'));

    const restarted = makeLink();
    const socket = new FakeSocket();
    restarted.attach(socket as never, 'd1');
    expect(socket.sent.map((e) => (e as { localId: string }).localId)).toEqual(['L1', 'L2']);
  });

  it('does not deliver a message twice across a restart once the host took it', () => {
    const link = makeLink();
    link.sendTo('d1', 'srf-1', input('L1'));
    link.attach(new FakeSocket() as never, 'd1');

    const restarted = makeLink();
    const socket = new FakeSocket();
    restarted.attach(socket as never, 'd1');
    expect(socket.sent).toEqual([]);
  });

  it("holds only a person's message, not every control frame", () => {
    const link = makeLink();
    link.sendTo('d1', 'srf-1', { type: 'chat.stop_request', chatId: 'c1' } as WireEvent);
    const socket = new FakeSocket();
    makeLink().attach(socket as never, 'd1');
    expect(socket.sent).toEqual([]);
  });

  it('forgetting a host drops what was held for it', () => {
    const link = makeLink();
    link.sendTo('d1', 'srf-1', input('L1'));
    link.forget('d1');
    const socket = new FakeSocket();
    makeLink().attach(socket as never, 'd1');
    expect(socket.sent).toEqual([]);
  });

  it('does not deliver a message that waited longer than the limit', () => {
    let now = 1_000;
    makeLink(() => now).sendTo('d1', 'srf-1', input('L1'));
    now += HELD_INPUT_MAX_AGE_MS + 1;
    const socket = new FakeSocket();
    makeLink(() => now).attach(socket as never, 'd1');
    expect(socket.sent).toEqual([]);
  });

  it('starts empty and says so when the held file is damaged', () => {
    writeFileSync(join(dir, 'held-input.json'), '{not json');
    const socket = new FakeSocket();
    makeLink().attach(socket as never, 'd1');
    expect(socket.sent).toEqual([]);
  });

  it('stamps a message with the real clock when it is not given one', () => {
    const before = Date.now();
    const store = new HeldInputStore({ dataDir: dir, logger });
    store.add('d1', 'srf-1', input('L1'));
    const [held] = store.all();
    expect(held!.at).toBeGreaterThanOrEqual(before);
    expect(held!.at).toBeLessThanOrEqual(Date.now());
  });

  it('keeps messages in memory only when it has no data directory', () => {
    const store = new HeldInputStore({ logger });
    store.add('d1', 'srf-1', input('L1'));
    expect(store.all()).toHaveLength(1);
    store.clearHost('d1');
    expect(store.all()).toEqual([]);
  });

  it('clearing a host that holds nothing writes nothing', () => {
    const store = new HeldInputStore({ dataDir: dir, logger });
    store.add('d1', 'srf-1', input('L1'));
    store.clearHost('someone-else');
    expect(store.all()).toHaveLength(1);
    expect(new HeldInputStore({ dataDir: dir, logger }).all()).toHaveLength(1);
  });

  it('says so, and keeps the message in memory, when it cannot write its file', () => {
    const warned: string[] = [];
    const store = new HeldInputStore({
      dataDir: join(dir, 'not', 'a', 'directory'),
      logger: { warn: (_o, m) => warned.push(String(m)) },
    });
    store.add('d1', 'srf-1', input('L1'));
    expect(store.all()).toHaveLength(1);
    expect(warned.join(' ')).toContain('could not write the held messages');
  });

  it('reads a saved file that is valid JSON but not a list as nothing held', () => {
    writeFileSync(join(dir, 'held-input.json'), '{"not":"a list"}');
    expect(new HeldInputStore({ dataDir: dir, logger }).all()).toEqual([]);
  });
});
