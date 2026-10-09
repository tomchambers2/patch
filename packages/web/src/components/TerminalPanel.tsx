// TerminalPanel — a shell on the HOST, as a pane tab (spec/14 §
// Panes and tabs, § Terminal, spec/02 § Terminal sessions).
//
// This exists because the host is remote: `git clone`ing a repo onto it —
// which has to happen BEFORE a chat can be opened in that folder — has no other
// route from a surface.
//
// One form: a `{kind:'terminal', chatId}` pane tab, filling whatever pane it's
// the active tab of. Closing the tab (⌘W, the tab bar's ×) only hides it —
// same as the old drawer's close button — the shell in `terminalStore` keeps
// running; reopening a terminal tab for the same chat re-attaches to it with
// its scrollback intact.
//
// The shell is a pipe: nothing echoes, and there is no prompt to come back. So
// the prompt row itself reports whether the command that was sent is still
// going, and names the key that interrupts it — otherwise `cd /tmp`, which
// prints nothing and finishes instantly, is indistinguishable from a session
// wedged by something reading stdin, which prints nothing and never finishes.
//
// NO FALLBACK: a command that cannot be sent (no socket) and every host-side
// error land in the scrollback as an explicit line. The prompt is never left
// looking alive over a dead session.

import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import type { WireEvent } from '@patch/wire';
import type { PatchWs } from '../api/ws.js';
import { useTerminalStore } from '../stores/terminalStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { defaultDaemonId, usePresenceStore } from '../stores/presenceStore.js';

export interface TerminalPanelProps {
  /** Session key: a chatId, or `new` for the not-yet-spawned chat's shell. */
  chatId: string;
  /**
   * The chat's folder — where the shell is rooted. OMITTED on `/chats/new`:
   * there is no folder yet, and that is exactly when a shell is wanted (to
   * clone one onto the host). The host then starts the shell in its own
   * home and reports the real directory, which the header shows.
   */
  folder?: string;
  ws: PatchWs | null;
  /** Only the focused pane's active tab should steal input focus on mount —
   *  several terminal tabs can be mounted at once, one per pane. */
  focused?: boolean;
}

function newSessionId(): string {
  return `term-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** How many trailing path segments the drawer header keeps. */
const CWD_SEGMENTS = 3;

/**
 * The last few segments of a path, prefixed with `…` when anything was dropped.
 *
 * A cwd is identified by its END (`…/daemon/.patch/threads/manager`), so the
 * header keeps the tail and drops the front — the opposite of what CSS
 * `text-overflow: ellipsis` does on its own.
 */
export function tailPath(path: string | undefined): string {
  if (!path) return '';
  const segments = path.split('/').filter((s) => s !== '');
  if (segments.length <= CWD_SEGMENTS) return path;
  return `…/${segments.slice(-CWD_SEGMENTS).join('/')}`;
}

export function TerminalPanel({
  chatId,
  folder,
  ws,
  focused = true,
}: TerminalPanelProps): JSX.Element {
  // The chat's own host — the terminal exists to work on that chat's files, so
  // the shell belongs on that machine and nowhere else. `/chats/new` has no
  // chat yet, hence the fall-through to the account's default host below.
  const chatDaemonId = useChatStore((s) => s.chats[chatId]?.daemonId ?? null) || null;
  const session = useTerminalStore((s) => s.sessions[chatId]);
  const startSession = useTerminalStore((s) => s.startSession);
  const recordCommand = useTerminalStore((s) => s.recordCommand);
  const markRunning = useTerminalStore((s) => s.markRunning);
  const appendLocal = useTerminalStore((s) => s.appendLocal);
  const pending = useTerminalStore((s) => s.pending[chatId]);
  const takePending = useTerminalStore((s) => s.takePending);

  const [line, setLine] = useState('');
  // Position in `session.history` while walking it with ↑/↓; null = "at the
  // live line the user is typing".
  const [historyAt, setHistoryAt] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  /** Send a frame, reporting a dead socket into the scrollback rather than dropping it. */
  function send(event: WireEvent, forChat = chatId): boolean {
    if (!ws) {
      appendLocal(forChat, '\n[not connected, reconnect and try again]\n');
      return false;
    }
    ws.send(event);
    return true;
  }

  /** Open a shell for this chat (first open, or an explicit restart). */
  function startShell(): void {
    // A shell runs on ONE machine. The chat's own host is the only right answer
    // — the terminal exists to work on the files that chat works on — so this
    // refuses rather than opening a shell on some other box.
    const daemonId = chatDaemonId ?? defaultDaemonId(usePresenceStore.getState().hosts);
    if (daemonId === null) {
      appendLocal(chatId, '\n[no host to open a shell on]\n');
      return;
    }
    const sessionId = newSessionId();
    startSession(chatId, folder ?? '', sessionId);
    // Claim a folder only when we actually have one. With none, the host
    // roots the shell and tells us where — never a path this surface guessed.
    send(
      folder
        ? { type: 'patch.terminal.open', sessionId, daemonId, folder }
        : { type: 'patch.terminal.open', sessionId, daemonId },
      chatId,
    );
  }

  // Opening the drawer for a chat with no live shell starts one. A session in
  // any live-ish state is reused — closing the drawer hides it, it does not
  // kill the shell (spec/14 § Terminal).
  useEffect(() => {
    // An existing session is reused whatever its state: a live one keeps
    // running behind a closed tab, and an ended/errored one waits for the
    // explicit Restart rather than silently respawning.
    if (session) return;
    startShell();
    // Deliberately keyed on mount for this chat: `startShell` closes over the
    // current session/ws, so a dependency-complete list would re-run it on
    // every render and spawn shells.
  }, [chatId]);

  // Drain whatever asked for this terminal (spec/14 § Background task bar): a
  // click on a running background task queues a command or a note and opens
  // the terminal tab, and the shell it wants may not exist yet at that moment.
  // Gated on `live` because a command sent to a starting session is written to
  // a shell that has not reported its cwd yet. Taken and cleared in one step,
  // so a re-render — or React's double-invoked mount effects — cannot run it
  // twice.
  useEffect(() => {
    if (pending === undefined || session?.status !== 'live') return;
    const entry = takePending(chatId);
    /* v8 ignore next -- `pending` being defined is what got us here; the take can only miss if another effect already drained it in the same tick. */
    if (entry === null) return;
    if (entry.kind === 'note') appendLocal(chatId, entry.text);
    else runLine(entry.text);
    // `runLine` closes over the current session/ws, so a dependency-complete
    // list would re-run this on every render.
  }, [pending, session?.status, chatId]);

  // Follow the tail as output streams in.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [session?.chunks.length]);

  /**
   * Run a line in this session exactly as if it had been typed: into the
   * history, echoed to the scrollback, then onto the wire. The only path a
   * command takes, so a command the app raises itself is indistinguishable
   * from one the user typed.
   */
  function runLine(text: string): void {
    /* v8 ignore next 2 -- the prompt only exists once the session does: the open effect creates it before any keystroke can land. */
    if (!session) return;
    recordCommand(chatId, text);
    // Echo the command so the scrollback reads like a terminal — the shell has
    // no PTY, so nothing echoes it for us.
    appendLocal(chatId, `❯ ${text}\n`);
    const sent = send({
      type: 'patch.terminal.input',
      sessionId: session.sessionId,
      data: `${text}\n`,
    });
    // Only a line that actually reached the host is running. One that never
    // left already said so in the scrollback, and marking it running would
    // leave the prompt spinning on nothing.
    if (sent) markRunning(chatId);
  }

  function submit(): void {
    const text = line;
    setLine('');
    setHistoryAt(null);
    runLine(text);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    /* v8 ignore next 2 -- same: no prompt without a session. */
    if (!session) return;
    if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      send({ type: 'patch.terminal.signal', sessionId: session.sessionId, signal: 'SIGINT' });
      appendLocal(chatId, '^C\n');
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
      return;
    }
    const history = session.history;
    if (e.key === 'ArrowUp') {
      if (history.length === 0) return;
      e.preventDefault();
      const next = historyAt === null ? history.length - 1 : Math.max(0, historyAt - 1);
      setHistoryAt(next);
      setLine(history[next] as string);
      return;
    }
    if (e.key === 'ArrowDown') {
      if (historyAt === null) return;
      e.preventDefault();
      const next = historyAt + 1;
      if (next >= history.length) {
        setHistoryAt(null);
        setLine('');
        return;
      }
      setHistoryAt(next);
      setLine(history[next] as string);
    }
  }

  const dead = session?.status === 'ended' || session?.status === 'error';
  const running = session?.running === true;

  return (
    <section className="terminal-pane" data-testid="terminal-pane" aria-label="Terminal">
      <header className="terminal-head">
        {/* The daemon's reported cwd wins over anything we asked for — on a
                new chat it is the only place the directory comes from. The
                header shows the TAIL of the path: truncating the other end hid
                the basename, the one part that says where you are (Tom,
                `patch/todo.md` — "terminal header cuts the end off the path,
                cut the front instead"). Full path on hover. */}
        <span className="terminal-cwd mono" title={session?.folder || folder}>
          {tailPath(session?.folder || folder)}
        </span>
      </header>
      <div className="terminal-scroll mono" data-testid="terminal-scroll" ref={scrollRef}>
        {(session?.chunks ?? []).map((c, i) => (
          <span key={i} className={`term-${c.stream}`}>
            {c.data}
          </span>
        ))}
      </div>
      {dead ? (
        <button
          type="button"
          className="terminal-restart"
          data-testid="terminal-restart"
          onClick={startShell}
        >
          Restart
        </button>
      ) : (
        <div
          className="terminal-prompt"
          data-testid="terminal-prompt-row"
          data-running={running ? 'true' : 'false'}
        >
          <span className="terminal-caret mono" aria-hidden>
            ❯
          </span>
          <input
            type="text"
            className="terminal-input mono"
            data-testid="terminal-input"
            aria-label="terminal command"
            spellCheck={false}
            autoComplete="off"
            autoFocus={focused}
            value={line}
            onChange={(e) => setLine(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {/* The one thing the shell cannot say for itself. The key is named
              because a command that reads stdin never ends on its own, and
              Ctrl-C is the only way back. */}
          {running ? (
            <span className="terminal-running mono" data-testid="terminal-running" role="status">
              <span className="terminal-running-dot" aria-hidden />
              ⌃C interrupts
            </span>
          ) : null}
        </div>
      )}
    </section>
  );
}
