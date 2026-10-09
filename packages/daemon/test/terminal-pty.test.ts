// PTY terminal sessions (spec/02 § Terminal sessions — PTY sessions).
//
// Real python3 helper, real pseudo-terminal, real shell — the point of the mode
// is that the shell behaves like it does in a terminal (a tty on stdin, echo,
// a prompt, a window size), so nothing here is mocked.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WireEvent } from '@patch/wire';
import { TerminalSessions } from '../src/terminal.js';

function collector(): {
  frames: WireEvent[];
  emit: (e: WireEvent) => void;
  waitFor: (pred: (e: WireEvent) => boolean, label: string) => Promise<WireEvent>;
  text: (sessionId: string) => string;
} {
  const frames: WireEvent[] = [];
  const waiters: Array<{ pred: (e: WireEvent) => boolean; resolve: (e: WireEvent) => void }> = [];
  const emit = (e: WireEvent): void => {
    frames.push(e);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(e)) {
        waiters[i].resolve(e);
        waiters.splice(i, 1);
      }
    }
  };
  const text = (sessionId: string): string =>
    frames
      .filter(
        (f): f is Extract<WireEvent, { type: 'patch.terminal.output' }> =>
          f.type === 'patch.terminal.output' && f.sessionId === sessionId,
      )
      .map((f) => f.data)
      .join('');
  const waitFor = (pred: (e: WireEvent) => boolean, label: string): Promise<WireEvent> => {
    const hit = frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${label}; output so far: ${text('p1')}`)),
        15_000,
      );
      waiters.push({
        pred,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
      });
    });
  };
  return { frames, emit, waitFor, text };
}

describe('TerminalSessions — PTY sessions', () => {
  let dir: string;
  let sessions: TerminalSessions;
  let sink: ReturnType<typeof collector>;
  let prevShell: string | undefined;
  let prevHome: string | undefined;

  /** Wait until the session's accumulated output contains `needle`. */
  const until = async (needle: string): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (!sink.text('p1').includes(needle)) {
      if (Date.now() > deadline) {
        throw new Error(
          `never saw ${JSON.stringify(needle)} in ${JSON.stringify(sink.text('p1'))}`,
        );
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-pty-'));
    sink = collector();
    sessions = new TerminalSessions({ emit: sink.emit });
    // A plain bash with no profile noise, so assertions read the shell and not
    // whatever this machine's login scripts print.
    prevShell = process.env.SHELL;
    process.env.SHELL = '/bin/bash';
    // The shell is a LOGIN shell, so it reads this machine's profile and
    // bashrc — and Hetzner's bashrc attaches tmux whenever SSH_CONNECTION is
    // set, which a deploy started over ssh from the Mac inherits. `exit` then
    // leaves tmux, not the terminal. An empty HOME keeps the shell plain.
    prevHome = process.env.HOME;
    process.env.HOME = dir;
  });

  afterEach(async () => {
    await sessions.shutdown();
    process.env.SHELL = prevShell as string;
    process.env.HOME = prevHome as string;
    rmSync(dir, { recursive: true, force: true });
  });

  const open = (extra: Partial<Extract<WireEvent, { type: 'patch.terminal.open' }>> = {}) =>
    sessions.handle({
      type: 'patch.terminal.open',
      daemonId: 'd1',
      sessionId: 'p1',
      folder: dir,
      pty: { cols: 80, rows: 24 },
      forSurfaceId: 'phone',
      ...extra,
    });

  it('opens a real terminal: ready says pty, stdin is a tty, and it lands in the folder', async () => {
    open();
    const ready = await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
    expect(ready).toMatchObject({ sessionId: 'p1', cwd: dir, pty: true, forSurfaceId: 'phone' });
    sessions.handle({
      type: 'patch.terminal.input',
      sessionId: 'p1',
      data: 'test -t 0 && echo "TTY-$((6*7))"; pwd\r',
    });
    await until('TTY-42');
    await until(dir);
  });

  it('echoes what is typed, like a terminal does', async () => {
    open();
    await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
    sessions.handle({ type: 'patch.terminal.input', sessionId: 'p1', data: 'echo abc$((1+1))' });
    // Not run yet (no Enter) — what comes back is the echo of the keystrokes.
    await until('echo abc$((1+1))');
    expect(sink.text('p1')).not.toContain('abc2');
    sessions.handle({ type: 'patch.terminal.input', sessionId: 'p1', data: '\r' });
    await until('abc2');
  });

  it('sends no completion sentinel and reports no command-exit', async () => {
    open();
    await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
    sessions.handle({
      type: 'patch.terminal.input',
      sessionId: 'p1',
      data: 'echo done-$((2+2))\r',
    });
    await until('done-4');
    expect(sink.text('p1')).not.toContain('__patch_exit_');
    expect(sink.frames.some((f) => f.type === 'patch.terminal.command-exit')).toBe(false);
  });

  it('starts at the requested size and follows a resize', async () => {
    open({ pty: { cols: 91, rows: 17 } });
    await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
    sessions.handle({ type: 'patch.terminal.input', sessionId: 'p1', data: 'stty size\r' });
    await until('17 91');
    sessions.handle({ type: 'patch.terminal.resize', sessionId: 'p1', cols: 42, rows: 11 });
    sessions.handle({ type: 'patch.terminal.input', sessionId: 'p1', data: 'stty size\r' });
    await until('11 42');
  });

  it('Ctrl-C interrupts the foreground command and the shell carries on', async () => {
    open();
    await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
    sessions.handle({ type: 'patch.terminal.input', sessionId: 'p1', data: 'sleep 30\r' });
    await until('sleep 30');
    sessions.handle({ type: 'patch.terminal.signal', sessionId: 'p1', signal: 'SIGINT' });
    sessions.handle({
      type: 'patch.terminal.input',
      sessionId: 'p1',
      data: 'echo back-$((3*3))\r',
    });
    await until('back-9');
  });

  it('keeps a multi-byte character whole when a read splits it', async () => {
    writeFileSync(join(dir, 'snow.txt'), `${'☃'.repeat(5000)}\n`);
    open();
    await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
    sessions.handle({
      type: 'patch.terminal.input',
      sessionId: 'p1',
      data: 'cat snow.txt; echo END-$((1+1))\r',
    });
    await until('END-2');
    expect(sink.text('p1').split('☃').length - 1).toBeGreaterThanOrEqual(5000);
    expect(sink.text('p1')).not.toContain('�');
  });

  it('reports the shell exiting with its own status', async () => {
    open();
    await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
    sessions.handle({ type: 'patch.terminal.input', sessionId: 'p1', data: 'exit 3\r' });
    const exit = await sink.waitFor((e) => e.type === 'patch.terminal.exit', 'exit');
    expect(exit).toMatchObject({ sessionId: 'p1', code: 3, reason: 'shell_exit' });
  });

  it('close ends the terminal and says so', async () => {
    open();
    await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
    sessions.handle({ type: 'patch.terminal.close', sessionId: 'p1' });
    const exit = await sink.waitFor((e) => e.type === 'patch.terminal.exit', 'exit');
    expect(exit).toMatchObject({ reason: 'closed', code: null });
    expect(sessions.count()).toBe(0);
  });

  it('a missing helper is pty_unavailable, never a pipe shell instead (NO FALLBACK)', async () => {
    sessions = new TerminalSessions({ emit: sink.emit, python: join(dir, 'no-python') });
    open();
    const err = await sink.waitFor((e) => e.type === 'patch.terminal.error', 'error');
    expect(err).toMatchObject({ sessionId: 'p1', code: 'pty_unavailable', forSurfaceId: 'phone' });
    expect(sink.frames.some((f) => f.type === 'patch.terminal.ready')).toBe(false);
    expect(sessions.count()).toBe(0);
  });

  it('refuses to resize a pipe session, which has no window', async () => {
    sessions.handle({ type: 'patch.terminal.open', daemonId: 'd1', sessionId: 'p1', folder: dir });
    await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
    sessions.handle({ type: 'patch.terminal.resize', sessionId: 'p1', cols: 40, rows: 10 });
    const err = await sink.waitFor((e) => e.type === 'patch.terminal.error', 'error');
    expect(err).toMatchObject({ code: 'not_a_pty' });
  });

  it('a resize for an unknown session is unknown_session', async () => {
    sessions.handle({ type: 'patch.terminal.resize', sessionId: 'ghost', cols: 40, rows: 10 });
    const err = await sink.waitFor((e) => e.type === 'patch.terminal.error', 'error');
    expect(err).toMatchObject({ sessionId: 'ghost', code: 'unknown_session' });
  });
});
