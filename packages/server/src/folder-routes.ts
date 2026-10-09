// Folder-registry REST endpoint (spec/04 § Folders).
//
// `GET /api/folders` serves the host-owned folder list for cold-start: a
// surface that connects after the host published its `folders.list` snapshot
// reads the current list here rather than waiting for the next push. Mirrors
// how `GET /api/chats` exposes the ChatRegistry mirror. Live updates still
// arrive over the WS (`folders.list` / `folders.updated` fan-out).
//
// Same surface-JWT gate as the sibling `/api/chats` / `/api/settings` routes.
// NO FALLBACK — missing/invalid/revoked → 401.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { verifySurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import type { Registry } from './registry.js';
import type { FolderRegistry } from './folder-registry.js';
import type { DaemonLink } from './daemon-link.js';
import { checkRegisteredHost, UNKNOWN_HOST_STATUS } from './host-addressing.js';

export async function requireAuth(
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

export interface FolderRoutesDeps {
  logger: Logger;
  registry: Registry;
  folderRegistry: FolderRegistry;
  daemonLink: DaemonLink;
  idGenerator: () => string;
}

/** How long GET /api/folders/browse blocks waiting for the host RPC. */
const BROWSE_REQUEST_TIMEOUT_MS = 5_000;

export function registerFolderRoutes(app: FastifyInstance, deps: FolderRoutesDeps): void {
  // ---- GET /api/folders ----
  // The flat published registry — the one-tap shortcut for the common case.
  app.get('/api/folders', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return (
        reply
          // requireAuth's only throw site always sets statusCode=401.
          /* v8 ignore next */
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message })
      );
    }
    // Grouped by host, because the picker renders one group per machine
    // (spec/04 § Folders). A flat union would make two hosts' identical paths
    // indistinguishable.
    return reply.code(200).send({ hosts: deps.folderRegistry.list() });
  });

  // ---- GET /api/folders/browse?dir=<abs> ----
  // spec/04 § Browsing (directory listing) — the folder BROWSER. Round-trips
  // `patch.folders.browse.request` over the daemon-link (the host owns the
  // project filesystem) and returns its child-directory listing. With no `dir`
  // the host returns its browsable roots. NO FALLBACK: a dir escaping the
  // project roots → 404 folder_not_found; timeout → 504.
  const browsePending = new Map<
    string,
    {
      resolve: (ev: Extract<WireEvent, { type: 'patch.folders.browse.response' }>) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  deps.daemonLink.onEvent((event: WireEvent) => {
    if (event.type !== 'patch.folders.browse.response') return;
    const w = browsePending.get(event.requestId);
    if (!w) return;
    browsePending.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });
  app.get<{ Querystring: { dir?: string; daemonId?: string } }>(
    '/api/folders/browse',
    async (req, reply) => {
      let auth;
      try {
        auth = await requireAuth(req, deps.registry);
      } catch (e) {
        return (
          reply
            // requireAuth's only throw site always sets statusCode=401.
            /* v8 ignore next */
            .code((e as Error & { statusCode?: number }).statusCode ?? 401)
            .send({ error: (e as Error).message })
        );
      }
      // Browsing is addressed to ONE host — the surface must say which, because
      // it is never the surface's own filesystem being browsed (spec/04 §
      // Browsing).
      const daemonId = (req.query?.daemonId ?? '').toString().trim();
      if (!daemonId) {
        return reply.code(400).send({ error: 'invalid query', message: 'daemonId is required' });
      }
      // …and it must be a machine this account registered. Browsing an unknown
      // machine's filesystem must not fall through to whichever host is
      // attached — that would list the wrong host's directories.
      const unknownHost = checkRegisteredHost(deps.registry, daemonId);
      if (unknownHost) {
        deps.logger.warn({ daemonId }, 'GET /api/folders/browse rejected: unregistered daemonId');
        return reply.code(UNKNOWN_HOST_STATUS).send(unknownHost);
      }
      const dir = (req.query?.dir ?? '').toString().trim();
      const requestId = deps.idGenerator();
      const result = await new Promise<
        Extract<WireEvent, { type: 'patch.folders.browse.response' }> | 'timeout'
      >((resolveP) => {
        const timeout = setTimeout(() => {
          browsePending.delete(requestId);
          resolveP('timeout');
        }, BROWSE_REQUEST_TIMEOUT_MS);
        browsePending.set(requestId, { resolve: resolveP, timeout });
        deps.daemonLink.send(auth.surfaceId, {
          type: 'patch.folders.browse.request',
          requestId,
          daemonId,
          // Empty dir → omit so the host returns its browsable roots.
          ...(dir ? { dir } : {}),
        });
      });
      if (result === 'timeout') {
        return reply.code(504).send({ error: 'daemon_timeout' });
      }
      if (!result.ok) {
        const code = result.error?.code ?? 'internal';
        const status = code === 'folder_not_found' ? 404 : 502;
        return reply
          .code(status)
          .send({ error: code, message: result.error?.message ?? 'browse error' });
      }
      return reply.code(200).send({
        daemonId: result.daemonId,
        dir: result.dir ?? null,
        parent: result.parent ?? null,
        entries: result.entries ?? [],
      });
    },
  );
}
