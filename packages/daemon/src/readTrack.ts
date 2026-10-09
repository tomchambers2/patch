// Reading one track (branch) of a chat's own history log (spec/04 §
// Branching): parent-cut-plus-own-records. A track is its own records in full,
// plus its ancestors' records up to (and including) the seq each fork point
// hung off — mirroring exactly how Claude Code's own resumed transcript file
// physically carries a copy of everything before the resume point.

import type { LogRecord, LoggedEvent } from '@patch/wire';
import type { ChatLog } from './chatLog.js';
import type { ChatMeta } from './meta.js';

export interface TrackSegment {
  branchId: string;
  /** Records on this branch with seq <= this bound belong to the track. */
  upperBound: number;
}

/**
 * The chain of (branch, upper-seq-bound) segments a track is made of, root
 * last. `targetBranchId`'s own segment has no bound (`Infinity` — every record
 * it ever carries belongs to it).
 *
 * Each ancestor's bound is where its child forked from — but an edit fork and
 * a side thread disagree about whether the fork POINT ITSELF belongs to the
 * parent's contribution: editing a message REPLACES it (the parent's own
 * record at that seq is not shared — the fork provides its own), while a side
 * thread hangs new content off an existing message that both tracks show
 * (spec/04 § Side threads). So the parent's bound is `forkFromSeq - 1` for an
 * edit fork, `forkFromSeq` for a side thread (`branch.sideThread`).
 */
export function branchChain(meta: ChatMeta, targetBranchId: string): TrackSegment[] {
  const branches = meta.branches ?? [
    {
      branchId: targetBranchId,
      parentBranchId: null,
      forkFromSeq: null,
      label: 'main',
      createdAt: meta.createdAt,
    },
  ];
  const byId = new Map(branches.map((b) => [b.branchId, b]));
  const chain: TrackSegment[] = [];
  let cur = byId.get(targetBranchId);
  let upperBound = Number.POSITIVE_INFINITY;
  const visited = new Set<string>();
  while (cur && !visited.has(cur.branchId)) {
    visited.add(cur.branchId);
    chain.push({ branchId: cur.branchId, upperBound });
    if (cur.parentBranchId === null) break;
    upperBound =
      cur.forkFromSeq === null || cur.forkFromSeq === undefined
        ? Number.POSITIVE_INFINITY
        : cur.sideThread
          ? cur.forkFromSeq
          : cur.forkFromSeq - 1;
    cur = byId.get(cur.parentBranchId);
  }
  return chain;
}

/**
 * Every logged event belonging to `targetBranchId`'s track, in seq order,
 * blob results already rehydrated (`ChatLog.readEvents`). `fromSeq` is
 * exclusive, matching `chat.replay`'s convention.
 */
export function readTrack(
  chatLog: Pick<ChatLog, 'readEvents'>,
  chatId: string,
  meta: ChatMeta,
  targetBranchId: string,
  fromSeq = -1,
): Array<{ record: LogRecord; event: LoggedEvent }> {
  const chain = branchChain(meta, targetBranchId);
  const bounds = new Map(chain.map((c) => [c.branchId, c.upperBound]));
  const out: Array<{ record: LogRecord; event: LoggedEvent }> = [];
  // `ChatLog.readEvents`'s `minSeq` is INCLUSIVE; `readTrack`'s `fromSeq`
  // matches `chat.replay`'s EXCLUSIVE convention (spec/12 § Replay vs history
  // cursors), so it is one higher here.
  for (const entry of chatLog.readEvents(chatId, fromSeq + 1)) {
    const bound = bounds.get(entry.record.branchId);
    if (bound === undefined) continue;
    if (entry.record.seq > bound) continue;
    out.push(entry);
  }
  out.sort((a, b) => a.record.seq - b.record.seq);
  return out;
}

/**
 * Every record of ANY kind belonging to the track — not just `k:'event'`.
 * Needed for records the wire event stream never carried in the first place:
 * a failed turn's `turn.end` (spec/04 § History — a failed turn replays as a
 * system note, never a `chat.error`, which is not itself a logged event type
 * and so never appears via `readTrack`).
 */
export function readTrackRecords(
  chatLog: Pick<ChatLog, 'read'>,
  chatId: string,
  meta: ChatMeta,
  targetBranchId: string,
  fromSeq = -1,
): LogRecord[] {
  const chain = branchChain(meta, targetBranchId);
  const bounds = new Map(chain.map((c) => [c.branchId, c.upperBound]));
  const out: LogRecord[] = [];
  for (const record of chatLog.read(chatId, fromSeq + 1)) {
    if (record.seq < fromSeq + 1) continue;
    const bound = bounds.get(record.branchId);
    if (bound === undefined) continue;
    if (record.seq > bound) continue;
    out.push(record);
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}
