// Serving one blob's bytes on request (spec/04 § History — blobs).
//
// Replay sends tool output as a reference, never a body: tool output is
// 85-99% of a long chat's bytes and every one of those rows arrives
// collapsed. This is the other half — what answers when the reader actually
// opens a row, or when an `<img>` goes after a picture.
//
// NO FALLBACK, matching `hostFiles.ts`: a sha this host does not hold is a
// typed `not_found`, never an empty success, so a missing blob can never be
// mistaken for an empty tool result.

import { Buffer } from 'node:buffer';
import type { Logger } from 'pino';
import { BLOB_FETCH_LIMIT_BYTES, type PatchBlobRequestEvent, type WireEvent } from '@patch/wire';

/** What the handler needs of the host — just the one read. */
export interface BlobSource {
  readChatBlob(chatId: string, sha: string): { bytes: Buffer; mime: string } | null;
}

/**
 * Answer one `patch.blob.request`. Every outcome — the bytes, or a typed
 * refusal — goes back as exactly one `patch.blob.response`.
 */
export function handleBlobRequest(
  event: PatchBlobRequestEvent,
  source: BlobSource,
  sender: (e: WireEvent) => void,
  logger: Logger,
  daemonId: string,
): void {
  const base = { type: 'patch.blob.response' as const, requestId: event.requestId, daemonId };
  try {
    const found = source.readChatBlob(event.chatId, event.sha);
    if (found === null) {
      sender({
        ...base,
        ok: false,
        error: { code: 'not_found', message: `no blob ${event.sha} on this host` },
      });
      return;
    }
    if (found.bytes.length > BLOB_FETCH_LIMIT_BYTES) {
      sender({
        ...base,
        ok: false,
        error: {
          code: 'too_large',
          message: `blob is ${found.bytes.length} bytes, over the ${BLOB_FETCH_LIMIT_BYTES} limit`,
        },
      });
      return;
    }
    sender({ ...base, ok: true, mime: found.mime, data: found.bytes.toString('base64') });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ sha: event.sha, chatId: event.chatId, err: message }, 'blob read failed');
    sender({ ...base, ok: false, error: { code: 'internal', message } });
  }
}
