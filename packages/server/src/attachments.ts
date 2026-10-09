// Composer attachment routes (spec/14 § Composer, spec/15 § Composer —
// "Attachments (images + files)").
//
// Two endpoints, both mirroring existing patterns in this codebase:
//   1. `POST /api/chats/:chatId/attachment` (multipart: a required `file` field
//      and an optional `model` one) — mirrors the voice-note upload route
//      (`voice/note.ts`): verify the surface credential, reject an unknown chat,
//      buffer the file, then:
//        a. store the `file` bytes + a small metadata sidecar to the server's own
//           attachments dir (so the GET below can serve it back for inline
//           rendering), and
//        b. round-trip the bytes to the HOST over the host link
//           (`patch.attachment.store_*`) so Claude — which runs on the host
//           with the chat folder as cwd — has a copy it can read by path.
//      `file` is the user's ORIGINAL and `model` the client's downscaled copy, so
//      the stream renders full size while the agent reads something inside its
//      vision limits (spec/15 § Composer). Only an actual downscale sends `model`.
//      Returns `{ ok: true, ref }` where `ref` is the wire `AttachmentRef` plus
//      the relative `url` the surface renders inline.
//   2. `GET /api/chats/:chatId/attachment/:id` — mirrors the public APK
//      download static-serve (`app.ts` `/api/download/:name`): streams the
//      stored file back with its mime type. Unauthenticated (like the download
//      route) so an `<img src>` in the chat stream can load it without a bearer
//      header the browser can't attach; the ULID `id` is unguessable and the
//      route is path-traversal-safe (id is charset-validated, never a filename).
//
// NO FALLBACK: a missing/invalid credential → 401; an unknown chat → 404; the
// host being silent → 504; a host-side write failure → 502. The attachment
// is NEVER silently dropped.

import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { verifySurfaceCredential } from '@patch/auth';
import { type AttachmentKind, type AttachmentRef, type WireEvent } from '@patch/wire';
import type { Registry } from './registry.js';
import type { ChatRegistry } from './chat-registry.js';
import type { DaemonLink } from './daemon-link.js';

const STORE_REQUEST_TIMEOUT_MS = 30_000;
/** Reject files larger than this before spending a host round-trip on them. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Server-minted ids are ULIDs — charset-validate before touching the fs (no traversal). */
const ID_RE = /^[0-9A-Za-z]+$/;

async function requireAuth(
  req: FastifyRequest,
  registry: Registry,
): Promise<{ surfaceId: string }> {
  const generic = (): Error & { statusCode?: number } => {
    const e = new Error('unauthenticated') as Error & { statusCode?: number };
    e.statusCode = 401;
    return e;
  };
  const account = registry.getAccount();
  if (!account) throw generic();
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) throw generic();
  const jwt = authHeader.slice('Bearer '.length).trim();
  let claims;
  try {
    claims = await verifySurfaceCredential(jwt, { userPublicKey: account.userPublicKey });
  } catch {
    throw generic();
  }
  if (registry.isRevoked(claims.surface_id)) throw generic();
  return { surfaceId: claims.surface_id };
}

/** `image/*` → inline picture; everything else → file chip (spec § Composer). */
function kindForMime(mime: string): AttachmentKind {
  return mime.toLowerCase().startsWith('image/') ? 'image' : 'file';
}

interface AttachmentSidecar {
  name: string;
  mimeType: string;
  kind: AttachmentKind;
}

export interface AttachmentRoutesDeps {
  logger: Logger;
  registry: Registry;
  chatRegistry: ChatRegistry;
  daemonLink: DaemonLink;
  idGenerator: () => string;
  /** Root the server writes its serving-copies under: `<dir>/<chatId>/<id>`. */
  attachmentsDir: string;
}

export function registerAttachmentRoutes(app: FastifyInstance, deps: AttachmentRoutesDeps): void {
  // Correlate `patch.attachment.store_response` frames back to the awaiting HTTP
  // call (same pattern as voice-note / secrets / skills RPCs).
  const pending = new Map<
    string,
    {
      resolve: (ev: Extract<WireEvent, { type: 'patch.attachment.store_response' }>) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  deps.daemonLink.onEvent((event: WireEvent) => {
    if (event.type !== 'patch.attachment.store_response') return;
    const w = pending.get(event.requestId);
    if (!w) return;
    pending.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });

  function awaitDaemon(
    surfaceId: string,
    build: (requestId: string) => WireEvent,
  ): Promise<Extract<WireEvent, { type: 'patch.attachment.store_response' }> | 'timeout'> {
    const requestId = deps.idGenerator();
    return new Promise((resolveP) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        resolveP('timeout');
      }, STORE_REQUEST_TIMEOUT_MS);
      pending.set(requestId, { resolve: resolveP, timeout });
      deps.daemonLink.send(surfaceId, build(requestId));
    });
  }

  // ---- upload ----
  app.post<{ Params: { chatId: string } }>('/api/chats/:chatId/attachment', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }

    const chatId = req.params.chatId;
    if (!chatId || chatId.length === 0) {
      return reply.code(400).send({ error: 'chatId is required' });
    }

    if (!req.isMultipart()) {
      return reply.code(400).send({ error: 'expected multipart/form-data' });
    }
    let bytes: Buffer | undefined;
    let modelBytes: Buffer | undefined;
    let filename = 'attachment';
    let mimeType = 'application/octet-stream';
    try {
      // TWO file parts, not one (the app-wide default): `file` is the original,
      // `model` the downscaled copy for the agent (spec/15 § Composer).
      const parts = req.parts({ limits: { files: 2 } });
      for await (const part of parts) {
        if (part.type === 'file') {
          if (part.fieldname === 'model') {
            modelBytes = await part.toBuffer();
            continue;
          }
          if (part.fieldname !== 'file') {
            // Drain unexpected files so the stream doesn't stall.
            await part.toBuffer();
            continue;
          }
          bytes = await part.toBuffer();
          if (part.filename && part.filename.length > 0) filename = part.filename;
          if (part.mimetype && part.mimetype.length > 0) mimeType = part.mimetype;
        }
      }
    } catch (err) {
      return reply.code(400).send({ error: `invalid multipart body: ${(err as Error).message}` });
    }

    if (!bytes || bytes.byteLength === 0) {
      return reply.code(400).send({ error: 'file is required' });
    }
    // Unreachable via HTTP: @fastify/multipart's own `fileSize` limit (app.ts,
    // registered at the same 25MB ceiling) always truncates/rejects an
    // oversized part first, landing in the `catch` above with a 400, so
    // `bytes.byteLength` can never exceed this here.
    /* v8 ignore next 3 */
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      return reply.code(413).send({ error: 'attachment too large' });
    }

    // NO SILENT FALLBACK (mirrors /voice/note): an attachment for an unknown
    // chatId must be rejected, not stored-then-orphaned.
    if (!deps.chatRegistry.get(chatId)) {
      return reply.code(404).send({ error: `chat not found: ${chatId}` });
    }

    const id = deps.idGenerator();
    const kind = kindForMime(mimeType);

    // (a) Store the server's serving-copy + a metadata sidecar. The id is the
    // on-disk name (a server-minted ULID) so the original filename never
    // reaches the fs path — no traversal is possible.
    try {
      const dir = join(deps.attachmentsDir, chatId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, id), bytes);
      const sidecar: AttachmentSidecar = { name: filename, mimeType, kind };
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(sidecar), 'utf8');
    } catch (err) {
      deps.logger.error({ chatId, err: (err as Error).message }, 'attachment: server store failed');
      return reply.code(500).send({ error: 'internal' });
    }

    // (b) Hand a copy to the host so Claude can read it by path. NO FALLBACK:
    // a timeout/daemon error fails the whole upload — the ref would be useless
    // to the agent otherwise.
    //
    // The agent gets the DOWNSCALED copy (within the vision limits) while the
    // original above is what gets served and rendered. No `model` part is not an
    // error being swallowed: it means the client had nothing to downscale (the
    // image was already within the cap, or it isn't an image), so the one blob
    // legitimately serves both purposes.
    const dataBase64 = (modelBytes ?? bytes).toString('base64');
    const result = await awaitDaemon(auth.surfaceId, (requestId) => ({
      type: 'patch.attachment.store_request',
      requestId,
      chatId,
      id,
      name: filename,
      mimeType,
      kind,
      dataBase64,
    }));

    if (result === 'timeout') {
      deps.logger.warn({ chatId, id }, 'attachment: host store timed out');
      return reply.code(504).send({ error: 'daemon_timeout' });
    }
    if (!result.ok) {
      const code = result.error?.code ?? 'internal';
      const status = code === 'chat_not_found' ? 404 : 502;
      return reply
        .code(status)
        .send({ error: code, message: result.error?.message ?? 'attachment store failed' });
    }

    const ref: AttachmentRef & { url: string } = {
      id,
      name: filename,
      mimeType,
      kind,
      url: `/api/chats/${chatId}/attachment/${id}`,
    };
    return reply.code(200).send({ ok: true, ref });
  });

  // ---- serve back (inline rendering) ----
  app.get<{ Params: { chatId: string; id: string } }>(
    '/api/chats/:chatId/attachment/:id',
    { logLevel: 'warn' },
    async (req, reply) => {
      const { chatId, id } = req.params;
      if (!ID_RE.test(id) || chatId.includes('/') || chatId.includes('..')) {
        return reply.code(404).send({ error: 'not found' });
      }
      const dir = join(deps.attachmentsDir, chatId);
      const dataPath = join(dir, id);
      const metaPath = join(dir, `${id}.json`);
      if (!existsSync(dataPath) || !existsSync(metaPath)) {
        return reply.code(404).send({ error: 'attachment not found' });
      }
      let sidecar: AttachmentSidecar;
      try {
        sidecar = JSON.parse(readFileSync(metaPath, 'utf8')) as AttachmentSidecar;
      } catch {
        return reply.code(404).send({ error: 'attachment not found' });
      }
      return (
        reply
          .code(200)
          .header('content-type', sidecar.mimeType)
          .header('content-length', String(statSync(dataPath).size))
          // `inline` so images render in-page; the filename rides for downloads.
          .header(
            'content-disposition',
            `inline; filename="${sidecar.name.replace(/["\\]/g, '_')}"`,
          )
          .send(createReadStream(dataPath))
      );
    },
  );
}
