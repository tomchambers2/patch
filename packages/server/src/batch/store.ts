// Batch store (spec/14 § Batch mode) — one account-wide batch, persisted at
// `<dataDir>/batch.json`. The server owns this, not a browser: notification
// suppression (spec/09 § Chat completion) and the check-in decision both need
// to work whether or not a surface is even open, and a batch spans hosts, so
// no single host can be the source of truth either.
//
// This file is pure bookkeeping (persistence + membership + opened-tracking).
// Deciding WHEN to check in or end — which needs live chat activity — is
// `BatchNotifier` (`notifier.ts`), which calls back into this store.
//
// NO FALLBACK: a corrupt file resets to "no batch running", a legitimate
// first-run state, rather than a half-parsed record silently misbehaving.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { Logger } from 'pino';
import { ulid } from 'ulid';

export const BatchCheckInChoice = z.union([
  z
    .object({
      type: z.literal('time'),
      minutes: z.union([z.literal(15), z.literal(20), z.literal(30)]),
    })
    .strict(),
  z.object({ type: z.literal('all-done') }).strict(),
]);
export type BatchCheckInChoice = z.infer<typeof BatchCheckInChoice>;

/** `When all done` is capped at this many minutes regardless (spec/14 § Batch mode). */
export const BATCH_ALL_DONE_CAP_MIN = 30;

const BatchRecordSchema = z
  .object({
    id: z.string().min(1),
    startedAt: z.number(),
    checkIn: BatchCheckInChoice,
    checkInAt: z.number(),
    members: z.array(z.string()),
    checkedIn: z.boolean(),
    openedMemberIds: z.array(z.string()),
  })
  .strict();
export type BatchRecord = z.infer<typeof BatchRecordSchema>;

const StoredBatch = z
  .object({
    batch: BatchRecordSchema.nullable(),
    carryover: z.array(z.string()),
  })
  .strict();

export interface BatchSnapshot {
  batch: BatchRecord | null;
  carryover: string[];
}

export class BatchStore {
  private readonly path: string | null;
  private readonly logger: Pick<Logger, 'warn'> | undefined;
  private readonly nowMs: () => number;
  private readonly idGenerator: () => string;
  private batch: BatchRecord | null;
  private carryover: string[];

  constructor(opts: {
    dataDir?: string;
    logger?: Pick<Logger, 'warn'>;
    nowMs?: () => number;
    idGenerator?: () => string;
  }) {
    this.path = opts.dataDir ? join(opts.dataDir, 'batch.json') : null;
    this.logger = opts.logger;
    this.nowMs = opts.nowMs ?? ((): number => Date.now());
    this.idGenerator = opts.idGenerator ?? ((): string => ulid());
    const loaded = this.load();
    this.batch = loaded.batch;
    this.carryover = loaded.carryover;
  }

  private load(): BatchSnapshot {
    if (!this.path || !existsSync(this.path)) return { batch: null, carryover: [] };
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (err) {
      this.logger?.warn(
        { path: this.path, err: (err as Error).message },
        'batch: unreadable file; starting with no batch',
      );
      return { batch: null, carryover: [] };
    }
    const parsed = StoredBatch.safeParse(raw);
    if (!parsed.success) {
      this.logger?.warn(
        { path: this.path, err: parsed.error.message },
        'batch: invalid file; starting with no batch',
      );
      return { batch: null, carryover: [] };
    }
    return parsed.data;
  }

  private persist(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const snapshot: BatchSnapshot = { batch: this.batch, carryover: this.carryover };
    writeFileSync(this.path, JSON.stringify(snapshot, null, 2), 'utf8');
  }

  current(): BatchRecord | null {
    return this.batch;
  }

  carryoverMembers(): string[] {
    return [...this.carryover];
  }

  /** Whether `chatId` is a member of the currently-running batch (spec/09 § Chat completion). */
  isSuppressedMember(chatId: string): boolean {
    return this.batch !== null && this.batch.members.includes(chatId);
  }

  private checkInAtFor(checkIn: BatchCheckInChoice, startedAt: number): number {
    const minutes = checkIn.type === 'time' ? checkIn.minutes : BATCH_ALL_DONE_CAP_MIN;
    return startedAt + minutes * 60_000;
  }

  /**
   * Start a batch with `checkIn`, pre-populated with whatever rolled over from
   * the last one that ended (spec/14 § Batch mode — "members still running
   * roll into the next batch"). A no-op, returning the existing record, if a
   * batch is already running — the UI only offers Start when there is none.
   */
  start(checkIn: BatchCheckInChoice): BatchRecord {
    if (this.batch) return this.batch;
    const startedAt = this.nowMs();
    this.batch = {
      id: this.idGenerator(),
      startedAt,
      checkIn,
      checkInAt: this.checkInAtFor(checkIn, startedAt),
      members: this.carryover,
      checkedIn: false,
      openedMemberIds: [],
    };
    this.carryover = [];
    this.persist();
    return this.batch;
  }

  /**
   * Add `chatId` to the running batch, if one is running and it is not
   * already a member (spec/14 § Batch mode — auto-membership). No-op when no
   * batch is running.
   */
  ensureMember(chatId: string): void {
    if (!this.batch || this.batch.members.includes(chatId)) return;
    this.batch = { ...this.batch, members: [...this.batch.members, chatId] };
    this.persist();
  }

  /** Drop `chatId` from the running batch (the row's `×`). No-op otherwise. */
  removeMember(chatId: string): void {
    if (!this.batch || !this.batch.members.includes(chatId)) return;
    this.batch = {
      ...this.batch,
      members: this.batch.members.filter((m) => m !== chatId),
      openedMemberIds: this.batch.openedMemberIds.filter((m) => m !== chatId),
    };
    this.persist();
  }

  /** Record that the user has opened `chatId` (spec/14 § Batch mode — ending). */
  markOpened(chatId: string): void {
    if (!this.batch || !this.batch.members.includes(chatId)) return;
    if (this.batch.openedMemberIds.includes(chatId)) return;
    this.batch = { ...this.batch, openedMemberIds: [...this.batch.openedMemberIds, chatId] };
    this.persist();
  }

  /**
   * Move to the checked-in state, without firing the notification — used both
   * by the automatic triggers (which DO notify, from `BatchNotifier`) and the
   * manual `Check in now` (which does not). No-op if already checked in or no
   * batch is running.
   */
  checkIn(): void {
    if (!this.batch || this.batch.checkedIn) return;
    this.batch = { ...this.batch, checkedIn: true };
    this.persist();
  }

  /**
   * End the running batch: members still running (per `isReady`) roll over
   * into `carryover` for the next `start()`. No-op if no batch is running.
   */
  end(isReady: (chatId: string) => boolean): void {
    if (!this.batch) return;
    this.carryover = this.batch.members.filter((id) => !isReady(id));
    this.batch = null;
    this.persist();
  }
}
