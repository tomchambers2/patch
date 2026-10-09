// The messages each chat is holding behind a running turn (spec/04 § Message
// queueing). The host announces them with `chat.queued` and releases them with
// `chat.dequeued`, both live-only, so a surface that connects or opens the chat
// afterwards would otherwise never learn what is still waiting. The server sees
// every one of those events on the way past, so it keeps the current queue and
// tells a surface about it when that surface asks for the chat's replay.

import type { ChatQueuedEvent, WireEvent } from '@patch/wire';
import type { ChatRegistry } from './chat-registry.js';

export class QueueTracker {
  private readonly queues = new Map<string, Map<string, ChatQueuedEvent>>();

  constructor(private readonly chats: Pick<ChatRegistry, 'get'>) {}

  observe(event: WireEvent): void {
    switch (event.type) {
      case 'chat.queued': {
        let queue = this.queues.get(event.chatId);
        if (!queue) {
          queue = new Map();
          this.queues.set(event.chatId, queue);
        }
        queue.set(event.localId, {
          type: 'chat.queued',
          chatId: event.chatId,
          localId: event.localId,
          message: event.message,
          queueSeq: event.queueSeq,
        });
        return;
      }
      case 'chat.dequeued':
        this.drop(event.chatId, event.localId);
        return;
      case 'chat.message':
        // The turn's own persisted message means it left the queue, whether or
        // not the dequeue frame was seen.
        if (event.role === 'user' && event.localId !== undefined) {
          this.drop(event.chatId, event.localId);
        }
        return;
      case 'chat.state':
        // A chat that is not running cannot be holding anything behind a turn.
        if (event.activity === 'idle') this.queues.delete(event.chatId);
        return;
      case 'daemon.offline':
        // The host's queue is gone with the host's process; it announces what
        // it still holds again when it comes back.
        for (const chatId of [...this.queues.keys()]) {
          if (this.chats.get(chatId)?.daemonId === event.daemonId) this.queues.delete(chatId);
        }
        return;
      default:
        return;
    }
  }

  /** The chat's waiting messages, in queue order, as the events that announced them. */
  snapshot(chatId: string): ChatQueuedEvent[] {
    const queue = this.queues.get(chatId);
    if (!queue) return [];
    return [...queue.values()].sort((a, b) => a.queueSeq - b.queueSeq);
  }

  private drop(chatId: string, localId: string): void {
    const queue = this.queues.get(chatId);
    if (!queue) return;
    queue.delete(localId);
    if (queue.size === 0) this.queues.delete(chatId);
  }
}
