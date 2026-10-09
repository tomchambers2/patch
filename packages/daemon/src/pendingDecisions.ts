// Durable record of a permission request / AskUserQuestion still awaiting an
// answer (spec/02-daemon.md § Host restart behaviour).
//
// A permission/question BLOCKS the turn inside the SDK's `canUseTool`
// callback (chatRunner.ts's `requestPermission`) via an in-memory Promise
// (`permissionGates`) — that suspended await lives only in this one process,
// exactly like a native `run_in_background` call did before `patch_watch`.
// A host restart destroys it: `resumeInterruptedTurns` today just replays
// the ORIGINAL message that preceded the tool call, so the resumed agent has
// no memory a question was ever asked, and any answer given in the instant
// before the crash is silently discarded (spec/02: "A query that was
// mid-tool-call when the host died loses that tool call").
//
// This module can't make the blocking mechanism itself survive a restart —
// the suspended await is gone with the process, and nothing can resume it.
// What it CAN do is persist the fact that a decision was pending, so the
// restart's resumed turn can tell the agent what it had asked instead of
// nothing, rather than blindly re-deriving from scratch. Same durability
// idiom as `wake.ts`'s `wake.json`: atomic write, read fresh on restart, no
// resident timer needed here since resolution is event-driven, not time-based.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** One still-open permission/question, persisted at `<chatDir>/pending-decisions.json`. */
export const PendingDecisionRecord = z
  .object({
    requestId: z.string().min(1),
    tool: z.string().min(1),
    args: z.record(z.unknown()),
    description: z.string().optional(),
    createdAt: z.number().int(),
  })
  .strict();
export type PendingDecisionRecord = z.infer<typeof PendingDecisionRecord>;

const PENDING_DECISIONS_FILE = 'pending-decisions.json';

function filePath(chatDir: string): string {
  return join(chatDir, PENDING_DECISIONS_FILE);
}

function readAll(chatDir: string): PendingDecisionRecord[] {
  const path = filePath(chatDir);
  if (!existsSync(path)) return [];
  try {
    const parsed = z.array(PendingDecisionRecord).safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : [];
  } catch {
    // Corrupt or half-written file (e.g. a crash mid-write despite the atomic
    // rename below being extremely unlikely to be the cause) — treat as
    // "nothing pending" rather than blocking the restart on it.
    return [];
  }
}

function writeAll(chatDir: string, records: PendingDecisionRecord[]): void {
  const path = filePath(chatDir);
  if (records.length === 0) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  if (!existsSync(chatDir)) mkdirSync(chatDir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(records), 'utf8');
  renameSync(tmp, path); // atomic — a crash mid-write can't corrupt the file
}

/**
 * Record a newly-opened permission/question. Persisted BEFORE the request is
 * announced to the surface, mirroring `requestPermission`'s own "register the
 * gate before announcing" ordering — a request that is public but not yet
 * durable could be answered and lost in the same narrow window it exists to
 * close.
 */
export function persistPendingDecision(chatDir: string, rec: PendingDecisionRecord): void {
  const all = readAll(chatDir).filter((r) => r.requestId !== rec.requestId);
  all.push(rec);
  writeAll(chatDir, all);
}

/** Clear one decision: answered, expired, or the chat moved on. */
export function clearPendingDecision(chatDir: string, requestId: string): void {
  const all = readAll(chatDir).filter((r) => r.requestId !== requestId);
  writeAll(chatDir, all);
}

/** Clear every decision for a chat — used once their text has been folded
 *  into a resumed turn's reminder (resumeInterruptedTurns), so a chat that
 *  still needs an answer asks fresh rather than carrying a stale record. */
export function clearAllPendingDecisions(chatDir: string): void {
  writeAll(chatDir, []);
}

/** Every decision still on disk for a chat — read on restart, nothing else. */
export function readPendingDecisions(chatDir: string): PendingDecisionRecord[] {
  return readAll(chatDir);
}
