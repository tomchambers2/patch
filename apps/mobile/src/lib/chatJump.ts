// Opening a chat at a search hit's message (spec/03 § Chat search): the chat
// route carries the matched message's canonical `seq`, and the chat screen
// scrolls its transcript to the row holding it. These are the pure halves.

import type { TimelineRow } from './toolSummary';
import type { ChatEventEntry } from '../stores/chatStore';

/**
 * How long an open keeps looking for the target while the transcript hydrates
 * (it replays over several frames). Past this the chat stays where it opened.
 */
export const JUMP_WAIT_MS = 5000;
/** How long the row jumped to stays tinted. */
export const JUMP_HIGHLIGHT_MS = 2000;
/**
 * After `scrollToIndex` fails on a row not measured yet, how long to let the
 * list render around the estimated offset before asking again — and how many
 * times. Variable-height rows make the first ask fail routinely.
 */
export const JUMP_RETRY_DELAY_MS = 50;
export const JUMP_MAX_RETRIES = 10;

/** The `seq` route param as a message seq, or null when absent/not one. */
export function parseSeqParam(raw: string | string[] | undefined): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === undefined || !/^\d+$/.test(v)) return null;
  return Number(v);
}

function holdsSeq(entry: ChatEventEntry, seq: number): boolean {
  // A re-run turn is drawn once and keeps every seq it ran as (`attempts`).
  return entry.seq === seq || (entry.attempts?.some((a) => a.seq === seq) ?? false);
}

/**
 * The index in `rows` (the list's own data, in whatever order the list draws
 * it) of the row holding the message `seq` — a tool run folded into one row
 * holds every seq inside it. -1 when it is not there (yet).
 */
export function rowIndexForSeq(rows: readonly TimelineRow[], seq: number): number {
  return rows.findIndex((r) =>
    r.kind === 'group'
      ? r.entries.some((e) => holdsSeq(e, seq))
      : holdsSeq(r.entry, seq) || (r.result !== undefined && holdsSeq(r.result, seq)),
  );
}
