// The server-run message queue (spec/04 § Message queueing).
//
// A message that arrives while a chat is mid-turn is held HERE, not on the
// host. The server decides when each one reaches the agent:
//
//   - at a tool boundary: the host asks (`patch.queue_pull.request`) after a
//     batch of tool calls and takes whatever is waiting, in order;
//   - when the chat goes idle: the server hands over the next message itself.
//
// So a queue survives a host restart or a host being offline, because it lives
// in `<dataDir>/server-queue.json`, and every surface sees one queue.
//
// It only takes a message when it can decide for it: the mode is on, the host
// is online and says it takes queued messages from the server, and the chat is
// busy. Anything else goes straight to the host as before, which keeps its own
// queue for the messages it starts itself (a goal resubmit, a self-wake).

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'pino';
import type { ChatInputEvent, WireEvent } from '@patch/wire';
import type { ChatRegistry } from './chat-registry.js';

/** A release the host never started on is not waited on for ever. */
export const RELEASE_GUARD_MS = 10_000;

interface QueueItem {
  localId: string;
  event: ChatInputEvent;
  queueSeq: number;
  surfaceId: string;
}

interface Persisted {
  queues: Record<string, QueueItem[]>;
  seq: Record<string, number>;
}

export interface ServerQueueDeps {
  chats: Pick<ChatRegistry, 'get'>;
  /** Send a frame to one host (buffered by the link while it is offline). */
  sendTo: (daemonId: string, surfaceId: string, event: WireEvent) => void;
  isOnline: (daemonId: string) => boolean;
  /** Does this host take queued messages from the server? */
  hostSupports: (daemonId: string) => boolean;
  /** Put a frame through the same pipeline a host's own frame takes, so surfaces and observers see it. */
  inject: (event: WireEvent) => void;
  dataDir?: string;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => number;
}

export class ServerQueue {
  private queues = new Map<string, QueueItem[]>();
  private seqs = new Map<string, number>();
  /** Chats whose next message was just handed to the host; it has not reported `running` yet. */
  private readonly releasing = new Map<string, number>();
  private readonly path: string | null;
  private readonly now: () => number;

  constructor(private readonly deps: ServerQueueDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.path = deps.dataDir ? join(deps.dataDir, 'server-queue.json') : null;
    this.load();
  }

  /** Announce what was restored from disk, so observers and later surfaces know about it. */
  restore(): void {
    for (const [chatId, items] of this.queues) {
      for (const item of items) this.announce(chatId, item);
    }
  }

  /** True when this chat has messages waiting in the server queue. */
  hasWaiting(chatId: string): boolean {
    return (this.queues.get(chatId)?.length ?? 0) > 0;
  }

  /**
   * A surface sent a message. Returns true when the server took it into the
   * queue (and acknowledged it); false when it should go to the host as usual.
   */
  enqueueIfBusy(surfaceId: string, event: ChatInputEvent): boolean {
    if (event.branchId !== undefined || event.source !== undefined) return false;
    const chat = this.deps.chats.get(event.chatId);
    if (!chat) return false;
    const host = chat.daemonId;
    if (!this.deps.isOnline(host) || !this.deps.hostSupports(host)) return false;
    const existing = this.queues.get(event.chatId)?.find((i) => i.localId === event.localId);
    if (existing) {
      // A redelivery from a surface that did not see the acknowledgement.
      this.ack(surfaceId, event);
      return true;
    }
    if (!this.busy(event.chatId, chat.activity) && !this.hasWaiting(event.chatId)) return false;
    const queueSeq = (this.seqs.get(event.chatId) ?? 0) + 1;
    this.seqs.set(event.chatId, queueSeq);
    const item: QueueItem = { localId: event.localId, event, queueSeq, surfaceId };
    const items = this.queues.get(event.chatId) ?? [];
    items.push(item);
    this.queues.set(event.chatId, items);
    this.save();
    this.ack(surfaceId, event);
    this.announce(event.chatId, item);
    return true;
  }

  /** The hub handed a message straight to an idle host: the next one must queue behind it. */
  noteForwarded(chatId: string): void {
    if (!this.deps.chats.get(chatId)) return;
    this.releasing.set(chatId, this.now());
  }

  /**
   * Look at a frame from a host before anything else does. Returns the frame
   * to pass on: the same one, or `null` to drop it.
   *
   * A chat that goes idle while it still has messages waiting is not finished,
   * so the idle report becomes `running` (surfaces, the completion push and the
   * sweep all read idle as "done") and the next message is released.
   */
  gate(event: WireEvent, fromDaemonId: string | null): WireEvent | null {
    if (event.type === 'daemon.offline') {
      for (const [chatId] of this.releasing) {
        if (this.deps.chats.get(chatId)?.daemonId === event.daemonId) this.releasing.delete(chatId);
      }
      return event;
    }
    if (event.type !== 'chat.state') return event;
    const chatId = event.chatId;
    if (event.status !== undefined && event.status !== 'active') {
      this.clear(chatId);
      return event;
    }
    if (event.activity === 'running') {
      this.releasing.delete(chatId);
      return event;
    }
    if (event.activity !== 'idle' || !this.hasWaiting(chatId)) return event;
    // Defer the release: this frame has not been seen by the registry yet, and
    // the release looks the chat's host up.
    const host = fromDaemonId ?? this.deps.chats.get(chatId)?.daemonId ?? null;
    queueMicrotask(() => this.release(chatId, host));
    return { ...event, activity: 'running' };
  }

  /** The host asked, at a tool boundary: everything waiting for this chat, oldest first. */
  pull(chatId: string): ChatInputEvent[] {
    const items = this.queues.get(chatId);
    if (!items || items.length === 0) return [];
    this.queues.delete(chatId);
    this.save();
    return items.map((i) => i.event);
  }

  /** A surface cancelled a waiting message. True when it was ours. */
  unqueue(chatId: string, localId: string): boolean {
    const items = this.queues.get(chatId);
    const at = items?.findIndex((i) => i.localId === localId) ?? -1;
    if (!items || at < 0) return false;
    items.splice(at, 1);
    if (items.length === 0) this.queues.delete(chatId);
    this.save();
    this.deps.inject({ type: 'chat.dequeued', chatId, localId, reason: 'cancelled' });
    return true;
  }

  /** A surface edited a waiting message. True when it was ours. */
  edit(chatId: string, localId: string, message: string): boolean {
    const item = this.queues.get(chatId)?.find((i) => i.localId === localId);
    if (!item) return false;
    if (message.trim() === '' && (item.event.attachments?.length ?? 0) === 0) {
      return this.unqueue(chatId, localId);
    }
    item.event = { ...item.event, message };
    this.save();
    this.announce(chatId, item);
    return true;
  }

  /**
   * A surface pressed send now on a waiting message. True when it was ours.
   * The running turn is stopped; when the chat goes idle the queue drains in
   * order, so nothing is reordered.
   */
  promote(chatId: string, localId: string, surfaceId: string): boolean {
    const items = this.queues.get(chatId);
    if (!items?.some((i) => i.localId === localId)) return false;
    const host = this.deps.chats.get(chatId)?.daemonId;
    if (host !== undefined)
      this.deps.sendTo(host, surfaceId, { type: 'chat.stop_request', chatId });
    return true;
  }

  private busy(chatId: string, activity: string | undefined): boolean {
    if (activity === 'running' || activity === 'awaiting-permission') return true;
    const since = this.releasing.get(chatId);
    if (since === undefined) return false;
    if (this.now() - since > RELEASE_GUARD_MS) {
      this.releasing.delete(chatId);
      return false;
    }
    return true;
  }

  private release(chatId: string, hostHint: string | null): void {
    const items = this.queues.get(chatId);
    const item = items?.[0];
    if (!items || !item) return;
    const host = hostHint;
    if (host === null || !this.deps.isOnline(host)) {
      // Nothing is lost: it stays queued and goes when the chat next reports idle.
      this.deps.logger.warn({ chatId }, 'server-queue: host not reachable; message stays queued');
      return;
    }
    items.shift();
    if (items.length === 0) this.queues.delete(chatId);
    this.save();
    this.releasing.set(chatId, this.now());
    this.deps.inject({ type: 'chat.dequeued', chatId, localId: item.localId, reason: 'running' });
    this.deps.sendTo(host, item.surfaceId, item.event);
  }

  private clear(chatId: string): void {
    const items = this.queues.get(chatId);
    if (!items) return;
    this.queues.delete(chatId);
    this.save();
    for (const item of items) {
      this.deps.inject({
        type: 'chat.dequeued',
        chatId,
        localId: item.localId,
        reason: 'cancelled',
      });
    }
  }

  private ack(surfaceId: string, event: ChatInputEvent): void {
    this.deps.inject({
      type: 'chat.input_ack',
      chatId: event.chatId,
      localId: event.localId,
      forSurfaceId: surfaceId,
    });
  }

  private announce(chatId: string, item: QueueItem): void {
    this.deps.inject({
      type: 'chat.queued',
      chatId,
      localId: item.localId,
      message: item.event.message,
      queueSeq: item.queueSeq,
    });
  }

  private load(): void {
    if (this.path === null || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Persisted;
      this.queues = new Map(Object.entries(parsed.queues ?? {}));
      this.seqs = new Map(Object.entries(parsed.seq ?? {}));
    } catch (err) {
      // NO FALLBACK: say so, then start empty rather than guess at a damaged file.
      this.deps.logger.warn({ err }, 'server-queue: could not read the queue; starting empty');
    }
  }

  private save(): void {
    if (this.path === null) return;
    const data: Persisted = {
      queues: Object.fromEntries(this.queues),
      seq: Object.fromEntries(this.seqs),
    };
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, this.path);
    } catch (err) {
      this.deps.logger.warn({ err }, 'server-queue: could not write the queue');
    }
  }
}
