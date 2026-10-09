// Secrets REST endpoints (spec/15 § Settings tab — Secrets).
//
// Secrets are editable from any surface. The host owns the store (it injects
// them into chats); the server:
//   - serves the host-published mirror for cold-start reads
//     (`GET /api/secrets`), mirroring `GET /api/folders`, and
//   - round-trips writes to the host over the host link, correlated by
//     `requestId` exactly like `GET /api/skills` (`patch.skills.*`):
//       `PUT    /api/secrets/:key`  → `patch.secrets.set_request`
//       `DELETE /api/secrets/:key`  → `patch.secrets.delete_request`
//     both awaiting `patch.secrets.response`.
// On success the host also emits `secrets.updated`, so the mirror + every live
// surface reflect the write immediately.
//
// Same surface-JWT gate as the sibling `/api/folders` / `/api/chats` routes.
// NO FALLBACK — missing/invalid/revoked → 401; host silence → 504.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { verifySurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import type { Registry } from './registry.js';
import type { SecretsRegistry } from './secrets-registry.js';
import type { DaemonLink } from './daemon-link.js';

const SECRETS_REQUEST_TIMEOUT_MS = 5_000;

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

export interface SecretsRoutesDeps {
  logger: Logger;
  registry: Registry;
  secretsRegistry: SecretsRegistry;
  daemonLink: DaemonLink;
  idGenerator: () => string;
}

export function registerSecretsRoutes(app: FastifyInstance, deps: SecretsRoutesDeps): void {
  // Correlate `patch.secrets.response` frames back to the awaiting HTTP call.
  const pending = new Map<
    string,
    {
      resolve: (ev: Extract<WireEvent, { type: 'patch.secrets.response' }>) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  deps.daemonLink.onEvent((event: WireEvent) => {
    if (event.type !== 'patch.secrets.response') return;
    const w = pending.get(event.requestId);
    if (!w) return;
    pending.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });

  function awaitDaemon(
    surfaceId: string,
    build: (requestId: string) => WireEvent,
  ): Promise<Extract<WireEvent, { type: 'patch.secrets.response' }> | 'timeout'> {
    const requestId = deps.idGenerator();
    return new Promise((resolveP) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        resolveP('timeout');
      }, SECRETS_REQUEST_TIMEOUT_MS);
      pending.set(requestId, { resolve: resolveP, timeout });
      deps.daemonLink.send(surfaceId, build(requestId));
    });
  }

  // ---- GET /api/secrets ----
  app.get('/api/secrets', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return (
        reply
          // requireAuth's only throw site always sets statusCode=401, so `?? 401`
          // is defensive-only and unreachable here.
          /* v8 ignore next */
          .code((e as Error & { statusCode?: number }).statusCode ?? 401)
          .send({ error: (e as Error).message })
      );
    }
    return reply.code(200).send({ secrets: deps.secretsRegistry.list() });
  });

  // ---- PUT /api/secrets/:key ---- (upsert)
  app.put<{ Params: { key: string }; Body: { value?: unknown } }>(
    '/api/secrets/:key',
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
      // Fastify only matches this route with a :key segment present, so
      // req.params.key is always a defined string — `?? ''` is defensive-only.
      /* v8 ignore next */
      const key = (req.params.key ?? '').trim();
      if (!key) {
        return reply.code(400).send({ error: 'key_required', message: 'key is required' });
      }
      const value = req.body?.value;
      if (typeof value !== 'string') {
        return reply.code(400).send({ error: 'value_required', message: 'value must be a string' });
      }
      const result = await awaitDaemon(auth.surfaceId, (requestId) => ({
        type: 'patch.secrets.set_request',
        requestId,
        key,
        value,
      }));
      return replyForMutation(reply, result);
    },
  );

  // ---- DELETE /api/secrets/:key ----
  app.delete<{ Params: { key: string } }>('/api/secrets/:key', async (req, reply) => {
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
    // Fastify only matches this route with a :key segment present, so
    // req.params.key is always a defined string — `?? ''` is defensive-only.
    /* v8 ignore next */
    const key = (req.params.key ?? '').trim();
    if (!key) {
      return reply.code(400).send({ error: 'key_required', message: 'key is required' });
    }
    const result = await awaitDaemon(auth.surfaceId, (requestId) => ({
      type: 'patch.secrets.delete_request',
      requestId,
      key,
    }));
    return replyForMutation(reply, result);
  });
}

function replyForMutation(
  reply: import('fastify').FastifyReply,
  result: Extract<WireEvent, { type: 'patch.secrets.response' }> | 'timeout',
): import('fastify').FastifyReply {
  if (result === 'timeout') {
    return reply.code(504).send({ error: 'daemon_timeout' });
  }
  if (!result.ok) {
    const code = result.error?.code ?? 'internal';
    const status = code === 'invalid_key' ? 400 : code === 'not_found' ? 404 : 502;
    return reply
      .code(status)
      .send({ error: code, message: result.error?.message ?? 'secret write failed' });
  }
  return reply.code(200).send({ ok: true });
}
