// The Manager's bounded context window (spec/06 § Manager conversation).
//
// The Manager thread grows forever by design (spec/06 § What they share), but
// the MODEL only ever needs to see the last N messages of it — the rest is
// history the log keeps in full, not context the next turn pays for. This is
// the pure half: given the chat's whole track, find the point N real
// messages from the end and keep everything from there on, so a tool call
// and its result never get split across the cut. The host-side half
// (`ChatRunner.ensureBoundedManagerContext`) decides WHEN to apply it and
// writes the result into a fresh native session via `nativeReconstruct`.

import type { TrackEntry } from './nativeReconstruct.js';

/** How many `chat.message` (user/assistant, non-`system`) entries are in the track. */
export function countMessages(track: readonly TrackEntry[]): number {
  let n = 0;
  for (const { event } of track) {
    if (event.type === 'chat.message' && event.role !== 'system') n++;
  }
  return n;
}

/**
 * The trailing slice of `track` that carries the last `windowMessages` real
 * messages, plus whatever tool calls/results/artifacts sit alongside them —
 * never a message cut loose from the tool call it was answering. `track` is
 * oldest-first (a `readTrack` result); the return value is too.
 *
 * `windowMessages <= 0` is nonsensical for a window and returns the track
 * unchanged rather than an empty one — the caller's own guard
 * (`managerContextWindow` is a positive-int setting) means this only ever
 * fires from a test or a misconfigured value, and an empty context is a
 * worse failure mode than an unbounded one.
 */
export function windowTrack(
  track: readonly TrackEntry[],
  windowMessages: number,
): readonly TrackEntry[] {
  if (windowMessages <= 0) return track;
  let count = 0;
  let startIndex = track.length;
  for (let i = track.length - 1; i >= 0; i--) {
    const event = track[i]!.event;
    if (event.type === 'chat.message' && event.role !== 'system') {
      count++;
      startIndex = i;
      if (count >= windowMessages) break;
    }
  }
  return track.slice(startIndex);
}
