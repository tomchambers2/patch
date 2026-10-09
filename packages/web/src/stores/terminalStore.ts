// terminalStore — the chat terminal drawer (spec/14 § Terminal).
//
// A shell on the HOST, one session per chat. The store owns the session
// id, the scrollback, the command history and the session's lifecycle status;
// the panel is a pure view over it. Sessions outlive the drawer being closed
// (closing hides, it does not kill) and outlive navigating between chats, so
// coming back to a chat shows the same scrollback.
//
// It also tracks whether a command is still running. The host's shell is a
// pipe with no prompt and no echo, so the only thing that says a command
// finished is the `command-exit` frame; without it a command that printed
// nothing (`cd`) and a session wedged by something reading stdin look exactly
// the same.
//
// NO FALLBACK: a host-side failure (folder missing, unknown session) is kept
// as an error CHUNK in the scrollback and an `error` status — never swallowed
// into a silently dead prompt.

import { create } from 'zustand';
import type { WireEvent } from '@patch/wire';

export type TerminalStatus = 'starting' | 'live' | 'ended' | 'error';

export interface TerminalChunk {
  stream: 'stdout' | 'stderr' | 'meta';
  data: string;
}

export interface TerminalSession {
  sessionId: string;
  chatId: string;
  folder: string;
  status: TerminalStatus;
  /** Scrollback, oldest first. Capped so a long-lived session can't grow forever. */
  chunks: TerminalChunk[];
  /** Commands submitted this session, oldest first (↑/↓ walk this). */
  history: string[];
  /**
   * A command has been sent and has not reported back. Set on send, cleared by
   * `command-exit` — and by anything that ends the session, since a dead shell
   * will never report the command it was running.
   */
  running: boolean;
}

/** Scrollback cap — chunks beyond this are dropped from the FRONT. */
export const MAX_CHUNKS = 2000;

/**
 * Something to put into a chat's terminal as soon as its shell is live: a
 * command to run exactly as if it had been typed, or a plain note to print.
 *
 * It has to be queued rather than written straight in, because the thing that
 * raises it (a click on the background task bar) is normally what OPENS the
 * terminal — at that moment there is no session, so an immediate write would
 * be dropped on the floor. A note is carried alongside a command and not
 * folded into one, since the no-usable-id case must still say so and must NOT
 * run anything.
 */
export interface TerminalPending {
  kind: 'command' | 'note';
  text: string;
}

interface TerminalState {
  /** Sessions by chatId. */
  sessions: Record<string, TerminalSession>;
  /** Sessions by sessionId → chatId, for routing inbound host frames. */
  bySessionId: Record<string, string>;
  /** At most one queued command/note per chat, waiting for a live session. */
  pending: Record<string, TerminalPending>;
  /** Register a session the caller is about to open on the wire. */
  startSession(chatId: string, folder: string, sessionId: string): void;
  /** Record a submitted command line in the session's history. */
  recordCommand(chatId: string, line: string): void;
  /** Mark this chat's session as waiting on a command it has just sent. */
  markRunning(chatId: string): void;
  /** Append a locally-generated line (e.g. the echoed prompt, a send failure). */
  appendLocal(chatId: string, data: string, stream?: TerminalChunk['stream']): void;
  /**
   * Queue something for this chat's terminal to do once its shell is live.
   * One entry per chat: a second click replaces the first, so the terminal
   * shows what was asked for LAST rather than replaying a backlog.
   */
  queuePending(chatId: string, entry: TerminalPending): void;
  /**
   * Take this chat's queued entry and clear it in the same synchronous step,
   * so a re-render (or React's double-invoked effects) can never run it twice.
   */
  takePending(chatId: string): TerminalPending | null;
  /** Feed a host → surface terminal frame in. Unknown sessions are ignored. */
  ingest(event: WireEvent): void;
  _reset(): void;
}

function appendChunk(session: TerminalSession, chunk: TerminalChunk): TerminalSession {
  const chunks = [...session.chunks, chunk];
  return { ...session, chunks: chunks.length > MAX_CHUNKS ? chunks.slice(-MAX_CHUNKS) : chunks };
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: {},
  bySessionId: {},
  pending: {},

  startSession: (chatId, folder, sessionId) =>
    set((s) => ({
      sessions: {
        ...s.sessions,
        [chatId]: {
          sessionId,
          chatId,
          folder,
          status: 'starting',
          // A restart keeps the previous scrollback so the user doesn't lose
          // what the last session printed.
          chunks: s.sessions[chatId]?.chunks ?? [],
          history: s.sessions[chatId]?.history ?? [],
          // A new shell is running nothing, whatever the old one was stuck on.
          running: false,
        },
      },
      bySessionId: { ...s.bySessionId, [sessionId]: chatId },
    })),

  recordCommand: (chatId, line) =>
    set((s) => {
      const session = s.sessions[chatId];
      if (!session) return s;
      return {
        sessions: { ...s.sessions, [chatId]: { ...session, history: [...session.history, line] } },
      };
    }),

  markRunning: (chatId) =>
    set((s) => {
      const session = s.sessions[chatId];
      /* v8 ignore next -- only ever called straight after a send on a session that exists. */
      if (!session) return s;
      return { sessions: { ...s.sessions, [chatId]: { ...session, running: true } } };
    }),

  appendLocal: (chatId, data, stream = 'meta') =>
    set((s) => {
      const session = s.sessions[chatId];
      if (!session) return s;
      return { sessions: { ...s.sessions, [chatId]: appendChunk(session, { stream, data }) } };
    }),

  queuePending: (chatId, entry) => set((s) => ({ pending: { ...s.pending, [chatId]: entry } })),

  takePending: (chatId) => {
    const entry = get().pending[chatId];
    if (entry === undefined) return null;
    set((s) => {
      const next = { ...s.pending };
      delete next[chatId];
      return { pending: next };
    });
    return entry;
  },

  ingest: (event) => {
    if (
      event.type !== 'patch.terminal.ready' &&
      event.type !== 'patch.terminal.output' &&
      event.type !== 'patch.terminal.command-exit' &&
      event.type !== 'patch.terminal.exit' &&
      event.type !== 'patch.terminal.error'
    ) {
      return;
    }
    const chatId = get().bySessionId[event.sessionId];
    // A frame for a session this surface doesn't know about (e.g. a reload
    // dropped the mapping). Nothing to render it into.
    if (chatId === undefined) return;
    set((s) => {
      const session = s.sessions[chatId];
      /* v8 ignore next -- bySessionId and sessions are written together, so a mapped session always exists. */
      if (!session) return s;
      let next: TerminalSession;
      switch (event.type) {
        case 'patch.terminal.ready':
          next = { ...session, status: 'live', folder: event.cwd };
          break;
        case 'patch.terminal.output':
          next = appendChunk(session, { stream: event.stream, data: event.data });
          break;
        case 'patch.terminal.command-exit':
          // A clean run adds no line: the prompt going quiet is what says it
          // finished, and a `done` after every `ls` is noise. A FAILURE has to
          // be said out loud — a pipe shell has no `$?` to check afterwards.
          next = {
            ...(event.code === 0
              ? session
              : appendChunk(session, { stream: 'meta', data: `exit ${event.code}\n` })),
            running: false,
          };
          break;
        case 'patch.terminal.exit':
          next = {
            ...appendChunk(session, {
              stream: 'meta',
              data: `\n[session ended: ${event.reason}${
                event.code === null ? '' : ` (exit ${event.code})`
              }]\n`,
            }),
            status: 'ended',
            // The shell is gone, so whatever it was running will never report.
            running: false,
          };
          break;
        case 'patch.terminal.error':
          next = {
            ...appendChunk(session, {
              stream: 'meta',
              data: `\n[error: ${event.message}]\n`,
            }),
            status: 'error',
            running: false,
          };
          break;
      }
      return { sessions: { ...s.sessions, [chatId]: next } };
    });
  },

  _reset: () => set({ sessions: {}, bySessionId: {}, pending: {} }),
}));
