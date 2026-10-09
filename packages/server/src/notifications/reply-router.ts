// Reply routing for special threads (group 11, spec/06 ## Reply routing).
//
// When a user-turn arrives on thread_speakers carrying a `source` block
// (voice-device transcript), we stash the source. When the agent emits its
// next assistant `chat.message` on that thread, we auto-forward to the
// originating channel:
//   - voice-device → notify { channel:'speakers', deviceId: source.deviceId }
//
// The mapping is per-chat single-slot: the latest inbound `source` wins;
// the router consumes-and-clears it on the first assistant reply. This is
// the simplest mechanism that handles the common case (one inbound → one
// reply). Multi-turn conversations pile up several inbound user turns
// before the agent replies; the latest source is the only one that
// matters because the reply is for the most-recent inbound channel.

import type { Logger } from 'pino';
import {
  SPECIAL_THREAD_IDS,
  type ChatInputSource,
  type ChatMessageEvent,
  type ChatInputEvent,
  type NotifyEvent,
  type WireEvent,
} from '@patch/wire';
import type { Registry } from '../registry.js';
import type { NotificationRouter } from './router.js';

const SPECIAL_THREAD_IDS_SET = new Set<string>([SPECIAL_THREAD_IDS.speakers]);

export interface ReplyRouterDeps {
  logger: Logger;
  registry: Registry;
  router: NotificationRouter;
}

export class ReplyRouter {
  /**
   * Latest source per chat, consumed on next assistant reply.
   *
   * Group 12 (MED-4): the `pending` map is the ONLY in-memory state. The
   * previous `consumed` Set was an unbounded leak — it kept every
   * (chatId, seq) we'd ever routed for the lifetime of the process. The
   * `pending.delete(chatId)` on consume already provides the once-only
   * guarantee for the realistic path (a second assistant message before a
   * new inbound finds nothing to route).
   */
  private readonly pending = new Map<string, ChatInputSource>();

  constructor(private readonly deps: ReplyRouterDeps) {}

  /** Observe a surface→host `chat.input` to capture source metadata. */
  observeInput(event: ChatInputEvent): void {
    if (!SPECIAL_THREAD_IDS_SET.has(event.chatId)) return;
    if (!event.source) return;
    this.pending.set(event.chatId, event.source);
  }

  /**
   * Observe a host→server event. When it's an assistant `chat.message` on
   * a special thread with a pending source, route the reply automatically.
   */
  async observeOutbound(event: WireEvent): Promise<void> {
    if (event.type !== 'chat.message') return;
    const msg = event as ChatMessageEvent;
    if (msg.role !== 'assistant') return;
    if (!SPECIAL_THREAD_IDS_SET.has(msg.chatId)) return;
    const source = this.pending.get(msg.chatId);
    if (!source) return;
    // Consume the source — next reply only routes if a new inbound arrives.
    // (Group 12 MED-4: this delete is the only once-only guard we need.)
    this.pending.delete(msg.chatId);

    try {
      if (source.kind === 'voice-device') {
        await this.routeVoiceDeviceReply(source, msg.content, msg.chatId);
      }
    } catch (err) {
      this.deps.logger.error(
        { err: (err as Error).message, chatId: msg.chatId, kind: source.kind },
        'reply routing failed',
      );
    }
  }

  private async routeVoiceDeviceReply(
    source: Extract<ChatInputSource, { kind: 'voice-device' }>,
    text: string,
    chatId: string,
  ): Promise<void> {
    const notify: NotifyEvent = {
      type: 'notify',
      chatId,
      channel: 'speakers',
      message: text,
      deviceId: source.deviceId,
    };
    await this.deps.router.route(notify);
    this.deps.logger.info(
      { deviceId: source.deviceId, len: text.length },
      'voice-device reply routed',
    );
  }
}
