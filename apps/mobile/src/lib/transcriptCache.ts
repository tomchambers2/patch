// A chat's transcript, kept on this phone (spec/15 § Instant open, spec/12 §
// Cold start). MMKV — the same store the credential and the chat list use.
//
// Replay is cheap now that tool bodies stay in the blob store and the answer
// arrives as a few frames instead of thousands. This is the last piece: a
// chat you have already opened should not be downloaded again just because
// the app was killed. Opening one paints from here synchronously — before a
// frame is drawn, let alone before the socket answers — and the ask that
// follows is only for what is newer than the last seq held.
//
// The HOST stays the record. This is a cache, never a source of truth:
//   - Only DURABLE events are kept — the ones carrying a seq, exactly what a
//     replay would re-send. Deltas and state frames are never stored.
//   - Keyed by branch. A fork, an edit or a branch switch makes the cached
//     track the WRONG track, and the chat is dropped whole and refetched
//     rather than merged into something plausible.
//   - Unreadable content is reported and dropped, never silently treated as
//     an empty chat: this runs on the open path, and a launch-blocking throw
//     over a disposable mirror would be far worse than the refetch it saves.
//
// Bounded twice — events per chat, and chats — so a year of use cannot grow
// without limit on a phone.

import { store } from './credential';
import { useUiStore } from '../stores/uiStore';

const KEY_PREFIX = 'patch.transcript.v1.';
const INDEX_KEY = 'patch.transcript.index.v1';
/** Most recent events kept per chat — well past a tall screen's worth. */
export const MAX_CACHED_EVENTS = 3000;
/** How many chats' transcripts to keep, least-recently-opened dropped first. */
export const MAX_CACHED_CHATS = 20;
/** Live events trickle in; coalesce before rewriting a chat's blob. */
const FLUSH_MS = 750;

interface CachedChat {
  branchId: string | null;
  events: unknown[];
}

/** chatId -> epoch ms last opened. */
type CacheIndex = Record<string, number>;

const pending = new Map<string, unknown[]>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function key(chatId: string): string {
  return `${KEY_PREFIX}${chatId}`;
}

function durableSeq(event: unknown): number | null {
  if (typeof event !== 'object' || event === null) return null;
  const e = event as { seq?: unknown; chatId?: unknown };
  if (typeof e.chatId !== 'string') return null;
  // A negative seq is an optimistic local echo the host has not persisted;
  // caching one would resurrect a message that may never have been sent.
  return typeof e.seq === 'number' && Number.isInteger(e.seq) && e.seq >= 0 ? e.seq : null;
}

function readIndex(): CacheIndex {
  const raw = store().getString(INDEX_KEY);
  if (raw === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as CacheIndex) : {};
  } catch {
    store().delete(INDEX_KEY);
    return {};
  }
}

function readChat(chatId: string): CachedChat | null {
  const raw = store().getString(key(chatId));
  if (raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as CachedChat).events)
    ) {
      throw new Error('cached transcript is not a transcript');
    }
    return parsed as CachedChat;
  } catch (e) {
    store().delete(key(chatId));
    useUiStore.getState().pushError(`transcript cache unreadable: ${(e as Error).message}`);
    return null;
  }
}

/**
 * What this phone already holds for a chat, oldest first — or null. Returns
 * synchronously, which is the whole point: the transcript is on screen in
 * the first frame rather than after a round trip.
 */
export function loadTranscript(chatId: string): CachedChat | null {
  const held = readChat(chatId);
  if (held === null) return null;
  const index = readIndex();
  index[chatId] = Date.now();
  store().set(INDEX_KEY, JSON.stringify(index));
  return held;
}

/** Merge `events` into what is held, newest `MAX_CACHED_EVENTS` kept. */
function writeMerged(chatId: string, incoming: unknown[]): void {
  const held = readChat(chatId);
  const bySeq = new Map<number, unknown>();
  for (const event of held?.events ?? []) {
    const seq = durableSeq(event);
    if (seq !== null) bySeq.set(seq, event);
  }
  for (const event of incoming) {
    const seq = durableSeq(event);
    // Re-delivery overwrites rather than duplicates, which is what makes a
    // reconnect's overlapping replay safe to feed straight in.
    if (seq !== null) bySeq.set(seq, event);
  }
  const events = [...bySeq.entries()].sort(([a], [b]) => a - b).map(([, e]) => e);
  const trimmed = events.length > MAX_CACHED_EVENTS ? events.slice(-MAX_CACHED_EVENTS) : events;
  store().set(
    key(chatId),
    JSON.stringify({ branchId: held?.branchId ?? null, events: trimmed } satisfies CachedChat),
  );
}

function flush(): void {
  flushTimer = null;
  const batch = [...pending.entries()];
  pending.clear();
  try {
    for (const [chatId, events] of batch) writeMerged(chatId, events);
    const index = readIndex();
    const now = Date.now();
    for (const [chatId] of batch) index[chatId] = index[chatId] ?? now;
    // Bound the number of chats held, least-recently-opened first.
    const ordered = Object.entries(index).sort(([, a], [, b]) => b - a);
    for (const [chatId] of ordered.slice(MAX_CACHED_CHATS)) {
      store().delete(key(chatId));
      delete index[chatId];
    }
    store().set(INDEX_KEY, JSON.stringify(index));
  } catch (e) {
    useUiStore.getState().pushError(`transcript cache write failed: ${(e as Error).message}`);
  }
}

/**
 * Keep these events for `chatId`. Coalesced: a streaming reply lands a run of
 * events a few milliseconds apart, and rewriting the chat's blob for each one
 * would cost more than the cache saves.
 */
export function saveEvents(chatId: string, events: unknown[]): void {
  const keepable = events.filter((e) => durableSeq(e) !== null);
  if (keepable.length === 0) return;
  const held = pending.get(chatId);
  if (held) held.push(...keepable);
  else pending.set(chatId, keepable);
  if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_MS);
}

/** Record which track the held events belong to. */
export function setBranch(chatId: string, branchId: string): void {
  const held = readChat(chatId);
  if (held === null) return;
  store().set(key(chatId), JSON.stringify({ branchId, events: held.events } satisfies CachedChat));
}

/** Forget a chat entirely — its track was replaced, not extended. */
export function dropTranscript(chatId: string): void {
  pending.delete(chatId);
  store().delete(key(chatId));
  const index = readIndex();
  delete index[chatId];
  store().set(INDEX_KEY, JSON.stringify(index));
}

/** Test seam: drop anything waiting to be written. */
export function __resetPendingForTests(): void {
  pending.clear();
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
}
