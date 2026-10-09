// The browser tunnel relay (spec/02 § Browser — Route through, spec/03
// § Browser tunnel). Unlike the request/response relays in cross-host.ts, a
// tunnel stream is symmetric: `ready`/`data`/`error` can arrive from EITHER
// machine and must reach the OTHER one, for the whole life of the stream.

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { registerBrowserTunnelBridge } from '../src/browser-tunnel-bridge.js';
import type { DaemonLink } from '../src/daemon-link.js';
import type { Registry } from '../src/registry.js';

const logger = pino({ level: 'silent' });

interface Sent {
  daemonId: string;
  surfaceId: string;
  event: WireEvent;
}

function harness(opts: { registered?: string[]; online?: string[] } = {}) {
  const registered = new Set(opts.registered ?? ['host-a', 'host-b']);
  const online = new Set(opts.online ?? ['host-a', 'host-b']);
  const sent: Sent[] = [];
  let handler: ((e: WireEvent, from: string | null) => void) | undefined;
  let statusHandler: ((daemonId: string, status: 'online' | 'offline') => void) | undefined;

  const daemonLink = {
    sendTo: (daemonId: string, surfaceId: string, event: WireEvent) => {
      sent.push({ daemonId, surfaceId, event });
    },
    isOnline: (id: string) => online.has(id),
    onEvent: (h: (e: WireEvent, from: string | null) => void) => {
      handler = h;
      return () => {
        handler = undefined;
      };
    },
    onHostStatus: (h: (daemonId: string, status: 'online' | 'offline') => void) => {
      statusHandler = h;
      return () => {
        statusHandler = undefined;
      };
    },
  } as unknown as DaemonLink;

  const registry = {
    isRegisteredDaemon: (id: string) => registered.has(id),
  } as unknown as Registry;

  const dispose = registerBrowserTunnelBridge({ logger, daemonLink, registry });
  return {
    sent,
    dispose,
    feed: (event: WireEvent, from: string | null) => handler?.(event, from),
    goOffline: (daemonId: string) => statusHandler?.(daemonId, 'offline'),
  };
}

const openFrame = (over: Partial<Record<string, unknown>> = {}): WireEvent =>
  ({
    type: 'patch.browser_tunnel.open',
    streamId: 'stream-1',
    daemonId: 'host-b',
    host: 'example.com',
    port: 443,
    ...over,
  }) as WireEvent;

describe('browser tunnel bridge', () => {
  it('relays open to the routing machine', () => {
    const h = harness();
    h.feed(openFrame(), 'host-a');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.daemonId).toBe('host-b');
    expect(h.sent[0]!.event).toMatchObject({
      type: 'patch.browser_tunnel.open',
      streamId: 'stream-1',
    });
    h.dispose();
  });

  it('relays ready back to the browsing machine, not the routing one', () => {
    const h = harness();
    h.feed(openFrame(), 'host-a');
    h.sent.length = 0;
    h.feed({ type: 'patch.browser_tunnel.ready', streamId: 'stream-1' } as WireEvent, 'host-b');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.daemonId).toBe('host-a');
    expect(h.sent[0]!.event).toMatchObject({ type: 'patch.browser_tunnel.ready' });
    h.dispose();
  });

  it('relays data in BOTH directions on the same stream', () => {
    const h = harness();
    h.feed(openFrame(), 'host-a');
    h.feed({ type: 'patch.browser_tunnel.ready', streamId: 'stream-1' } as WireEvent, 'host-b');
    h.sent.length = 0;

    // browsing → routing
    h.feed(
      { type: 'patch.browser_tunnel.data', streamId: 'stream-1', data: 'AAA=' } as WireEvent,
      'host-a',
    );
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.daemonId).toBe('host-b');

    // routing → browsing
    h.feed(
      { type: 'patch.browser_tunnel.data', streamId: 'stream-1', data: 'BBB=' } as WireEvent,
      'host-b',
    );
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!.daemonId).toBe('host-a');
    h.dispose();
  });

  it('relays close to the other side and forgets the route', () => {
    const h = harness();
    h.feed(openFrame(), 'host-a');
    h.feed({ type: 'patch.browser_tunnel.ready', streamId: 'stream-1' } as WireEvent, 'host-b');
    h.sent.length = 0;

    h.feed({ type: 'patch.browser_tunnel.close', streamId: 'stream-1' } as WireEvent, 'host-a');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.daemonId).toBe('host-b');

    // The route is gone — a later frame on the same streamId is dropped, not relayed.
    h.sent.length = 0;
    h.feed(
      { type: 'patch.browser_tunnel.data', streamId: 'stream-1', data: 'CCC=' } as WireEvent,
      'host-a',
    );
    expect(h.sent).toHaveLength(0);
    h.dispose();
  });

  it('refuses open to an UNREGISTERED routing host, naming it, with no relay', () => {
    const h = harness({ registered: ['host-a'] });
    h.feed(openFrame({ daemonId: 'host-zzz' }), 'host-a');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.daemonId).toBe('host-a');
    expect(h.sent[0]!.event).toMatchObject({
      type: 'patch.browser_tunnel.error',
      streamId: 'stream-1',
      code: 'host_not_registered',
    });
    expect((h.sent[0]!.event as { message: string }).message).toContain('host-zzz');
    h.dispose();
  });

  it('refuses open to an OFFLINE routing host, naming it, with NO FALLBACK to direct', () => {
    const h = harness({ online: ['host-a'] });
    h.feed(openFrame(), 'host-a');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.daemonId).toBe('host-a');
    expect(h.sent[0]!.event).toMatchObject({
      type: 'patch.browser_tunnel.error',
      code: 'host_offline',
    });
    expect((h.sent[0]!.event as { message: string }).message).toContain('host-b');
    h.dispose();
  });

  it('tells the surviving side, loudly, when the other machine of an open stream goes offline', () => {
    const h = harness();
    h.feed(openFrame(), 'host-a');
    h.feed({ type: 'patch.browser_tunnel.ready', streamId: 'stream-1' } as WireEvent, 'host-b');
    h.sent.length = 0;

    h.goOffline('host-b');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.daemonId).toBe('host-a');
    expect(h.sent[0]!.event).toMatchObject({
      type: 'patch.browser_tunnel.error',
      streamId: 'stream-1',
      code: 'host_offline',
    });

    // The route is gone — nothing relays for this stream any more.
    h.sent.length = 0;
    h.feed(
      { type: 'patch.browser_tunnel.data', streamId: 'stream-1', data: 'DDD=' } as WireEvent,
      'host-a',
    );
    expect(h.sent).toHaveLength(0);
    h.dispose();
  });

  it('drops (loudly logged) a frame for a stream it never opened', () => {
    const h = harness();
    h.feed(
      { type: 'patch.browser_tunnel.data', streamId: 'never-opened', data: 'AAA=' } as WireEvent,
      'host-a',
    );
    expect(h.sent).toHaveLength(0);
    h.dispose();
  });
});
