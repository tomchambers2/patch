// Host files REST (spec/03 § Host files, spec/15 § Host files and terminal).
//
// The phone's Files screen: list a directory, open a text file, save it back —
// on a named HOST, by absolute path, with no chat in between. The chat-scoped
// routes (`/api/chats/:id/files`) resolve every path through a chat's pinned
// folder, which left anything outside a chat (a skill in `~/.claude/skills`, a
// dotfile, a machine with no chat on it) out of reach.
//
//   GET /api/hosts/:daemonId/files?path=<abs>          list (no path = home)
//   GET /api/hosts/:daemonId/files/content?path=<abs>  read
//   PUT /api/hosts/:daemonId/files/content             write {path, content, baseVersion}
//
// Auth is exactly the folder browser's: a live surface credential, and a
// daemonId that names a machine this account registered. Each call round-trips
// one `patch.host_files.request` to that machine. NO FALLBACK: an offline host
// is refused up front (503) rather than left to time out, a timeout is a 504,
// and every host refusal keeps its own status — a save can never read as
// having landed when it did not.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { WireEvent } from '@patch/wire';
import type { Registry } from './registry.js';
import type { DaemonLink } from './daemon-link.js';
import { checkRegisteredHost, UNKNOWN_HOST_STATUS } from './host-addressing.js';
import { requireAuth } from './folder-routes.js';

export interface HostFilesRoutesDeps {
  logger: Logger;
  registry: Registry;
  daemonLink: DaemonLink;
  idGenerator: () => string;
}

/** Long enough for a megabyte each way over a slow link; still bounded. */
export const HOST_FILES_TIMEOUT_MS = 10_000;

/** A save's request body: up to 1 MiB of content, which JSON escaping can grow. */
export const HOST_FILES_BODY_LIMIT = 8 * 1024 * 1024;

type Response = Extract<WireEvent, { type: 'patch.host_files.response' }>;
type RequestBody = Omit<
  Extract<WireEvent, { type: 'patch.host_files.request' }>,
  'type' | 'requestId' | 'daemonId'
>;
type ErrorCode = NonNullable<Response['error']>['code'];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  path_invalid: 400,
  not_found: 404,
  not_a_directory: 400,
  not_a_file: 400,
  too_large: 413,
  binary: 415,
  conflict: 409,
  permission_denied: 403,
  internal: 502,
};

export function registerHostFilesRoutes(app: FastifyInstance, deps: HostFilesRoutesDeps): void {
  const pending = new Map<
    string,
    { resolve: (ev: Response) => void; timeout: NodeJS.Timeout; daemonId: string }
  >();
  deps.daemonLink.onEvent((event: WireEvent, from) => {
    if (event.type !== 'patch.host_files.response') return;
    const w = pending.get(event.requestId);
    if (!w) return;
    // Only the machine that was asked may answer — a reply naming another host
    // is a routing bug, not an answer.
    if (event.daemonId !== w.daemonId || (from !== null && from !== w.daemonId)) {
      deps.logger.warn(
        { requestId: event.requestId, asked: w.daemonId, answered: event.daemonId, from },
        'host files: response from a machine that was not asked; ignoring',
      );
      return;
    }
    pending.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });

  /**
   * The shared front half of every route: authenticate, check the host, build
   * the request (a string back from `build` is a 400 with that message), and
   * round-trip it. Returns the host's response, or null when a reply has
   * already been sent. Auth comes first, so an unauthenticated caller learns
   * nothing about what a valid body looks like.
   */
  async function roundTrip(
    req: FastifyRequest<{ Params: { daemonId: string } }>,
    reply: FastifyReply,
    build: () => RequestBody | string,
  ): Promise<Response | null> {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      await reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
      return null;
    }
    const daemonId = req.params.daemonId;
    const unknownHost = checkRegisteredHost(deps.registry, daemonId);
    if (unknownHost) {
      deps.logger.warn({ daemonId }, 'host files rejected: unregistered daemonId');
      await reply.code(UNKNOWN_HOST_STATUS).send(unknownHost);
      return null;
    }
    if (!deps.daemonLink.isOnline(daemonId)) {
      await reply
        .code(503)
        .send({ error: 'host_offline', message: `${daemonId} is offline`, daemonId });
      return null;
    }
    const body = build();
    if (typeof body === 'string') {
      await reply.code(400).send({ error: 'path_invalid', message: body });
      return null;
    }
    const requestId = deps.idGenerator();
    const result = await new Promise<Response | 'timeout'>((resolve) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        resolve('timeout');
      }, HOST_FILES_TIMEOUT_MS);
      pending.set(requestId, { resolve, timeout, daemonId });
      deps.daemonLink.sendTo(daemonId, auth.surfaceId, {
        type: 'patch.host_files.request',
        requestId,
        daemonId,
        ...body,
      });
    });
    if (result === 'timeout') {
      await reply.code(504).send({ error: 'daemon_timeout' });
      return null;
    }
    if (!result.ok) {
      const code = result.error?.code ?? 'internal';
      await reply
        .code(STATUS_BY_CODE[code])
        .send({ error: code, message: result.error?.message ?? 'host files error' });
      return null;
    }
    return result;
  }

  app.get<{ Params: { daemonId: string }; Querystring: { path?: string } }>(
    '/api/hosts/:daemonId/files',
    async (req, reply) => {
      const path = (req.query?.path ?? '').toString();
      const res = await roundTrip(req, reply, () => ({
        op: 'list',
        ...(path ? { path } : {}),
      }));
      if (!res) return reply;
      return reply
        .code(200)
        .send({ path: res.path, parent: res.parent ?? null, entries: res.entries ?? [] });
    },
  );

  app.get<{ Params: { daemonId: string }; Querystring: { path?: string } }>(
    '/api/hosts/:daemonId/files/content',
    async (req, reply) => {
      const path = (req.query?.path ?? '').toString();
      const res = await roundTrip(req, reply, () =>
        path ? { op: 'read', path } : 'path is required',
      );
      if (!res) return reply;
      return reply
        .code(200)
        .send({ path: res.path, content: res.content, size: res.size, version: res.version });
    },
  );

  app.put<{
    Params: { daemonId: string };
    Body: { path?: unknown; content?: unknown; baseVersion?: unknown };
  }>(
    '/api/hosts/:daemonId/files/content',
    // The editor's cap is 1 MiB of content; JSON escaping can grow that, and
    // the server-wide default body limit is exactly 1 MiB.
    { bodyLimit: HOST_FILES_BODY_LIMIT },
    async (req, reply) => {
      const body = req.body ?? {};
      const res = await roundTrip(req, reply, () =>
        typeof body.path === 'string' &&
        body.path !== '' &&
        typeof body.content === 'string' &&
        typeof body.baseVersion === 'string' &&
        body.baseVersion !== ''
          ? { op: 'write', path: body.path, content: body.content, baseVersion: body.baseVersion }
          : 'body must carry path, content and baseVersion',
      );
      if (!res) return reply;
      return reply.code(200).send({ path: res.path, size: res.size, version: res.version });
    },
  );
}
