// In-memory outbound event buffer used while the server-daemon WS link is
// down. Per spec/12-error-and-offline.md "Host → server disconnect":
// max 10k events per chat, drop oldest with a logged warn. Flush on reconnect.

import type { WireEvent } from '@patch/wire';

export const DEFAULT_BUFFER_PER_CHAT = 10_000;

export interface BufferDrop {
  chatId: string;
  droppedCount: number;
}

export class EventBuffer {
  private readonly perChat = new Map<string, WireEvent[]>();
  private readonly global: WireEvent[] = [];
  private readonly maxPerChat: number;
  private readonly maxGlobal: number;
  private readonly onDrop?: (drop: BufferDrop) => void;

  constructor(
    opts: {
      maxPerChat?: number;
      maxGlobal?: number;
      onDrop?: (drop: BufferDrop) => void;
    } = {},
  ) {
    this.maxPerChat = opts.maxPerChat ?? DEFAULT_BUFFER_PER_CHAT;
    this.maxGlobal = opts.maxGlobal ?? DEFAULT_BUFFER_PER_CHAT;
    if (opts.onDrop) this.onDrop = opts.onDrop;
  }

  push(event: WireEvent): void {
    const chatId = (event as { chatId?: unknown }).chatId;
    if (typeof chatId === 'string' && chatId.length > 0) {
      let arr = this.perChat.get(chatId);
      if (!arr) {
        arr = [];
        this.perChat.set(chatId, arr);
      }
      arr.push(event);
      if (arr.length > this.maxPerChat) {
        const dropped = arr.length - this.maxPerChat;
        arr.splice(0, dropped);
        this.onDrop?.({ chatId, droppedCount: dropped });
      }
    } else {
      this.global.push(event);
      if (this.global.length > this.maxGlobal) {
        this.global.splice(0, this.global.length - this.maxGlobal);
      }
    }
  }

  /** Drains every queued event in a stable order: global first, then per-chat in insertion order. */
  drain(): WireEvent[] {
    const out: WireEvent[] = [];
    out.push(...this.global);
    this.global.length = 0;
    for (const arr of this.perChat.values()) {
      out.push(...arr);
      arr.length = 0;
    }
    return out;
  }

  size(): number {
    let n = this.global.length;
    for (const arr of this.perChat.values()) n += arr.length;
    return n;
  }
}
