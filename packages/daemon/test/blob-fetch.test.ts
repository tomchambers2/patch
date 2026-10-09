// Answering one `patch.blob.request` (spec/04 § History — blobs).
//
// The body replay deliberately did not send. Every outcome has to be exactly
// one typed response: a missing blob must never come back as an empty
// success, or a tool result that failed to load would read as a tool that
// returned nothing.

import { describe, it, expect } from 'vitest';
import { Buffer } from 'node:buffer';
import pino from 'pino';
import { BLOB_FETCH_LIMIT_BYTES, type WireEvent } from '@patch/wire';
import { handleBlobRequest, type BlobSource } from '../src/blobFetch.js';

const silent = pino({ level: 'silent' });
const SHA = 'b'.repeat(64);

function ask(source: BlobSource): Extract<WireEvent, { type: 'patch.blob.response' }>[] {
  const sent: WireEvent[] = [];
  handleBlobRequest(
    { type: 'patch.blob.request', requestId: 'r1', daemonId: 'd1', chatId: 'c1', sha: SHA },
    source,
    (e) => sent.push(e),
    silent,
    'd1',
  );
  return sent.filter((e) => e.type === 'patch.blob.response');
}

describe('handleBlobRequest', () => {
  it('returns the bytes base64 with their media type, exactly once', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const out = ask({ readChatBlob: () => ({ bytes, mime: 'image/png' }) });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      requestId: 'r1',
      daemonId: 'd1',
      ok: true,
      mime: 'image/png',
      data: bytes.toString('base64'),
    });
  });

  it('asks the store for the sha under the chat it was asked about', () => {
    const seen: Array<[string, string]> = [];
    ask({
      readChatBlob: (chatId, sha) => {
        seen.push([chatId, sha]);
        return null;
      },
    });
    expect(seen).toEqual([['c1', SHA]]);
  });

  it('a sha this host does not hold is not_found, never an empty success', () => {
    const out = ask({ readChatBlob: () => null });
    expect(out[0]!.ok).toBe(false);
    expect(out[0]!.error?.code).toBe('not_found');
    expect(out[0]!.data).toBeUndefined();
  });

  it('refuses a blob over the transfer limit rather than trying to send it', () => {
    const out = ask({
      readChatBlob: () => ({
        bytes: Buffer.alloc(BLOB_FETCH_LIMIT_BYTES + 1),
        mime: 'application/json',
      }),
    });
    expect(out[0]!.ok).toBe(false);
    expect(out[0]!.error?.code).toBe('too_large');
  });

  it('turns a throwing store into one internal response, not an unhandled throw', () => {
    const out = ask({
      readChatBlob: () => {
        throw new Error('chat not found: c1');
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.ok).toBe(false);
    expect(out[0]!.error).toMatchObject({ code: 'internal', message: 'chat not found: c1' });
  });
});
