// Connection diagnostics screen (spec/12 § Connection diagnostics screen).
//
// The failure this covers: a surface that cannot reach the agent used to show
// nothing but "Reconnecting…", which tells the user neither WHAT is broken
// (server down / host down / credential rejected) nor gives them anything to
// report. These tests pin the real behaviour: the checks actually run over the
// network, they distinguish the failure modes, the screen takes over only when
// the surface has never connected, and the report is copyable.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react';
import {
  ConnectionDiagnostics,
  ConnectionDiagnosticsGate,
} from '../components/ConnectionDiagnostics.js';
import { runDiagnostics, formatReport } from '../lib/diagnostics.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { saveCredential, clearCredential } from '../lib/credential.js';
import { setActiveWs, PatchWs } from '../api/ws.js';
import { decodeCompat, resetWireCompatStats } from '@patch/wire';

// A shape-valid surface credential (3-part JWT with a surface_id claim).
const CRED = `x.${btoa(JSON.stringify({ surface_id: 'srf_1', surface_kind: 'web' }))}.y`;

interface FetchCase {
  status: number;
  body?: unknown;
  throws?: Error;
}

function stubFetch(routes: Record<string, FetchCase>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: string) => {
    const route = routes[input];
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
  clearCredential();
  saveCredential(CRED);
  usePresenceStore.setState({
    connection: 'offline',
    daemonOnline: false,
    wsUrl: 'ws://test/ws',
    everConnected: false,
    failedAttempts: 0,
    lastClose: null,
  });
  useUiStore.setState({ diagnosticsOpen: false, diagnosticsBlockingClosed: false });
  resetWireCompatStats();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setActiveWs(null);
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
      ['protocol', 'pass'],
    ]);
    expect(report.checks[1]!.detail).toContain('1.2.3');
    expect(report.checks[1]!.detail).toContain('abcdef1');
  });

  // spec/03 § Forward compatibility. Tolerating a newer host must not make
  // the drift invisible: the diagnostics screen is where a surface admits it is
  // behind, which is the "update me" the old strict decode shouted once per
  // frame and nobody could act on.
  it('reports an IGNORED FIELD from a newer agent as drift, but not as a failure', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({ connection: 'connected', everConnected: true });
    decodeCompat(
      JSON.stringify({
        type: 'chat.state',
        chatId: 'c1',
        activity: 'idle',
        permissionMode: 'bypassPermissions',
        lastUpdated: 1,
        limitResetsAt: 2,
      }),
    );

    const report = await runDiagnostics();

    const protocolCheck = report.checks.find((c) => c.id === 'protocol');
    expect(protocolCheck!.status).toBe('pass');
    expect(protocolCheck!.detail).toContain('chat.state.limitResetsAt');
  });

  it('FAILS when an event type was dropped — that is behaviour this build is missing', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({ connection: 'connected', everConnected: true });
    decodeCompat(JSON.stringify({ type: 'chat.vibes', chatId: 'c1' }));

    const report = await runDiagnostics();

    const protocolCheck = report.checks.find((c) => c.id === 'protocol');
    expect(protocolCheck!.status).toBe('fail');
    expect(protocolCheck!.detail).toContain('chat.vibes');
    expect(protocolCheck!.detail).toContain('update this surface');
  });

  it('distinguishes a DOWN AGENT from a down server — server passes, agent fails on 503', async () => {
    stubFetch({
      '/api/healthz': HEALTHY['/api/healthz'],
      '/api/daemon/healthz': { status: 503, body: { ok: false, reason: 'host offline' } },
    });
    const report = await runDiagnostics();
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.server!.status).toBe('pass');
    expect(byId.agent!.status).toBe('fail');
    expect(byId.agent!.detail).toMatch(/agent/i);
  });

  it('reports the server unreachable with the thrown network error, and cannot claim the agent is fine', async () => {
    stubFetch({
      '/api/healthz': { status: 0, throws: new TypeError('Failed to fetch') },
      '/api/daemon/healthz': { status: 0, throws: new TypeError('Failed to fetch') },
    });
    const report = await runDiagnostics();
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
    expect(byId.server!.status).toBe('fail');
    expect(byId.server!.detail).toContain('Failed to fetch');
    expect(byId.agent!.status).toBe('fail');
  });

  it('reports a rejected credential distinctly when the agent probe 401s', async () => {
    stubFetch({
      '/api/healthz': HEALTHY['/api/healthz'],
      '/api/daemon/healthz': { status: 401, body: { error: 'unauthenticated' } },
    });
    const report = await runDiagnostics();
    const agent = report.checks.find((c) => c.id === 'agent')!;
    expect(agent.status).toBe('fail');
    expect(agent.detail).toMatch(/credential/i);
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
    expect(byId.agent!.status).toBe('fail');
    expect(byId.agent!.detail).toMatch(/credential/i);
    expect(fetchFn.mock.calls.map((c) => c[0])).not.toContain('/api/daemon/healthz');
  });

  it('carries the websocket state, url, failed-attempt count and last close reason', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({
      connection: 'reconnecting',
      failedAttempts: 3,
      lastClose: { code: 1006, reason: 'abnormal closure', at: 1_700_000_000_000 },
    });
    const report = await runDiagnostics();
    const socket = report.checks.find((c) => c.id === 'websocket')!;
    expect(socket.status).toBe('fail');
    expect(socket.detail).toContain('reconnecting');
    expect(socket.detail).toContain('3');
    expect(socket.detail).toContain('1006');
    expect(socket.detail).toContain('abnormal closure');
    expect(report.wsUrl).toBe('ws://test/ws');
  });

  it('says so plainly when no socket URL is known and the close carried no reason', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({
      wsUrl: null,
      lastClose: { code: 1006, reason: '', at: 1_700_000_000_000 },
    });
    const report = await runDiagnostics();
    expect(report.wsUrl).toBe('(none)');
    const socket = report.checks.find((c) => c.id === 'websocket')!;
    expect(socket.detail).toContain('(none)');
    expect(socket.detail).toContain('(no reason)');
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
  it('renders a plain-text report carrying every check and the surface build', async () => {
    stubFetch({
      '/api/healthz': HEALTHY['/api/healthz'],
      '/api/daemon/healthz': { status: 503, body: {} },
    });
    const text = formatReport(await runDiagnostics());
    expect(text).toContain('patch connection diagnostics');
    expect(text).toContain('ws://test/ws');
    expect(text).toContain('credential');
    expect(text).toContain('server');
    expect(text).toContain('agent');
    expect(text).toContain('websocket');
    expect(text).toContain('FAIL');
  });
});

describe('ConnectionDiagnostics screen', () => {
  it('runs the checks on mount and names the agent as the thing that is down', async () => {
    stubFetch({
      '/api/healthz': HEALTHY['/api/healthz'],
      '/api/daemon/healthz': { status: 503, body: {} },
    });
    render(<ConnectionDiagnostics />);
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-headline')).toHaveTextContent(/agent/i),
    );
    expect(screen.getByTestId('check-server')).toHaveTextContent(/OK/);
    expect(screen.getByTestId('check-agent')).toHaveTextContent(/FAILED/);
  });

  it('names the server when the server itself is unreachable', async () => {
    stubFetch({
      '/api/healthz': { status: 0, throws: new TypeError('Failed to fetch') },
      '/api/daemon/healthz': { status: 0, throws: new TypeError('Failed to fetch') },
    });
    render(<ConnectionDiagnostics />);
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-headline')).toHaveTextContent(/server/i),
    );
  });

  it('names the pairing problem when there is no credential', async () => {
    clearCredential();
    stubFetch(HEALTHY);
    render(<ConnectionDiagnostics />);
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-headline')).toHaveTextContent(/paired/i),
    );
  });

  it('names the live connection when everything answers but the socket is down', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({ connection: 'reconnecting' });
    render(<ConnectionDiagnostics />);
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-headline')).toHaveTextContent(/live connection/i),
    );
  });

  it('says everything is reachable when no check fails', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({ connection: 'connected' });
    render(<ConnectionDiagnostics />);
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-headline')).toHaveTextContent(/reachable/i),
    );
  });

  it('Retry now dials the socket immediately and re-runs the checks', async () => {
    const fetchFn = stubFetch(HEALTHY);
    const reconnectNow = vi.fn();
    setActiveWs({ reconnectNow } as unknown as PatchWs);
    render(<ConnectionDiagnostics />);
    await waitFor(() => expect(screen.getByTestId('check-server')).toBeInTheDocument());
    const before = fetchFn.mock.calls.length;
    fireEvent.click(screen.getByTestId('diagnostics-retry'));
    expect(reconnectNow).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(fetchFn.mock.calls.length).toBeGreaterThan(before));
  });

  it('Retry now is a no-op on the socket when no connection is registered', async () => {
    stubFetch(HEALTHY);
    setActiveWs(null);
    render(<ConnectionDiagnostics />);
    await waitFor(() => expect(screen.getByTestId('check-server')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('diagnostics-retry'));
    await waitFor(() => expect(screen.getByTestId('check-server')).toBeInTheDocument());
  });

  it('Copy report puts the plain-text report on the clipboard', async () => {
    stubFetch(HEALTHY);
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<ConnectionDiagnostics />);
    await waitFor(() => expect(screen.getByTestId('check-server')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('diagnostics-copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(String(writeText.mock.calls[0]![0])).toContain('patch connection diagnostics');
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-copy')).toHaveTextContent(/copied/i),
    );
  });

  it('says so loudly when the clipboard write fails — never a silent no-op', async () => {
    stubFetch(HEALTHY);
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<ConnectionDiagnostics />);
    await waitFor(() => expect(screen.getByTestId('check-server')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('diagnostics-copy'));
    await waitFor(() =>
      expect(screen.getByTestId('diagnostics-copy')).toHaveTextContent(/copy failed/i),
    );
  });

  it('shows a running state while the checks are in flight', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await gate;
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }),
    );
    render(<ConnectionDiagnostics />);
    expect(screen.getByTestId('diagnostics-running')).toBeInTheDocument();
    release();
    await waitFor(() => expect(screen.queryByTestId('diagnostics-running')).toBeNull());
  });
});

describe('ConnectionDiagnosticsGate', () => {
  it('does not take over on the first connect attempt — no offline flash on load', () => {
    usePresenceStore.setState({
      connection: 'connecting',
      everConnected: false,
      failedAttempts: 0,
    });
    const { container } = render(<ConnectionDiagnosticsGate />);
    expect(container).toBeEmptyDOMElement();
  });

  it('does not take over after a single failed attempt', () => {
    usePresenceStore.setState({ connection: 'offline', everConnected: false, failedAttempts: 1 });
    const { container } = render(<ConnectionDiagnosticsGate />);
    expect(container).toBeEmptyDOMElement();
  });

  it('takes over the window once a never-connected surface has failed twice', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({ connection: 'offline', everConnected: false, failedAttempts: 2 });
    render(<ConnectionDiagnosticsGate />);
    expect(screen.getByTestId('connection-diagnostics')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('check-server')).toBeInTheDocument());
  });

  // The takeover must never be a trap: it rendered no Close at all, so a
  // surface that loaded with the server unreachable had no way back into the
  // app.
  it('the blocking takeover carries a Close, and closing it gives the app back', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({ connection: 'offline', everConnected: false, failedAttempts: 2 });
    const { container } = render(<ConnectionDiagnosticsGate />);
    await waitFor(() => expect(screen.getByTestId('check-server')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('diagnostics-dismiss'));
    expect(container).toBeEmptyDOMElement();
  });

  it('a closed takeover stays closed when the next attempt fails', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({ connection: 'offline', everConnected: false, failedAttempts: 2 });
    const { container } = render(<ConnectionDiagnosticsGate />);
    await waitFor(() => expect(screen.getByTestId('check-server')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('diagnostics-dismiss'));
    act(() => {
      usePresenceStore.setState({ failedAttempts: 7 });
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('a closed takeover comes back when a banner asks to diagnose', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({ connection: 'offline', everConnected: false, failedAttempts: 2 });
    render(<ConnectionDiagnosticsGate />);
    await waitFor(() => expect(screen.getByTestId('check-server')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('diagnostics-dismiss'));
    act(() => {
      useUiStore.getState().setDiagnosticsOpen(true);
    });
    expect(screen.getByTestId('connection-diagnostics')).toBeInTheDocument();
    expect(screen.getByTestId('diagnostics-dismiss')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('check-server')).toBeInTheDocument());
  });

  it('an overlay opened while blocking is still dismissible, and closes both', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({ connection: 'offline', everConnected: false, failedAttempts: 2 });
    useUiStore.setState({ diagnosticsOpen: true });
    const { container } = render(<ConnectionDiagnosticsGate />);
    await waitFor(() => expect(screen.getByTestId('check-server')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('diagnostics-dismiss'));
    expect(useUiStore.getState().diagnosticsOpen).toBe(false);
    expect(useUiStore.getState().diagnosticsBlockingClosed).toBe(true);
    expect(container).toBeEmptyDOMElement();
  });

  it('never blocks a surface that HAS connected — a daemon-offline surface stays navigable', () => {
    usePresenceStore.setState({
      connection: 'connected',
      daemonOnline: false,
      everConnected: true,
      failedAttempts: 5,
    });
    const { container } = render(<ConnectionDiagnosticsGate />);
    expect(container).toBeEmptyDOMElement();
  });

  it('opens on demand as a dismissible overlay when a banner asks to diagnose', async () => {
    stubFetch(HEALTHY);
    usePresenceStore.setState({
      connection: 'connected',
      daemonOnline: false,
      everConnected: true,
    });
    useUiStore.setState({ diagnosticsOpen: true });
    render(<ConnectionDiagnosticsGate />);
    expect(screen.getByTestId('connection-diagnostics')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('diagnostics-dismiss'));
    expect(useUiStore.getState().diagnosticsOpen).toBe(false);
    expect(screen.queryByTestId('connection-diagnostics')).toBeNull();
  });
});
