// spec/07 § Keeping voice and text as one conversation / § Call cost — the
// glue between open voice sessions and the chats they are on:
//
//   - the timeline a fast voice writes its exchanges into,
//   - what lands in a chat with an open call going into that call's context,
//   - costing a call when it ends.

import type { Logger } from 'pino';
import type { WireEvent } from '@patch/wire';
import type { SessionInit } from './session.js';
import type { VoiceSessionLike, VoiceTimeline } from './voice-session-like.js';
import { callSummaryLine, costCall, type EngineCosting } from './voiceCost.js';
import type { VoiceLedger } from './voiceLedger.js';

/** What the glue needs from the chat host. */
export interface ChatVoiceDaemon {
  recordVoiceMessage(req: {
    chatId: string;
    role: 'user' | 'assistant';
    content: string;
    seq?: number;
  }): number;
  reserveVoiceSeq(chatId: string): number;
  emitVoiceDelta(chatId: string, messageSeq: number, delta: string): void;
  recordCallSummary(chatId: string, line: string): void;
}

export interface ChatVoice {
  makeTimeline(init: SessionInit): VoiceTimeline;
  /** Feed every outbound wire event through here. */
  observe(event: WireEvent): void;
  callEnded(info: {
    init: SessionInit;
    chatId: string;
    startedAt: number;
    endedAt: number;
    engine: EngineCosting;
  }): void;
}

const stripTag = (text: string): string => text.replace(/^\[voice[^\]]*\]\s*/, '');

export function createChatVoice(deps: {
  daemon: ChatVoiceDaemon;
  /** The open sessions on a chat; empty before the audio server is up. */
  sessionsOnChat: (chatId: string) => VoiceSessionLike[];
  ledger: VoiceLedger;
  logger: Logger;
  /** A call was costed: the host's totals changed. */
  onCosted: () => void;
}): ChatVoice {
  const { daemon, logger } = deps;
  // Set while a call writes its own exchange into the chat, so that write is
  // not echoed back into the same call as "something from elsewhere".
  let writing = false;
  const asVoice = (fn: () => void): void => {
    writing = true;
    try {
      fn();
    } finally {
      writing = false;
    }
  };

  /**
   * Cost a call and leave its one line in the chat. Only the voice engine is
   * costed: the agent turns a hand-off runs are the chat's own and are not a
   * call's expense, so there is nothing to wait for and the line lands at hang-up.
   */
  function cost(info: Parameters<ChatVoice['callEnded']>[0]): void {
    const { init, chatId, startedAt, endedAt, engine } = info;
    const costing = costCall({
      sessionId: init.sessionId,
      chatId,
      surfaceKind: init.surfaceKind,
      startedAt,
      endedAt,
      engine,
    });
    deps.ledger.record(costing);
    logger.info({ costing }, 'voice: call costed');
    try {
      daemon.recordCallSummary(chatId, callSummaryLine(costing));
    } catch (err) {
      logger.error(
        { chatId, err: (err as Error).message },
        'voice: could not write the call summary into the chat',
      );
    }
    deps.onCosted();
  }

  return {
    makeTimeline(init) {
      const tag =
        init.surfaceKind === 'device'
          ? `[voice • device:${init.deviceId ?? 'unknown'}] `
          : `[voice • ${init.surfaceKind}] `;
      // A timeline write runs inside a provider socket's message handler, so a
      // failure is logged loudly here rather than thrown into the socket.
      const guard = (what: string, chatId: string, fn: () => void): void => {
        try {
          fn();
        } catch (err) {
          logger.error(
            { sessionId: init.sessionId, chatId, err: (err as Error).message },
            `voice: could not write ${what} into the chat`,
          );
        }
      };
      return {
        userSaid(chatId, text) {
          guard('the spoken words', chatId, () =>
            asVoice(() =>
              daemon.recordVoiceMessage({ chatId, role: 'user', content: `${tag}${text}` }),
            ),
          );
        },
        beginReply(chatId) {
          let seq: number | undefined;
          let text = '';
          return {
            append(delta) {
              guard('the spoken reply', chatId, () => {
                seq ??= daemon.reserveVoiceSeq(chatId);
                text += delta;
                daemon.emitVoiceDelta(chatId, seq, delta);
              });
            },
            finish() {
              if (seq === undefined || text.trim() === '') return;
              const at = seq;
              guard('the spoken reply', chatId, () =>
                asVoice(() =>
                  daemon.recordVoiceMessage({
                    chatId,
                    role: 'assistant',
                    // Tagged like the user's words, so every surface can mark it as spoken.
                    content: `${tag}${text.trim()}`,
                    seq: at,
                  }),
                ),
              );
            },
          };
        },
      };
    },

    observe(event) {
      if (writing || event.type !== 'chat.message') return;
      if (event.role !== 'user' && event.role !== 'assistant') return;
      // A hand-off's own request is the fast voice's words, not news to it.
      if (event.role === 'user' && event.content.startsWith('[voice hand-off')) return;
      for (const session of deps.sessionsOnChat(event.chatId)) {
        // The answer to a hand-off reaches the fast voice from the session itself.
        if (event.role === 'assistant' && session.isAwaitingHandoff()) continue;
        session.pushContext(event.role, stripTag(event.content));
      }
    },

    callEnded(info) {
      cost(info);
    },
  };
}
