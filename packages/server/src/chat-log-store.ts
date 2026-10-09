// The server's log of each chat's transcript (spec/01 § Message log).
//
// Every transcript event a host sends passes through `commit` before anything
// is broadcast: it is written to the chat's append-only file first, so what a
// surface has seen live is always already on the server's disk. A resend of an
// event the server holds is a no-op, so a host that replays after a dropped link
// cannot double a message. Live streaming (deltas, state, progress) is not part
// of the transcript and never touches this.
//
// While a chat's host is online the host's own log answers replays; the server's
// copy answers them when it is not, and is what rebuilds a host's log that was
// lost (`patch.log_restore`).
//
// One synchronous append per finished event: a process crash loses nothing, and
// the operating system flushes it to disk shortly after. A person's own message
// is fsynced at once, the same policy the host's log keeps.

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Logger } from 'pino';
import type { WireEvent } from '@patch/wire';

const MAX_EVENTS_PER_CHAT = 50_000;

/** A tool result bigger than this is kept as a reference, as a host's own log keeps it. */
export const BLOB_INLINE_LIMIT_BYTES = 4 * 1024;
const PREVIEW_CHARS = 200;
const SHA_RE = /^[0-9a-f]{64}$/;

function isBlobRef(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { $blob?: unknown }).$blob === 'string'
  );
}

/** The start of a result's text, so a reader that never opens the blob has something to show. */
function previewOf(result: unknown, json: string): string {
  if (typeof result === 'string') return result.slice(0, PREVIEW_CHARS);
  const blocks = Array.isArray(result) ? result : [result];
  const parts: string[] = [];
  for (const b of blocks) {
    if (typeof b !== 'object' || b === null) continue;
    const block = b as { type?: unknown; text?: unknown };
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[image]');
  }
  const text = parts.length > 0 ? parts.join('\n') : json;
  return text.slice(0, PREVIEW_CHARS);
}

/** The events a replay is made of: the transcript, as opposed to live-only frames. */
export function isTranscriptEvent(event: WireEvent): boolean {
  switch (event.type) {
    case 'chat.message':
    case 'chat.tool_call':
    case 'chat.tool_result':
    case 'chat.provider_context':
    case 'chat.error':
      return true;
    default:
      return false;
  }
}

/**
 * What an event IS, apart from its content: two different things at one seq is
 * a numbering fault, while the same thing with a different payload is an update
 * (an attachment added, a result filled in).
 */
function identityOf(event: WireEvent): string {
  switch (event.type) {
    case 'chat.message':
      return `message ${event.role}`;
    case 'chat.tool_call':
    case 'chat.tool_result':
      return `${event.type} ${event.callId}`;
    default:
      return event.type;
  }
}

export type CommitOutcome =
  /** First time this seq was seen. */
  | 'new'
  /** The same event, resent. */
  | 'duplicate'
  /** Same event at this seq with a changed payload; the newer is kept. */
  | 'updated'
  /** A different event already holds this seq. Nothing is kept. */
  | 'conflict'
  /** Not a transcript event, or it carries no usable seq. */
  | 'ignored';

export interface ChatLogStoreOptions {
  /** Where the per-chat files live. Absent keeps the log in memory only. */
  dataDir?: string;
  logger: Pick<Logger, 'warn'>;
  /** How many events of one chat are held in memory; the oldest go first. */
  maxEventsPerChat?: number;
}

export class ChatLogStore {
  private readonly dir: string | null;
  private readonly logger: Pick<Logger, 'warn'>;
  private readonly maxEvents: number;
  private readonly chats = new Map<string, Map<number, WireEvent>>();

  constructor(opts: ChatLogStoreOptions) {
    this.logger = opts.logger;
    this.maxEvents = opts.maxEventsPerChat ?? MAX_EVENTS_PER_CHAT;
    this.dir = opts.dataDir ? join(opts.dataDir, 'chat-logs') : null;
    if (this.dir) mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Take a transcript event into the log, durably, and say what it was. The
   * caller broadcasts only after this returns, and not at all for `duplicate`
   * or `conflict`.
   */
  commit(event: WireEvent): CommitOutcome {
    if (!isTranscriptEvent(event)) return 'ignored';
    const { chatId, seq } = event as { chatId?: unknown; seq?: unknown };
    if (typeof chatId !== 'string' || typeof seq !== 'number' || seq < 0) return 'ignored';
    // A replay and the live stream carry the same event under the same seq.
    // Drop the routing tag a replay frame carries; it is not part of the event.
    const { forSurfaceId: _route, ...whole } = event as WireEvent & { forSurfaceId?: string };
    void _route;
    // A big tool result is kept as a reference to a stored body, so one of them
    // never weighs down the log or a replay of it.
    const stored = this.externalize(whole as WireEvent);
    const log = this.load(chatId);
    const had = log.get(seq);
    const json = JSON.stringify(stored);
    let outcome: CommitOutcome = 'new';
    if (had !== undefined) {
      if (identityOf(had) !== identityOf(stored as WireEvent)) {
        this.logger.warn(
          { chatId, seq, held: identityOf(had), got: identityOf(stored as WireEvent) },
          'chat-log-store: a different event already holds this seq; not committed',
        );
        return 'conflict';
      }
      if (JSON.stringify(had) === json) return 'duplicate';
      outcome = 'updated';
    }
    log.set(seq, stored as WireEvent);
    if (log.size > this.maxEvents) {
      const oldest = Math.min(...log.keys());
      log.delete(oldest);
    }
    this.append(chatId, json, event.type === 'chat.message' && event.role === 'user');
    return outcome;
  }

  /** Take in events that are not new to surfaces: a replay, or a batch of one. */
  observe(event: WireEvent): void {
    if (event.type === 'chat.replay_batch') {
      for (const inner of event.events) this.observe(inner as WireEvent);
      return;
    }
    this.commit(event);
  }

  /** The highest seq the server holds for the chat, or -1 when it holds none. */
  highWater(chatId: string): number {
    let max = -1;
    for (const seq of this.load(chatId).keys()) if (seq > max) max = seq;
    return max;
  }

  /** True when the server holds anything for the chat. */
  has(chatId: string): boolean {
    return this.load(chatId).size > 0;
  }

  /** The chat's events with `seq > fromSeq`, in seq order. `fromSeq` of -1 is everything. */
  read(chatId: string, fromSeq: number, limit?: number): WireEvent[] {
    const events = [...this.load(chatId).entries()]
      .filter(([seq]) => seq > fromSeq)
      .sort((a, b) => a[0] - b[0])
      .map(([, e]) => e);
    return limit === undefined ? events : events.slice(0, limit);
  }

  /** Writes are synchronous, so there is never anything held back. Kept for callers that shut down tidily. */
  async flush(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * A tool result over the inline limit becomes a content-addressed reference
   * (the same shape a host's log uses, so a surface fetches it the same way), and
   * its body is stored once under `chat-logs/blobs`. With no data dir the result
   * stays inline: there is nowhere to keep a body.
   */
  private externalize(event: WireEvent): WireEvent {
    if (event.type !== 'chat.tool_result' || this.dir === null) return event;
    const result = (event as { result?: unknown }).result;
    if (isBlobRef(result)) return event;
    const json = JSON.stringify(result ?? null);
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes <= BLOB_INLINE_LIMIT_BYTES) return event;
    const sha = createHash('sha256').update(json).digest('hex');
    const path = this.blobPath(sha);
    try {
      if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, json);
        renameSync(tmp, path);
      }
    } catch (err) {
      // Keep the body inline rather than lose it.
      this.logger.warn({ err, sha }, 'chat-log-store: could not store a large result; kept inline');
      return event;
    }
    return {
      ...event,
      result: { $blob: sha, bytes, mime: 'application/json', preview: previewOf(result, json) },
    } as WireEvent;
  }

  private blobPath(sha: string): string {
    return join(this.dir as string, 'blobs', sha.slice(0, 2), sha.slice(2));
  }

  /** The stored body a reference stands for, or null when the server does not hold it. */
  readBlob(sha: string): { bytes: Buffer; mime: string } | null {
    if (this.dir === null || !SHA_RE.test(sha)) return null;
    try {
      return { bytes: readFileSync(this.blobPath(sha)), mime: 'application/json' };
    } catch {
      return null;
    }
  }

  private append(chatId: string, line: string, durable: boolean): void {
    if (this.dir === null) return;
    const path = join(this.dir, `${fileName(chatId)}.jsonl`);
    try {
      if (!durable) {
        appendFileSync(path, `${line}\n`);
        return;
      }
      const fd = openSync(path, 'a');
      try {
        writeSync(fd, `${line}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      this.logger.warn({ err, chatId }, 'chat-log-store: could not write the chat log');
    }
  }

  private load(chatId: string): Map<number, WireEvent> {
    const held = this.chats.get(chatId);
    if (held) return held;
    const log = new Map<number, WireEvent>();
    this.chats.set(chatId, log);
    if (this.dir === null) return log;
    const path = join(this.dir, `${fileName(chatId)}.jsonl`);
    if (!existsSync(path)) return log;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      this.logger.warn({ err, chatId }, 'chat-log-store: could not read the chat log');
      return log;
    }
    for (const line of text.split('\n')) {
      if (line === '') continue;
      try {
        const event = JSON.parse(line) as WireEvent;
        const seq = (event as { seq?: unknown }).seq;
        // A torn last line from a crash, or a record that is not an event, is skipped.
        if (typeof seq === 'number') log.set(seq, event);
      } catch {
        continue;
      }
    }
    return log;
  }
}

/** A chat id is a ULID or a fixed thread name, but never trust it as a path segment. */
function fileName(chatId: string): string {
  return chatId.replace(/[^A-Za-z0-9_-]/g, '_');
}
