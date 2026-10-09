// spec/02 § Context compression — reading a compaction boundary, and the
// one-line record every surface shows for it.
//
// The boundary reaches the host in two different spellings, and they are not
// interchangeable:
//   - the SDK STREAM message is snake_case (`pre_tokens`), the shape the
//     `claude` binary validates before yielding it.
//   - the JSONL Claude Code writes to disk is camelCase (`preTokens`), which is
//     what a replay reads back.
// One validator, two key maps — so both paths accept exactly the same figures
// and reject exactly the same rubbish.

import { MessageCompaction } from '@patch/wire';

interface CompactionKeys {
  pre: string;
  post: string;
  duration: string;
}

const STREAM_KEYS: CompactionKeys = {
  pre: 'pre_tokens',
  post: 'post_tokens',
  duration: 'duration_ms',
};

const TRANSCRIPT_KEYS: CompactionKeys = {
  pre: 'preTokens',
  post: 'postTokens',
  duration: 'durationMs',
};

function parseCompaction(meta: unknown, keys: CompactionKeys): MessageCompaction {
  if (typeof meta !== 'object' || meta === null) {
    throw new Error('compact_boundary: the boundary carries no compaction metadata');
  }
  const m = meta as Record<string, unknown>;
  // Pick only the figures we publish: the metadata also carries relink uuids
  // and discovered-tool lists, and the wire shape is strict.
  const candidate = {
    trigger: m['trigger'],
    preTokens: m[keys.pre],
    ...(m[keys.post] !== undefined ? { postTokens: m[keys.post] } : {}),
    ...(m[keys.duration] !== undefined ? { durationMs: m[keys.duration] } : {}),
  };
  const parsed = MessageCompaction.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`compact_boundary: unusable compaction metadata — ${parsed.error.message}`);
  }
  return parsed.data;
}

/** Read the figures off an SDK `compact_boundary` stream message. */
export function compactionFromSdkMetadata(meta: unknown): MessageCompaction {
  return parseCompaction(meta, STREAM_KEYS);
}

/** Read the figures off a `compact_boundary` line in an on-disk transcript. */
export function compactionFromTranscriptMetadata(meta: unknown): MessageCompaction {
  return parseCompaction(meta, TRANSCRIPT_KEYS);
}

/** The on-disk metadata key, so the mock backend writes what the reader reads. */
export const TRANSCRIPT_METADATA_KEY = 'compactMetadata';

function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/**
 * The one-line record of a compression. Real boundaries report only the
 * pre-count, so the "from N" wording is the common case rather than a corner.
 */
export function compactionSummaryLine(c: MessageCompaction): string {
  return c.postTokens === undefined
    ? `Context compressed · from ${formatTokens(c.preTokens)}`
    : `Context compressed · ${formatTokens(c.preTokens)} → ${formatTokens(c.postTokens)}`;
}
