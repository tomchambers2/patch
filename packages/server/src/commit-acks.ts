// Telling a host how far the server's log of a chat reaches (`chat.committed`).
//
// Sent a moment after events are committed, one frame per chat however many
// events landed, so a burst of tool calls is one acknowledgement and never a
// write the turn waits on.

import type { WireEvent } from '@patch/wire';

export const COMMIT_ACK_DELAY_MS = 100;
const SERVER_SURFACE = '_server';

export interface CommitAcksDeps {
  sendTo: (daemonId: string, surfaceId: string, event: WireEvent) => void;
  isOnline: (daemonId: string) => boolean;
  delayMs?: number;
}

export class CommitAcks {
  private readonly pending = new Map<string, { daemonId: string; through: number }>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: CommitAcksDeps) {}

  /** The server committed `seq` for this chat, which lives on `daemonId`. */
  note(chatId: string, daemonId: string, seq: number): void {
    const held = this.pending.get(chatId);
    if (held) {
      held.daemonId = daemonId;
      if (seq > held.through) held.through = seq;
    } else {
      this.pending.set(chatId, { daemonId, through: seq });
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.send(), this.deps.delayMs ?? COMMIT_ACK_DELAY_MS);
      this.timer.unref();
    }
  }

  /** Send what is waiting now. */
  send(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = [...this.pending.entries()];
    this.pending.clear();
    for (const [chatId, { daemonId, through }] of batch) {
      // A host that is gone is told by `patch.log_sync` when it returns.
      if (!this.deps.isOnline(daemonId)) continue;
      this.deps.sendTo(daemonId, SERVER_SURFACE, { type: 'chat.committed', chatId, through });
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}
