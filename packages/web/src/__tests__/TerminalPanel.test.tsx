// The chat terminal (spec/14 § Terminal, § Panes and tabs) — a
// `{kind:'terminal', chatId}` pane tab now, not a docked drawer.
//
// The point of this feature: the host is remote, so cloning a repo onto it —
// the thing that has to happen before a chat can even be opened in that folder —
// has no other route from a surface. These tests drive the panel the way the
// user does: mount its tab, type `git clone …`, and prove the right frames go
// out and the host's output comes back.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { WireEvent } from '@patch/wire';
import { TerminalPanel } from '../components/TerminalPanel.js';
import { useTerminalStore } from '../stores/terminalStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';

function makeWs(): { send: ReturnType<typeof vi.fn>; sent: WireEvent[] } {
  const sent: WireEvent[] = [];
  const send = vi.fn((e: WireEvent) => {
    sent.push(e);
  });
  return { send, sent };
}

function renderPanel(ws: { send: (e: WireEvent) => void } | null = makeWs()): void {
  render(
    <TerminalPanel
      chatId="c1"
      folder="/home/tom/projects"
      ws={ws as unknown as Parameters<typeof TerminalPanel>[0]['ws']}
    />,
  );
}

/** The sessionId the panel minted for chat `c1`. */
function sessionId(): string {
  const s = useTerminalStore.getState().sessions['c1'];
  if (!s) throw new Error('no session started');
  return s.sessionId;
}

describe('TerminalPanel', () => {
  // A registered host, because every host-scoped action names one. With an
  // empty roster there is no right answer and the UI refuses rather than
  // guessing a machine — which is the behaviour, not a fixture detail.
  beforeEach(() => {
    usePresenceStore
      .getState()
      .setHosts([{ daemonId: 'd1', online: true, lastSeenAt: null, host: null, accounts: [] }]);
    useTerminalStore.getState()._reset();
  });

  it('mounting starts a session in the chat folder', async () => {
    const ws = makeWs();
    renderPanel(ws);
    expect(screen.getByTestId('terminal-pane')).toBeInTheDocument();
    await waitFor(() => expect(ws.sent).toHaveLength(1));
    expect(ws.sent[0]).toMatchObject({
      type: 'patch.terminal.open',
      daemonId: 'd1',
      folder: '/home/tom/projects',
    });
  });

  it('sends a typed command to the host and renders its output', async () => {
    const ws = makeWs();
    renderPanel(ws);
    await waitFor(() => expect(ws.sent).toHaveLength(1));

    useTerminalStore.getState().ingest({
      type: 'patch.terminal.ready',
      sessionId: sessionId(),
      cwd: '/home/tom/projects',
    });

    const input = screen.getByTestId('terminal-input');
    fireEvent.change(input, { target: { value: 'git clone git@github.com:tom/thing.git' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(ws.sent[1]).toMatchObject({
      type: 'patch.terminal.input',
      sessionId: sessionId(),
      data: 'git clone git@github.com:tom/thing.git\n',
    });
    // The input clears, ready for the next command.
    expect((input as HTMLInputElement).value).toBe('');

    useTerminalStore.getState().ingest({
      type: 'patch.terminal.output',
      sessionId: sessionId(),
      stream: 'stdout',
      data: "Cloning into 'thing'...\n",
    });
    expect(await screen.findByText(/Cloning into 'thing'/)).toBeInTheDocument();
  });

  it('tints stderr apart from stdout', async () => {
    const ws = makeWs();
    renderPanel(ws);
    await waitFor(() => expect(ws.sent).toHaveLength(1));
    useTerminalStore.getState().ingest({
      type: 'patch.terminal.output',
      sessionId: sessionId(),
      stream: 'stderr',
      data: 'fatal: repository not found\n',
    });
    const chunk = await screen.findByText(/repository not found/);
    expect(chunk).toHaveClass('term-stderr');
  });

  it('↑ / ↓ walk this session command history', async () => {
    const ws = makeWs();
    renderPanel(ws);
    await waitFor(() => expect(ws.sent).toHaveLength(1));
    const input = screen.getByTestId('terminal-input') as HTMLInputElement;
    for (const cmd of ['ls', 'pwd']) {
      fireEvent.change(input, { target: { value: cmd } });
      fireEvent.keyDown(input, { key: 'Enter' });
    }
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('pwd');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('ls');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.value).toBe('pwd');
  });

  it('Ctrl-C sends SIGINT to the running command, not a session close', async () => {
    const ws = makeWs();
    renderPanel(ws);
    await waitFor(() => expect(ws.sent).toHaveLength(1));
    fireEvent.keyDown(screen.getByTestId('terminal-input'), { key: 'c', ctrlKey: true });
    expect(ws.sent[1]).toMatchObject({ type: 'patch.terminal.signal', signal: 'SIGINT' });
    expect(ws.sent.some((e) => e.type === 'patch.terminal.close')).toBe(false);
  });

  it('closing the tab (unmounting) keeps the shell and the scrollback — reopening re-attaches', async () => {
    const ws = makeWs();
    const { unmount } = render(
      <TerminalPanel
        chatId="c1"
        folder="/home/tom/projects"
        ws={ws as unknown as Parameters<typeof TerminalPanel>[0]['ws']}
      />,
    );
    await waitFor(() => expect(ws.sent).toHaveLength(1));
    useTerminalStore.getState().ingest({
      type: 'patch.terminal.output',
      sessionId: sessionId(),
      stream: 'stdout',
      data: 'still here\n',
    });
    unmount();
    // No close frame: the shell keeps running.
    expect(ws.sent.some((e) => e.type === 'patch.terminal.close')).toBe(false);

    renderPanel(ws);
    expect(await screen.findByText(/still here/)).toBeInTheDocument();
    // Re-opening an existing session does NOT open a second shell.
    expect(ws.sent.filter((e) => e.type === 'patch.terminal.open')).toHaveLength(1);
  });

  it('surfaces a host error and offers a restart (NO FALLBACK)', async () => {
    const ws = makeWs();
    renderPanel(ws);
    await waitFor(() => expect(ws.sent).toHaveLength(1));
    useTerminalStore.getState().ingest({
      type: 'patch.terminal.error',
      sessionId: sessionId(),
      code: 'folder_not_found',
      message: 'folder does not exist on the host: /home/tom/projects',
    });
    expect(await screen.findByText(/does not exist on the host/)).toBeInTheDocument();
    // The dead prompt is replaced by an explicit restart.
    expect(screen.queryByTestId('terminal-input')).toBeNull();
    fireEvent.click(screen.getByTestId('terminal-restart'));
    await waitFor(() =>
      expect(ws.sent.filter((e) => e.type === 'patch.terminal.open')).toHaveLength(2),
    );
  });

  it('says so when the session ends, and restarts on demand', async () => {
    const ws = makeWs();
    renderPanel(ws);
    await waitFor(() => expect(ws.sent).toHaveLength(1));
    useTerminalStore.getState().ingest({
      type: 'patch.terminal.exit',
      sessionId: sessionId(),
      code: 0,
      reason: 'idle_timeout',
    });
    expect(await screen.findByText(/session ended: idle_timeout/)).toBeInTheDocument();
    expect(screen.getByTestId('terminal-restart')).toBeInTheDocument();
  });

  it('reports a send with no socket instead of silently dropping the command', async () => {
    renderPanel(null);
    expect(await screen.findByText(/not connected/i)).toBeInTheDocument();
  });

  it('with no folder (the NEW-CHAT case) still offers a shell — rooted by the host', async () => {
    // This is the case that matters most: you are on /chats/new because the
    // folder does NOT exist on the host yet, and a shell is how you put it
    // there. A terminal that refuses to open without a folder is useless here.
    const ws = makeWs();
    render(
      <TerminalPanel
        chatId="new"
        ws={ws as unknown as Parameters<typeof TerminalPanel>[0]['ws']}
      />,
    );
    await waitFor(() => expect(ws.sent).toHaveLength(1));
    expect(ws.sent[0]).toMatchObject({ type: 'patch.terminal.open' });
    // No folder is CLAIMED — the host picks and reports it.
    expect(ws.sent[0]).not.toHaveProperty('folder');
  });

  it('shows the cwd the host reports, not the one the surface guessed', async () => {
    const ws = makeWs();
    render(
      <TerminalPanel
        chatId="new"
        ws={ws as unknown as Parameters<typeof TerminalPanel>[0]['ws']}
      />,
    );
    await waitFor(() => expect(ws.sent).toHaveLength(1));
    const sid = useTerminalStore.getState().sessions['new']?.sessionId as string;
    useTerminalStore
      .getState()
      .ingest({ type: 'patch.terminal.ready', sessionId: sid, cwd: '/home/claude-dev' });
    expect(await screen.findByText('/home/claude-dev')).toBeInTheDocument();
  });

  it('↓ past the newest history entry returns to an empty line', async () => {
    const ws = makeWs();
    renderPanel(ws);
    await waitFor(() => expect(ws.sent).toHaveLength(1));
    const input = screen.getByTestId('terminal-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ls' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('ls');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.value).toBe('');
    // ↓ at the live line is a no-op.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.value).toBe('');
  });

  it('↑ with no history yet is a no-op', async () => {
    const ws = makeWs();
    renderPanel(ws);
    await waitFor(() => expect(ws.sent).toHaveLength(1));
    const input = screen.getByTestId('terminal-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'half-typed' } });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.value).toBe('half-typed');
  });
});

// Work raised by something OTHER than the prompt — a click on the background
// task bar (spec/14 § Main chat panel — Background task bar). It is queued
// because that click is normally what opens the terminal tab, so at that
// moment there is no session to write into yet.
describe('TerminalPanel — queued work', () => {
  beforeEach(() => {
    usePresenceStore
      .getState()
      .setHosts([{ daemonId: 'd1', online: true, lastSeenAt: null, host: null, accounts: [] }]);
    useTerminalStore.getState()._reset();
  });

  /** Bring the session mounting puts in `starting` up to `live`. */
  async function goLive(): Promise<void> {
    await waitFor(() => expect(useTerminalStore.getState().sessions['c1']).toBeDefined());
    act(() => {
      useTerminalStore
        .getState()
        .ingest({ type: 'patch.terminal.ready', sessionId: sessionId(), cwd: '/home/tom' });
    });
  }

  it('runs a queued command once the session is live, exactly as if typed', async () => {
    const ws = makeWs();
    useTerminalStore.getState().queuePending('c1', { kind: 'command', text: 'tail -f out' });
    renderPanel(ws);
    await goLive();

    await waitFor(() => expect(ws.sent.some((e) => e.type === 'patch.terminal.input')).toBe(true));
    expect(ws.sent.find((e) => e.type === 'patch.terminal.input')).toMatchObject({
      data: 'tail -f out\n',
    });
    // Echoed and remembered, like anything typed at the prompt.
    expect(screen.getByTestId('terminal-scroll').textContent).toContain('❯ tail -f out');
    expect(useTerminalStore.getState().sessions['c1']?.history).toEqual(['tail -f out']);
    expect(useTerminalStore.getState().pending['c1']).toBeUndefined();
  });

  it('nothing runs while the session is still starting', async () => {
    const ws = makeWs();
    useTerminalStore.getState().queuePending('c1', { kind: 'command', text: 'tail -f out' });
    renderPanel(ws);
    await waitFor(() => expect(ws.sent).toHaveLength(1));
    expect(ws.sent.some((e) => e.type === 'patch.terminal.input')).toBe(false);
    expect(useTerminalStore.getState().pending['c1']).toBeDefined();
  });

  it('prints a queued note into the scrollback and runs nothing', async () => {
    const ws = makeWs();
    useTerminalStore
      .getState()
      .queuePending('c1', { kind: 'note', text: '\n[no background id reported yet]\n' });
    renderPanel(ws);
    await goLive();

    await waitFor(() =>
      expect(screen.getByTestId('terminal-scroll').textContent).toContain(
        'no background id reported yet',
      ),
    );
    expect(ws.sent.some((e) => e.type === 'patch.terminal.input')).toBe(false);
    expect(useTerminalStore.getState().sessions['c1']?.history).toEqual([]);
  });

  it('drains once — a later re-render does not run it again', async () => {
    const ws = makeWs();
    useTerminalStore.getState().queuePending('c1', { kind: 'command', text: 'tail -f out' });
    renderPanel(ws);
    await goLive();
    await waitFor(() =>
      expect(ws.sent.filter((e) => e.type === 'patch.terminal.input')).toHaveLength(1),
    );

    // Anything that re-renders the panel: more output arriving.
    act(() => {
      useTerminalStore.getState().ingest({
        type: 'patch.terminal.output',
        sessionId: sessionId(),
        stream: 'stdout',
        data: 'line\n',
      });
    });
    expect(ws.sent.filter((e) => e.type === 'patch.terminal.input')).toHaveLength(1);
  });

  it('drains a command queued while the session is ALREADY live', async () => {
    const ws = makeWs();
    renderPanel(ws);
    await goLive();
    act(() => {
      useTerminalStore.getState().queuePending('c1', { kind: 'command', text: 'ls -l' });
    });
    await waitFor(() => expect(ws.sent.some((e) => e.type === 'patch.terminal.input')).toBe(true));
    expect(ws.sent.find((e) => e.type === 'patch.terminal.input')).toMatchObject({
      data: 'ls -l\n',
    });
  });

  it('a closed (unmounted) terminal tab drains nothing', async () => {
    const ws = makeWs();
    const { unmount } = render(
      <TerminalPanel
        chatId="c1"
        folder="/home/tom/projects"
        ws={ws as unknown as Parameters<typeof TerminalPanel>[0]['ws']}
      />,
    );
    await goLive();
    unmount();
    act(() => {
      useTerminalStore.getState().queuePending('c1', { kind: 'command', text: 'ls -l' });
    });
    expect(ws.sent.some((e) => e.type === 'patch.terminal.input')).toBe(false);
    expect(useTerminalStore.getState().pending['c1']).toBeDefined();
  });
});

// spec/14 § Terminal — command completion. The bug this closes: a command
// that prints nothing looked exactly like a session that had stopped
// answering, because a pipe shell echoes nothing and prints no prompt.
describe('TerminalPanel — command completion', () => {
  beforeEach(() => {
    usePresenceStore
      .getState()
      .setHosts([{ daemonId: 'd1', online: true, lastSeenAt: null, host: null, accounts: [] }]);
    useTerminalStore.getState()._reset();
  });

  it('says a command is still running, and how to interrupt it', async () => {
    const ws = makeWs();
    renderPanel(ws);
    await waitFor(() => expect(ws.sent).toHaveLength(1));
    // Nothing sent yet, so nothing is running.
    expect(screen.queryByTestId('terminal-running')).toBeNull();

    const input = screen.getByTestId('terminal-input');
    fireEvent.change(input, { target: { value: 'cd /tmp' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const marker = await screen.findByTestId('terminal-running');
    expect(marker).toHaveTextContent('⌃C interrupts');

    act(() => {
      useTerminalStore.getState().ingest({
        type: 'patch.terminal.command-exit',
        sessionId: sessionId(),
        code: 0,
      });
    });
    await waitFor(() => expect(screen.queryByTestId('terminal-running')).toBeNull());
    // A clean run leaves the scrollback as the echo alone — no "done" noise.
    expect(screen.getByTestId('terminal-scroll')).toHaveTextContent('❯ cd /tmp');
    expect(screen.getByTestId('terminal-scroll').textContent).not.toContain('exit');
  });

  it('keeps showing a wedged command as running, so the terminal never looks dead', async () => {
    const ws = makeWs();
    renderPanel(ws);
    await waitFor(() => expect(ws.sent).toHaveLength(1));
    const input = screen.getByTestId('terminal-input');
    // `python3` prints no banner without a TTY and never returns — the exact
    // shape of the original report.
    fireEvent.change(input, { target: { value: 'python3' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByTestId('terminal-running')).toBeInTheDocument();
    // Still running with no output at all, which is the whole point.
    expect(screen.getByTestId('terminal-scroll').textContent).toBe('❯ python3\n');
  });

  it('spells out a non-zero exit in the scrollback', async () => {
    const ws = makeWs();
    renderPanel(ws);
    await waitFor(() => expect(ws.sent).toHaveLength(1));
    const input = screen.getByTestId('terminal-input');
    fireEvent.change(input, { target: { value: 'git push' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    act(() => {
      useTerminalStore.getState().ingest({
        type: 'patch.terminal.command-exit',
        sessionId: sessionId(),
        code: 128,
      });
    });
    const chunk = await screen.findByText(/exit 128/);
    expect(chunk).toHaveClass('term-meta');
    expect(screen.queryByTestId('terminal-running')).toBeNull();
  });

  it('a command that never reached the host is not shown as running', async () => {
    // NO FALLBACK: the send already said it failed; a spinner over it would
    // claim work that is not happening.
    renderPanel(null);
    await waitFor(() => expect(screen.getByTestId('terminal-scroll')).toBeInTheDocument());
    const input = screen.getByTestId('terminal-input');
    fireEvent.change(input, { target: { value: 'ls' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // Twice: the open could not be sent either, and then neither could `ls`.
    expect(await screen.findAllByText(/not connected/)).toHaveLength(2);
    expect(screen.queryByTestId('terminal-running')).toBeNull();
  });
});
