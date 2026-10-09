// Voice reply bridge — the seam between a live audio session and the host's
// chat pipeline (spec/03 § Audio session, spec/07 § Voice reply).
//
// A voice session submits the transcribed utterance as a normal chat turn and
// then needs TWO things back:
//   1. the assistant's text AS IT STREAMS, so Kokoro can start speaking on the
//      first sentence boundary, and
//   2. the full reply once the turn settles, so the turn can be closed.
//
// Neither is a wire frame addressed to the session — both are read off the
// host's own outbound event stream. This module owns that read.
//
// ## Why a turn must be ARMED before it can settle
//
// The naive version of this (which shipped, and which A1-17 caught) resolved
// the waiter on the first `chat.state {activity:'idle'}` seen for the chat
// after the input was accepted. But `chat.state` is emitted for many reasons
// that have nothing to do with a turn finishing, and several of them fire
// while the chat is STILL IDLE, before the SDK query starts:
//
//   * `sendInput` clears a stale `statusSummary` and emits state (chatRunner
//     ~line 1595) — fires on every turn after the first,
//   * `runQuery` captures the chat's `preview` from the first user message and
//     emits state (chatRunner ~line 2062) — fires on the first turn.
//
// Either one resolved the reply promise instantly with an EMPTY buffer and
// deleted the streaming sink, so every subsequent assistant delta was dropped
// on the floor. The session then had no text to synthesise: zero
// `audio.tts_chunk` frames, no `audio.state: speaking`, and a bare
// `audio.tts_end` once `sendInput`'s await returned. Silent, total loss of the
// voice reply's down leg.
//
// The fix is to make a waiter TURN-SCOPED rather than chat-scoped: it only
// becomes eligible to settle once it has seen the chat actually go
// `running` (which is what `runQuery` sets immediately before it starts
// consuming SDK envelopes). Deltas and assistant messages are likewise only
// collected while armed, so a turn queued behind a running one can never be
// handed the previous turn's text.

import type { WireEvent } from '@patch/wire';

interface Waiter {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  onReplyText?: (chunk: string) => void;
  /**
   * The `localId` the turn was sent with. When set, the waiter is armed only by that
   * turn's own persisted user message (emitted as the turn starts), never by whichever
   * turn happens to be running on the chat when it was registered.
   */
  localId?: string;
  /** Set once the chat has been observed to enter `running` for this turn. */
  armed: boolean;
  /** Assistant messages collected since arming. */
  buf: string[];
}

export interface VoiceReplyBridge {
  /**
   * Feed EVERY outbound host wire event through here (call it from the
   * host's `emit`). Pure observation — never mutates or drops the event.
   */
  observe(event: WireEvent): void;
  /**
   * Register interest in the next turn to run on `chatId`. Resolves with the
   * assistant's full reply text when that turn settles; rejects if the turn
   * errors. `onReplyText` receives incremental assistant text while the turn
   * runs so the session can speak sentence-by-sentence.
   */
  awaitReply(
    chatId: string,
    onReplyText?: (chunk: string) => void,
    localId?: string,
  ): Promise<string>;
  /**
   * Drop the pending waiter for `chatId`, rejecting it with `err`. Used when
   * submitting the input itself throws — without this the session would wait
   * forever on a turn that never started.
   */
  abandon(chatId: string, err: Error): void;
  /** Number of outstanding waiters (test/diagnostic). */
  pendingCount(): number;
}

export function createVoiceReplyBridge(): VoiceReplyBridge {
  const waiters = new Map<string, Waiter>();

  function settleReject(chatId: string, err: Error): void {
    const w = waiters.get(chatId);
    if (!w) return;
    waiters.delete(chatId);
    w.reject(err);
  }

  return {
    observe(event: WireEvent): void {
      switch (event.type) {
        case 'chat.message_delta': {
          const w = waiters.get(event.chatId);
          // Only an armed waiter owns the turn currently producing text.
          if (w?.armed) w.onReplyText?.(event.delta);
          return;
        }
        case 'chat.message': {
          const w = waiters.get(event.chatId);
          if (!w) return;
          if (event.role === 'user') {
            // This turn's own message, written as the turn starts: everything from here is its.
            if (w.localId !== undefined && event.localId === w.localId) {
              w.armed = true;
              w.buf = [];
            }
            return;
          }
          if (event.role !== 'assistant' || !w.armed) return;
          // What the voice itself said into the chat while the agent worked is not the agent's answer.
          if (event.content.startsWith('[voice')) return;
          w.buf.push(event.content);
          return;
        }
        case 'chat.state': {
          const w = waiters.get(event.chatId);
          if (!w) return;
          if (event.activity === 'running') {
            // The turn has started. Everything from here belongs to it. A waiter that
            // knows its turn's localId waits for that turn's own message instead: the chat
            // can already be running some other turn when a hand-off is queued behind it.
            if (w.localId !== undefined) return;
            // Only the first: the host re-emits `running` through a turn (summaries, status),
            // and clearing here on each would throw away text the turn already produced.
            if (!w.armed) {
              w.armed = true;
              w.buf = [];
            }
            return;
          }
          if (event.activity === 'idle' && w.armed) {
            waiters.delete(event.chatId);
            w.resolve(w.buf.join('\n'));
          }
          return;
        }
        case 'chat.error': {
          // A turn can fail BEFORE it ever reaches `running` (OAuth gap, folder
          // preflight), so this deliberately does not require `armed` — the
          // voice session must hear about it either way, loudly.
          settleReject(event.chatId, new Error(event.error.message));
          return;
        }
        default:
          return;
      }
    },

    awaitReply(
      chatId: string,
      onReplyText?: (chunk: string) => void,
      localId?: string,
    ): Promise<string> {
      // One voice session per chat is the v1 contract. A second registration
      // means the first will never be settled by its own turn — fail it loudly
      // rather than leaving it hanging on a promise nothing resolves.
      settleReject(chatId, new Error(`voice reply superseded by a newer turn on chat ${chatId}`));
      return new Promise<string>((resolve, reject) => {
        waiters.set(chatId, {
          resolve,
          reject,
          ...(onReplyText ? { onReplyText } : {}),
          ...(localId !== undefined ? { localId } : {}),
          armed: false,
          buf: [],
        });
      });
    },

    abandon(chatId: string, err: Error): void {
      settleReject(chatId, err);
    },

    pendingCount(): number {
      return waiters.size;
    },
  };
}
