// Host terminal (spec/15 § Host files and terminal, spec/02 § Terminal
// sessions — PTY sessions). Drives the screen the way the page and the host
// would: page messages in through the WebView's onMessage, host frames in
// through the terminal store, and asserts on the wire frames sent and the
// calls injected into the page.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import type { WireEvent } from '@patch/wire';
import {
  renderRN,
  findHost,
  byTestId,
  hasText,
  flush,
  actSync,
  actAsync,
} from './testUtils/render';
import HostTerminal from '../app/hosts/[daemonId]/terminal';
import { routerMock, __resetRouterMock, __setLocalSearchParams } from './stubs/expo-router';
import { __injected, __resetWebView } from './stubs/webview';
import { TOO_OLD_MESSAGE, useTerminalStore } from '../src/stores/terminalStore';
import { useFolderStore } from '../src/stores/folderStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useUiStore } from '../src/stores/uiStore';
import { lightColors } from '../src/lib/theme';

const { wsMock, listSpy } = vi.hoisted(() => ({
  wsMock: { send: vi.fn(), safeSend: vi.fn() },
  listSpy: vi.fn(),
}));
vi.mock('../src/api/ws', () => ({ getWs: () => wsMock }));
vi.mock('../src/api/rest', async (orig) => ({
  ...(await orig<typeof import('../src/api/rest')>()),
  api: { hostFilesList: listSpy },
}));

const mounted: ReactTestRenderer[] = [];
function render(): ReactTestRenderer {
  const r = renderRN(<HostTerminal />);
  mounted.push(r);
  return r;
}

const webview = (r: ReactTestRenderer) => findHost(r.root, byTestId('terminal-webview'));
function fromPage(r: ReactTestRenderer, msg: unknown): void {
  actSync(() => {
    (webview(r).props.onMessage as (e: { nativeEvent: { data: string } }) => void)({
      nativeEvent: { data: typeof msg === 'string' ? msg : JSON.stringify(msg) },
    });
  });
}
const fromDaemon = (event: WireEvent): void =>
  actSync(() => useTerminalStore.getState().ingest(event));
const press = (r: ReactTestRenderer, id: string): void =>
  actSync(() => {
    (findHost(r.root, byTestId(id)).props.onPress as () => void)();
  });

const sent = (): WireEvent[] => wsMock.send.mock.calls.map((c) => c[0] as WireEvent);
const safeSent = (): WireEvent[] => wsMock.safeSend.mock.calls.map((c) => c[0] as WireEvent);
const opened = (): Extract<WireEvent, { type: 'patch.terminal.open' }> =>
  sent().find((e) => e.type === 'patch.terminal.open') as Extract<
    WireEvent,
    { type: 'patch.terminal.open' }
  >;
const inputs = (): string[] =>
  sent()
    .filter(
      (e): e is Extract<WireEvent, { type: 'patch.terminal.input' }> =>
        e.type === 'patch.terminal.input',
    )
    .map((e) => e.data);

/** Mount in /srv, let the page load, and let the host confirm a PTY. */
function openLive(): { r: ReactTestRenderer; sessionId: string } {
  __setLocalSearchParams({ daemonId: 'd1', folder: '/srv' });
  const r = render();
  fromPage(r, { type: 'ready', cols: 48, rows: 20 });
  const sessionId = opened().sessionId;
  fromDaemon({ type: 'patch.terminal.ready', sessionId, cwd: '/srv', pty: true });
  return { r, sessionId };
}

describe('Host terminal', () => {
  beforeEach(() => {
    __resetRouterMock();
    __resetWebView();
    wsMock.send.mockReset();
    wsMock.safeSend.mockReset();
    listSpy.mockReset();
    useTerminalStore.getState()._reset();
    useFolderStore.getState()._reset();
    usePresenceStore.setState({ hosts: {} });
    useUiStore.setState({ errors: [] });
  });
  afterEach(() => {
    actSync(() => {
      for (const r of mounted.splice(0)) r.unmount();
    });
  });

  it('draws with a real emulator page in the app`s theme, and opens nothing before it has measured', () => {
    __setLocalSearchParams({ daemonId: 'd1', folder: '/srv' });
    const r = render();
    const html = (webview(r).props.source as { html: string }).html;
    expect(html).toContain('new Terminal(');
    expect(html).toContain(lightColors.paper);
    expect(sent()).toEqual([]);
  });

  it('opens a PTY at the page`s size, in the chosen folder, on the named host', () => {
    __setLocalSearchParams({ daemonId: 'd1', folder: '/srv' });
    const r = render();
    fromPage(r, { type: 'ready', cols: 48, rows: 20 });
    expect(opened()).toMatchObject({
      type: 'patch.terminal.open',
      daemonId: 'd1',
      folder: '/srv',
      pty: { cols: 48, rows: 20 },
    });
    expect(opened().sessionId).toMatch(/^term-[0-9a-f]{16}$/);
    expect(hasText(findHost(r.root, byTestId('terminal-status-text')), 'Starting')).toBe(true);
    expect(__injected).toContain('window.__patch.focus();true;');
  });

  it('a `command` param is typed into the shell once, as soon as it is live', () => {
    __setLocalSearchParams({ daemonId: 'd1', folder: '/srv', command: "tail -f '/x/t1.output'" });
    const r = render();
    fromPage(r, { type: 'ready', cols: 48, rows: 20 });
    expect(inputs()).toEqual([]);
    const sessionId = opened().sessionId;
    fromDaemon({ type: 'patch.terminal.ready', sessionId, cwd: '/srv', pty: true });
    expect(inputs()).toEqual(["tail -f '/x/t1.output'\r"]);
    fromDaemon({ type: 'patch.terminal.output', sessionId, stream: 'stdout', data: 'x' });
    expect(inputs()).toHaveLength(1);
  });

  it('once live, draws the shell`s output and sends what is typed', () => {
    const { r, sessionId } = openLive();
    expect(r.root.findAll((n) => n.props?.testID === 'terminal-status')).toHaveLength(0);
    fromDaemon({
      type: 'patch.terminal.output',
      sessionId,
      stream: 'stdout',
      data: 'tom@box:/srv$ ',
    });
    expect(__injected).toContain('window.__patch.write("tom@box:/srv$ ");true;');
    fromPage(r, { type: 'data', data: 'ls\r' });
    expect(inputs()).toEqual(['ls\r']);
    // Only the new output is written the next time.
    fromDaemon({ type: 'patch.terminal.output', sessionId, stream: 'stdout', data: 'a b\r\n' });
    expect(__injected.filter((j) => j.startsWith('window.__patch.write'))).toEqual([
      'window.__patch.write("tom@box:/srv$ ");true;',
      'window.__patch.write("a b\\r\\n");true;',
    ]);
  });

  it('sticky Ctrl turns the next typed key into its control character, then lets go', () => {
    const { r } = openLive();
    press(r, 'terminal-key-ctrl');
    expect(findHost(r.root, byTestId('terminal-key-ctrl')).props.accessibilityState).toEqual({
      selected: true,
    });
    fromPage(r, { type: 'data', data: 'c' });
    fromPage(r, { type: 'data', data: 'c' });
    expect(inputs()).toEqual(['\x03', 'c']);
    expect(findHost(r.root, byTestId('terminal-key-ctrl')).props.accessibilityState).toEqual({
      selected: false,
    });
    // Tapping Ctrl again before a key disarms it.
    press(r, 'terminal-key-ctrl');
    press(r, 'terminal-key-ctrl');
    fromPage(r, { type: 'data', data: 'd' });
    expect(inputs()).toEqual(['\x03', 'c', 'd']);
  });

  it('the key bar sends terminal bytes, and arrows follow the cursor-key mode', () => {
    const { r } = openLive();
    press(r, 'terminal-key-esc');
    press(r, 'terminal-key-tab');
    press(r, 'terminal-key-up');
    press(r, 'terminal-key-pipe');
    press(r, 'terminal-key-tilde');
    press(r, 'terminal-key-slash');
    fromPage(r, { type: 'modes', appCursor: true });
    press(r, 'terminal-key-up');
    press(r, 'terminal-key-ctrl');
    press(r, 'terminal-key-left');
    press(r, 'terminal-key-down');
    expect(inputs()).toEqual([
      '\x1b',
      '\t',
      '\x1b[A',
      '|',
      '~',
      '/',
      '\x1bOA',
      '\x1b[1;5D',
      '\x1bOB',
    ]);
  });

  it('tells the host when the terminal changes size', () => {
    const { r, sessionId } = openLive();
    fromPage(r, { type: 'resize', cols: 40, rows: 12 });
    expect(safeSent()).toContainEqual({
      type: 'patch.terminal.resize',
      sessionId,
      cols: 40,
      rows: 12,
    });
  });

  it('types nothing into a session that is not live', () => {
    __setLocalSearchParams({ daemonId: 'd1', folder: '/srv' });
    const r = render();
    fromPage(r, { type: 'ready', cols: 48, rows: 20 });
    fromPage(r, { type: 'data', data: 'x' });
    fromPage(r, { type: 'resize', cols: 40, rows: 12 });
    press(r, 'terminal-key-esc');
    expect(inputs()).toEqual([]);
    expect(safeSent().filter((e) => e.type === 'patch.terminal.resize')).toEqual([]);
  });

  it('closes the shell on the host when the screen goes', () => {
    const { r, sessionId } = openLive();
    mounted.splice(mounted.indexOf(r), 1);
    actSync(() => r.unmount());
    expect(safeSent()).toContainEqual({ type: 'patch.terminal.close', sessionId });
    expect(useTerminalStore.getState().sessions[sessionId]).toBeUndefined();
  });

  it('refuses a pipe shell from a host too old for a PTY, and closes it (NO FALLBACK)', () => {
    __setLocalSearchParams({ daemonId: 'd1', folder: '/srv' });
    const r = render();
    fromPage(r, { type: 'ready', cols: 48, rows: 20 });
    const sessionId = opened().sessionId;
    fromDaemon({ type: 'patch.terminal.ready', sessionId, cwd: '/srv' });
    expect(hasText(findHost(r.root, byTestId('terminal-status-text')), TOO_OLD_MESSAGE)).toBe(true);
    expect(safeSent()).toContainEqual({ type: 'patch.terminal.close', sessionId });
    fromPage(r, { type: 'data', data: 'ls\r' });
    expect(inputs()).toEqual([]);
  });

  it('an ended session says why and restarts as a fresh shell on a cleared screen', () => {
    const { r, sessionId } = openLive();
    fromDaemon({ type: 'patch.terminal.exit', sessionId, code: 0, reason: 'shell_exit' });
    expect(hasText(r.root, 'Shell exited with status 0')).toBe(true);
    press(r, 'terminal-restart');
    expect(__injected).toContain('window.__patch.reset();true;');
    const opens = sent().filter((e) => e.type === 'patch.terminal.open') as Array<
      Extract<WireEvent, { type: 'patch.terminal.open' }>
    >;
    expect(opens).toHaveLength(2);
    expect(opens[1]!.sessionId).not.toBe(sessionId);
    expect(opens[1]!.pty).toEqual({ cols: 48, rows: 20 });
  });

  it('says so when the open cannot even be sent', () => {
    wsMock.send.mockImplementation(() => {
      throw new Error('PatchWs: not connected');
    });
    __setLocalSearchParams({ daemonId: 'd1', folder: '/srv' });
    const r = render();
    fromPage(r, { type: 'ready', cols: 48, rows: 20 });
    expect(
      hasText(findHost(r.root, byTestId('terminal-status-text')), 'Could not reach the server'),
    ).toBe(true);
    expect(r.root.findAll((n) => n.props?.testID === 'terminal-restart').length).toBeGreaterThan(0);
  });

  it('a keystroke the link drops is reported, not swallowed', () => {
    const { r } = openLive();
    wsMock.send.mockImplementation(() => {
      throw new Error('PatchWs: not connected');
    });
    fromPage(r, { type: 'data', data: 'x' });
    expect(useUiStore.getState().errors.map((e) => e.message)).toEqual([
      'terminal: PatchWs: not connected',
    ]);
  });

  it('a reloaded page is redrawn with the whole scrollback and resized', () => {
    const { r, sessionId } = openLive();
    fromDaemon({ type: 'patch.terminal.output', sessionId, stream: 'stdout', data: 'one ' });
    fromDaemon({ type: 'patch.terminal.output', sessionId, stream: 'stdout', data: 'two' });
    __resetWebView();
    fromPage(r, { type: 'ready', cols: 30, rows: 10 });
    expect(__injected).toContain('window.__patch.write("one two");true;');
    expect(safeSent()).toContainEqual({
      type: 'patch.terminal.resize',
      sessionId,
      cols: 30,
      rows: 10,
    });
    // Still the one session.
    expect(sent().filter((e) => e.type === 'patch.terminal.open')).toHaveLength(1);
  });

  it('reports a page error, and a message it cannot read', () => {
    const { r } = openLive();
    fromPage(r, { type: 'error', message: 'Terminal is not defined' });
    fromPage(r, 'garbage');
    expect(useUiStore.getState().errors.map((e) => e.message)).toEqual([
      'terminal page: Terminal is not defined',
      'terminal page sent something that is not JSON: garbage',
    ]);
  });

  it('back leaves', () => {
    const { r } = openLive();
    press(r, 'host-tool-back');
    expect(routerMock.back).toHaveBeenCalled();
  });

  describe('with no folder, asks where to start', () => {
    beforeEach(() => {
      useFolderStore.getState().setHostFolders({
        daemonId: 'd1',
        roots: ['/home/tom/projects/patch'],
        recent: [],
      });
      __setLocalSearchParams({ daemonId: 'd1' });
    });

    it('offers Home and the host`s project folders; a folder starts there', () => {
      const r = render();
      expect(hasText(r.root, 'Start in')).toBe(true);
      expect(hasText(r.root, 'Home')).toBe(true);
      press(r, 'place-/home/tom/projects/patch');
      fromPage(r, { type: 'ready', cols: 48, rows: 20 });
      expect(opened()).toMatchObject({ folder: '/home/tom/projects/patch' });
      press(r, 'host-tool-back');
      expect(routerMock.back).toHaveBeenCalled();
    });

    it('Home asks the host where home is, then starts there', async () => {
      listSpy.mockResolvedValue({ path: '/home/tom', parent: '/home', entries: [] });
      const r = render();
      await actAsync(async () => {
        (findHost(r.root, byTestId('place-home')).props.onPress as () => void)();
      });
      await flush();
      expect(listSpy).toHaveBeenCalledWith('d1');
      fromPage(r, { type: 'ready', cols: 48, rows: 20 });
      expect(opened()).toMatchObject({ folder: '/home/tom' });
    });

    it('a host that cannot say where home is, says why', async () => {
      listSpy.mockRejectedValue(new Error('host_offline: d1 is offline'));
      const r = render();
      await actAsync(async () => {
        (findHost(r.root, byTestId('place-home')).props.onPress as () => void)();
      });
      await flush();
      expect(hasText(findHost(r.root, byTestId('terminal-home-error')), 'd1 is offline')).toBe(
        true,
      );
      expect(sent()).toEqual([]);
    });
  });
});
