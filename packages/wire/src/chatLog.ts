// A chat's own history log (spec/04 § History): `~/.patch/chats/<chatId>/events.jsonl`,
// append-only, one `LogRecord` per line. Patch keeps it independently of any
// agent harness, so a harness pruning or rotating its own session files costs
// context, never history.
//
// Every durable wire event is stored exactly as it was emitted live. The other
// record kinds carry what a replay or a harness switch needs that no wire
// event says: where turns and sessions begin and end, which permission was
// asked and how it was answered, and the model's thinking.

import { z } from 'zod';
import {
  ChatArtifactEvent,
  ChatToolRunSummaryEvent,
  ChatErrorCode,
  ChatMessageEvent,
  ChatToolCallEvent,
  ChatToolResultEvent,
  HarnessId,
  PermissionMode,
  TurnOrigin,
} from './events.js';

export const CHAT_LOG_VERSION = 1;

/** Where a record came from in the harness's own store — a Claude uuid, a Codex item id. */
export const NativeRef = z
  .object({
    harness: HarnessId,
    sessionId: z.string().min(1),
    id: z.string().min(1),
  })
  .strict();
export type NativeRef = z.infer<typeof NativeRef>;

/**
 * A tool result (or one block of one) too large to keep inline, stored
 * content-addressed at `~/.patch/blobs/sha256/<ab>/<rest>` and replaced here by
 * this reference. `preview` is the start of its text, so a reader that never
 * opens the blob still has something to show.
 *
 * Replay sends the REFERENCE, never the body: tool output is 85-99% of a long
 * chat's bytes (one measured chat ships 23 MB to draw 150 KB of conversation)
 * and every one of those rows draws collapsed. A surface fetches the body from
 * `GET /api/chats/:chatId/blob/:sha` when the row is actually opened. The sha
 * IS the content, so that response is immutable and cached for good — which is
 * also why reopening a chat, or restarting the app, never refetches one.
 */
export const BlobRef = z
  .object({
    $blob: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative(),
    mime: z.string().min(1).optional(),
    preview: z.string(),
    /**
     * Pixel size, for an image blob whose header we could read. The surface
     * reserves exactly this box before the bytes arrive, so an image loading
     * in cannot shove the transcript around under the reader. Absent when the
     * blob is not an image, or its header was not one we parse.
     */
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  })
  .strict();
export type BlobRef = z.infer<typeof BlobRef>;

/** The wire events that are history: what a chat shows and must still show on reload. */
export const LoggedEvent = z.discriminatedUnion('type', [
  ChatMessageEvent,
  ChatToolCallEvent,
  ChatToolResultEvent,
  ChatArtifactEvent,
  ChatToolRunSummaryEvent,
]);
export type LoggedEvent = z.infer<typeof LoggedEvent>;
export const LOGGED_EVENT_TYPES: ReadonlySet<LoggedEvent['type']> = new Set([
  'chat.message',
  'chat.tool_call',
  'chat.tool_result',
  'chat.artifact',
  'chat.tool_run_summary',
]);

export const TurnOutcome = z.enum(['completed', 'stopped', 'failed', 'interrupted']);
export type TurnOutcome = z.infer<typeof TurnOutcome>;

export const SessionReason = z.enum([
  'start',
  'fork',
  'rotate',
  'clear',
  'compact',
  'switch',
  'reseed',
]);
export type SessionReason = z.infer<typeof SessionReason>;

export const PermissionDecisionBy = z.enum(['user', 'expiry', 'cancelled']);
export type PermissionDecisionBy = z.infer<typeof PermissionDecisionBy>;

export const LogRecordBody = z.discriminatedUnion('k', [
  z.object({ k: z.literal('event'), event: LoggedEvent }).strict(),
  z
    .object({
      k: z.literal('turn.start'),
      harness: HarnessId,
      /** Null when the chat names no model (the harness's own default ran). */
      model: z.string().min(1).nullable(),
      sessionId: z.string().min(1).optional(),
      origin: TurnOrigin,
      localId: z.string().min(1).optional(),
      retryOfSeq: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      k: z.literal('turn.end'),
      outcome: TurnOutcome,
      error: z.object({ code: ChatErrorCode, message: z.string() }).strict().optional(),
      usage: z.record(z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      k: z.literal('session'),
      harness: HarnessId,
      model: z.string().min(1).nullable(),
      sessionId: z.string().min(1),
      reason: SessionReason,
      /** What the new session was started from — a fork point, a seeded history. */
      seed: z.record(z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      k: z.literal('permission.request'),
      requestId: z.string().min(1),
      tool: z.string().min(1),
      args: z.unknown(),
      description: z.string().optional(),
      expiresAt: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      k: z.literal('permission.decision'),
      requestId: z.string().min(1),
      decision: z.enum(['approve', 'deny', 'approve_with_edits']),
      by: PermissionDecisionBy,
      editedInput: z.record(z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      k: z.literal('permission.mode'),
      mode: PermissionMode,
      automatic: z.literal(true).optional(),
    })
    .strict(),
  z.object({ k: z.literal('thinking'), text: z.string() }).strict(),
  /** A seq handed out before its record exists (a streamed reply, a live-only error). */
  z.object({ k: z.literal('seq.reserve') }).strict(),
  z
    .object({
      k: z.literal('import'),
      harness: HarnessId,
      sessionId: z.string().min(1),
      records: z.number().int().nonnegative(),
    })
    .strict(),
  /**
   * First record of every log. Seqs below `legacyUpTo` were emitted before the
   * log existed and live only in the harness transcript.
   */
  z.object({ k: z.literal('log.start'), legacyUpTo: z.number().int().nonnegative() }).strict(),
]);
export type LogRecordBody = z.infer<typeof LogRecordBody>;

export const LogRecord = z
  .object({
    v: z.literal(CHAT_LOG_VERSION),
    /**
     * An event's own seq on `event`, `permission.request` and `seq.reserve`
     * records; on every other kind, the highest seq allocated when it was
     * written (-1 before the first).
     */
    seq: z.number().int().min(-1),
    at: z.number().int().nonnegative(),
    branchId: z.string().min(1),
    turnId: z.string().min(1).optional(),
    nativeRef: NativeRef.optional(),
    rec: LogRecordBody,
  })
  .strict();
export type LogRecord = z.infer<typeof LogRecord>;
