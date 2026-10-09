// Manager failover (spec/06): when the home host stays offline, another host
// runs the Manager with the recent conversation, and hands back on return.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { ChatLogStore } from '../src/chat-log-store.js';
import { FAILOVER_GRACE_MS, ManagerFailover } from '../src/manager-failover.js';

const logger = pino({ level: 'silent' });

const say = (seq: number, role: 'user' | 'assistant', content: string): WireEvent =>
  ({ type: 'chat.message', chatId: 'thread_manager', role, content, seq }) as WireEvent;

describe('ManagerFailover', () => {
  let dir: string;
  let online: Set<string>;
  let handlers: Array<(id: string, s: 'online' | 'offline') => void>;
  let sent: Array<{ daemonId: string; event: WireEvent }>;
  let log: ChatLogStore;
  let window: number;

  const make = (): ManagerFailover => {
    const f = new ManagerFailover({
      homeDaemonId: () => 'home',
      registeredDaemonIds: () => ['home', 'other', 'third'],
      isOnline: (id) => online.has(id),
      onHostStatus: (h) => {
        handlers.push(h);
        return () => undefined;
      },
      sendTo: (daemonId, _s, event) => sent.push({ daemonId, event }),
      log,
      contextWindow: () => window,
      dataDir: dir,
      logger,
    });
    f.start();
    return f;
  };
  const status = (id: string, s: 'online' | 'offline'): void => {
    if (s === 'online') online.add(id);
    else online.delete(id);
    for (const h of handlers) h(id, s);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    dir = mkdtempSync(join(tmpdir(), 'patch-mf-'));
    online = new Set(['home', 'other']);
    handlers = [];
    sent = [];
    window = 40;
    log = new ChatLogStore({ logger });
    log.observe(say(0, 'user', 'first'));
    log.observe(say(1, 'assistant', 'reply one'));
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  test('does nothing while the home host is up, or only briefly away', () => {
    const f = make();
    status('home', 'offline');
    vi.advanceTimersByTime(FAILOVER_GRACE_MS - 1);
    expect(sent).toEqual([]);
    status('home', 'online');
    vi.advanceTimersByTime(FAILOVER_GRACE_MS * 2);
    expect(sent).toEqual([]);
    expect(f.acting()).toBeNull();
    expect(f.specialThreadHost()).toBe('home');
  });

  test('another host takes over after the grace period, with the conversation and the next seq', () => {
    const f = make();
    status('home', 'offline');
    vi.advanceTimersByTime(FAILOVER_GRACE_MS);

    expect(f.acting()).toBe('other');
    expect(f.specialThreadHost()).toBe('other');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.daemonId).toBe('other');
    const adopt = sent[0]!.event as {
      type: string;
      epoch: number;
      handoff: string;
      nextSeq: number;
    };
    expect(adopt).toMatchObject({ type: 'host.manager_adopt', epoch: 1, nextSeq: 2 });
    expect(adopt.handoff).toContain('user: first');
    expect(adopt.handoff).toContain('assistant: reply one');
    expect(adopt.handoff.indexOf('user: first')).toBeLessThan(adopt.handoff.indexOf('reply one'));
  });

  test('hands over only as many messages as the context window allows', () => {
    window = 1;
    make();
    status('home', 'offline');
    vi.advanceTimersByTime(FAILOVER_GRACE_MS);
    const { handoff } = sent[0]!.event as { handoff: string };
    expect(handoff).toContain('reply one');
    expect(handoff).not.toContain('user: first');
  });

  test('waits for a host to be up, and takes over when one is', () => {
    online = new Set(['home']);
    const f = make();
    status('home', 'offline');
    vi.advanceTimersByTime(FAILOVER_GRACE_MS);
    expect(f.acting()).toBeNull();

    status('other', 'online');
    vi.advanceTimersByTime(FAILOVER_GRACE_MS);
    expect(f.acting()).toBe('other');
  });

  test('hands back when the home host returns, telling it what was said meanwhile', () => {
    const f = make();
    status('home', 'offline');
    vi.advanceTimersByTime(FAILOVER_GRACE_MS);
    sent.length = 0;

    // The stand-in runs the Manager, numbering from 2.
    log.observe(say(2, 'user', 'while you were gone'));
    log.observe(say(3, 'assistant', 'handled it'));

    status('home', 'online');
    expect(f.acting()).toBeNull();
    expect(f.specialThreadHost()).toBe('home');

    const release = sent.find((s) => s.daemonId === 'other')!.event;
    expect(release).toMatchObject({ type: 'host.manager_release' });
    const toHome = sent.find((s) => s.daemonId === 'home' && s.event.type === 'host.manager_adopt')!
      .event as { handoff: string; nextSeq: number; epoch: number };
    expect(toHome.nextSeq).toBe(4);
    expect(toHome.handoff).toContain('while you were gone');
    expect(toHome.handoff).toContain('handled it');
    expect(toHome.handoff).not.toContain('reply one'); // only the stretch it missed
  });

  test('says nothing to the home host when nothing was said while it was away', () => {
    make();
    status('home', 'offline');
    vi.advanceTimersByTime(FAILOVER_GRACE_MS);
    sent.length = 0;
    status('home', 'online');
    expect(sent.filter((s) => s.daemonId === 'home')).toEqual([]);
  });

  test('answers the missing stretch from the server copy, and only that', () => {
    const f = make();
    status('home', 'offline');
    vi.advanceTimersByTime(FAILOVER_GRACE_MS);
    log.observe(say(2, 'user', 'a'));
    log.observe(say(3, 'assistant', 'b'));
    status('home', 'online');
    log.observe(say(4, 'user', 'back home'));

    expect(f.gapEvents(-1).map((e) => (e as { seq: number }).seq)).toEqual([2, 3]);
    expect(f.gapEvents(2).map((e) => (e as { seq: number }).seq)).toEqual([3]);
  });

  test('a different host takes over when the stand-in goes away', () => {
    online = new Set(['home', 'other', 'third']);
    const f = make();
    status('home', 'offline');
    vi.advanceTimersByTime(FAILOVER_GRACE_MS);
    expect(f.acting()).toBe('other');

    status('other', 'offline');
    expect(f.acting()).toBe('third');
    const adopts = sent.filter((s) => s.event.type === 'host.manager_adopt');
    expect(adopts.map((a) => (a.event as { epoch: number }).epoch)).toEqual([1, 2]);
  });

  test('tells a host again, as it reattaches, what it was last asked to do', () => {
    make();
    status('home', 'offline');
    vi.advanceTimersByTime(FAILOVER_GRACE_MS);
    sent.length = 0;
    status('other', 'offline'); // third is not up, so nobody stands in
    status('other', 'online');
    expect(sent.some((s) => s.daemonId === 'other' && s.event.type === 'host.manager_adopt')).toBe(
      true,
    );
  });

  test('keeps its state across a server restart', () => {
    const first = make();
    status('home', 'offline');
    vi.advanceTimersByTime(FAILOVER_GRACE_MS);
    expect(first.acting()).toBe('other');

    handlers = [];
    const second = make();
    expect(second.acting()).toBe('other');
    expect(second.specialThreadHost()).toBe('other');
  });

  describe('odd and failing cases', () => {
    const toolCall = (seq: number): WireEvent =>
      ({
        type: 'chat.tool_call',
        chatId: 'thread_manager',
        seq,
        tool: 'Bash',
        args: {},
        callId: `k${seq}`,
      }) as WireEvent;
    const system = (seq: number): WireEvent =>
      ({
        type: 'chat.message',
        chatId: 'thread_manager',
        role: 'system',
        content: 'Session rotated',
        seq,
      }) as WireEvent;

    test('answers no missing stretch when nothing has been taken over', () => {
      const f = make();
      expect(f.gapEvents(-1)).toEqual([]);
    });

    test('hands over only the conversation: no tool calls, no system notes', () => {
      log.observe(toolCall(2));
      log.observe(system(3));
      make();
      status('home', 'offline');
      vi.advanceTimersByTime(FAILOVER_GRACE_MS);
      const { handoff } = sent[0]!.event as { handoff: string };
      expect(handoff).not.toContain('Session rotated');
      expect(handoff).not.toContain('Bash');
      expect(handoff).toContain('assistant: reply one');
    });

    test('cuts each message and the whole handoff to a size that fits', () => {
      for (let seq = 2; seq < 80; seq++) log.observe(say(seq, 'user', 'q'.repeat(5_000)));
      window = 1_000;
      make();
      status('home', 'offline');
      vi.advanceTimersByTime(FAILOVER_GRACE_MS);
      const { handoff } = sent[0]!.event as { handoff: string };
      expect(handoff.length).toBeLessThan(25_000);
      // Each message is cut before the whole is: no run of 2,001 in a row.
      expect(handoff).not.toContain('q'.repeat(2_001));
    });

    test('says there is nothing yet when the Manager has said nothing', () => {
      log = new ChatLogStore({ logger });
      make();
      status('home', 'offline');
      vi.advanceTimersByTime(FAILOVER_GRACE_MS);
      const adopt = sent[0]!.event as { handoff: string; nextSeq: number };
      expect(adopt.handoff).toContain('(nothing yet)');
      expect(adopt.nextSeq).toBe(0);
    });

    test('hands back from a state saved without its stretch', () => {
      writeFileSync(
        join(dir, 'manager-failover.json'),
        JSON.stringify({ acting: 'other', epoch: 4, gaps: [], orders: {} }),
      );
      const f = make();
      expect(f.acting()).toBe('other');
      status('home', 'online');
      expect(f.acting()).toBeNull();
      expect(
        sent.some((s) => s.daemonId === 'other' && s.event.type === 'host.manager_release'),
      ).toBe(true);
    });

    test('starts clean, and says so, when its saved state is damaged', () => {
      writeFileSync(join(dir, 'manager-failover.json'), '{not json');
      const warned: string[] = [];
      const f = new ManagerFailover({
        homeDaemonId: () => 'home',
        registeredDaemonIds: () => ['home', 'other'],
        isOnline: (id) => online.has(id),
        onHostStatus: () => () => undefined,
        sendTo: () => undefined,
        log,
        contextWindow: () => 40,
        dataDir: dir,
        logger: { info: () => undefined, warn: (_o, m) => warned.push(String(m)) },
      });
      expect(f.acting()).toBeNull();
      expect(warned.join(' ')).toContain('could not read its state');
    });

    test('says so, and carries on, when it cannot write its state', () => {
      const warned: string[] = [];
      const f = new ManagerFailover({
        homeDaemonId: () => 'home',
        registeredDaemonIds: () => ['home', 'other'],
        isOnline: (id) => online.has(id),
        onHostStatus: (h) => {
          handlers.push(h);
          return () => undefined;
        },
        sendTo: (daemonId, _s, event) => sent.push({ daemonId, event }),
        log,
        contextWindow: () => 40,
        dataDir: join(dir, 'not', 'a', 'directory'),
        logger: { info: () => undefined, warn: (_o, m) => warned.push(String(m)) },
      });
      f.start();
      status('home', 'offline');
      vi.advanceTimersByTime(FAILOVER_GRACE_MS);
      expect(f.acting()).toBe('other');
      expect(warned.join(' ')).toContain('could not write its state');
    });

    test('works with no data directory at all, and stops cleanly', () => {
      const f = new ManagerFailover({
        homeDaemonId: () => 'home',
        registeredDaemonIds: () => ['home', 'other'],
        isOnline: (id) => online.has(id),
        onHostStatus: (h) => {
          handlers.push(h);
          return () => undefined;
        },
        sendTo: (daemonId, _s, event) => sent.push({ daemonId, event }),
        log,
        contextWindow: () => 40,
        logger: { info: () => undefined, warn: () => undefined },
      });
      f.start();
      status('home', 'offline');
      vi.advanceTimersByTime(FAILOVER_GRACE_MS);
      expect(f.acting()).toBe('other');
      f.stop();
      f.stop();
    });

    test('starts the wait at startup when the home host is already down', () => {
      online = new Set(['other']);
      const f = make();
      vi.advanceTimersByTime(FAILOVER_GRACE_MS);
      expect(f.acting()).toBe('other');
    });

    test('ignores a host coming back that is not the home host while one is standing in', () => {
      const f = make();
      status('home', 'offline');
      vi.advanceTimersByTime(FAILOVER_GRACE_MS);
      status('third', 'online');
      expect(f.acting()).toBe('other');
    });

    test('does not choose a host twice for one wait', () => {
      make();
      status('home', 'offline');
      status('home', 'offline');
      vi.advanceTimersByTime(FAILOVER_GRACE_MS);
      expect(sent.filter((s) => s.event.type === 'host.manager_adopt')).toHaveLength(1);
    });
  });
});
