// terminalStore — session bookkeeping behind a terminal pane tab (spec/14 §
// Terminal, § Panes and tabs). The panel test drives the UI; this covers the
// store's own rules: routing frames by sessionId, keeping scrollback across a
// restart, capping it, and ignoring frames that belong to nothing.

import { describe, it, expect, beforeEach } from 'vitest';
import { useTerminalStore, MAX_CHUNKS } from '../stores/terminalStore.js';

const store = (): ReturnType<typeof useTerminalStore.getState> => useTerminalStore.getState();

describe('terminalStore', () => {
  beforeEach(() => {
    store()._reset();
  });

  it('routes host frames to the chat that owns the session', () => {
    store().startSession('c1', '/p/one', 's1');
    store().startSession('c2', '/p/two', 's2');
    store().ingest({ type: 'patch.terminal.ready', sessionId: 's2', cwd: '/p/two' });
    store().ingest({
      type: 'patch.terminal.output',
      sessionId: 's2',
      stream: 'stdout',
      data: 'two\n',
    });
    expect(store().sessions['c1']?.chunks).toHaveLength(0);
    expect(store().sessions['c2']?.status).toBe('live');
    expect(store().sessions['c2']?.chunks[0]?.data).toBe('two\n');
  });

  it('ignores non-terminal frames and frames for unknown sessions', () => {
    store().startSession('c1', '/p', 's1');
    store().ingest({ type: 'daemon.online', daemonId: 'd1' });
    store().ingest({
      type: 'patch.terminal.output',
      sessionId: 'not-mine',
      stream: 'stdout',
      data: 'x',
    });
    expect(store().sessions['c1']?.chunks).toHaveLength(0);
  });

  it('reports an exit with its code, and one without', () => {
    store().startSession('c1', '/p', 's1');
    store().ingest({ type: 'patch.terminal.exit', sessionId: 's1', code: 3, reason: 'shell_exit' });
    expect(store().sessions['c1']?.chunks[0]?.data).toContain('exit 3');
    expect(store().sessions['c1']?.status).toBe('ended');

    store().startSession('c2', '/p', 's2');
    store().ingest({ type: 'patch.terminal.exit', sessionId: 's2', code: null, reason: 'closed' });
    expect(store().sessions['c2']?.chunks[0]?.data).toContain('session ended: closed');
    expect(store().sessions['c2']?.chunks[0]?.data).not.toContain('exit');
  });

  it('a restart keeps the previous scrollback and history', () => {
    store().startSession('c1', '/p', 's1');
    store().recordCommand('c1', 'ls');
    store().appendLocal('c1', 'output\n', 'stdout');
    store().startSession('c1', '/p', 's2');
    expect(store().sessions['c1']?.sessionId).toBe('s2');
    expect(store().sessions['c1']?.chunks[0]?.data).toBe('output\n');
    expect(store().sessions['c1']?.history).toEqual(['ls']);
    // The new session id routes; the old one is a leftover mapping to the same chat.
    store().ingest({ type: 'patch.terminal.ready', sessionId: 's2', cwd: '/p' });
    expect(store().sessions['c1']?.status).toBe('live');
  });

  it('writes to a chat with no session are dropped, not crashes', () => {
    expect(() => {
      store().recordCommand('nope', 'ls');
      store().appendLocal('nope', 'x');
    }).not.toThrow();
    expect(store().sessions['nope']).toBeUndefined();
  });

  it('caps the scrollback so a long session cannot grow forever', () => {
    store().startSession('c1', '/p', 's1');
    for (let i = 0; i < MAX_CHUNKS + 50; i++) {
      store().ingest({
        type: 'patch.terminal.output',
        sessionId: 's1',
        stream: 'stdout',
        data: `${i}\n`,
      });
    }
    const chunks = store().sessions['c1']?.chunks ?? [];
    expect(chunks).toHaveLength(MAX_CHUNKS);
    // The OLDEST are dropped — the tail (what the user is reading) is kept.
    expect(chunks[chunks.length - 1]?.data).toBe(`${MAX_CHUNKS + 49}\n`);
  });

  // Something the app itself wants the terminal to do, raised BEFORE the shell
  // exists (spec/14 § Main chat panel — Background task bar).
  describe('pending work', () => {
    it('holds one entry per chat until it is taken', () => {
      store().queuePending('c1', { kind: 'command', text: 'tail -f a' });
      expect(store().pending['c1']).toEqual({ kind: 'command', text: 'tail -f a' });
      expect(store().takePending('c1')).toEqual({ kind: 'command', text: 'tail -f a' });
    });

    it('drains exactly once — a second take gets nothing', () => {
      store().queuePending('c1', { kind: 'command', text: 'tail -f a' });
      expect(store().takePending('c1')).not.toBeNull();
      expect(store().takePending('c1')).toBeNull();
      expect(store().pending['c1']).toBeUndefined();
    });

    it('taking from a chat with nothing queued is null, not a throw', () => {
      expect(store().takePending('nobody')).toBeNull();
    });

    it('carries a plain note as well as a command', () => {
      store().queuePending('c1', { kind: 'note', text: 'no id yet' });
      expect(store().takePending('c1')).toEqual({ kind: 'note', text: 'no id yet' });
    });

    it('is per chat — taking one leaves the other', () => {
      store().queuePending('c1', { kind: 'command', text: 'one' });
      store().queuePending('c2', { kind: 'command', text: 'two' });
      expect(store().takePending('c1')?.text).toBe('one');
      expect(store().pending['c2']).toEqual({ kind: 'command', text: 'two' });
    });

    it('a second ask replaces the first rather than queueing a backlog', () => {
      store().queuePending('c1', { kind: 'command', text: 'one' });
      store().queuePending('c1', { kind: 'command', text: 'two' });
      expect(store().takePending('c1')?.text).toBe('two');
      expect(store().takePending('c1')).toBeNull();
    });
  });
});

// Command completion (spec/14 § Terminal). The shell is a pipe with no prompt,
// so the store's `running` flag is the only thing that distinguishes "finished
// and printed nothing" from "still going".
describe('terminalStore — command completion', () => {
  beforeEach(() => {
    store()._reset();
  });

  it('a sent command is running until the host says it finished', () => {
    store().startSession('c1', '/p', 's1');
    expect(store().sessions['c1']?.running).toBe(false);
    store().markRunning('c1');
    expect(store().sessions['c1']?.running).toBe(true);
    store().ingest({ type: 'patch.terminal.command-exit', sessionId: 's1', code: 0 });
    expect(store().sessions['c1']?.running).toBe(false);
  });

  it('a clean exit adds nothing to the scrollback', () => {
    store().startSession('c1', '/p', 's1');
    store().appendLocal('c1', '❯ cd /tmp\n');
    store().markRunning('c1');
    store().ingest({ type: 'patch.terminal.command-exit', sessionId: 's1', code: 0 });
    expect(store().sessions['c1']?.chunks.map((c) => c.data)).toEqual(['❯ cd /tmp\n']);
  });

  it('a failure says so in the scrollback, because a pipe shell has no $? to read', () => {
    store().startSession('c1', '/p', 's1');
    store().markRunning('c1');
    store().ingest({ type: 'patch.terminal.command-exit', sessionId: 's1', code: 127 });
    const last = store().sessions['c1']?.chunks.at(-1);
    expect(last).toEqual({ stream: 'meta', data: 'exit 127\n' });
  });

  it('a session that ends stops claiming to be running', () => {
    store().startSession('c1', '/p', 's1');
    store().markRunning('c1');
    store().ingest({
      type: 'patch.terminal.exit',
      sessionId: 's1',
      code: 0,
      reason: 'shell_exit',
    });
    expect(store().sessions['c1']?.running).toBe(false);
    expect(store().sessions['c1']?.status).toBe('ended');
  });

  it('a host error stops claiming to be running', () => {
    store().startSession('c1', '/p', 's1');
    store().markRunning('c1');
    store().ingest({
      type: 'patch.terminal.error',
      sessionId: 's1',
      code: 'internal',
      message: 'boom',
    });
    expect(store().sessions['c1']?.running).toBe(false);
    expect(store().sessions['c1']?.status).toBe('error');
  });

  it('restarting a wedged session starts it not-running', () => {
    store().startSession('c1', '/p', 's1');
    store().markRunning('c1');
    store().startSession('c1', '/p', 's2');
    expect(store().sessions['c1']?.running).toBe(false);
  });

  it('routes a completion to the chat that owns the session, and nowhere else', () => {
    store().startSession('c1', '/p/one', 's1');
    store().startSession('c2', '/p/two', 's2');
    store().markRunning('c1');
    store().markRunning('c2');
    store().ingest({ type: 'patch.terminal.command-exit', sessionId: 's2', code: 1 });
    expect(store().sessions['c1']?.running).toBe(true);
    expect(store().sessions['c2']?.running).toBe(false);
  });
});
