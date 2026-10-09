// Direct unit coverage of src/notifications/call-orchestrator.ts, closing the
// gaps not already exercised by test/notifications.test.ts's CallOrchestrator
// suite: fanout failure catches, the unknown-call / decline branches of
// handleResponse, and the timeout fallback-push failure catch.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Registry } from '../src/registry.js';
import { PresenceTracker } from '../src/presence.js';
import { NotificationRouter } from '../src/notifications/router.js';
import { CallOrchestrator } from '../src/notifications/call-orchestrator.js';
import { generateUserKeypair } from '@patch/auth';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const silent = pino({ level: 'silent' });
const ACCOUNT = generateUserKeypair(() => new Uint8Array(32).fill(9));

interface FakeWsHub {
  sendToKind: (kind: string, ev: WireEvent) => number;
  sendToKinds: (kinds: ReadonlySet<string>, ev: WireEvent) => number;
  sendToSurface: (id: string, ev: WireEvent) => boolean;
  sendToAll: (ev: WireEvent) => number;
  delivered: { event: WireEvent }[];
}

function makeFakeWsHub(): FakeWsHub {
  const delivered: FakeWsHub['delivered'] = [];
  return {
    delivered,
    sendToKind: (_kind, ev) => {
      delivered.push({ event: ev });
      return 1;
    },
    sendToKinds: (_kinds, ev) => {
      delivered.push({ event: ev });
      return 1;
    },
    sendToSurface: (_id, ev) => {
      delivered.push({ event: ev });
      return true;
    },
    sendToAll: (ev) => {
      delivered.push({ event: ev });
      return 1;
    },
  };
}

function makeRouter(dir: string): NotificationRouter {
  const registry = Registry.load(dir);
  registry.bootstrapAccount({ keypair: ACCOUNT });
  const presence = new PresenceTracker();
  return new NotificationRouter({
    logger: silent,
    registry,
    presence,
    wsHub: makeFakeWsHub() as never,
    dataDir: dir,
  });
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'patch-call-orch-'));
}

describe('CallOrchestrator — fanout failure catches', () => {
  it('logs a warning (does not throw) when the desktop fanout notify rejects', async () => {
    const dir = tmpDir();
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: ACCOUNT });
    const presence = new PresenceTracker();
    const wsHub = makeFakeWsHub();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
    });
    // routeDesktop is synchronous and never throws itself; force a failure by
    // making the desktop channel's account lookup absent instead is not
    // possible here (desktop doesn't check account) — so monkeypatch route()
    // to reject only for the desktop channel.
    const originalRoute = router.route.bind(router);
    vi.spyOn(router, 'route').mockImplementation(async (event) => {
      if (event.channel === 'desktop') throw new Error('desktop unreachable');
      return originalRoute(event);
    });
    const orch = new CallOrchestrator({
      logger: silent,
      wsHub: wsHub as never,
      router,
      timeoutMs: 60_000,
      idGenerator: () => 'call-desktop-fail',
    });
    await expect(orch.startCall({ type: 'patch.call', chatId: 'c1', message: 'hi' })).resolves.toBe(
      'call-desktop-fail',
    );
    orch.shutdown();
  });

  it('logs a warning (does not throw) when the push fanout notify rejects', async () => {
    const dir = tmpDir();
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: ACCOUNT });
    const presence = new PresenceTracker();
    const wsHub = makeFakeWsHub();
    const router = new NotificationRouter({
      logger: silent,
      registry,
      presence,
      wsHub: wsHub as never,
      dataDir: dir,
      // No pushBackend configured → routePush throws "no push backend configured".
    });
    const orch = new CallOrchestrator({
      logger: silent,
      wsHub: wsHub as never,
      router,
      timeoutMs: 60_000,
      idGenerator: () => 'call-push-fail',
    });
    await expect(orch.startCall({ type: 'patch.call', chatId: 'c1' })).resolves.toBe(
      'call-push-fail',
    );
    orch.shutdown();
  });
});

describe('CallOrchestrator — default id/timeout/clock (no overrides injected)', () => {
  it('uses randomUUID() for callId and Date.now() for the clock when neither is injected', async () => {
    const dir = tmpDir();
    const router = makeRouter(dir);
    const wsHub = makeFakeWsHub();
    // No idGenerator, no nowMs, no timeoutMs — exercises every `?? `/ternary
    // default branch in startCall()/now().
    const orch = new CallOrchestrator({ logger: silent, wsHub: wsHub as never, router });
    const callId = await orch.startCall({ type: 'patch.call', chatId: 'c1' });
    // randomUUID() shape check (loose — just confirms it's not our fixture ids).
    expect(callId).toMatch(/^[0-9a-f-]{36}$/);
    expect(orch.getCall(callId)?.startedAt).toBeGreaterThan(0);
    orch.shutdown();
  });

  it('uses the injected nowMs() clock when provided', async () => {
    const dir = tmpDir();
    const router = makeRouter(dir);
    const wsHub = makeFakeWsHub();
    const orch = new CallOrchestrator({
      logger: silent,
      wsHub: wsHub as never,
      router,
      idGenerator: () => 'call-custom-clock',
      nowMs: () => 42,
    });
    await orch.startCall({ type: 'patch.call', chatId: 'c1' });
    expect(orch.getCall('call-custom-clock')?.startedAt).toBe(42);
    orch.shutdown();
  });
});

describe('CallOrchestrator.handleResponse — unknown call / decline branches', () => {
  it('logs info and returns for an unknown callId (no matching in-memory state)', () => {
    const dir = tmpDir();
    const router = makeRouter(dir);
    const wsHub = makeFakeWsHub();
    const orch = new CallOrchestrator({ logger: silent, wsHub: wsHub as never, router });
    expect(() =>
      orch.handleResponse('srf-1', {
        type: 'chat.call_response',
        callId: 'never-started',
        response: 'accept',
      }),
    ).not.toThrow();
    expect(wsHub.delivered).toHaveLength(0);
    orch.shutdown();
  });

  it('a decline does not resolve the call — other surfaces may still accept', async () => {
    const dir = tmpDir();
    const router = makeRouter(dir);
    const wsHub = makeFakeWsHub();
    const orch = new CallOrchestrator({
      logger: silent,
      wsHub: wsHub as never,
      router,
      timeoutMs: 60_000,
      idGenerator: () => 'call-decline',
    });
    await orch.startCall({ type: 'patch.call', chatId: 'c1' });
    orch.handleResponse('srf-declined', {
      type: 'chat.call_response',
      callId: 'call-decline',
      response: 'decline',
    });
    expect(orch.getCall('call-decline')?.status).toBe('ringing');
    expect(wsHub.delivered.find((d) => d.event.type === 'chat.call_winner')).toBeUndefined();
    // A later accept from a different surface still resolves the call.
    orch.handleResponse('srf-accept', {
      type: 'chat.call_response',
      callId: 'call-decline',
      response: 'accept',
    });
    expect(orch.getCall('call-decline')?.status).toBe('accepted');
    orch.shutdown();
  });
});

describe('CallOrchestrator — timeout fallback push failure', () => {
  it('logs a warning (does not throw) when the timeout fallback push rejects', async () => {
    vi.useFakeTimers();
    try {
      const dir = tmpDir();
      const registry = Registry.load(dir);
      registry.bootstrapAccount({ keypair: ACCOUNT });
      const presence = new PresenceTracker();
      const wsHub = makeFakeWsHub();
      // No pushBackend → every routePush call (both the initial urgent fanout
      // and the timeout fallback) throws "no push backend configured".
      const router = new NotificationRouter({
        logger: silent,
        registry,
        presence,
        wsHub: wsHub as never,
        dataDir: dir,
      });
      const orch = new CallOrchestrator({
        logger: silent,
        wsHub: wsHub as never,
        router,
        timeoutMs: 30_000,
        idGenerator: () => 'call-timeout-fail',
      });
      await orch.startCall({ type: 'patch.call', chatId: 'c1', message: 'pick up' });
      await vi.advanceTimersByTimeAsync(30_001);
      const timeout = wsHub.delivered.find((d) => d.event.type === 'chat.call_timeout');
      expect(timeout).toBeDefined();
      expect(orch.getCall('call-timeout-fail')?.status).toBe('timeout');
      orch.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('timeoutCall(): no-ops for a callId with no in-memory state (defensive re-entrancy guard)', async () => {
    const dir = tmpDir();
    const router = makeRouter(dir);
    const wsHub = makeFakeWsHub();
    const orch = new CallOrchestrator({ logger: silent, wsHub: wsHub as never, router });
    await (orch as unknown as { timeoutCall: (id: string) => Promise<void> }).timeoutCall(
      'never-started',
    );
    expect(wsHub.delivered).toHaveLength(0);
    orch.shutdown();
  });

  it('timeoutCall(): no-ops when invoked twice for the same call (already resolved by the first run)', async () => {
    const dir = tmpDir();
    const router = makeRouter(dir);
    const wsHub = makeFakeWsHub();
    const orch = new CallOrchestrator({
      logger: silent,
      wsHub: wsHub as never,
      router,
      idGenerator: () => 'call-double-timeout',
    });
    await orch.startCall({ type: 'patch.call', chatId: 'c1' }); // message omitted → default fallback text
    const timeoutCall = (
      orch as unknown as { timeoutCall: (id: string) => Promise<void> }
    ).timeoutCall.bind(orch);
    await timeoutCall('call-double-timeout');
    expect(orch.getCall('call-double-timeout')?.status).toBe('timeout');
    const firstTimeoutEvents = wsHub.delivered.filter((d) => d.event.type === 'chat.call_timeout');
    expect(firstTimeoutEvents).toHaveLength(1);
    // Second invocation: status is no longer 'ringing' → early return, no
    // duplicate chat.call_timeout event.
    await timeoutCall('call-double-timeout');
    const timeoutEvents = wsHub.delivered.filter((d) => d.event.type === 'chat.call_timeout');
    expect(timeoutEvents).toHaveLength(1);
    orch.shutdown();
  });

  it('a call that resolves before its timeout fires does not re-resolve (timeoutCall early return)', async () => {
    vi.useFakeTimers();
    try {
      const dir = tmpDir();
      const router = makeRouter(dir);
      const wsHub = makeFakeWsHub();
      const orch = new CallOrchestrator({
        logger: silent,
        wsHub: wsHub as never,
        router,
        timeoutMs: 30_000,
        idGenerator: () => 'call-early-accept',
      });
      await orch.startCall({ type: 'patch.call', chatId: 'c1' });
      orch.handleResponse('srf-1', {
        type: 'chat.call_response',
        callId: 'call-early-accept',
        response: 'accept',
      });
      expect(orch.getCall('call-early-accept')?.status).toBe('accepted');
      await vi.advanceTimersByTimeAsync(30_001);
      // Still accepted, not flipped to timeout — and only one call_winner event.
      expect(orch.getCall('call-early-accept')?.status).toBe('accepted');
      const timeoutEvents = wsHub.delivered.filter((d) => d.event.type === 'chat.call_timeout');
      expect(timeoutEvents).toHaveLength(0);
      orch.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CallOrchestrator — reach (spec/09 § Reaching the user)', () => {
  it('under auto-notify a call is spoken aloud, never rung', async () => {
    const dir = tmpDir();
    const wsHub = makeFakeWsHub();
    const router = makeRouter(dir);
    const routeSpy = vi.spyOn(router, 'route');
    const orch = new CallOrchestrator({
      logger: silent,
      wsHub: wsHub as never,
      router,
      idGenerator: () => 'call-auto',
      reach: () => 'auto-notify',
    });
    await orch.startCall({
      type: 'patch.call',
      chatId: 'c1',
      message: 'the bus chat is blocked on a permission',
    });
    // One frame out, and it is the spoken one — no ring, and no push/desktop
    // fanout, because nobody is being asked to accept anything.
    expect(wsHub.delivered.map((d) => d.event.type)).toEqual(['chat.speak']);
    expect(wsHub.delivered[0]!.event).toMatchObject({
      chatId: 'c1',
      message: 'the bus chat is blocked on a permission',
    });
    expect(routeSpy).not.toHaveBeenCalled();
  });

  it('under notify it rings, which is the default when no reach is wired', async () => {
    const dir = tmpDir();
    const wsHub = makeFakeWsHub();
    const orch = new CallOrchestrator({
      logger: silent,
      wsHub: wsHub as never,
      router: makeRouter(dir),
      idGenerator: () => 'call-ring',
      timeoutMs: 60_000,
    });
    await orch.startCall({ type: 'patch.call', chatId: 'c1', message: 'picking up?' });
    expect(wsHub.delivered.map((d) => d.event.type)).toContain('chat.call_request');
    expect(wsHub.delivered.map((d) => d.event.type)).not.toContain('chat.speak');
  });

  it('a call with no message still rings under auto-notify — there is nothing to speak', async () => {
    const dir = tmpDir();
    const wsHub = makeFakeWsHub();
    const orch = new CallOrchestrator({
      logger: silent,
      wsHub: wsHub as never,
      router: makeRouter(dir),
      idGenerator: () => 'call-bare',
      timeoutMs: 60_000,
      reach: () => 'auto-notify',
    });
    await orch.startCall({ type: 'patch.call', chatId: 'c1' });
    expect(wsHub.delivered.map((d) => d.event.type)).toContain('chat.call_request');
  });
});
