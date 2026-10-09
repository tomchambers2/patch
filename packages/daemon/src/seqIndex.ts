// The canonical-seq sidecar's two pure halves, shared by `chatRunner` (which
// writes and resolves it) and `chatSearch` (which only ever reads it — a search
// must never allocate a seq as a side effect).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Hash of a payload identity (`eventIdentity`). The canonical seq sidecar is an
 * INDEX, not a second transcript: it stores `{seq, hash}` only, so message text
 * lives in exactly one store (spec/04 § Chat model — `~/.patch/chats/<chatId>/`
 * "holds ... no transcript").
 */
export function identityHash(key: string): string {
  return createHash('sha256').update(key).digest('base64url').slice(0, 22);
}

/**
 * Read a chat's sidecar into `hash → seqs in recording order`. Repeated
 * payloads (the user asking the same thing twice) each hold their own entry and
 * are consumed in order, so the n-th occurrence in the transcript resolves to
 * the n-th seq. A seq recorded more than once keeps its FIRST entry only. A
 * missing file is an empty index (a chat that has never emitted anything).
 */
export function readSeqIndexFile(path: string, chatId: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (!existsSync(path)) return out;
  const seen = new Set<number>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.length === 0) continue;
    const parsed = JSON.parse(line) as { seq?: unknown; hash?: unknown };
    if (typeof parsed.seq !== 'number' || typeof parsed.hash !== 'string') {
      throw new Error(`seq index: corrupt line for ${chatId}: ${JSON.stringify(line)}`);
    }
    if (seen.has(parsed.seq)) continue;
    seen.add(parsed.seq);
    const list = out.get(parsed.hash);
    if (list) list.push(parsed.seq);
    else out.set(parsed.hash, [parsed.seq]);
  }
  return out;
}
