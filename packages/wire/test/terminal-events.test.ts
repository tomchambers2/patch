// Terminal session frames (spec/03 § Terminal sessions).
//
// The shapes the surface ↔ host terminal drawer rides on. These are the
// contract both the host's session manager and the web drawer decode against,
// so the union must accept them and reject the malformed ones.

import { describe, it, expect } from 'vitest';
import { WireEvent, EVENT_SCHEMAS } from '../src/events.js';
import { encode, decode } from '../src/codec.js';

describe('terminal wire frames', () => {
  it('accepts the surface → host frames', () => {
    for (const ev of [
      {
        type: 'patch.terminal.open',
        sessionId: 's1',
        daemonId: 'host-a',
        folder: '/home/tom/projects',
      },
      // No folder — "a shell anywhere I can work" (the new-chat case).
      { type: 'patch.terminal.open', sessionId: 's1', daemonId: 'host-a' },
      { type: 'patch.terminal.input', sessionId: 's1', data: 'git clone git@x:y.git\n' },
      { type: 'patch.terminal.signal', sessionId: 's1', signal: 'SIGINT' },
      { type: 'patch.terminal.close', sessionId: 's1' },
    ]) {
      expect(WireEvent.safeParse(ev).success).toBe(true);
    }
  });

  it('accepts the host → surface frames', () => {
    for (const ev of [
      { type: 'patch.terminal.ready', sessionId: 's1', cwd: '/home/tom/projects' },
      { type: 'patch.terminal.output', sessionId: 's1', stream: 'stdout', data: 'ok\n' },
      { type: 'patch.terminal.output', sessionId: 's1', stream: 'stderr', data: 'boom\n' },
      { type: 'patch.terminal.exit', sessionId: 's1', code: 0, reason: 'shell_exit' },
      { type: 'patch.terminal.exit', sessionId: 's1', code: null, reason: 'closed' },
      {
        type: 'patch.terminal.error',
        sessionId: 's1',
        code: 'folder_not_found',
        message: 'nope',
      },
    ]) {
      expect(WireEvent.safeParse(ev).success).toBe(true);
    }
  });

  it('carries forSurfaceId so output routes back to ONE surface', () => {
    const parsed = WireEvent.safeParse({
      type: 'patch.terminal.output',
      sessionId: 's1',
      stream: 'stdout',
      data: 'x',
      forSurfaceId: 'surface-1',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects malformed frames (no silent coercion)', () => {
    const bad = [
      { type: 'patch.terminal.open', sessionId: 's1', daemonId: 'host-a', folder: '' }, // named-but-empty
      { type: 'patch.terminal.open', sessionId: '', daemonId: 'host-a', folder: '/x' },
      { type: 'patch.terminal.signal', sessionId: 's1', signal: 'SIGKILL' },
      { type: 'patch.terminal.output', sessionId: 's1', stream: 'other', data: 'x' },
      { type: 'patch.terminal.exit', sessionId: 's1', code: 0, reason: 'whatever' },
      { type: 'patch.terminal.error', sessionId: 's1', code: 'nope', message: 'm' },
      { type: 'patch.terminal.open', sessionId: 's1', daemonId: 'host-a', folder: '/x', extra: 1 }, // strict
    ];
    for (const ev of bad) expect(WireEvent.safeParse(ev).success).toBe(false);
  });

  it('every terminal type is registered in EVENT_SCHEMAS', () => {
    for (const t of [
      'patch.terminal.open',
      'patch.terminal.input',
      'patch.terminal.signal',
      'patch.terminal.close',
      'patch.terminal.ready',
      'patch.terminal.output',
      'patch.terminal.command-exit',
      'patch.terminal.exit',
      'patch.terminal.error',
    ] as const) {
      expect(EVENT_SCHEMAS[t]).toBeDefined();
    }
  });

  it('accepts an open asking for a PTY, a resize, and a ready confirming one', () => {
    // spec/02 § Terminal sessions — PTY sessions.
    const good = [
      {
        type: 'patch.terminal.open',
        sessionId: 's1',
        daemonId: 'host-a',
        pty: { cols: 80, rows: 24 },
      },
      { type: 'patch.terminal.resize', sessionId: 's1', cols: 40, rows: 18 },
      { type: 'patch.terminal.ready', sessionId: 's1', cwd: '/home/tom', pty: true },
      { type: 'patch.terminal.error', sessionId: 's1', code: 'pty_unavailable', message: 'm' },
      { type: 'patch.terminal.error', sessionId: 's1', code: 'not_a_pty', message: 'm' },
    ];
    for (const ev of good) expect(WireEvent.safeParse(ev).success, JSON.stringify(ev)).toBe(true);
  });

  it('rejects a nonsense PTY window size', () => {
    const bad = [
      { type: 'patch.terminal.open', sessionId: 's1', daemonId: 'h', pty: { cols: 0, rows: 24 } },
      { type: 'patch.terminal.open', sessionId: 's1', daemonId: 'h', pty: { cols: 80 } },
      { type: 'patch.terminal.resize', sessionId: 's1', cols: 80, rows: 1.5 },
      { type: 'patch.terminal.resize', sessionId: 's1', cols: 5000, rows: 24 },
    ];
    for (const ev of bad) expect(WireEvent.safeParse(ev).success, JSON.stringify(ev)).toBe(false);
  });

  it('host files RPC: accepts list / read / write requests and their answers', () => {
    // spec/03 § Host files.
    const good = [
      { type: 'patch.host_files.request', requestId: 'r', daemonId: 'h', op: 'list' },
      {
        type: 'patch.host_files.request',
        requestId: 'r',
        daemonId: 'h',
        op: 'read',
        path: '/etc/hosts',
      },
      {
        type: 'patch.host_files.response',
        requestId: 'r',
        daemonId: 'h',
        ok: true,
        path: '/etc/hosts',
        content: 'x',
        size: 1,
        version: 'abc',
      },
      {
        type: 'patch.host_files.response',
        requestId: 'r',
        daemonId: 'h',
        ok: false,
        error: { code: 'conflict', message: 'changed on disk' },
      },
    ];
    for (const ev of good) expect(WireEvent.safeParse(ev).success, JSON.stringify(ev)).toBe(true);
  });

  it('host files RPC: a request must name its host, and the op set is closed', () => {
    const bad = [
      { type: 'patch.host_files.request', requestId: 'r', op: 'list' },
      { type: 'patch.host_files.request', requestId: 'r', daemonId: 'h', op: 'delete', path: '/x' },
      {
        type: 'patch.host_files.response',
        requestId: 'r',
        daemonId: 'h',
        ok: false,
        error: { code: 'nope', message: 'm' },
      },
    ];
    for (const ev of bad) expect(WireEvent.safeParse(ev).success, JSON.stringify(ev)).toBe(false);
  });

  it('round-trips through the codec with raw control bytes intact', () => {
    const ev = {
      type: 'patch.terminal.output' as const,
      sessionId: 's1',
      stream: 'stdout' as const,
      data: 'Cloning into repo...\r\n[32mdone[0m\n',
    };
    expect(decode(encode(ev))).toEqual(ev);
  });
});
