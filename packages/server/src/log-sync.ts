// Keeping the server's log of a chat and its host's log in step (spec/01 § Message
// log).
//
// A host says how far its own log of a chat reaches on every `chat.state`. Most
// of the time that is exactly where the server's log reaches. When it is not:
//
//   - the host is AHEAD: the server missed events (a link that dropped for longer
//     than the host's in-memory resend buffer holds). The server asks the host for
//     what follows its own high-water mark, and takes the answer as live events.
//   - the host is BEHIND: its log was lost, or another host ran the chat past it.
//     The server sends what the host lacks, so the host's local copy is rebuilt.
//
// A discrepancy is only acted on if it is still there a moment later, because a
// host numbers an event a beat before it sends it. A chat the server has never
// held any of is left alone: this keeps what it has seen, it does not copy every
// chat's whole history off every host the first time it connects.

import type { Logger } from 'pino';
import { REPLAY_BATCH_BYTES, type WireEvent } from '@patch/wire';
import type { ChatLogStore } from './chat-log-store.js';
import { isTranscriptEvent } from './chat-log-store.js';
import type { ChatRegistry } from './chat-registry.js';

export const LOG_SYNC_DELAY_MS = 2_000;
/** A restore the host has not shown up in its next report is sent again after this long. */
export const LOG_RESTORE_RETRY_MS = 60_000;
const SERVER_SURFACE = '_server';

export interface LogSyncDeps {
  store: Pick<ChatLogStore, 'highWater' | 'has' | 'read'>;
  chats: Pick<ChatRegistry, 'get'>;
  sendTo: (daemonId: string, surfaceId: string, event: WireEvent) => void;
  isOnline: (daemonId: string) => boolean;
  /** Put an event through the same path a host's own live event takes. */
  inject: (event: WireEvent) => void;
  logger: Pick<Logger, 'info' | 'warn'>;
  delayMs?: number;
  now?: () => number;
}

export class LogSync {
  private readonly reported = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Where a host's log reached when the server last asked it for more: not asked again until it grows. */
  private readonly askedAt = new Map<string, number>();
  private readonly restoredAt = new Map<string, { through: number; at: number }>();
  private readonly now: () => number;

  constructor(private readonly deps: LogSyncDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  observe(event: WireEvent): void {
    if (event.type === 'chat.state' && typeof event.lastSeq === 'number') {
      this.reported.set(event.chatId, event.lastSeq);
      this.schedule(event.chatId);
      return;
    }
    if (event.type === 'patch.log_sync.batch') {
      for (const inner of event.events) {
        // Only the transcript is kept by the server; the hub commits each and
        // broadcasts what is new.
        if (isTranscriptEvent(inner as WireEvent)) this.deps.inject(inner as WireEvent);
      }
      return;
    }
    if (event.type === 'daemon.offline') {
      for (const [chatId, timer] of this.timers) {
        if (this.deps.chats.get(chatId)?.daemonId !== event.daemonId) continue;
        clearTimeout(timer);
        this.timers.delete(chatId);
      }
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private schedule(chatId: string): void {
    if (this.timers.has(chatId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(chatId);
      this.check(chatId);
    }, this.deps.delayMs ?? LOG_SYNC_DELAY_MS);
    timer.unref();
    this.timers.set(chatId, timer);
  }

  private check(chatId: string): void {
    const hostLast = this.reported.get(chatId);
    if (hostLast === undefined || !this.deps.store.has(chatId)) return;
    const host = this.deps.chats.get(chatId)?.daemonId;
    if (host === undefined || !this.deps.isOnline(host)) return;
    const high = this.deps.store.highWater(chatId);
    if (hostLast > high) {
      if ((this.askedAt.get(chatId) ?? -1) >= hostLast) return;
      this.askedAt.set(chatId, hostLast);
      this.deps.logger.info(
        { chatId, hostLast, high },
        'log-sync: the host is ahead; asking for what the server missed',
      );
      this.deps.sendTo(host, SERVER_SURFACE, {
        type: 'patch.log_sync.request',
        chatId,
        afterSeq: high,
      });
      return;
    }
    if (hostLast < high) {
      const sent = this.restoredAt.get(chatId);
      if (sent && sent.through >= high && this.now() - sent.at < LOG_RESTORE_RETRY_MS) return;
      this.restoredAt.set(chatId, { through: high, at: this.now() });
      this.deps.logger.info(
        { chatId, hostLast, high },
        'log-sync: the host is behind; sending what it lacks',
      );
      this.restore(host, chatId, hostLast);
    }
  }

  private restore(host: string, chatId: string, afterSeq: number): void {
    const events = this.deps.store.read(chatId, afterSeq);
    const chunks: WireEvent[][] = [[]];
    let bytes = 0;
    for (const e of events) {
      const size = JSON.stringify(e).length;
      const open = chunks[chunks.length - 1]!;
      if (open.length > 0 && (open.length >= 200 || bytes + size > REPLAY_BATCH_BYTES)) {
        chunks.push([]);
        bytes = 0;
      }
      chunks[chunks.length - 1]!.push(e);
      bytes += size;
    }
    chunks.forEach((chunk, i) => {
      this.deps.sendTo(host, SERVER_SURFACE, {
        type: 'patch.log_restore',
        chatId,
        events: chunk,
        done: i === chunks.length - 1,
      });
    });
  }
}
