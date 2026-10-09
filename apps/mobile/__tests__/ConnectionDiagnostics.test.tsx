// Connection diagnostics screen (spec/12 § Connection diagnostics screen).
//
// The failure this covers: a phone that cannot reach the agent used to show
// nothing but "Reconnecting…", which tells the user neither WHAT is broken
// (no data / server down / host down / credential rejected / Settings →
// Host pointed at the wrong host) nor gives them anything to report.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  renderRN,
  findHost,
  queryHost,
  byTestId,
  textOf,
  flush,
  actSync,
} from './testUtils/render';
import {
  ConnectionDiagnostics,
  ConnectionDiagnosticsGate,
} from '../src/components/ConnectionDiagnostics';
import { runDiagnostics, formatReport } from '../src/lib/diagnostics';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useUiStore } from '../src/stores/uiStore';
import { saveCredential, clearCredential } from '../src/lib/credential';
import { getWs } from '../src/api/ws';
import { setRoute } from '../src/config';
import { __clearAllMmkv } from './stubs/mmkv';
import { routerMock } from './stubs/expo-router';
import { space } from '../src/lib/theme';
import { __setSafeAreaInsets } from './stubs/safe-area-context';
import { __lastCopied, __setFail, __resetClipboard } from './stubs/expo-clipboard';

vi.mock('../src/api/ws', () => ({ getWs: vi.fn() }));

const reconnectNow = vi.fn();

function b64(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}
// A shape-valid surface credential (3-part JWT with the identity claims).
const CRED = `x.${b64({ sub: 'acct_1', surface_id: 'srf_1', surface_kind: 'mobile', label: 'Pixel' })}.y`;

interface FetchCase {
  status: number;
  body?: unknown;
  throws?: Error;
}

function stubFetch(routes: Record<string, FetchCase>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: string) => {
    const path = input.slice(input.indexOf('/api'));
    const route = routes[path];
    if (!route) throw new Error(`unstubbed fetch: ${input}`);
    if (route.throws) throw route.throws;
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.body ?? {},
    } as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn as unknown as ReturnType<typeof vi.fn>;
}

const HEALTHY = {
  '/api/healthz': { status: 200, body: { ok: true, version: '1.2.3', gitSha: 'abcdef1' } },
  '/api/daemon/healthz': { status: 200, body: { ok: true } },
};

beforeEach(() => {
  reconnectNow.mockClear();
  vi.mocked(getWs).mockReturnValue({ reconnectNow } as unknown as ReturnType<typeof getWs>);
  clearCredential();
  saveCredential(CRED);
  usePresenceStore.setState({
    connection: 'offline',
    daemon: 'offline',
    wsUrl: 'wss://patch.example/ws',
    everConnected: false,
    failedAttempts: 0,
    lastClose: null,
  });
  useUiStore.setState({ diagnosticsOpen: false, diagnosticsBlockingClosed: false });
  __resetClipboard();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearCredential();
});

describe('runDiagnostics', () => {
  it('passes every check when the credential, server and agent are all healthy', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({ connection: 'connected', everConnected: true });
    const report = await runDiagnostics();
    expect(report.checks.map((c) => [c.id, c.status])).toEqual([
      ['credential', 'pass'],
      ['server', 'pass'],
      ['agent', 'pass'],
      ['websocket', 'pass'],
      // Forward compatibility has absorbed nothing on a surface as new as its
      // agent (spec/03 § Forward compatibility).
      ['protocol', 'pass'],
    ]);
    expect(report.checks[1]!.detail).toContain('1.2.3');
  });

  it('distinguishes a DOWN AGENT from a down server — server passes, agent fails on 503', async () => {
    stubFetch({
      '/api/healthz': HEALTHY['/api/healthz'],
      '/api/daemon/healthz': { status: 503, body: { ok: false } },
    });
    const report = await runDiagnostics();
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.server!.status).toBe('pass');
    expect(byId.agent!.status).toBe('fail');
    expect(byId.agent!.detail).toMatch(/agent/i);
  });

  it('reports the server unreachable with the thrown network error', async () => {
    stubFetch({
      '/api/healthz': { status: 0, throws: new TypeError('Network request failed') },
      '/api/daemon/healthz': { status: 0, throws: new TypeError('Network request failed') },
    });
    const report = await runDiagnostics();
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.server!.detail).toContain('Network request failed');
    expect(byId.agent!.status).toBe('fail');
  });

  it('reports a rejected credential distinctly when the agent probe 401s', async () => {
    stubFetch({
      '/api/healthz': HEALTHY['/api/healthz'],
      '/api/daemon/healthz': { status: 401, body: { error: 'unauthenticated' } },
    });
    const report = await runDiagnostics();
    expect(report.checks.find((c) => c.id === 'agent')!.detail).toMatch(/credential/i);
  });

  it('reports an unexpected agent-probe status verbatim rather than guessing', async () => {
    stubFetch({
      '/api/healthz': HEALTHY['/api/healthz'],
      '/api/daemon/healthz': { status: 500, body: {} },
    });
    const report = await runDiagnostics();
    expect(report.checks.find((c) => c.id === 'agent')!.detail).toContain('500');
  });

  it('reports a non-2xx server probe with its status', async () => {
    stubFetch({
      '/api/healthz': { status: 502, body: {} },
      '/api/daemon/healthz': { status: 503, body: {} },
    });
    const report = await runDiagnostics();
    expect(report.checks.find((c) => c.id === 'server')!.detail).toContain('502');
  });

  it('fails the credential check, and skips the authed agent probe, when nothing is stored', async () => {
    clearCredential();
    const fetchFn = stubFetch(HEALTHY);
    const report = await runDiagnostics();
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.credential!.status).toBe('fail');
    expect(byId.agent!.detail).toMatch(/credential/i);
    expect(fetchFn.mock.calls.some((c) => String(c[0]).includes('/api/daemon/healthz'))).toBe(
      false,
    );
  });

  it('carries the websocket state, url, failed-attempt count and last close reason', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({
      connection: 'reconnecting',
      failedAttempts: 3,
      lastClose: { code: 1006, reason: 'abnormal closure', at: 1_700_000_000_000 },
    });
    const socket = (await runDiagnostics()).checks.find((c) => c.id === 'websocket')!;
    expect(socket.status).toBe('fail');
    expect(socket.detail).toContain('reconnecting');
    expect(socket.detail).toContain('3');
    expect(socket.detail).toContain('1006');
    expect(socket.detail).toContain('abnormal closure');
  });

  it('says so plainly when no socket URL is known and the close carried no reason', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({
      wsUrl: null,
      lastClose: { code: 1006, reason: '', at: 1_700_000_000_000 },
    });
    const report = await runDiagnostics();
    expect(report.wsUrl).toBe('(none)');
    expect(report.checks.find((c) => c.id === 'websocket')!.detail).toContain('(no reason)');
  });

  it('does not invent a version or sha when healthz omits them', async () => {
    stubFetch({
      '/api/healthz': { status: 200, body: {} },
      '/api/daemon/healthz': HEALTHY['/api/daemon/healthz'],
    });
    const report = await runDiagnostics();
    expect(report.checks.find((c) => c.id === 'server')!.detail).toContain('version ?');
  });

  it('stringifies a non-Error rejection rather than rendering [object Object]', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject('socket hang up')),
    );
    const report = await runDiagnostics();
    expect(report.checks.find((c) => c.id === 'server')!.detail).toContain('socket hang up');
  });
});

describe('formatReport', () => {
  it('renders a plain-text report carrying the server URL and every check', async () => {
    stubFetch({
      '/api/healthz': HEALTHY['/api/healthz'],
      '/api/daemon/healthz': { status: 503, body: {} },
    });
    const text = formatReport(await runDiagnostics());
    expect(text).toContain('patch connection diagnostics');
    expect(text).toContain('server:');
    expect(text).toContain('FAIL');
    expect(text).toContain('agent');
  });

  // A phone that reaches its server through a relay looks different from one
  // that does not, and the report is where that gets said.
  it('says when the server is reached through a relay', async () => {
    stubFetch(HEALTHY);
    setRoute({
      kind: 'relay',
      relay: { url: 'wss://relay.example.com', channel: 'c', serverKey: 'k' },
    });
    const text = formatReport(await runDiagnostics());
    expect(text).toContain('through relay.example.com');
    expect(text).toContain('end-to-end encrypted, through a relay');
  });

  it('names the host of a direct route', async () => {
    stubFetch(HEALTHY);
    __clearAllMmkv();
    const text = formatReport(await runDiagnostics());
    expect(text).toContain('server:    patch.test');
    expect(text).toContain('route:     direct');
  });
});

describe('ConnectionDiagnostics screen', () => {
  it('runs the checks on mount and names the agent as the thing that is down', async () => {
    stubFetch({
      '/api/healthz': HEALTHY['/api/healthz'],
      '/api/daemon/healthz': { status: 503, body: {} },
    });
    const r = renderRN(<ConnectionDiagnostics />);
    await flush();
    expect(textOf(findHost(r.root, byTestId('diagnostics-headline')))).toMatch(/agent/i);
    expect(textOf(findHost(r.root, byTestId('check-server-status')))).toBe('OK');
    expect(textOf(findHost(r.root, byTestId('check-agent-status')))).toBe('FAILED');
  });

  it('names the server when the server itself is unreachable', async () => {
    stubFetch({
      '/api/healthz': { status: 0, throws: new TypeError('Network request failed') },
      '/api/daemon/healthz': { status: 0, throws: new TypeError('Network request failed') },
    });
    const r = renderRN(<ConnectionDiagnostics />);
    await flush();
    expect(textOf(findHost(r.root, byTestId('diagnostics-headline')))).toMatch(/server/i);
  });

  it('names the pairing problem when there is no credential', async () => {
    clearCredential();
    stubFetch(HEALTHY);
    const r = renderRN(<ConnectionDiagnostics />);
    await flush();
    expect(textOf(findHost(r.root, byTestId('diagnostics-headline')))).toMatch(/paired/i);
  });

  it('names the live connection when everything answers but the socket is down', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({ connection: 'reconnecting' });
    const r = renderRN(<ConnectionDiagnostics />);
    await flush();
    expect(textOf(findHost(r.root, byTestId('diagnostics-headline')))).toMatch(/live connection/i);
  });

  it('says everything is reachable when no check fails', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({ connection: 'connected' });
    const r = renderRN(<ConnectionDiagnostics />);
    await flush();
    expect(textOf(findHost(r.root, byTestId('diagnostics-headline')))).toMatch(/reachable/i);
  });

  it('shows a running state while the checks are in flight', async () => {
    stubFetch(HEALTHY);
    const r = renderRN(<ConnectionDiagnostics />);
    expect(queryHost(r.root, byTestId('diagnostics-running'))).not.toBeNull();
    await flush();
    expect(queryHost(r.root, byTestId('diagnostics-running'))).toBeNull();
  });

  it('Retry now dials the socket immediately and re-runs the checks', async () => {
    const fetchFn = stubFetch(HEALTHY);
    const r = renderRN(<ConnectionDiagnostics />);
    await flush();
    const before = fetchFn.mock.calls.length;
    findHost(r.root, byTestId('diagnostics-retry')).props.onPress();
    await flush();
    expect(reconnectNow).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls.length).toBeGreaterThan(before);
  });

  it('Copy report puts the plain-text report on the clipboard', async () => {
    stubFetch(HEALTHY);
    const r = renderRN(<ConnectionDiagnostics />);
    await flush();
    findHost(r.root, byTestId('diagnostics-copy')).props.onPress();
    await flush();
    expect(__lastCopied()).toContain('patch connection diagnostics');
    expect(textOf(findHost(r.root, byTestId('diagnostics-copy')))).toMatch(/copied/i);
  });

  // Android draws the app behind the system navigation bar, and the button row
  // (Close included) is the bottom of the card — without the inset it lands
  // under the bar and the press never reaches it.
  it('pads past the bottom safe-area inset so the controls clear the nav bar', async () => {
    stubFetch(HEALTHY);
    __setSafeAreaInsets({ bottom: 48 });
    try {
      const r = renderRN(<ConnectionDiagnostics />);
      await flush();
      const style = findHost(r.root, byTestId('connection-diagnostics')).props.style as {
        paddingBottom?: number;
      };
      expect(style.paddingBottom).toBe(space.lg + 48);
    } finally {
      __setSafeAreaInsets({ bottom: 10 });
    }
  });

  it('says so loudly when the clipboard write fails — never a silent no-op', async () => {
    stubFetch(HEALTHY);
    __setFail(true);
    const r = renderRN(<ConnectionDiagnostics />);
    await flush();
    findHost(r.root, byTestId('diagnostics-copy')).props.onPress();
    await flush();
    expect(textOf(findHost(r.root, byTestId('diagnostics-copy')))).toMatch(/copy failed/i);
  });
});

describe('ConnectionDiagnosticsGate', () => {
  it('does not take over on the first connect attempt — no offline flash on load', () => {
    usePresenceStore.setState({
      connection: 'connecting',
      everConnected: false,
      failedAttempts: 0,
    });
    const r = renderRN(<ConnectionDiagnosticsGate />);
    expect(r.toJSON()).toBeNull();
  });

  it('does not take over after a single failed attempt', () => {
    usePresenceStore.setState({ connection: 'offline', everConnected: false, failedAttempts: 1 });
    const r = renderRN(<ConnectionDiagnosticsGate />);
    expect(r.toJSON()).toBeNull();
  });

  it('takes over the screen once a never-connected phone has failed twice', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({ connection: 'offline', everConnected: false, failedAttempts: 2 });
    const r = renderRN(<ConnectionDiagnosticsGate />);
    expect(queryHost(r.root, byTestId('connection-diagnostics'))).not.toBeNull();
    await flush();
  });

  // The bug this covers: the blocking takeover rendered no Close at all, so a
  // phone that launched with the server unreachable was stuck behind a
  // full-screen overlay with no way back into the app.
  it('the blocking takeover carries a Close, and closing it gives the app back', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({ connection: 'offline', everConnected: false, failedAttempts: 2 });
    const r = renderRN(<ConnectionDiagnosticsGate />);
    await flush();
    findHost(r.root, byTestId('diagnostics-dismiss')).props.onPress();
    await flush();
    expect(r.toJSON()).toBeNull();
  });

  it('a closed takeover stays closed when the next attempt fails', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({ connection: 'offline', everConnected: false, failedAttempts: 2 });
    const r = renderRN(<ConnectionDiagnosticsGate />);
    await flush();
    findHost(r.root, byTestId('diagnostics-dismiss')).props.onPress();
    await flush();
    actSync(() => {
      usePresenceStore.setState({ failedAttempts: 7 });
    });
    expect(r.toJSON()).toBeNull();
  });

  it('a closed takeover comes back when a banner asks to diagnose', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({ connection: 'offline', everConnected: false, failedAttempts: 2 });
    const r = renderRN(<ConnectionDiagnosticsGate />);
    await flush();
    findHost(r.root, byTestId('diagnostics-dismiss')).props.onPress();
    await flush();
    actSync(() => {
      useUiStore.getState().setDiagnosticsOpen(true);
    });
    await flush();
    expect(queryHost(r.root, byTestId('connection-diagnostics'))).not.toBeNull();
    expect(queryHost(r.root, byTestId('diagnostics-dismiss'))).not.toBeNull();
  });

  // Opening it deliberately while the phone happens to be in blocking state
  // must not hand back the version with no way out.
  it('an overlay opened while blocking is still dismissible, and closes both', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({ connection: 'offline', everConnected: false, failedAttempts: 2 });
    useUiStore.setState({ diagnosticsOpen: true });
    const r = renderRN(<ConnectionDiagnosticsGate />);
    await flush();
    findHost(r.root, byTestId('diagnostics-dismiss')).props.onPress();
    await flush();
    expect(useUiStore.getState().diagnosticsOpen).toBe(false);
    expect(useUiStore.getState().diagnosticsBlockingClosed).toBe(true);
    expect(r.toJSON()).toBeNull();
  });

  it('never blocks a phone that HAS connected — a daemon-offline surface stays navigable', () => {
    usePresenceStore.setState({
      connection: 'connected',
      daemon: 'offline',
      everConnected: true,
      failedAttempts: 5,
    });
    const r = renderRN(<ConnectionDiagnosticsGate />);
    expect(r.toJSON()).toBeNull();
  });

  it('opens on demand as a dismissible overlay when a banner asks to diagnose', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({ connection: 'connected', everConnected: true });
    useUiStore.setState({ diagnosticsOpen: true });
    const r = renderRN(<ConnectionDiagnosticsGate />);
    await flush();
    findHost(r.root, byTestId('diagnostics-dismiss')).props.onPress();
    await flush();
    expect(useUiStore.getState().diagnosticsOpen).toBe(false);
    expect(r.toJSON()).toBeNull();
  });
});

it('opens pairing even while diagnostics is waiting on an unreachable server', () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  );
  const r = renderRN(<ConnectionDiagnostics />);
  useUiStore.setState({ diagnosticsOpen: true, diagnosticsBlockingClosed: false });
  actSync(() => findHost(r.root, byTestId('diagnostics-pair')).props.onPress());
  expect(routerMock.push).toHaveBeenCalledWith('/pair');
  expect(useUiStore.getState().diagnosticsOpen).toBe(false);
  expect(useUiStore.getState().diagnosticsBlockingClosed).toBe(true);
});
