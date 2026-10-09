// Terminal sessions (spec/02-daemon.md § Terminal sessions, spec/03 § Terminal
// sessions, spec/14 § Terminal).
//
// The host owns the project filesystem, so it owns the shell. A surface opens
// a session against a folder and drives it over the wire — the only route a
// surface has to `git clone` a repo ONTO the host, run an install, or see
// what is actually on disk. Without it a remote host is a closed box: a
// folder that isn't there yet can never be put there.
//
// TWO KINDS OF SESSION. The default is a pipe shell, deliberately: web's
// terminal drawer is a line-at-a-time command box, and pipes cover its use
// case — clone / install / inspect. The cost is that full-screen curses
// programs and TTY-demanding password prompts don't work;
// `GIT_TERMINAL_PROMPT=0` makes the common case of that (git asking for a
// password) fail fast and loudly instead of hanging forever on a prompt nobody
// can answer.
//
// An open that carries `pty` gets a REAL pseudo-terminal instead, for a surface
// drawing with a terminal emulator (the phone). It still needs no native
// module: the PTY is allocated by a small python3 helper (`ptyHelper.ts`).
// Everything below about the completion sentinel applies to pipe sessions
// only — a terminal's own prompt says when a command finished.
//
// NO FALLBACK: a folder that does not exist on the host is a `folder_not_found`
// error frame, never a shell quietly started in `$HOME` or `/` — a shell in the
// wrong place is how you clone a repo into the void.
//
// COMMAND COMPLETION. A pipe shell prints no prompt and echoes nothing, so
// stdout alone can never say that a command finished: `cd /tmp` emits zero
// bytes and looks identical to a session wedged by something reading stdin.
// So each session mints a random marker at spawn, and every input frame that
// ends in a newline is followed by `printf '<marker>:%s\n' "$?"` on the same
// stdin. The shell runs it the moment the command before it returns, which
// makes the marker line mean exactly "that command is done, with this status".
// The marker is stripped out of stdout — it is never surfaced as output — and
// re-emitted as `patch.terminal.command-exit`.
//
// Stripping it means line-buffering stdout, because a marker can straddle a
// chunk boundary. Only the trailing bytes that could still be the start of a
// marker are held back; everything else streams immediately, so `printf` with
// no trailing newline still arrives promptly. stderr is never buffered: the
// sentinel writes to stdout.
//
// KNOWN LIMITATIONS, both accepted rather than worked around:
//   - A multi-line construct typed line by line (a heredoc, an unclosed quote)
//     swallows the injected sentinel into its body, so that command reports no
//     completion until the construct closes.
//   - A command that reads stdin itself (`python3`, `cat`) consumes the
//     sentinel line too and will usually complain about it. That is louder than
//     the alternative — a terminal that silently swallows every later keystroke
//     — and the command stays correctly marked as running until it exits.

import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { Writable } from 'node:stream';
import { PTY_HELPER_SOURCE } from './ptyHelper.js';
import type { Logger } from 'pino';
import type { WireEvent } from '@patch/wire';

// NO SESSION CAP. There was a hard limit of 4 concurrent sessions per host.
// It bounded nothing worth bounding: an idle session is one `bash` with three
// pipes (~2MB RSS), while the cost that actually matters is what a session
// RUNS — which a count of shells never constrained. What it did do was reject
// real work, because slots are far easier to hold than to free: one per chat,
// closing the drawer deliberately keeps the shell alive, and a surface that
// reloads strands its old session until the idle timer reaps it. Four reloads
// inside half an hour could exhaust it. Sessions are now bounded by
// IDLE_TIMEOUT_MS alone.

/** A session with no input for this long is ended (spec/02 § Terminal sessions). */
export const IDLE_TIMEOUT_MS = 30 * 60_000;

/** Output rate cap: bytes per session per window before chunks are dropped. */
export const OUTPUT_WINDOW_MS = 1_000;
export const OUTPUT_BYTES_PER_WINDOW = 512 * 1024;

/** Surface→host frames this manager handles. */
type TerminalRequest = Extract<
  WireEvent,
  {
    type:
      | 'patch.terminal.open'
      | 'patch.terminal.input'
      | 'patch.terminal.signal'
      | 'patch.terminal.close'
      | 'patch.terminal.resize';
  }
>;

type EndReason = Extract<WireEvent, { type: 'patch.terminal.exit' }>['reason'];

interface Session {
  sessionId: string;
  child: ChildProcessWithoutNullStreams;
  /** The surface that opened it — every frame for this session routes there. */
  forSurfaceId?: string;
  /** Set before we kill the shell so the `exit` handler reports WHY it ended. */
  endReason: EndReason | null;
  idleTimer: NodeJS.Timeout;
  /** Rolling output-rate window: start instant + bytes emitted within it. */
  windowStart: number;
  windowBytes: number;
  /** True once this window's truncation notice has been sent (send it once). */
  windowTruncated: boolean;
  /** Per-session completion sentinel, `<marker>:<code>` on its own stdout line. */
  marker: string;
  /**
   * Trailing stdout bytes held back because they could still turn out to be
   * the start of the marker. Never more than the marker's own length.
   */
  pendingOut: string;
  /**
   * Set for a PTY session (spec/02 § Terminal sessions — PTY sessions): the
   * helper's window-size control pipe, and a UTF-8 decoder that carries a
   * multi-byte character split across two reads over to the next one, since
   * an emulator draws what it is given and a replacement glyph is a bug.
   * `null` for a pipe session.
   */
  pty: { control: Writable; decoder: StringDecoder } | null;
}

export interface TerminalSessionsOptions {
  /** Emits a host→surface frame (wired to the server link's sender). */
  emit: (event: WireEvent) => void;
  /**
   * Where a session with NO folder starts. Wired to the host's first
   * published project root, because that is where a clone is going: the
   * host's `$HOME` is `/root` in the container while the project dirs are
   * mounted elsewhere, so homing there would drop the user somewhere they'd
   * only have to `cd` out of. Returning nothing falls through to `$HOME`, and
   * either way `ready.cwd` reports where the shell actually landed.
   */
  defaultCwd?: () => string | undefined;
  /**
   * The interpreter that runs the PTY helper (`ptyHelper.ts`). Injected so a
   * test can name one that does not exist; the host runs `python3` off PATH.
   */
  python?: string;
  logger?: Logger;
}

export class TerminalSessions {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly opts: TerminalSessionsOptions) {}

  /** Live session count (tests). */
  count(): number {
    return this.sessions.size;
  }

  /** Route one surface→host terminal frame. */
  handle(event: TerminalRequest): void {
    switch (event.type) {
      case 'patch.terminal.open':
        this.open(event);
        return;
      case 'patch.terminal.input':
        this.input(event);
        return;
      case 'patch.terminal.signal':
        this.interrupt(event);
        return;
      case 'patch.terminal.close':
        this.close(event);
        return;
      case 'patch.terminal.resize':
        this.resize(event);
        return;
    }
  }

  /** End every live session — the host is going down (spec: no reattach). */
  async shutdown(): Promise<void> {
    const ending = [...this.sessions.values()].map(
      (s) =>
        new Promise<void>((resolve) => {
          // A child that already exited will never emit `exit` again — resolve
          // straight away rather than hanging the shutdown on a dead process.
          /* v8 ignore next -- every session in the map is live; the guard covers a shell that died between the snapshot and this line. */
          if (s.child.exitCode !== null || s.child.signalCode !== null) return resolve();
          s.child.once('exit', () => resolve());
          this.end(s, 'daemon_shutdown');
        }),
    );
    await Promise.all(ending);
  }

  // ---- open ----------------------------------------------------------------

  private open(event: Extract<WireEvent, { type: 'patch.terminal.open' }>): void {
    const { sessionId, forSurfaceId } = event;

    // No folder named = "a shell anywhere I can work" (the new-chat case: there
    // is no folder yet, which is the very reason a shell is wanted). Start in
    // the host's home — `ready.cwd` tells the surface exactly where it landed,
    // so this resolves a request, it does not paper over a failure.
    const folder = event.folder ?? this.opts.defaultCwd?.() ?? homedir();

    // A NAMED folder gets the same validation a chat spawn does: missing — or a
    // file — is `folder_not_found`; we never start a shell somewhere else
    // instead. (The home directory is checked too: an unusable HOME is a real
    // host misconfiguration and must be reported, not worked around.)
    let isDir = false;
    try {
      isDir = statSync(folder).isDirectory();
    } catch {
      isDir = false;
    }
    /* v8 ignore next 6 -- the `!isDir` body is covered via a named missing folder; the homedir() side of the same branch would need an unusable HOME on the test host. */
    if (!isDir) {
      this.error(sessionId, 'folder_not_found', `folder does not exist on the host: ${folder}`, {
        forSurfaceId,
      });
      return;
    }

    // Re-opening a live sessionId replaces its shell (a surface that reconnected
    // and re-opened must not leak the old one).
    const existing = this.sessions.get(sessionId);
    if (existing) this.end(existing, 'closed');

    if (event.pty !== undefined) {
      this.openPty(sessionId, folder, event.pty, forSurfaceId);
      return;
    }

    const shell = process.env.SHELL || 'bash';
    const child = spawn(shell, {
      cwd: folder,
      // Own process group: lets us signal the whole job tree on close without
      // ever aiming a signal at the host itself.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        TERM: 'dumb',
        // No TTY means nobody can answer a credential prompt — fail loudly
        // rather than hang the session forever waiting on one.
        GIT_TERMINAL_PROMPT: '0',
      },
    }) as ChildProcessWithoutNullStreams;

    const session: Session = {
      sessionId,
      child,
      ...(forSurfaceId !== undefined ? { forSurfaceId } : {}),
      endReason: null,
      idleTimer: this.armIdleTimer(sessionId),
      windowStart: Date.now(),
      windowBytes: 0,
      windowTruncated: false,
      // Random per session so a command that happens to print the literal
      // string cannot forge a completion for someone else's shell.
      marker: `__patch_exit_${randomBytes(6).toString('hex')}`,
      pendingOut: '',
      pty: null,
    };
    this.sessions.set(sessionId, session);

    // The shell can exit between our two writes (`exit 3` followed by the
    // sentinel), and an unhandled EPIPE on stdin would take the host with it.
    // The session's own `exit` frame already reports what happened.
    child.stdin.on('error', (err: Error) => {
      this.opts.logger?.debug({ sessionId, err: err.message }, 'terminal stdin write failed');
    });
    child.stdout.on('data', (buf: Buffer) => this.output(session, 'stdout', buf));
    child.stderr.on('data', (buf: Buffer) => this.output(session, 'stderr', buf));
    child.on('error', (err: Error) => {
      // A shell that failed to spawn (missing binary, EACCES) never emits
      // `exit`, so drop the session here — leaving it in the map would keep a
      // dead entry that hangs shutdown forever.
      this.opts.logger?.warn({ sessionId, err: err.message }, 'terminal session error');
      clearTimeout(session.idleTimer);
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
      this.error(sessionId, 'internal', err.message, { forSurfaceId });
    });
    child.on('exit', (code) => {
      clearTimeout(session.idleTimer);
      // Only drop the map entry if it is still OURS: a re-open of the same
      // sessionId replaces the entry synchronously, and the old shell's exit
      // lands afterwards — deleting blindly would evict the live replacement.
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
      this.emit(
        {
          type: 'patch.terminal.exit',
          sessionId,
          code: session.endReason === null ? code : null,
          reason: session.endReason ?? 'shell_exit',
        },
        forSurfaceId,
      );
    });

    this.emit({ type: 'patch.terminal.ready', sessionId, cwd: folder }, forSurfaceId);
  }

  /**
   * A REAL pseudo-terminal session (spec/02 § Terminal sessions — PTY
   * sessions), for a surface that draws with a terminal emulator. The shell
   * echoes, prints its prompt, completes on Tab and runs full-screen programs,
   * so none of the pipe session's machinery applies: no completion sentinel
   * (the prompt says a command finished), no stdout/stderr split (a terminal
   * has one output), and Ctrl-C is the ETX byte the line discipline turns into
   * SIGINT for the foreground job, exactly as on a local terminal.
   *
   * NO FALLBACK: if the helper cannot run, the surface gets `pty_unavailable` —
   * never a pipe shell drawn into an emulator that expects a terminal.
   */
  private openPty(
    sessionId: string,
    folder: string,
    size: { cols: number; rows: number },
    forSurfaceId: string | undefined,
  ): void {
    const shell = process.env.SHELL || 'bash';
    const python = this.opts.python ?? 'python3';
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };
    // A pipe session's guard against a credential prompt nobody can answer.
    // A terminal CAN answer one, so it must not inherit the refusal.
    delete env.GIT_TERMINAL_PROMPT;
    // The emulator speaks UTF-8. A host started by systemd often has no
    // locale at all, which leaves the shell in the C locale — readline then
    // draws every non-ASCII keystroke as an octal escape. Only when NOTHING
    // names a character set is one declared; a configured locale is left alone.
    if (!env.LC_ALL && !env.LC_CTYPE && !env.LANG) {
      env.LC_CTYPE = process.platform === 'darwin' ? 'UTF-8' : 'C.UTF-8';
    }
    const child = spawn(
      python,
      ['-c', PTY_HELPER_SOURCE, String(size.cols), String(size.rows), shell],
      {
        cwd: folder,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        env,
      },
    ) as unknown as ChildProcessWithoutNullStreams;
    const control = (child as unknown as { stdio: Writable[] }).stdio[3] as Writable;

    const session: Session = {
      sessionId,
      child,
      ...(forSurfaceId !== undefined ? { forSurfaceId } : {}),
      endReason: null,
      idleTimer: this.armIdleTimer(sessionId),
      windowStart: Date.now(),
      windowBytes: 0,
      windowTruncated: false,
      marker: '',
      pendingOut: '',
      pty: { control, decoder: new StringDecoder('utf8') },
    };
    this.sessions.set(sessionId, session);

    const ignoreWriteError = (err: Error): void => {
      this.opts.logger?.debug({ sessionId, err: err.message }, 'terminal pty write failed');
    };
    child.stdin.on('error', ignoreWriteError);
    control.on('error', ignoreWriteError);
    child.stdout.on('data', (buf: Buffer) => this.output(session, 'stdout', buf));
    // The helper's own stderr: a Python traceback, a failed exec. Shown, as
    // stderr, rather than swallowed — it is the only account of what broke.
    child.stderr.on('data', (buf: Buffer) => this.output(session, 'stderr', buf));
    child.on('spawn', () => {
      // Ready only once the helper really is running, so a missing python3
      // is reported as an error in place of a ready — never after one.
      this.emit({ type: 'patch.terminal.ready', sessionId, cwd: folder, pty: true }, forSurfaceId);
    });
    child.on('error', (err: Error) => {
      this.opts.logger?.warn({ sessionId, err: err.message }, 'terminal pty helper failed');
      clearTimeout(session.idleTimer);
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
      this.error(
        sessionId,
        'pty_unavailable',
        `this host cannot open a terminal: ${python} failed to start (${err.message})`,
        { forSurfaceId },
      );
    });
    child.on('exit', (code) => {
      clearTimeout(session.idleTimer);
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
      this.emit(
        {
          type: 'patch.terminal.exit',
          sessionId,
          code: session.endReason === null ? code : null,
          reason: session.endReason ?? 'shell_exit',
        },
        forSurfaceId,
      );
    });
  }

  private resize(event: Extract<WireEvent, { type: 'patch.terminal.resize' }>): void {
    const session = this.require(event.sessionId, event.forSurfaceId);
    if (!session) return;
    if (session.pty === null) {
      this.error(session.sessionId, 'not_a_pty', 'a pipe session has no window to resize', {
        forSurfaceId: event.forSurfaceId,
      });
      return;
    }
    session.pty.control.write(`${event.cols} ${event.rows}\n`);
  }

  // ---- input / signal / close ---------------------------------------------

  private input(event: Extract<WireEvent, { type: 'patch.terminal.input' }>): void {
    const session = this.require(event.sessionId, event.forSurfaceId);
    if (!session) return;
    clearTimeout(session.idleTimer);
    session.idleTimer = this.armIdleTimer(session.sessionId);
    session.child.stdin.write(event.data);
    // A terminal needs no sentinel — its prompt says when a command is done.
    if (session.pty !== null) return;
    // A complete line is a command the shell will run, so ask it to report the
    // status the moment it returns. Input that does NOT end in a newline is a
    // partial line — half a command, or bytes being fed to something's stdin —
    // and a sentinel there would be spliced into the middle of it.
    if (!event.data.endsWith('\n')) return;
    session.child.stdin.write(`printf '${session.marker}:%s\\n' "$?"\n`);
  }

  /**
   * Ctrl-C. The shell and its children share our detached process group, so a
   * group-wide SIGINT would take the session down with the command. Instead we
   * signal the shell's DESCENDANTS only — the foreground command and anything
   * it spawned — leaving the shell itself alive to take the next command.
   */
  private interrupt(event: Extract<WireEvent, { type: 'patch.terminal.signal' }>): void {
    const session = this.require(event.sessionId, event.forSurfaceId);
    if (!session) return;
    // A terminal interrupts the way a keyboard does: ETX to the line
    // discipline, which signals whatever job is in the foreground — and only
    // that job, which the descendant walk below cannot know.
    if (session.pty !== null) {
      session.child.stdin.write('\x03');
      return;
    }
    const shellPid = session.child.pid;
    /* v8 ignore next -- a just-spawned, still-live child always has a pid; this guards the typing only. */
    if (shellPid === undefined) return;
    execFile('ps', ['-A', '-o', 'pid=,ppid='], (err, stdout) => {
      /* v8 ignore next 4 -- `ps` is present on every host the host runs on (Linux container + macOS dev); its failure path can't be exercised without removing it. */
      if (err) {
        this.opts.logger?.warn({ err: err.message }, 'terminal interrupt: ps failed');
        return;
      }
      for (const pid of descendantsOf(stdout, shellPid)) {
        /* v8 ignore next 5 -- the pid vanishing between the `ps` listing and the signal is a real race, but not one a test can schedule. */
        try {
          process.kill(pid, 'SIGINT');
        } catch {
          // Already gone — nothing to interrupt.
        }
      }
    });
  }

  private close(event: Extract<WireEvent, { type: 'patch.terminal.close' }>): void {
    const session = this.require(event.sessionId, event.forSurfaceId);
    if (!session) return;
    this.end(session, 'closed');
  }

  // ---- internals -----------------------------------------------------------

  /** Look a session up, reporting `unknown_session` when it isn't there. */
  private require(sessionId: string, forSurfaceId?: string): Session | null {
    const session = this.sessions.get(sessionId);
    if (session) return session;
    this.error(sessionId, 'unknown_session', `no terminal session ${sessionId}`, { forSurfaceId });
    return null;
  }

  /** Kill a session's whole job tree, attributing the reason to its exit frame. */
  private end(session: Session, reason: EndReason): void {
    session.endReason = reason;
    clearTimeout(session.idleTimer);
    // Negative pid = the detached process group: the shell AND whatever it was
    // running. A bare shell kill would orphan a running `pnpm install`.
    /* v8 ignore next 6 -- `pid` is always set for a session that reached the map, and the group having already died between frames is a race no test can schedule. */
    const pid = session.child.pid;
    try {
      if (pid !== undefined) process.kill(-pid, 'SIGKILL');
    } catch {
      // Group already gone (the shell exited on its own between frames).
    }
  }

  private armIdleTimer(sessionId: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const session = this.sessions.get(sessionId);
      // The timer is cleared on exit/close, so it can only fire while the
      // session is live.
      /* v8 ignore next 2 */
      if (!session) return;
      this.opts.logger?.info({ sessionId }, 'terminal session idle-timed out');
      this.end(session, 'idle_timeout');
    }, IDLE_TIMEOUT_MS);
    // A pending idle timer must not hold the process open.
    timer.unref?.();
    return timer;
  }

  /**
   * Stream one chunk back, subject to the per-session rate cap. A runaway
   * command (`yes`, a build with a firehose of logs) must not be able to flood
   * the link; over the cap we drop chunks for the rest of the window and say so
   * once, so the user knows output is missing rather than silently losing it.
   *
   * stdout additionally passes the completion-sentinel filter. Markers are
   * pulled out even while the window is dropping output: the frame is a handful
   * of bytes, and losing it would leave the surface showing a command as
   * running forever because too much scrolled past.
   */
  private output(session: Session, stream: 'stdout' | 'stderr', buf: Buffer): void {
    const now = Date.now();
    if (now - session.windowStart >= OUTPUT_WINDOW_MS) {
      session.windowStart = now;
      session.windowBytes = 0;
      session.windowTruncated = false;
    }
    session.windowBytes += buf.length;
    const dropping = session.windowBytes > OUTPUT_BYTES_PER_WINDOW;
    if (dropping && !session.windowTruncated) {
      session.windowTruncated = true;
      this.emit(
        {
          type: 'patch.terminal.output',
          sessionId: session.sessionId,
          stream: 'stderr',
          data: '\n[patch] output truncated — too much output too fast\n',
        },
        session.forSurfaceId,
      );
    }
    if (session.pty !== null) {
      const text = stream === 'stdout' ? session.pty.decoder.write(buf) : buf.toString('utf8');
      if (!dropping && text !== '') this.emitOutput(session, stream, text);
      return;
    }
    const text = buf.toString('utf8');
    // The sentinel is written to stdout, so stderr needs no line buffering and
    // streams byte-for-byte exactly as it arrives.
    if (stream === 'stderr') {
      if (!dropping) this.emitOutput(session, 'stderr', text);
      return;
    }
    this.takeMarkers(session, text, dropping);
  }

  /**
   * Run one stdout chunk through the sentinel filter, emitting the bytes the
   * surface should see and a `command-exit` for every completion it carries,
   * interleaved in the order the shell actually produced them.
   */
  private takeMarkers(session: Session, text: string, dropping: boolean): void {
    const read = readMarkers(`${session.marker}:`, session.pendingOut, text);
    session.pendingOut = read.pending;
    // IN ORDER. A chunk can carry output, a completion, and the next command's
    // output all at once, and emitting every exit frame first would file the
    // `exit 2` line above the error that earned it — or, when a chunk lands
    // mid-message, between the two halves of one line.
    for (const segment of read.segments) {
      if (segment.kind === 'exit') {
        this.emit(
          { type: 'patch.terminal.command-exit', sessionId: session.sessionId, code: segment.code },
          session.forSurfaceId,
        );
        continue;
      }
      if (!dropping && segment.data !== '') this.emitOutput(session, 'stdout', segment.data);
    }
  }

  /** Emit one output chunk for a session, routed to its owning surface. */
  private emitOutput(session: Session, stream: 'stdout' | 'stderr', data: string): void {
    this.emit(
      { type: 'patch.terminal.output', sessionId: session.sessionId, stream, data },
      session.forSurfaceId,
    );
  }

  private error(
    sessionId: string,
    code: Extract<WireEvent, { type: 'patch.terminal.error' }>['code'],
    message: string,
    opts: { forSurfaceId?: string },
  ): void {
    this.emit({ type: 'patch.terminal.error', sessionId, code, message }, opts.forSurfaceId);
  }

  /** Stamp the owning surface so the hub routes the frame to it alone. */
  private emit(event: WireEvent, forSurfaceId?: string): void {
    this.opts.emit(forSurfaceId === undefined ? event : ({ ...event, forSurfaceId } as WireEvent));
  }
}

/**
 * One piece of a stdout chunk, in the order the shell produced it: bytes for
 * the surface, or a command that finished with a status.
 */
export type MarkerSegment = { kind: 'out'; data: string } | { kind: 'exit'; code: number };

/**
 * Split a stdout chunk into ordered segments, pulling out every completion
 * sentinel.
 *
 * `pending` is whatever the previous chunk held back, since the pipe decides
 * where chunks break and a marker can straddle one. Returns the segments in
 * order and the tail to hold for next time.
 *
 * ORDER IS THE POINT. One chunk routinely carries the tail of a command's
 * output, that command's sentinel, and the start of the next one. Reporting
 * the completions separately from the bytes would put `exit 2` above the error
 * that produced it, or — when the chunk lands mid-line — between the halves of
 * a single message.
 *
 * A marker is matched anywhere on a line, not just at its start: a command
 * whose last line has no newline (`printf 'Password: '`) leaves the sentinel
 * appended to it, and those bytes still have to reach the surface without a
 * line break being invented for them.
 */
export function readMarkers(
  prefix: string,
  pending: string,
  text: string,
): { segments: MarkerSegment[]; pending: string } {
  const joined = pending + text;
  const cut = joined.lastIndexOf('\n');
  const complete = cut === -1 ? '' : joined.slice(0, cut + 1);
  const partial = cut === -1 ? joined : joined.slice(cut + 1);

  const segments: MarkerSegment[] = [];
  /** Append output, coalescing with the run of bytes already being built. */
  const pushOut = (data: string): void => {
    if (data === '') return;
    const last = segments[segments.length - 1];
    if (last?.kind === 'out') last.data += data;
    else segments.push({ kind: 'out', data });
  };

  if (complete.includes(prefix)) {
    for (const line of complete.slice(0, -1).split('\n')) {
      const hit = splitMarker(prefix, line);
      if (hit === null) {
        pushOut(`${line}\n`);
        continue;
      }
      // The newline belonged to the sentinel's own `printf`, so it goes with
      // it — keeping it would invent a break the command never printed.
      pushOut(hit.text);
      segments.push({ kind: 'exit', code: hit.code });
    }
  } else {
    pushOut(complete);
  }

  // Hold back ONLY the tail that could still grow into a marker. Holding the
  // whole unterminated line instead would stall every prompt written without a
  // trailing newline until the next chunk happened to arrive.
  const held = markerTail(prefix, partial);
  pushOut(held === 0 ? partial : partial.slice(0, partial.length - held));
  return { segments, pending: held === 0 ? '' : partial.slice(-held) };
}

/**
 * A completion sentinel on one stdout line: the bytes before it (the command's
 * own unterminated output, usually nothing) and the exit code it carries.
 * `null` when this line is not a sentinel.
 */
export function splitMarker(prefix: string, line: string): { text: string; code: number } | null {
  const at = line.indexOf(prefix);
  if (at === -1) return null;
  const rest = line.slice(at + prefix.length);
  // `$?` is always a non-negative integer, so anything else on the line means
  // the marker was printed by the command rather than by our own `printf`.
  if (!/^\d+$/.test(rest)) return null;
  return { text: line.slice(0, at), code: Number(rest) };
}

/**
 * How many trailing characters of an unterminated stdout line have to be held
 * back because they could still turn into a completion sentinel — the sentinel
 * already in full but waiting on its digits, or any suffix that is the
 * beginning of one. Zero means the whole line can stream now.
 */
export function markerTail(prefix: string, partial: string): number {
  const at = partial.indexOf(prefix);
  if (at !== -1) return partial.length - at;
  const from = Math.min(partial.length, prefix.length - 1);
  for (let k = from; k > 0; k--) {
    if (prefix.startsWith(partial.slice(-k))) return k;
  }
  return 0;
}

/**
 * Every descendant pid of `rootPid`, from `ps -A -o pid=,ppid=` output. Used by
 * the interrupt path: the foreground command plus anything it spawned, without
 * the shell itself.
 */
export function descendantsOf(psOutput: string, rootPid: number): number[] {
  const children = new Map<number, number[]>();
  for (const line of psOutput.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const out: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const next = queue.shift() as number;
    for (const child of children.get(next) ?? []) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}
