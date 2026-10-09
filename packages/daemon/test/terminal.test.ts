// Terminal sessions on the host (spec/02 § Terminal sessions).
//
// Real child processes, real pipes — this is the shell the surface drives, so a
// mocked spawn would prove nothing. Each test opens a session against a temp
// dir, runs something, and asserts on the frames the host emits back.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import {
  TerminalSessions,
  IDLE_TIMEOUT_MS,
  OUTPUT_WINDOW_MS,
  readMarkers,
  splitMarker,
  markerTail,
} from '../src/terminal.js';

/** Collects everything the manager emits, with helpers to await a frame. */
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
  const waitFor = (pred: (e: WireEvent) => boolean, label: string): Promise<WireEvent> => {
    const hit = frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 15_000);
      waiters.push({
        pred,
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
      });
    });
  };
  const text = (sessionId: string): string =>
    frames
      .filter(
        (f): f is Extract<WireEvent, { type: 'patch.terminal.output' }> =>
          f.type === 'patch.terminal.output' && f.sessionId === sessionId,
      )
      .map((f) => f.data)
      .join('');
  return { frames, emit, waitFor, text };
}

const outputContains = (sessionId: string, needle: string) => (e: WireEvent) =>
  e.type === 'patch.terminal.output' && e.sessionId === sessionId && e.data.includes(needle);

describe('TerminalSessions', () => {
  let dir: string;
  let sessions: TerminalSessions;
  let sink: ReturnType<typeof collector>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-term-'));
    sink = collector();
    sessions = new TerminalSessions({ emit: sink.emit });
  });

  afterEach(async () => {
    await sessions.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens a shell in the requested folder and streams stdout', async () => {
    sessions.handle({ type: 'patch.terminal.open', daemonId: 'd1', sessionId: 's1', folder: dir });
    const ready = await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
    expect(ready).toMatchObject({ type: 'patch.terminal.ready', sessionId: 's1' });

    sessions.handle({ type: 'patch.terminal.input', sessionId: 's1', data: 'pwd\n' });
    await sink.waitFor(outputContains('s1', dir), 'pwd output');
  });

  it('keeps shell state across commands (cd persists, like a real terminal)', async () => {
    sessions.handle({ type: 'patch.terminal.open', daemonId: 'd1', sessionId: 's1', folder: dir });
    await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
    sessions.handle({
      type: 'patch.terminal.input',
      sessionId: 's1',
      data: 'mkdir cloned && cd cloned\n',
    });
    sessions.handle({ type: 'patch.terminal.input', sessionId: 's1', data: 'pwd\n' });
    await sink.waitFor(outputContains('s1', 'cloned'), 'pwd inside cloned');
    expect(existsSync(join(dir, 'cloned'))).toBe(true);
  });

  it('tags stderr separately from stdout', async () => {
    sessions.handle({ type: 'patch.terminal.open', daemonId: 'd1', sessionId: 's1', folder: dir });
    await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
    sessions.handle({
      type: 'patch.terminal.input',
      sessionId: 's1',
      data: 'echo oops 1>&2\n',
    });
    const ev = await sink.waitFor(outputContains('s1', 'oops'), 'stderr output');
    expect((ev as { stream: string }).stream).toBe('stderr');
  });

  it('rejects a folder that does not exist on the host (NO FALLBACK)', async () => {
    sessions.handle({
      type: 'patch.terminal.open',
      daemonId: 'd1',
      sessionId: 's1',
      folder: join(dir, 'nope'),
    });
    const err = await sink.waitFor((e) => e.type === 'patch.terminal.error', 'error');
    expect(err).toMatchObject({ code: 'folder_not_found', sessionId: 's1' });
    // Nothing started — no shell in $HOME or /.
    expect(sink.frames.some((f) => f.type === 'patch.terminal.ready')).toBe(false);
  });

  it('rejects a file masquerading as a folder', async () => {
    sessions.handle({ type: 'patch.terminal.open', daemonId: 'd1', sessionId: 's1', folder: dir });
    await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
    sessions.handle({ type: 'patch.terminal.input', sessionId: 's1', data: `touch f\n` });
    await new Promise((r) => setTimeout(r, 300));
    sessions.handle({
      type: 'patch.terminal.open',
      daemonId: 'd1',
      sessionId: 's2',
      folder: join(dir, 'f'),
    });
    const err = await sink.waitFor(
      (e) => e.type === 'patch.terminal.error' && e.sessionId === 's2',
      'error for s2',
    );
    expect(err).toMatchObject({ code: 'folder_not_found' });
  });

  it('has NO concurrency cap: well past the old limit of 4, every session opens', async () => {
    // 12 is 3x the cap that used to reject the fifth open outright.
    const n = 12;
    for (let i = 0; i < n; i++) {
      sessions.handle({
        type: 'patch.terminal.open',
        daemonId: 'd1',
        sessionId: `s${i}`,
        folder: dir,
      });
    }
    // Every one of them reports ready — including the ones the cap used to kill.
    for (let i = 0; i < n; i++) {
      await sink.waitFor(
        (e) => e.type === 'patch.terminal.ready' && e.sessionId === `s${i}`,
        `ready s${i}`,
      );
    }
    expect(sessions.count()).toBe(n);
    // And nothing was rejected along the way.
    expect(sink.frames.filter((e) => e.type === 'patch.terminal.error')).toEqual([]);

    // They are real, independent shells, not just map entries: the last one -
    // the one furthest past the old cap - still runs a command.
    sessions.handle({ type: 'patch.terminal.input', sessionId: `s${n - 1}`, data: 'pwd\n' });
    await sink.waitFor(outputContains(`s${n - 1}`, dir), 'last session runs a command');
  });

  it('reports unknown_session for input/signal/close on a session it does not have', async () => {
    sessions.handle({ type: 'patch.terminal.input', sessionId: 'ghost', data: 'ls\n' });
    const err = await sink.waitFor((e) => e.type === 'patch.terminal.error', 'error');
    expect(err).toMatchObject({ code: 'unknown_session', sessionId: 'ghost' });

    sessions.handle({ type: 'patch.terminal.signal', sessionId: 'ghost', signal: 'SIGINT' });
    sessions.handle({ type: 'patch.terminal.close', sessionId: 'ghost' });
    const errs = sink.frames.filter((f) => f.type === 'patch.terminal.error');
    expect(errs).toHaveLength(3);
  });

  it('re-opening the same sessionId replaces the old shell', async () => {
    sessions.handle({ type: 'patch.terminal.open', daemonId: 'd1', sessionId: 's1', folder: dir });
    await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
    sessions.handle({ type: 'patch.terminal.open', daemonId: 'd1', sessionId: 's1', folder: dir });
    await sink.waitFor(
      (e) => e.type === 'patch.terminal.exit' && e.reason === 'closed',
      'old shell exit',
    );
    expect(sessions.count()).toBe(1);
  });

  it('SIGINT interrupts the running command without ending the session', async () => {
    sessions.handle({ type: 'patch.terminal.open', daemonId: 'd1', sessionId: 's1', folder: dir });
    await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
    sessions.handle({ type: 'patch.terminal.input', sessionId: 's1', data: 'sleep 30\n' });
    await new Promise((r) => setTimeout(r, 500));
    sessions.handle({ type: 'patch.terminal.signal', sessionId: 's1', signal: 'SIGINT' });
    // The session survives: a follow-up command still runs.
    sessions.handle({ type: 'patch.terminal.input', sessionId: 's1', data: 'echo alive\n' });
    await sink.waitFor(outputContains('s1', 'alive'), 'post-interrupt command');
    expect(sink.frames.some((f) => f.type === 'patch.terminal.exit')).toBe(false);
  });

  it('close ends the session and reports it', async () => {
    sessions.handle({ type: 'patch.terminal.open', daemonId: 'd1', sessionId: 's1', folder: dir });
    await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
    sessions.handle({ type: 'patch.terminal.close', sessionId: 's1' });
    const exit = await sink.waitFor((e) => e.type === 'patch.terminal.exit', 'exit');
    expect(exit).toMatchObject({ reason: 'closed', sessionId: 's1' });
    expect(sessions.count()).toBe(0);
  });

  it('reports the shell exiting on its own', async () => {
    sessions.handle({ type: 'patch.terminal.open', daemonId: 'd1', sessionId: 's1', folder: dir });
    await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
    sessions.handle({ type: 'patch.terminal.input', sessionId: 's1', data: 'exit 3\n' });
    const exit = await sink.waitFor((e) => e.type === 'patch.terminal.exit', 'exit');
    expect(exit).toMatchObject({ reason: 'shell_exit', code: 3 });
    expect(sessions.count()).toBe(0);
  });

  it('ends an idle session after the idle window', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      sessions.handle({
        type: 'patch.terminal.open',
        daemonId: 'd1',
        sessionId: 's1',
        folder: dir,
      });
      await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
      await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS + 1000);
      const exit = await sink.waitFor((e) => e.type === 'patch.terminal.exit', 'idle exit');
      expect(exit).toMatchObject({ reason: 'idle_timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('shutdown ends every live session with daemon_shutdown', async () => {
    sessions.handle({ type: 'patch.terminal.open', daemonId: 'd1', sessionId: 's1', folder: dir });
    sessions.handle({ type: 'patch.terminal.open', daemonId: 'd1', sessionId: 's2', folder: dir });
    await sink.waitFor(
      (e) => e.type === 'patch.terminal.ready' && e.sessionId === 's2',
      'ready s2',
    );
    await sessions.shutdown();
    const reasons = sink.frames
      .filter((f) => f.type === 'patch.terminal.exit')
      .map((f) => (f as { reason: string }).reason);
    expect(reasons).toEqual(['daemon_shutdown', 'daemon_shutdown']);
    expect(sessions.count()).toBe(0);
  });

  it('routes every frame back to the opening surface only', async () => {
    sessions.handle({
      type: 'patch.terminal.open',
      daemonId: 'd1',
      sessionId: 's1',
      folder: dir,
      forSurfaceId: 'surface-A',
    });
    const ready = await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
    expect((ready as { forSurfaceId?: string }).forSurfaceId).toBe('surface-A');
    sessions.handle({ type: 'patch.terminal.input', sessionId: 's1', data: 'echo hi\n' });
    const out = await sink.waitFor(outputContains('s1', 'hi'), 'output');
    expect((out as { forSurfaceId?: string }).forSurfaceId).toBe('surface-A');
  });

  it('caps the output rate so a firehose cannot flood the link', async () => {
    sessions.handle({ type: 'patch.terminal.open', daemonId: 'd1', sessionId: 's1', folder: dir });
    await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
    sessions.handle({
      type: 'patch.terminal.input',
      sessionId: 's1',
      data: 'yes patchpatchpatch | head -c 4000000\n',
    });
    const truncated = await sink.waitFor(
      (e) => e.type === 'patch.terminal.output' && e.data.includes('output truncated'),
      'truncation notice',
    );
    expect(truncated).toMatchObject({ stream: 'stderr' });
    expect(sink.text('s1').length).toBeLessThan(3_000_000);
  });

  it('reports an internal error when the shell binary is missing (NO FALLBACK)', async () => {
    const prev = process.env.SHELL;
    process.env.SHELL = join(dir, 'no-such-shell');
    // With a logger attached, so the failure is reported to the host log too.
    sessions = new TerminalSessions({ emit: sink.emit, logger: pino({ level: 'silent' }) });
    try {
      sessions.handle({
        type: 'patch.terminal.open',
        daemonId: 'd1',
        sessionId: 's1',
        folder: dir,
      });
      const err = await sink.waitFor((e) => e.type === 'patch.terminal.error', 'spawn error');
      expect(err).toMatchObject({ code: 'internal', sessionId: 's1' });
    } finally {
      process.env.SHELL = prev as string;
    }
  });

  it('uses bash when the environment names no shell', async () => {
    const prev = process.env.SHELL;
    delete process.env.SHELL;
    try {
      sessions.handle({
        type: 'patch.terminal.open',
        daemonId: 'd1',
        sessionId: 's1',
        folder: dir,
      });
      await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
      sessions.handle({ type: 'patch.terminal.input', sessionId: 's1', data: 'echo shelled\n' });
      await sink.waitFor(outputContains('s1', 'shelled'), 'output');
    } finally {
      process.env.SHELL = prev as string;
    }
  });

  it('the rate window rolls, so a slow steady stream is never truncated', async () => {
    sessions.handle({ type: 'patch.terminal.open', daemonId: 'd1', sessionId: 's1', folder: dir });
    await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
    sessions.handle({
      type: 'patch.terminal.input',
      sessionId: 's1',
      data: `echo first; sleep ${(OUTPUT_WINDOW_MS + 200) / 1000}; echo second\n`,
    });
    await sink.waitFor(outputContains('s1', 'first'), 'first');
    await sink.waitFor(outputContains('s1', 'second'), 'second');
    expect(sink.text('s1')).not.toContain('truncated');
  });

  it('with NO folder, starts in the host PROJECT ROOT and reports where it landed', async () => {
    // Where a clone is actually going. The host's $HOME is /root in the
    // container while the project dirs are mounted elsewhere, so homing there
    // would drop the user somewhere they'd only have to cd out of.
    sessions = new TerminalSessions({ emit: sink.emit, defaultCwd: () => dir });
    sessions.handle({ type: 'patch.terminal.open', daemonId: 'd1', sessionId: 's1' });
    const ready = (await sink.waitFor(
      (e) => e.type === 'patch.terminal.ready',
      'ready',
    )) as Extract<WireEvent, { type: 'patch.terminal.ready' }>;
    expect(ready.cwd).toBe(dir);
    sessions.handle({ type: 'patch.terminal.input', sessionId: 's1', data: 'pwd\n' });
    await sink.waitFor(outputContains('s1', dir), 'pwd output');
  });

  it('with NO folder and no project root, falls through to the host home', async () => {
    // The new-chat case: there is no folder yet — that is precisely why you want
    // a shell (to clone one onto the host). Demanding a folder here would make
    // the terminal useless exactly when it is needed.
    sessions.handle({ type: 'patch.terminal.open', daemonId: 'd1', sessionId: 's1' });
    const ready = (await sink.waitFor(
      (e) => e.type === 'patch.terminal.ready',
      'ready',
    )) as Extract<WireEvent, { type: 'patch.terminal.ready' }>;
    expect(ready.cwd).toBe(homedir());
    // And it is a real working shell there, not a stub.
    sessions.handle({ type: 'patch.terminal.input', sessionId: 's1', data: 'pwd\n' });
    await sink.waitFor(outputContains('s1', homedir()), 'pwd output');
  });

  it('a NAMED folder that is missing is still a loud error — only omitting it is a request', async () => {
    sessions.handle({
      type: 'patch.terminal.open',
      daemonId: 'd1',
      sessionId: 's1',
      folder: join(dir, 'gone'),
    });
    const err = await sink.waitFor((e) => e.type === 'patch.terminal.error', 'error');
    expect(err).toMatchObject({ code: 'folder_not_found' });
    expect(sink.frames.some((f) => f.type === 'patch.terminal.ready')).toBe(false);
  });
});

// Command completion (spec/02 § Terminal sessions → Command completion).
//
// A pipe shell prints no prompt, so without the injected sentinel a command
// that outputs nothing is indistinguishable from a wedged session. These cover
// the whole contract: the marker never reaches the surface, the exit code does,
// and the parsing survives being cut in half by a chunk boundary.
describe('TerminalSessions — command completion', () => {
  let dir: string;
  let sessions: TerminalSessions;
  let sink: ReturnType<typeof collector>;

  const exits = (sessionId: string): number[] =>
    sink.frames
      .filter(
        (f): f is Extract<WireEvent, { type: 'patch.terminal.command-exit' }> =>
          f.type === 'patch.terminal.command-exit' && f.sessionId === sessionId,
      )
      .map((f) => f.code);

  const waitForExit = (sessionId: string, code: number): Promise<WireEvent> =>
    sink.waitFor(
      (e) =>
        e.type === 'patch.terminal.command-exit' && e.sessionId === sessionId && e.code === code,
      `command-exit ${code}`,
    );

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'patch-term-exit-'));
    sink = collector();
    sessions = new TerminalSessions({ emit: sink.emit });
    sessions.handle({ type: 'patch.terminal.open', daemonId: 'd1', sessionId: 's1', folder: dir });
    await sink.waitFor((e) => e.type === 'patch.terminal.ready', 'ready');
  });

  afterEach(async () => {
    await sessions.shutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a command that finished cleanly but printed nothing at all', async () => {
    // The whole bug: `cd` emits zero bytes, so this frame is the only evidence
    // the terminal is alive and ready for the next command.
    sessions.handle({ type: 'patch.terminal.input', sessionId: 's1', data: 'cd /tmp\n' });
    await waitForExit('s1', 0);
    expect(sink.text('s1')).toBe('');
  });

  it('reports a non-zero status, and never leaks the marker as output', async () => {
    sessions.handle({ type: 'patch.terminal.input', sessionId: 's1', data: 'false\n' });
    await waitForExit('s1', 1);
    expect(sink.text('s1')).not.toContain('__patch_exit_');
  });

  it('carries the command output through and reports its status after it', async () => {
    sessions.handle({ type: 'patch.terminal.input', sessionId: 's1', data: 'echo hello\n' });
    await sink.waitFor(outputContains('s1', 'hello'), 'echo output');
    await waitForExit('s1', 0);
    expect(sink.text('s1')).toBe('hello\n');
  });

  it('one exit per command, in order', async () => {
    sessions.handle({ type: 'patch.terminal.input', sessionId: 's1', data: 'true\n' });
    await waitForExit('s1', 0);
    sessions.handle({ type: 'patch.terminal.input', sessionId: 's1', data: '(exit 7)\n' });
    await waitForExit('s1', 7);
    expect(exits('s1')).toEqual([0, 7]);
  });

  it('output with NO trailing newline still streams before the marker lands', async () => {
    // The held-back tail must be the marker's own prefix, never the command's
    // last unterminated line — holding that would stall an interactive prompt.
    sessions.handle({
      type: 'patch.terminal.input',
      sessionId: 's1',
      data: "printf 'Password: '\n",
    });
    await sink.waitFor(outputContains('s1', 'Password: '), 'unterminated prompt');
    await waitForExit('s1', 0);
    // And the marker did not glue itself onto that line.
    expect(sink.text('s1')).toBe('Password: ');
  });

  it('input with no trailing newline is a partial line and gets no sentinel', async () => {
    sessions.handle({ type: 'patch.terminal.input', sessionId: 's1', data: 'echo split' });
    // Nothing has been run, so nothing has finished. Give the shell a beat to
    // prove it emitted no completion rather than merely not having yet.
    await new Promise((r) => setTimeout(r, 300));
    expect(exits('s1')).toEqual([]);
    // Completing the line runs it, and THAT reports once.
    sessions.handle({ type: 'patch.terminal.input', sessionId: 's1', data: 'line\n' });
    await sink.waitFor(outputContains('s1', 'splitline'), 'joined command output');
    await waitForExit('s1', 0);
    expect(exits('s1')).toEqual([0]);
  });

  it('ends the session normally when the shell exits under the sentinel', async () => {
    // `exit` closes stdin between our two writes; the session must report its
    // own exit rather than dying on the broken pipe.
    sessions.handle({ type: 'patch.terminal.input', sessionId: 's1', data: 'exit 4\n' });
    const exit = await sink.waitFor((e) => e.type === 'patch.terminal.exit', 'session exit');
    expect(exit).toMatchObject({ reason: 'shell_exit', code: 4 });
  });
});

// The marker parser on its own — a chunk boundary can fall anywhere, and the
// pipe decides where, so these are driven directly rather than hoped for.
describe('splitMarker / markerTail', () => {
  const prefix = '__patch_exit_abc123:';

  it('reads a sentinel on its own line', () => {
    expect(splitMarker(prefix, `${prefix}0`)).toEqual({ text: '', code: 0 });
    expect(splitMarker(prefix, `${prefix}130`)).toEqual({ text: '', code: 130 });
  });

  it('reads a sentinel appended to output that had no newline', () => {
    expect(splitMarker(prefix, `Password: ${prefix}1`)).toEqual({ text: 'Password: ', code: 1 });
  });

  it('is not fooled by a line that merely mentions the marker', () => {
    expect(splitMarker(prefix, 'no marker here')).toBeNull();
    expect(splitMarker(prefix, `${prefix}notanumber`)).toBeNull();
    expect(splitMarker(prefix, `${prefix}`)).toBeNull();
  });

  it('holds back only a tail that could still become a sentinel', () => {
    expect(markerTail(prefix, 'hello')).toBe(0);
    expect(markerTail(prefix, '')).toBe(0);
    // A suffix that is the beginning of the marker.
    expect(markerTail(prefix, 'done __patch_ex')).toBe('__patch_ex'.length);
    // The marker in full, waiting on its digits.
    expect(markerTail(prefix, `x${prefix}12`)).toBe(prefix.length + 2);
  });
});

// Chunk boundaries are the pipe's to choose, so the filter is driven directly
// with the splits that matter rather than hoping a real shell produces them.
describe('readMarkers', () => {
  const prefix = '__patch_exit_abc123:';

  /** The bytes a chunk's segments would put on screen, sentinels removed. */
  const shown = (r: { segments: { kind: string; data?: string }[] }): string =>
    r.segments
      .filter((seg) => seg.kind === 'out')
      .map((seg) => seg.data)
      .join('');

  it('passes ordinary output straight through', () => {
    expect(readMarkers(prefix, '', 'hello\nworld\n')).toEqual({
      segments: [{ kind: 'out', data: 'hello\nworld\n' }],
      pending: '',
    });
  });

  it('strips a sentinel and reports its code', () => {
    expect(readMarkers(prefix, '', `hello\n${prefix}0\n`)).toEqual({
      segments: [
        { kind: 'out', data: 'hello\n' },
        { kind: 'exit', code: 0 },
      ],
      pending: '',
    });
  });

  it('reassembles a sentinel cut in half by a chunk boundary', () => {
    const first = readMarkers(prefix, '', 'hello\n__patch_exit_a');
    // The half-marker is held back, not shown.
    expect(shown(first)).toBe('hello\n');
    expect(first.segments.some((seg) => seg.kind === 'exit')).toBe(false);
    expect(first.pending).toBe('__patch_exit_a');
    const second = readMarkers(prefix, first.pending, 'bc123:3\n');
    expect(second).toEqual({ segments: [{ kind: 'exit', code: 3 }], pending: '' });
  });

  it('splits between the marker and its exit code without losing either', () => {
    const first = readMarkers(prefix, '', `out\n${prefix}`);
    expect(shown(first)).toBe('out\n');
    expect(first.pending).toBe(prefix);
    expect(readMarkers(prefix, first.pending, '12\n')).toEqual({
      segments: [{ kind: 'exit', code: 12 }],
      pending: '',
    });
  });

  it('streams a partial line promptly when it cannot be a sentinel', () => {
    // The wedge this whole feature exists to make visible: a prompt written
    // with no newline must appear NOW, not when the next chunk happens along.
    expect(readMarkers(prefix, '', 'Password: ')).toEqual({
      segments: [{ kind: 'out', data: 'Password: ' }],
      pending: '',
    });
  });

  it('keeps output that shares a line with the sentinel, and adds no newline', () => {
    expect(readMarkers(prefix, '', `Password: ${prefix}0\n`)).toEqual({
      segments: [
        { kind: 'out', data: 'Password: ' },
        { kind: 'exit', code: 0 },
      ],
      pending: '',
    });
  });

  it('handles several completions in one chunk, in order', () => {
    expect(readMarkers(prefix, '', `a\n${prefix}0\nb\n${prefix}2\n`)).toEqual({
      segments: [
        { kind: 'out', data: 'a\n' },
        { kind: 'exit', code: 0 },
        { kind: 'out', data: 'b\n' },
        { kind: 'exit', code: 2 },
      ],
      pending: '',
    });
  });

  it('never files a completion ahead of output the command printed first', () => {
    // A chunk that lands mid-message: the sentinel must not be spliced between
    // the two halves of the line before it, nor jump ahead of the line itself.
    const first = readMarkers(prefix, '', "ls: cannot access '/nope'");
    expect(shown(first)).toBe("ls: cannot access '/nope'");
    const second = readMarkers(prefix, first.pending, `: No such file\n${prefix}2\n`);
    expect(second.segments).toEqual([
      { kind: 'out', data: ': No such file\n' },
      { kind: 'exit', code: 2 },
    ]);
  });
});
