// Serving one blob's bytes (spec/04 § History — blobs, spec/01 § Endpoints).
//
//   GET /api/chats/:chatId/blob/:sha
//
// Replay sends tool output as a REFERENCE, never a body, because tool output
// is 85-99% of a long chat's bytes and every one of those rows draws
// collapsed. This is where a body comes from once someone actually opens a
// row, and where an `<img>` goes for a picture.
//
// Unauthenticated, exactly like the attachment and artifact serve-backs and
// the APK download: an `<img src>` cannot attach a bearer header, and the id
// is a 64-hex content hash — unguessable, and already equal to the content
// anyone quoting it would have to know. The chatId still has to name a chat
// this account has, and only the host that owns that chat is asked.
//
// Cached `immutable` because the sha IS the content: a blob can never change
// under a reader, so a surface that has fetched one never asks again. That is
// what makes reopening a chat — or restarting the app entirely — not
// re-download a single picture or tool result it already holds.
//
// NO FALLBACK (mirrors host-files-routes.ts): an offline host is refused up
// front with a 503 rather than left to time out, a timeout is a 504, and
// every host refusal keeps its own status. A missing blob is a 404 and can
// never read as an empty tool result.

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { WireEvent } from '@patch/wire';
import type { ChatRegistry } from './chat-registry.js';
import type { DaemonLink } from './daemon-link.js';
import type { ChatLogStore } from './chat-log-store.js';

export interface BlobRoutesDeps {
  logger: Logger;
  chatRegistry: ChatRegistry;
  daemonLink: DaemonLink;
  /** The server's own log: a big result it stored is served from here, with no host involved. */
  chatLogStore?: Pick<ChatLogStore, 'readBlob'>;
  idGenerator: () => string;
}

/** The surface id the bridge speaks as — mirrors the artifact bridge. */
const BRIDGE_SURFACE_ID = 'blob-bridge';
/** Generous for a few megabytes off a host's disk; still bounded. */
export const BLOB_TIMEOUT_MS = 15_000;
/** A content hash, charset-checked before it is used for anything. */
const SHA_RE = /^[0-9a-f]{64}$/;

type Response = Extract<WireEvent, { type: 'patch.blob.response' }>;
type ErrorCode = NonNullable<Response['error']>['code'];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  not_found: 404,
  too_large: 413,
  internal: 502,
};

export function registerBlobRoutes(app: FastifyInstance, deps: BlobRoutesDeps): void {
  const pending = new Map<
    string,
    { resolve: (ev: Response) => void; timeout: NodeJS.Timeout; daemonId: string }
  >();

  deps.daemonLink.onEvent((event: WireEvent, from) => {
    if (event.type !== 'patch.blob.response') return;
    const w = pending.get(event.requestId);
    if (!w) return;
    // Only the machine that was asked may answer — a reply naming another
    // host is a routing bug, not an answer.
    if (event.daemonId !== w.daemonId || (from !== null && from !== w.daemonId)) {
      deps.logger.warn(
        { requestId: event.requestId, asked: w.daemonId, answered: event.daemonId, from },
        'blob: response from a machine that was not asked; ignoring',
      );
      return;
    }
    pending.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });

  app.get<{ Params: { chatId: string; sha: string } }>(
    '/api/chats/:chatId/blob/:sha',
    async (req, reply) => {
      const { chatId, sha } = req.params;
      if (!SHA_RE.test(sha)) {
        return reply.code(400).send({ error: 'bad_sha', message: 'sha must be 64 hex characters' });
      }
      const chat = deps.chatRegistry.get(chatId);
      if (!chat) {
        return reply
          .code(404)
          .send({ error: 'chat_not_found', message: `chat not found: ${chatId}` });
      }
      // A result the server kept itself needs no host at all, online or not.
      const held = deps.chatLogStore?.readBlob(sha);
      if (held) {
        return reply
          .code(200)
          .header('content-type', held.mime)
          .header('content-length', String(held.bytes.byteLength))
          .header('cache-control', 'public, max-age=31536000, immutable')
          .send(held.bytes);
      }
      const daemonId = chat.daemonId;
      if (!deps.daemonLink.isOnline(daemonId)) {
        return reply
          .code(503)
          .send({ error: 'host_offline', message: `${daemonId} is offline`, daemonId });
      }

      const requestId = deps.idGenerator();
      const result = await new Promise<Response | 'timeout'>((resolve) => {
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          resolve('timeout');
        }, BLOB_TIMEOUT_MS);
        pending.set(requestId, { resolve, timeout, daemonId });
        deps.daemonLink.sendTo(daemonId, BRIDGE_SURFACE_ID, {
          type: 'patch.blob.request',
          requestId,
          daemonId,
          chatId,
          sha,
        });
      });

      if (result === 'timeout') {
        deps.logger.warn({ chatId, sha, daemonId }, 'blob: host did not answer in time');
        return reply
          .code(504)
          .send({ error: 'host_timeout', message: `${daemonId} did not answer in time` });
      }
      if (!result.ok || result.data === undefined) {
        const code = result.error?.code ?? 'internal';
        return reply
          .code(STATUS_BY_CODE[code])
          .send({ error: code, message: result.error?.message ?? 'blob fetch failed' });
      }

      const bytes = Buffer.from(result.data, 'base64');
      return reply
        .code(200)
        .header('content-type', result.mime ?? 'application/octet-stream')
        .header('content-length', String(bytes.byteLength))
        .header('cache-control', 'public, max-age=31536000, immutable')
        .send(bytes);
    },
  );
}
