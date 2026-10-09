// Agent-notification log (spec/09 § bell). Every notification an agent sent,
// with read state, persisted at `<dataDir>/notifications.json`.
//
// A secondary, re-derivable store: it must never take the server down. Writes
// are atomic (temp + rename) and a corrupt file is logged loudly and read as
// empty rather than thrown on.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';
import { ulid } from 'ulid';
import { z } from 'zod';

/** Newest entries kept (spec/09 § bell — Retention). */
export const NOTIFICATION_LOG_CAP = 200;

const Entry = z
  .object({
    id: z.string().min(1),
    chatId: z.string().min(1),
    message: z.string(),
    importance: z.enum(['silent', 'normal', 'urgent']),
    deepLink: z.string().optional(),
    sentAt: z.number(),
    readAt: z.number().nullable(),
  })
  .strict();
export type NotificationEntry = z.infer<typeof Entry>;

export interface NotificationSnapshot {
  items: NotificationEntry[];
  unread: number;
}

export interface NotificationLogOpts {
  dataDir?: string;
  logger: Logger;
  nowMs?: () => number;
  onChange?: (snapshot: NotificationSnapshot) => void;
}

export class NotificationLog {
  private items: NotificationEntry[] = [];
  private readonly path: string | null;
  private readonly opts: NotificationLogOpts;

  constructor(opts: NotificationLogOpts) {
    this.opts = opts;
    this.path = opts.dataDir ? join(opts.dataDir, 'notifications.json') : null;
    this.load();
  }

  private load(): void {
    if (!this.path || !existsSync(this.path)) return;
    try {
      this.items = z.array(Entry).parse(JSON.parse(readFileSync(this.path, 'utf8')));
    } catch (err) {
      this.opts.logger.error(
        { err: (err as Error).message, path: this.path },
        'notifications.json unreadable — starting with an empty notification log',
      );
      this.items = [];
    }
  }

  private save(): void {
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.items), 'utf8');
      renameSync(tmp, this.path);
    } catch (err) {
      this.opts.logger.error({ err: (err as Error).message }, 'failed to write notifications.json');
    }
  }

  snapshot(): NotificationSnapshot {
    const items = [...this.items].reverse();
    return { items, unread: items.filter((i) => i.readAt === null).length };
  }

  add(entry: Omit<NotificationEntry, 'id' | 'sentAt' | 'readAt'>): NotificationEntry {
    const full: NotificationEntry = {
      ...entry,
      id: ulid(),
      sentAt: this.opts.nowMs ? this.opts.nowMs() : Date.now(),
      readAt: null,
    };
    this.items.push(full);
    if (this.items.length > NOTIFICATION_LOG_CAP) {
      // Drop the oldest read entry first; only if all are unread, the oldest.
      const idx = this.items.findIndex((i) => i.readAt !== null);
      this.items.splice(idx === -1 ? 0 : idx, 1);
    }
    this.changed();
    return full;
  }

  markRead(target: { ids: string[] } | { all: true }): void {
    const now = this.opts.nowMs ? this.opts.nowMs() : Date.now();
    const ids = 'ids' in target ? new Set(target.ids) : null;
    let touched = false;
    for (const i of this.items) {
      if (i.readAt === null && (ids === null || ids.has(i.id))) {
        i.readAt = now;
        touched = true;
      }
    }
    if (touched) this.changed();
  }

  private changed(): void {
    this.save();
    this.opts.onChange?.(this.snapshot());
  }
}
