// Host terminal sessions on the phone (spec/15 § Host files and terminal).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MAX_OUTPUT_CHARS,
  TOO_OLD_MESSAGE,
  undrawn,
  useTerminalStore,
} from '../src/stores/terminalStore';

const store = () => useTerminalStore.getState();
const s1 = () => store().sessions['s1']!;

describe('terminalStore', () => {
  beforeEach(() => {
    store()._reset();
    store().start('s1', 'd1', '/home/tom');
  });

  it('starts a session as starting, empty, where it was asked to start', () => {
    expect(s1()).toMatchObject({
      sessionId: 's1',
      daemonId: 'd1',
      cwd: '/home/tom',
      status: 'starting',
      output: [],
      outputTotal: 0,
      message: null,
      wrongKind: false,
    });
  });

  it('goes live on a ready that confirms a PTY, taking the real cwd', () => {
    store().ingest({
      type: 'patch.terminal.ready',
      sessionId: 's1',
      cwd: '/home/tom/x',
      pty: true,
    });
    expect(s1()).toMatchObject({ status: 'live', cwd: '/home/tom/x' });
  });

  it('refuses a ready WITHOUT pty — an old host opened a pipe shell (NO FALLBACK)', () => {
    store().ingest({ type: 'patch.terminal.ready', sessionId: 's1', cwd: '/home/tom' });
    expect(s1()).toMatchObject({ status: 'error', message: TOO_OLD_MESSAGE, wrongKind: true });
    // The close that follows must not overwrite why.
    store().ingest({ type: 'patch.terminal.exit', sessionId: 's1', code: null, reason: 'closed' });
    expect(s1()).toMatchObject({ status: 'error', message: TOO_OLD_MESSAGE });
  });

  it('keeps output in order and counts every chunk ever added', () => {
    store().ingest({ type: 'patch.terminal.output', sessionId: 's1', stream: 'stdout', data: 'a' });
    store().ingest({ type: 'patch.terminal.output', sessionId: 's1', stream: 'stdout', data: 'b' });
    expect(s1().output).toEqual(['a', 'b']);
    expect(s1().outputTotal).toBe(2);
    expect(s1().outputChars).toBe(2);
  });

  it('drops the oldest output past the cap, still counting', () => {
    const big = 'x'.repeat(MAX_OUTPUT_CHARS / 2);
    for (let i = 0; i < 3; i++) {
      store().ingest({
        type: 'patch.terminal.output',
        sessionId: 's1',
        stream: 'stdout',
        data: big,
      });
    }
    expect(s1().output).toHaveLength(2);
    expect(s1().outputChars).toBe(MAX_OUTPUT_CHARS);
    expect(s1().outputTotal).toBe(3);
  });

  it('says why a session ended, with the shell`s own status', () => {
    store().ingest({ type: 'patch.terminal.exit', sessionId: 's1', code: 3, reason: 'shell_exit' });
    expect(s1()).toMatchObject({ status: 'ended', message: 'Shell exited with status 3' });
  });

  it('names each other ending plainly', () => {
    for (const [reason, words] of [
      ['closed', 'Session closed'],
      ['idle_timeout', 'Closed after 30 minutes with no input'],
      ['daemon_shutdown', 'The host restarted'],
    ] as const) {
      store().start('s1', 'd1', '/');
      store().ingest({ type: 'patch.terminal.exit', sessionId: 's1', code: null, reason });
      expect(s1().message).toBe(words);
    }
  });

  it('carries the host`s error message', () => {
    store().ingest({
      type: 'patch.terminal.error',
      sessionId: 's1',
      code: 'pty_unavailable',
      message: 'this host cannot open a terminal',
    });
    expect(s1()).toMatchObject({ status: 'error', message: 'this host cannot open a terminal' });
  });

  it('records a failure raised on this side', () => {
    store().fail('s1', 'Could not reach the server');
    expect(s1()).toMatchObject({ status: 'error', message: 'Could not reach the server' });
  });

  it('ignores frames for sessions it does not hold, and other event types', () => {
    const before = store().sessions;
    store().ingest({
      type: 'patch.terminal.output',
      sessionId: 'ghost',
      stream: 'stdout',
      data: 'x',
    });
    store().ingest({ type: 'patch.terminal.command-exit', sessionId: 's1', code: 0 });
    store().fail('ghost', 'x');
    expect(store().sessions).toBe(before);
  });

  it('forgets a session on remove', () => {
    store().remove('s1');
    expect(store().sessions['s1']).toBeUndefined();
  });
});

describe('undrawn', () => {
  beforeEach(() => {
    store()._reset();
    store().start('s1', 'd1', '/');
  });

  it('is what arrived since the view last drew', () => {
    for (const d of ['a', 'b', 'c']) {
      store().ingest({ type: 'patch.terminal.output', sessionId: 's1', stream: 'stdout', data: d });
    }
    expect(undrawn(s1(), 0)).toBe('abc');
    expect(undrawn(s1(), 2)).toBe('c');
    expect(undrawn(s1(), 3)).toBe('');
  });

  it('is everything still retained for a view that fell behind the cap', () => {
    const big = 'x'.repeat(MAX_OUTPUT_CHARS / 2);
    for (let i = 0; i < 3; i++) {
      store().ingest({
        type: 'patch.terminal.output',
        sessionId: 's1',
        stream: 'stdout',
        data: big,
      });
    }
    expect(undrawn(s1(), 0)).toHaveLength(MAX_OUTPUT_CHARS);
  });
});
