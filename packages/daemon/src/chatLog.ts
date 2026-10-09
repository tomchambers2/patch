// A chat's own history log (spec/04 § History): `~/.patch/chats/<chatId>/events.jsonl`.
//
// One writer per chat. Each record is one JSON line, written with ONE write()
// on an O_APPEND descriptor, so a crash can tear at most the last line — and
// opening the log repairs exactly that. The log is also the chat's seq
// authority: `allocate` hands out every seq the chat ever emits, and a restart
// resumes from the highest seq the log (or the legacy `seq` file / meta mirror)
// has seen, so a seq is never reused.
//
// Durability: a record is written the moment it happens, and fsynced at once
// only where losing it would lose something a person did or a decision that
// was made — a user message, the end of a turn, a new session, a permission
// decision, an import. Everything else is fsynced by a 1 s batch timer and on
// shutdown; a process crash loses nothing either way (the write() already
// reached the kernel), only a machine crash can lose the last second.
//
// Reads: every replay comes from here (chatRunner's `replayFromLog`).

import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { dirname, join } from 'node:path';
import { imageSize } from './imageSize.js';
import type { Logger } from 'pino';
import {
  CHAT_LOG_VERSION,
  LogRecord,
  type BlobImageSource,
  type BlobRef,
  type LogRecordBody,
  type LoggedEvent,
  type NativeRef,
  type TurnOutcome,
} from '@patch/wire';

/**
 * A tool result bigger than this (serialised) goes to the blob store.
 *
 * Measured over 1,201 real chats (27,178 inline tool results, 146.6 MB): the
 * median result is 634 bytes and p90 is 5.3 KB, so a 32 KB limit caught only
 * the 487 biggest and left 48 MB of tool output sitting in transcripts —
 * which is why a chat made of many SMALL results saw no improvement at all
 * from references (one measured at 1.08 MB before and after).
 *
 * At 4 KB that becomes 20.6 MB left inline, for about 2.6 extra blob files
 * per chat. Past here it stops paying: 4K->2K moves another 10.6 MB but
 * costs 3,651 more files, and 2K->1K only 5.1 MB for 3,524 more.
 *
 * The reader never pays a click for this: a row's body is fetched when the
 * row is OPENED (the detail pane only mounts then), so a referenced result
 * reads exactly like an inline one — it just is not carried by every chat
 * open for the 95% of rows nobody expands.
 */
export const BLOB_INLINE_LIMIT_BYTES = 4 * 1024;
/** How long a non-critical record may sit written-but-not-fsynced. */
export const FSYNC_BATCH_MS = 1000;
/** One sparse-index entry per this many records. */
const INDEX_STRIDE = 256;
const READ_CHUNK = 64 * 1024;
const PREVIEW_CHARS = 200;

export type ChatLogFs = Pick<
  typeof nodeFs,
  | 'openSync'
  | 'writeSync'
  | 'fsyncSync'
  | 'closeSync'
  | 'ftruncateSync'
  | 'fstatSync'
  | 'readSync'
  | 'existsSync'
  | 'mkdirSync'
  | 'readFileSync'
  | 'renameSync'
>;

/** Appending to a chat's history failed. The turn it belongs to fails with `history_write_failed`. */
export class HistoryWriteError extends Error {
  constructor(
    readonly chatId: string,
    message: string,
  ) {
    super(`history log for ${chatId}: ${message}`);
    this.name = 'HistoryWriteError';
  }
}

export interface ChatLogOptions {
  /** `~/.patch/chats/<chatId>` for a chat. */
  chatDir: (chatId: string) => string;
  /** `~/.patch/blobs`. */
  blobsDir: string;
  logger: Logger;
  now: () => number;
  fs?: Partial<ChatLogFs>;
  fsyncBatchMs?: number;
}

export interface AppendOptions {
  branchId: string;
  /** Record seq. Defaults to the chat's high-water mark (the last seq allocated). */
  seq?: number;
  nativeRef?: NativeRef;
  /** Drop this record if the open turn already logged one with the same key (a harness re-send). */
  dedupeKey?: string;
  /** fsync before returning. */
  sync?: boolean;
}

export interface HydrateResult {
  nextSeq: number;
  /** Set when the log ended in a torn line that was cut off. */
  repaired: { droppedBytes: number } | null;
  /** A turn the previous process started and never ended, now closed as `interrupted`. */
  interruptedTurnId: string | null;
  /**
   * The outcome the log itself recorded for the chat's last turn, when that
   * turn was already closed (null while `interruptedTurnId` is set, or before
   * the chat's first turn). The authoritative check for a `pendingTurns` entry
   * meta.json still lists as owed: `completed`/`stopped` means the turn this
   * log's own record shows already settled, and a resend of it would reprompt
   * a conversation that is, on this evidence, already finished.
   */
  lastTurnOutcome: TurnOutcome | null;
}

interface IndexEntry {
  offset: number;
  /** Highest seq of every record BEFORE `offset`. */
  hwBefore: number;
}

interface ChatLogState {
  path: string;
  fd: number | undefined;
  /** The next seq `allocate` hands out. */
  nextSeq: number;
  /** Highest seq any record in the file carries. */
  recordedHw: number;
  /** Whether the file has its `log.start` record. */
  started: boolean;
  legacyUpTo: number | undefined;
  dirty: boolean;
  size: number;
  records: number;
  /** Running max seq, maintained alongside `index`. */
  indexHw: number;
  index: IndexEntry[] | undefined;
  turn: { turnId: string; dedupe: Set<string> } | undefined;
  localIds: Set<string> | undefined;
  /** Set when the log cannot be written; every append refuses with this. */
  broken: string | undefined;
  /** Branch of the last record written, for the flush-time reservation. */
  lastBranchId: string;
}

export class ChatLog {
  private readonly fs: ChatLogFs;
  private readonly chats = new Map<string, ChatLogState>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly batchMs: number;

  constructor(private readonly opts: ChatLogOptions) {
    this.fs = { ...nodeFs, ...(opts.fs ?? {}) } as ChatLogFs;
    this.batchMs = opts.fsyncBatchMs ?? FSYNC_BATCH_MS;
  }

  pathFor(chatId: string): string {
    return join(this.opts.chatDir(chatId), 'events.jsonl');
  }

  // -------------------------------------------------------------------------
  // Open / hydrate

  /**
   * Load a chat's position from its log without holding it open: repair a torn
   * tail, find the highest seq, and close a turn a dead process left open.
   * `floor` is the highest next-seq any other store remembers (meta.json, the
   * legacy `seq` file); the result never goes below it.
   */
  hydrate(chatId: string, floor: number): HydrateResult {
    const existing = this.chats.get(chatId);
    if (existing) {
      return {
        nextSeq: Math.max(existing.nextSeq, floor),
        repaired: null,
        interruptedTurnId: null,
        lastTurnOutcome: null,
      };
    }
    const state = this.freshState(chatId, floor);
    this.chats.set(chatId, state);
    let repaired: HydrateResult['repaired'] = null;
    let openTurn: { turnId: string; branchId: string } | null = null;
    let lastTurnOutcome: TurnOutcome | null = null;
    if (this.fs.existsSync(state.path)) {
      try {
        repaired = this.repairTail(chatId, state);
        const scan = this.scanTail(chatId, state);
        state.recordedHw = scan.hw;
        state.nextSeq = Math.max(state.nextSeq, scan.hw + 1);
        openTurn = scan.openTurn;
        lastTurnOutcome = scan.lastTurnOutcome;
        const first = this.readFirstRecord(chatId, state);
        if (first) {
          state.started = first.rec.k === 'log.start';
          state.legacyUpTo = first.rec.k === 'log.start' ? first.rec.legacyUpTo : undefined;
          if (!state.started) {
            state.broken = 'the first record is not log.start';
            this.opts.logger.error(
              { chatId, path: state.path },
              'history log: first record is not log.start',
            );
          }
        }
      } catch (err) {
        state.broken = (err as Error).message;
        throw err;
      }
    }
    let interruptedTurnId: string | null = null;
    if (openTurn && !state.broken) {
      this.append(
        chatId,
        { k: 'turn.end', outcome: 'interrupted' },
        { branchId: openTurn.branchId, sync: true },
        openTurn.turnId,
      );
      interruptedTurnId = openTurn.turnId;
    }
    return { nextSeq: state.nextSeq, repaired, interruptedTurnId, lastTurnOutcome };
  }

  private freshState(chatId: string, floor: number): ChatLogState {
    return {
      path: this.pathFor(chatId),
      fd: undefined,
      nextSeq: floor,
      recordedHw: -1,
      started: false,
      legacyUpTo: undefined,
      dirty: false,
      size: 0,
      records: 0,
      indexHw: -1,
      index: undefined,
      turn: undefined,
      localIds: undefined,
      broken: undefined,
      lastBranchId: `${chatId}-b0`,
    };
  }

  private stateOf(chatId: string, floor = 0): ChatLogState {
    const s = this.chats.get(chatId);
    if (s) return s;
    this.hydrate(chatId, floor);
    return this.chats.get(chatId)!;
  }

  /**
   * Cut a torn last line off. A crash mid-write leaves at most one partial line
   * at the end (one write() per record); a last line that is in fact a whole
   * record merely missing its newline is kept.
   */
  private repairTail(chatId: string, state: ChatLogState): HydrateResult['repaired'] {
    const fd = this.fs.openSync(state.path, 'r+');
    try {
      const size = this.fs.fstatSync(fd).size;
      if (size === 0) return null;
      const last = Buffer.alloc(1);
      this.fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] === 0x0a) return null;
      // Find the last newline.
      let pos = size;
      let cut = 0;
      search: while (pos > 0) {
        const len = Math.min(READ_CHUNK, pos);
        const buf = Buffer.alloc(len);
        this.fs.readSync(fd, buf, 0, len, pos - len);
        for (let i = len - 1; i >= 0; i--) {
          if (buf[i] === 0x0a) {
            cut = pos - len + i + 1;
            break search;
          }
        }
        pos -= len;
      }
      const tail = Buffer.alloc(size - cut);
      this.fs.readSync(fd, tail, 0, tail.length, cut);
      if (parseRecord(tail.toString('utf8')) !== null) {
        this.fs.writeSync(fd, '\n', size);
        this.fs.fsyncSync(fd);
        return null;
      }
      this.fs.ftruncateSync(fd, cut);
      this.fs.fsyncSync(fd);
      this.opts.logger.warn(
        { chatId, path: state.path, droppedBytes: size - cut },
        'history log: cut a torn last record left by an unclean shutdown',
      );
      return { droppedBytes: size - cut };
    } finally {
      this.fs.closeSync(fd);
    }
  }

  /**
   * Walk the log backwards far enough to know its high-water seq and whether
   * its last turn was left open.
   *
   * Every non-`event` record carries the high-water seq of the moment it was
   * written, and an `event` after it either took a fresh (higher) seq or
   * finalised one reserved earlier (lower) — so the max over the lines up to
   * and including the last non-event record is the high-water of the file.
   * The walk continues to the last turn boundary to learn whether a turn is
   * still open.
   */
  private scanTail(
    chatId: string,
    state: ChatLogState,
  ): {
    hw: number;
    openTurn: { turnId: string; branchId: string } | null;
    /** The last turn's own recorded outcome, when it was already closed. */
    lastTurnOutcome: TurnOutcome | null;
  } {
    let hw = -1;
    let hwSettled = false;
    let openTurn: { turnId: string; branchId: string } | null = null;
    let lastTurnOutcome: TurnOutcome | null = null;
    let turnSettled = false;
    this.walkBackwards(chatId, state, (rec) => {
      if (!hwSettled) {
        hw = Math.max(hw, rec.seq);
        if (rec.rec.k !== 'event') hwSettled = true;
      }
      if (!turnSettled) {
        if (rec.rec.k === 'turn.end') {
          turnSettled = true;
          lastTurnOutcome = rec.rec.outcome;
        } else if (rec.rec.k === 'log.start') {
          turnSettled = true;
        } else if (rec.rec.k === 'turn.start') {
          turnSettled = true;
          if (rec.turnId) openTurn = { turnId: rec.turnId, branchId: rec.branchId };
        }
      }
      return !(hwSettled && turnSettled);
    });
    return { hw, openTurn, lastTurnOutcome };
  }

  private walkBackwards(
    chatId: string,
    state: ChatLogState,
    visit: (rec: LogRecord) => boolean,
  ): void {
    const fd = this.fs.openSync(state.path, 'r');
    try {
      const size = this.fs.fstatSync(fd).size;
      state.size = size;
      let pos = size;
      let carry = Buffer.alloc(0);
      while (pos > 0) {
        const len = Math.min(READ_CHUNK, pos);
        const buf = Buffer.alloc(len);
        this.fs.readSync(fd, buf, 0, len, pos - len);
        pos -= len;
        const joined = Buffer.concat([buf, carry]);
        // Complete lines are the ones after a newline in this buffer; the
        // bytes before the first newline carry into the next (earlier) chunk,
        // so a multi-byte character split at a chunk edge is never decoded.
        let end = joined.length;
        for (let i = joined.length - 1; i >= 0; i--) {
          if (joined[i] !== 0x0a) continue;
          if (end > i + 1) {
            const line = joined.subarray(i + 1, end).toString('utf8');
            if (!visit(this.parseOrThrow(chatId, line))) return;
          }
          end = i;
        }
        carry = Buffer.from(joined.subarray(0, end));
      }
      if (carry.length > 0) visit(this.parseOrThrow(chatId, carry.toString('utf8')));
    } finally {
      this.fs.closeSync(fd);
    }
  }

  private readFirstRecord(chatId: string, state: ChatLogState): LogRecord | null {
    const fd = this.fs.openSync(state.path, 'r');
    try {
      let pos = 0;
      let acc = '';
      for (;;) {
        const buf = Buffer.alloc(READ_CHUNK);
        const n = this.fs.readSync(fd, buf, 0, READ_CHUNK, pos);
        if (n === 0) return acc.length > 0 ? this.parseOrThrow(chatId, acc) : null;
        pos += n;
        acc += buf.subarray(0, n).toString('utf8');
        const nl = acc.indexOf('\n');
        if (nl >= 0) return this.parseOrThrow(chatId, acc.slice(0, nl));
      }
    } finally {
      this.fs.closeSync(fd);
    }
  }

  private parseOrThrow(chatId: string, line: string): LogRecord {
    const rec = parseRecord(line);
    if (rec === null) {
      throw new Error(`history log for ${chatId} has a corrupt record: ${line.slice(0, 120)}`);
    }
    return rec;
  }

  // -------------------------------------------------------------------------
  // Seq authority

  /** The seq `allocate` will hand out next. */
  nextSeq(chatId: string): number {
    return this.stateOf(chatId).nextSeq;
  }

  /** The highest seq any record of the chat carries, or -1 when it has none. */
  recordedHighWater(chatId: string): number {
    return this.stateOf(chatId).recordedHw;
  }

  /**
   * Hand out the chat's next seq. `floor` is what the caller believes the next
   * seq to be; the log never goes below it. The first allocation of a chat
   * that has no log yet starts the log, marking every earlier seq as legacy.
   */
  allocate(chatId: string, floor: number, branchId: string): number {
    const state = this.stateOf(chatId, floor);
    state.nextSeq = Math.max(state.nextSeq, floor);
    this.ensureStarted(chatId, state, branchId);
    return state.nextSeq++;
  }

  /** Record that `seq` was handed out before the record carrying it exists. */
  reserve(chatId: string, seq: number, branchId: string): void {
    this.append(chatId, { k: 'seq.reserve' }, { branchId, seq });
  }

  private ensureStarted(chatId: string, state: ChatLogState, branchId: string): void {
    if (state.started) return;
    if (state.broken) throw new HistoryWriteError(chatId, state.broken);
    state.started = true;
    state.legacyUpTo = state.nextSeq;
    this.writeRecord(chatId, state, {
      v: CHAT_LOG_VERSION,
      seq: state.nextSeq - 1,
      at: this.opts.now(),
      branchId,
      rec: { k: 'log.start', legacyUpTo: state.nextSeq },
    });
    this.fsyncState(chatId, state);
  }

  /** Seqs below this were emitted before the log existed. Undefined: no log yet. */
  legacyUpTo(chatId: string): number | undefined {
    return this.stateOf(chatId).legacyUpTo;
  }

  // -------------------------------------------------------------------------
  // Turns

  beginTurn(chatId: string, turnId: string): void {
    this.stateOf(chatId).turn = { turnId, dedupe: new Set() };
  }

  endTurn(chatId: string): void {
    const s = this.chats.get(chatId);
    if (s) s.turn = undefined;
  }

  currentTurnId(chatId: string): string | undefined {
    return this.chats.get(chatId)?.turn?.turnId;
  }

  // -------------------------------------------------------------------------
  // Append

  /**
   * Append one record. Returns false when `dedupeKey` names a record the open
   * turn already logged (the harness sent the same thing twice). Throws
   * `HistoryWriteError` when the record cannot be written.
   */
  append(chatId: string, body: LogRecordBody, o: AppendOptions, turnId?: string): boolean {
    const state = this.stateOf(chatId);
    if (state.broken) throw new HistoryWriteError(chatId, state.broken);
    if (o.dedupeKey !== undefined && state.turn) {
      if (state.turn.dedupe.has(o.dedupeKey)) return false;
      state.turn.dedupe.add(o.dedupeKey);
    }
    this.ensureStarted(chatId, state, o.branchId);
    const tid = turnId ?? state.turn?.turnId;
    const stored: LogRecordBody =
      body.k === 'event' ? { k: 'event', event: this.externalize(chatId, body.event) } : body;
    const record: LogRecord = {
      v: CHAT_LOG_VERSION,
      seq: o.seq ?? state.nextSeq - 1,
      at: this.opts.now(),
      branchId: o.branchId,
      ...(tid !== undefined ? { turnId: tid } : {}),
      ...(o.nativeRef !== undefined ? { nativeRef: o.nativeRef } : {}),
      rec: stored,
    };
    const parsed = LogRecord.safeParse(record);
    if (!parsed.success) {
      throw new HistoryWriteError(
        chatId,
        `record does not match the log schema: ${parsed.error.message}`,
      );
    }
    this.writeRecord(chatId, state, record);
    if (o.sync) this.fsyncState(chatId, state);
    else this.markDirty(state);
    if (state.localIds) collectLocalIds(record, state.localIds);
    return true;
  }

  private writeRecord(chatId: string, state: ChatLogState, record: LogRecord): void {
    const buf = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
    try {
      if (state.fd === undefined) {
        this.fs.mkdirSync(dirname(state.path), { recursive: true });
        state.fd = this.fs.openSync(state.path, 'a');
        state.size = this.fs.fstatSync(state.fd).size;
      }
      const offset = state.size;
      const n = this.fs.writeSync(state.fd, buf, 0, buf.length, null);
      if (n !== buf.length) {
        throw new Error(`short write: ${n} of ${buf.length} bytes`);
      }
      state.size += n;
      state.lastBranchId = record.branchId;
      state.recordedHw = Math.max(state.recordedHw, record.seq);
      if (state.index) {
        if (state.records % INDEX_STRIDE === 0) {
          state.index.push({ offset, hwBefore: state.indexHw });
        }
        state.indexHw = Math.max(state.indexHw, record.seq);
      }
      state.records++;
    } catch (err) {
      if (err instanceof HistoryWriteError) throw err;
      throw new HistoryWriteError(chatId, (err as Error).message);
    }
  }

  private fsyncState(chatId: string, state: ChatLogState): void {
    if (state.fd === undefined) return;
    try {
      this.fs.fsyncSync(state.fd);
      state.dirty = false;
    } catch (err) {
      throw new HistoryWriteError(chatId, `fsync failed: ${(err as Error).message}`);
    }
  }

  private markDirty(state: ChatLogState): void {
    state.dirty = true;
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        this.flush();
      } catch (err) {
        this.opts.logger.error({ err }, 'history log: batched fsync failed');
      }
    }, this.batchMs);
    this.timer.unref?.();
  }

  /**
   * Make everything written so far durable: record the high-water mark of any
   * seq handed out without a record yet, then fsync every chat with unsynced
   * records.
   */
  flush(): void {
    const failures: string[] = [];
    for (const [chatId, state] of this.chats) {
      try {
        if (state.started && !state.broken && state.nextSeq - 1 > state.recordedHw) {
          this.writeRecord(chatId, state, {
            v: CHAT_LOG_VERSION,
            seq: state.nextSeq - 1,
            at: this.opts.now(),
            branchId: state.lastBranchId,
            rec: { k: 'seq.reserve' },
          });
          state.dirty = true;
        }
        if (state.dirty) this.fsyncState(chatId, state);
      } catch (err) {
        failures.push(`${chatId}: ${(err as Error).message}`);
      }
    }
    if (failures.length > 0) throw new Error(`history flush failed — ${failures.join('; ')}`);
  }

  /** Flush and release one chat's descriptor (the chat is being removed). */
  close(chatId: string): void {
    const state = this.chats.get(chatId);
    if (!state) return;
    if (state.fd !== undefined) {
      if (state.dirty) this.fsyncState(chatId, state);
      this.fs.closeSync(state.fd);
    }
    this.chats.delete(chatId);
  }

  /** Flush everything and release every descriptor (shutdown). */
  closeAll(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    let firstErr: unknown;
    try {
      this.flush();
    } catch (err) {
      firstErr = err;
    }
    for (const state of this.chats.values()) {
      if (state.fd !== undefined) this.fs.closeSync(state.fd);
      state.fd = undefined;
    }
    this.chats.clear();
    if (firstErr !== undefined) throw firstErr;
  }

  // -------------------------------------------------------------------------
  // Blobs

  private blobPath(sha: string): string {
    return join(this.opts.blobsDir, 'sha256', sha.slice(0, 2), sha.slice(2));
  }

  /**
   * Move a tool result's bulk into the blob store, in two passes.
   *
   * 1. EVERY inline base64 image becomes a blob reference, whatever it weighs.
   *    Images are the single biggest thing in a chat log — 1,507 of them
   *    across this machine's chats carry 317 MB of base64 — and a transcript
   *    has no use for the bytes: it renders an `<img>` pointing at the blob.
   *    Their pixel size is read from the header here, once, so the surface can
   *    reserve the right box instead of reflowing when the picture lands.
   * 2. What is LEFT, if still over the inline limit, becomes one blob for the
   *    whole result, as before. Pass 1 runs first precisely so an image-
   *    carrying result usually drops under the limit and keeps its structure,
   *    leaving the picture visible without opening the row.
   *
   * Idempotent: a result that already holds references is returned untouched,
   * so re-externalising a record read back off the log is free.
   */
  private externalize(chatId: string, event: LoggedEvent): LoggedEvent {
    if (event.type !== 'chat.tool_result') return event;
    const result = event.result;
    if (isBlobRef(result)) return event;
    const deimaged = this.externalizeImages(chatId, result);
    const json = JSON.stringify(deimaged ?? null);
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes <= BLOB_INLINE_LIMIT_BYTES) {
      return deimaged === result ? event : { ...event, result: deimaged };
    }
    const ref = this.writeBlob(chatId, json, bytes, previewOf(deimaged));
    return { ...event, result: ref };
  }

  /**
   * Swap every `{ type: 'image', source: { type: 'base64' } }` block for a
   * blob reference, leaving every other block exactly as it was. Returns the
   * ORIGINAL value by identity when there was nothing to swap, so the caller
   * can tell a rewrite from a no-op without comparing deeply.
   */
  private externalizeImages(chatId: string, result: unknown): unknown {
    if (!hasInlineImage(result)) return result;
    const blocks = Array.isArray(result) ? result : [result];
    const swapped = blocks.map((block) => {
      if (typeof block !== 'object' || block === null) return block;
      const b = block as {
        type?: unknown;
        source?: { type?: unknown; media_type?: unknown; data?: unknown };
      };
      if (b.type !== 'image' || b.source?.type !== 'base64') return block;
      const data = b.source.data;
      if (typeof data !== 'string') return block;
      const mediaType =
        typeof b.source.media_type === 'string' ? b.source.media_type : 'application/octet-stream';
      const raw = Buffer.from(data, 'base64');
      const source = this.writeBinaryBlob(chatId, raw, mediaType);
      return { ...(block as object), source };
    });
    return Array.isArray(result) ? swapped : swapped[0];
  }

  private writeBlob(chatId: string, json: string, bytes: number, preview: string): BlobRef {
    const sha = this.putBlob(chatId, Buffer.from(json, 'utf8'));
    return { $blob: sha, bytes, mime: 'application/json', preview };
  }

  /**
   * An image's raw decoded bytes in the blob store, described by the source
   * block that replaces it. Stored decoded (not base64, not JSON-wrapped) so
   * `GET /api/chats/:id/blob/:sha` can hand the file straight to an `<img>`
   * with the right `Content-Type` and no re-encoding anywhere on the path.
   */
  private writeBinaryBlob(chatId: string, raw: Buffer, mediaType: string): BlobImageSource {
    const sha = this.putBlob(chatId, raw, mediaType);
    const size = imageSize(raw);
    return {
      type: 'blob',
      $blob: sha,
      media_type: mediaType,
      bytes: raw.length,
      ...(size === undefined ? {} : { width: size.width, height: size.height }),
    };
  }

  /**
   * Content-address `raw` and store it, with a `.meta` sidecar naming its
   * media type so a later reader serving the file by sha alone knows what it
   * is. Returns the sha. Already-stored content is left alone: the sha IS the
   * bytes, so a second write would be byte-identical.
   *
   * A blob written before the sidecar existed has none, and is JSON — see
   * `blobMime`. That is a format version, not a guess.
   */
  private putBlob(chatId: string, raw: Buffer, mediaType = 'application/json'): string {
    const sha = createHash('sha256').update(raw).digest('hex');
    const path = this.blobPath(sha);
    try {
      if (!this.fs.existsSync(path)) {
        this.fs.mkdirSync(dirname(path), { recursive: true });
        this.writeFileAtomic(
          `${path}.meta`,
          Buffer.from(JSON.stringify({ mime: mediaType }), 'utf8'),
        );
        this.writeFileAtomic(path, raw);
      }
    } catch (err) {
      throw new HistoryWriteError(chatId, `blob ${sha}: ${(err as Error).message}`);
    }
    return sha;
  }

  /** Write `buf` to `path` via a temp file + rename, fsynced before the rename. */
  private writeFileAtomic(path: string, buf: Buffer): void {
    const tmp = `${path}.${process.pid}.tmp`;
    const fd = this.fs.openSync(tmp, 'w');
    try {
      const n = this.fs.writeSync(fd, buf, 0, buf.length, 0);
      if (n !== buf.length) throw new Error(`short blob write: ${n} of ${buf.length} bytes`);
      this.fs.fsyncSync(fd);
    } finally {
      this.fs.closeSync(fd);
    }
    this.fs.renameSync(tmp, path);
  }

  /**
   * The event as replay should SEND it: bulk left in the blob store, never
   * rehydrated. Records written before per-image blobs existed still hold
   * inline base64 (317 MB of it on this machine), so this runs the same
   * externalisation over what it read — the sha is the content, so storing it
   * now is idempotent and the chat is permanently cheaper to open afterwards.
   */
  externalizeForReplay(chatId: string, event: LoggedEvent): LoggedEvent {
    return this.externalize(chatId, event);
  }

  /** The value a blob reference stands for. */
  readBlob(ref: BlobRef): unknown {
    return JSON.parse(this.fs.readFileSync(this.blobPath(ref.$blob), 'utf8') as string) as unknown;
  }

  /**
   * A tool result with every blob reference in it put back — the whole-result
   * kind AND the per-block image kind — so a caller that needs the real
   * content gets exactly what the tool returned.
   *
   * This is the opposite of what replay does, and deliberately a separate
   * path: a harness switch rebuilding a native session, and an agent reading
   * its own history, need the bytes; a transcript being drawn does not.
   * Losing images here would silently drop pictures out of a chat's context
   * the first time it changed harness.
   */
  rehydrate(result: unknown): unknown {
    if (isBlobRef(result)) return this.readBlob(result);
    if (!Array.isArray(result)) return result;
    let changed = false;
    const blocks = result.map((block) => {
      if (typeof block !== 'object' || block === null) return block;
      const b = block as {
        type?: unknown;
        source?: { type?: unknown; $blob?: unknown; media_type?: unknown };
      };
      if (b.type !== 'image' || b.source?.type !== 'blob') return block;
      const sha = b.source.$blob;
      if (typeof sha !== 'string') return block;
      const stored = this.readBlobBytes(sha);
      if (stored === null) return block;
      changed = true;
      return {
        ...(block as object),
        source: {
          type: 'base64',
          media_type: typeof b.source.media_type === 'string' ? b.source.media_type : stored.mime,
          data: stored.bytes.toString('base64'),
        },
      };
    });
    return changed ? blocks : result;
  }

  /**
   * A stored blob's raw bytes and media type, for serving it by sha. `null`
   * when this host does not hold that sha, which is a 404, not an error.
   */
  readBlobBytes(sha: string): { bytes: Buffer; mime: string } | null {
    const path = this.blobPath(sha);
    if (!this.fs.existsSync(path)) return null;
    return { bytes: this.fs.readFileSync(path) as Buffer, mime: this.blobMime(path) };
  }

  /**
   * The media type recorded beside a blob. Blobs written before the sidecar
   * existed have no `.meta` and are always the JSON of a tool result, which is
   * what the old `writeBlob` wrote and the only thing it wrote.
   */
  private blobMime(path: string): string {
    const metaPath = `${path}.meta`;
    if (!this.fs.existsSync(metaPath)) return 'application/json';
    const parsed = JSON.parse(this.fs.readFileSync(metaPath, 'utf8') as string) as {
      mime?: unknown;
    };
    return typeof parsed.mime === 'string' ? parsed.mime : 'application/json';
  }

  // -------------------------------------------------------------------------
  // Read

  /**
   * Every record, in file order, starting at the first record that could carry
   * a seq >= `minSeq` (found through the sparse index; records before that
   * point may still be returned, so callers filter by seq themselves).
   */
  read(chatId: string, minSeq = -1): LogRecord[] {
    const state = this.stateOf(chatId);
    if (!this.fs.existsSync(state.path)) return [];
    this.ensureIndex(chatId, state);
    let start = 0;
    for (const entry of state.index!) {
      if (entry.hwBefore < minSeq) start = entry.offset;
      else break;
    }
    const out: LogRecord[] = [];
    this.forEachLine(chatId, state.path, start, (line) => {
      out.push(this.parseOrThrow(chatId, line));
    });
    return out;
  }

  /** Logged events with seq >= `minSeq`, tool results read back out of the blob store. */
  readEvents(chatId: string, minSeq = -1): Array<{ record: LogRecord; event: LoggedEvent }> {
    const out: Array<{ record: LogRecord; event: LoggedEvent }> = [];
    for (const record of this.read(chatId, minSeq)) {
      if (record.rec.k !== 'event' || record.seq < minSeq) continue;
      const ev = record.rec.event;
      out.push({
        record,
        event: ev.type === 'chat.tool_result' ? { ...ev, result: this.rehydrate(ev.result) } : ev,
      });
    }
    return out;
  }

  private ensureIndex(chatId: string, state: ChatLogState): void {
    if (state.index) return;
    const index: IndexEntry[] = [];
    let hw = -1;
    let records = 0;
    let size = 0;
    this.forEachLine(chatId, state.path, 0, (line, offset) => {
      if (records % INDEX_STRIDE === 0) index.push({ offset, hwBefore: hw });
      hw = Math.max(hw, this.parseOrThrow(chatId, line).seq);
      records++;
      size = offset + Buffer.byteLength(line, 'utf8') + 1;
    });
    state.index = index;
    state.indexHw = hw;
    state.records = records;
    if (state.fd === undefined) state.size = size;
  }

  private forEachLine(
    chatId: string,
    path: string,
    start: number,
    visit: (line: string, offset: number) => void,
  ): void {
    const fd = this.fs.openSync(path, 'r');
    try {
      let pos = start;
      let carry = Buffer.alloc(0);
      let carryOffset = start;
      for (;;) {
        const buf = Buffer.alloc(READ_CHUNK);
        const n = this.fs.readSync(fd, buf, 0, READ_CHUNK, pos);
        if (n === 0) break;
        pos += n;
        const joined =
          carry.length > 0 ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
        let lineStart = 0;
        for (let i = 0; i < joined.length; i++) {
          if (joined[i] !== 0x0a) continue;
          if (i > lineStart) {
            visit(joined.subarray(lineStart, i).toString('utf8'), carryOffset + lineStart);
          }
          lineStart = i + 1;
        }
        carry = Buffer.from(joined.subarray(lineStart));
        carryOffset += lineStart;
      }
      if (carry.length > 0) {
        throw new Error(
          `history log for ${chatId} ends without a newline at offset ${carryOffset}`,
        );
      }
    } finally {
      this.fs.closeSync(fd);
    }
  }

  /**
   * Every localId this chat has accepted a turn under — on user messages and
   * on turn starts — so a surface redelivering one after a restart is still
   * recognised as a redelivery.
   */
  localIds(chatId: string): Set<string> {
    const state = this.stateOf(chatId);
    if (!state.localIds) {
      const ids = new Set<string>();
      for (const rec of this.read(chatId)) collectLocalIds(rec, ids);
      state.localIds = ids;
    }
    return state.localIds;
  }
}

function collectLocalIds(record: LogRecord, into: Set<string>): void {
  const r = record.rec;
  if (r.k === 'turn.start' && r.localId !== undefined) into.add(r.localId);
  else if (
    r.k === 'event' &&
    r.event.type === 'chat.message' &&
    r.event.role === 'user' &&
    r.event.localId !== undefined
  ) {
    into.add(r.event.localId);
  }
}

function parseRecord(line: string): LogRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  const parsed = LogRecord.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function isBlobRef(v: unknown): v is BlobRef {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { $blob?: unknown }).$blob === 'string' &&
    typeof (v as { bytes?: unknown }).bytes === 'number'
  );
}

function hasInlineImage(result: unknown): boolean {
  const blocks = Array.isArray(result) ? result : [result];
  return blocks.some((b) => {
    if (typeof b !== 'object' || b === null) return false;
    const block = b as { type?: unknown; source?: { type?: unknown } };
    return block.type === 'image' && block.source?.type === 'base64';
  });
}

function previewOf(result: unknown): string {
  if (typeof result === 'string') return result.slice(0, PREVIEW_CHARS);
  const blocks = Array.isArray(result) ? result : [result];
  const parts: string[] = [];
  for (const b of blocks) {
    if (typeof b !== 'object' || b === null) continue;
    const block = b as { type?: unknown; text?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[image]');
  }
  const text = parts.length > 0 ? parts.join('\n') : JSON.stringify(result ?? null);
  return text.slice(0, PREVIEW_CHARS);
}
