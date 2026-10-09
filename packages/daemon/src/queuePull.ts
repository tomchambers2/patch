// Asking the server what is waiting for a chat (spec/04 § Message queueing).
//
// When the server runs a host's message queue, a message sent behind a running
// turn waits on the server. At a tool boundary the host asks for it here, so it
// reaches the agent before the turn ends. The answer comes back on the same
// link; if it does not come in time, or the link is down, the turn goes on
// without it and the server hands the message over when the chat goes idle.

import { randomUUID } from 'node:crypto';
import type { ChatInputEvent, PatchQueuePullResponseEvent, WireEvent } from '@patch/wire';

export const QUEUE_PULL_TIMEOUT_MS = 2_000;

export interface QueuePullClientOptions {
  emit: (event: WireEvent) => void;
  isLinkOnline: () => boolean;
  timeoutMs?: number;
}

export class QueuePullClient {
  private enabled = false;
  private readonly pending = new Map<string, (items: ChatInputEvent[]) => void>();

  constructor(private readonly opts: QueuePullClientOptions) {}

  /** The server said whether it is running this host's queues (`server.queue_mode`). */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** What is waiting for this chat on the server, oldest first. Empty when it cannot be asked. */
  async pull(chatId: string): Promise<ChatInputEvent[]> {
    if (!this.enabled || !this.opts.isLinkOnline()) return [];
    const requestId = randomUUID();
    return await new Promise<ChatInputEvent[]>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve([]);
      }, this.opts.timeoutMs ?? QUEUE_PULL_TIMEOUT_MS);
      timer.unref();
      this.pending.set(requestId, (items) => {
        clearTimeout(timer);
        resolve(items);
      });
      this.opts.emit({ type: 'patch.queue_pull.request', requestId, chatId });
    });
  }

  handleResponse(event: PatchQueuePullResponseEvent): void {
    const resolve = this.pending.get(event.requestId);
    if (!resolve) return;
    this.pending.delete(event.requestId);
    resolve(event.items);
  }
}
