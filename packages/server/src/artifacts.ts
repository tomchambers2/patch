// Artifacts — the server half of Patch's own Artifact tool (spec/14
// § Artifacts, spec/01 § Endpoints).
//
// Two pieces:
//   1. A daemon-link bridge for `patch.artifact.publish_request` (mirrors
//      jobs/rpc-bridge.ts): write the page under `<artifactsDir>/<chatId>/`,
//      reply `patch.artifact.publish_response` with the URL it is now served
//      from. The host only stamps the chat card AFTER this reply, so a
//      failure here never produces a URL that 404s.
//   2. `GET /api/chats/:chatId/artifact/:artifactId` — serves the stored page.
//      Not public: it needs a surface bearer, or a signed link (`?sig=`). The
//      page has to load in a webview/iframe/<img> that cannot attach a bearer
//      header, so the URL handed back at publish carries an HMAC signature
//      (server secret, never guessable from the ids). `POST .../share` mints a
//      separate EXPIRING signed link for handing to someone else, and
//      `DELETE .../share` revokes every share link for that artifact. Served with `Content-Security-Policy: sandbox allow-scripts` so
//      agent-authored script runs in an OPAQUE origin and can never read the
//      SPA's stored credential or call the API as the user.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { PatchArtifactPublishRequestEvent, type WireEvent } from '@patch/wire';
import { verifySurfaceCredential } from '@patch/auth';
import type { DaemonLink } from './daemon-link.js';
import type { Registry } from './registry.js';

const BRIDGE_SURFACE_ID = 'artifact-bridge';
/** Ids are daemon-minted hex digests; charset-validate before touching the fs. */
const ID_RE = /^[0-9a-f]{2,64}$/;
/** Mirrors the host-side ceiling (spec/14 § Artifacts), post-wrapping. */
const MAX_ARTIFACT_BYTES = 3 * 1024 * 1024;
/** Opaque origin: agent-authored script cannot touch the SPA's origin. */
export const ARTIFACT_CSP = 'sandbox allow-scripts';

/** A `raw`-published artifact's sidecar: what content-type to serve `<id>.bin`
 * back with. Its mere presence (checked before `<id>.html`) is what tells the
 * GET route which of the two this id is — see `registerArtifactRoutes` below. */
interface RawArtifactSidecar {
  contentType: string;
}

export interface ArtifactRoutesDeps {
  logger: Logger;
  daemonLink: DaemonLink;
  registry: Registry;
  /** Root artifacts are written under: `<dir>/<chatId>/<artifactId>.html`. */
  artifactsDir: string;
}

const DEFAULT_SHARE_TTL_S = 7 * 24 * 3600;
const MIN_SHARE_TTL_S = 60;
const MAX_SHARE_TTL_S = 30 * 24 * 3600;

/** The signing secret outlives restarts (links in transcripts must keep working)
 * and is created once. A malformed file is a loud failure: regenerating it
 * would silently kill every link already issued. */
export function loadLinkSecret(artifactsDir: string): Buffer {
  mkdirSync(artifactsDir, { recursive: true });
  const file = join(artifactsDir, '.link-secret');
  if (!existsSync(file)) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, randomBytes(32).toString('hex'), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
  }
  const secret = Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  if (secret.length !== 32) throw new Error(`artifact link secret ${file} is malformed`);
  return secret;
}

function safeChatId(chatId: string): boolean {
  return chatId.length > 0 && !chatId.includes('/') && !chatId.includes('..');
}

export function registerArtifactRoutes(app: FastifyInstance, deps: ArtifactRoutesDeps): () => void {
  const secret = loadLinkSecret(deps.artifactsDir);
  const sign = (...parts: (string | number)[]): string =>
    createHmac('sha256', secret).update(parts.join('|')).digest('hex');
  const same = (a: string, b: string): boolean =>
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const appSig = (chatId: string, artifactId: string): string => sign('app', chatId, artifactId);
  const epochFile = (chatId: string, artifactId: string): string =>
    join(deps.artifactsDir, chatId, `${artifactId}.share-epoch`);
  const readEpoch = (chatId: string, artifactId: string): number => {
    const f = epochFile(chatId, artifactId);
    return existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0;
  };
  const shareSig = (chatId: string, artifactId: string, exp: number): string =>
    sign('share', chatId, artifactId, exp, readEpoch(chatId, artifactId));
  const artifactUrl = (chatId: string, artifactId: string): string =>
    `/api/chats/${chatId}/artifact/${artifactId}?sig=${appSig(chatId, artifactId)}`;

  async function hasBearer(req: FastifyRequest): Promise<boolean | 'invalid'> {
    const header = req.headers.authorization;
    if (!header) return false;
    const account = deps.registry.getAccount();
    if (!account || !header.startsWith('Bearer ')) return 'invalid';
    try {
      const claims = await verifySurfaceCredential(header.slice('Bearer '.length).trim(), {
        userPublicKey: account.userPublicKey,
      });
      return deps.registry.isRevoked(claims.surface_id) ? 'invalid' : true;
    } catch {
      return 'invalid';
    }
  }

  const artifactExists = (chatId: string, artifactId: string): boolean =>
    existsSync(join(deps.artifactsDir, chatId, `${artifactId}.html`)) ||
    existsSync(join(deps.artifactsDir, chatId, `${artifactId}.meta.json`));

  const unsub = deps.daemonLink.onEvent((event: WireEvent) => {
    if (event.type !== 'patch.artifact.publish_request') return;
    const parsed = PatchArtifactPublishRequestEvent.safeParse(event);
    const reply = (out: WireEvent): void => deps.daemonLink.send(BRIDGE_SURFACE_ID, out);
    if (!parsed.success) {
      reply({
        type: 'patch.artifact.publish_response',
        requestId: event.requestId,
        ok: false,
        error: { code: 'invalid_data', message: parsed.error.message },
      });
      return;
    }
    const { requestId, chatId, artifactId, html, raw } = parsed.data;
    if (!safeChatId(chatId) || !ID_RE.test(artifactId)) {
      reply({
        type: 'patch.artifact.publish_response',
        requestId,
        ok: false,
        error: { code: 'invalid_data', message: 'invalid chatId or artifactId' },
      });
      return;
    }
    if ((html === undefined) === (raw === undefined)) {
      reply({
        type: 'patch.artifact.publish_response',
        requestId,
        ok: false,
        error: { code: 'invalid_data', message: 'exactly one of html/raw must be set' },
      });
      return;
    }
    if (Buffer.byteLength(html ?? raw!.base64, 'utf8') > MAX_ARTIFACT_BYTES) {
      reply({
        type: 'patch.artifact.publish_response',
        requestId,
        ok: false,
        error: { code: 'invalid_data', message: 'artifact too large' },
      });
      return;
    }
    try {
      const dir = join(deps.artifactsDir, chatId);
      mkdirSync(dir, { recursive: true });
      // Republish overwrites in place — same id, same URL (spec/14).
      if (raw !== undefined) {
        writeFileSync(join(dir, `${artifactId}.bin`), Buffer.from(raw.base64, 'base64'));
        writeFileSync(
          join(dir, `${artifactId}.meta.json`),
          JSON.stringify({ contentType: raw.contentType } satisfies RawArtifactSidecar),
          'utf8',
        );
      } else {
        writeFileSync(join(dir, `${artifactId}.html`), html!, 'utf8');
      }
    } catch (err) {
      deps.logger.error(
        { chatId, artifactId, err: (err as Error).message },
        'artifact: store failed',
      );
      reply({
        type: 'patch.artifact.publish_response',
        requestId,
        ok: false,
        error: { code: 'internal', message: (err as Error).message },
      });
      return;
    }
    reply({
      type: 'patch.artifact.publish_response',
      requestId,
      ok: true,
      url: artifactUrl(chatId, artifactId),
    });
  });

  app.post<{
    Params: { chatId: string; artifactId: string };
    Body: { ttlSeconds?: number } | undefined;
  }>('/api/chats/:chatId/artifact/:artifactId/share', async (req, reply) => {
    if ((await hasBearer(req)) !== true) return reply.code(401).send({ error: 'unauthenticated' });
    const { chatId, artifactId } = req.params;
    if (!safeChatId(chatId) || !ID_RE.test(artifactId) || !artifactExists(chatId, artifactId)) {
      return reply.code(404).send({ error: 'artifact not found' });
    }
    const ttl = req.body?.ttlSeconds ?? DEFAULT_SHARE_TTL_S;
    if (!Number.isInteger(ttl) || ttl < MIN_SHARE_TTL_S || ttl > MAX_SHARE_TTL_S) {
      return reply.code(400).send({
        error: `ttlSeconds must be an integer between ${MIN_SHARE_TTL_S} and ${MAX_SHARE_TTL_S}`,
      });
    }
    const exp = Date.now() + ttl * 1000;
    return reply.code(200).send({
      url: `/api/chats/${chatId}/artifact/${artifactId}?exp=${exp}&sig=${shareSig(chatId, artifactId, exp)}`,
      expiresAt: exp,
    });
  });

  app.delete<{ Params: { chatId: string; artifactId: string } }>(
    '/api/chats/:chatId/artifact/:artifactId/share',
    async (req, reply) => {
      if ((await hasBearer(req)) !== true) {
        return reply.code(401).send({ error: 'unauthenticated' });
      }
      const { chatId, artifactId } = req.params;
      if (!safeChatId(chatId) || !ID_RE.test(artifactId) || !artifactExists(chatId, artifactId)) {
        return reply.code(404).send({ error: 'artifact not found' });
      }
      writeFileSync(epochFile(chatId, artifactId), String(readEpoch(chatId, artifactId) + 1));
      return reply.code(204).send();
    },
  );

  app.get<{
    Params: { chatId: string; artifactId: string };
    Querystring: { sig?: string; exp?: string };
  }>('/api/chats/:chatId/artifact/:artifactId', { logLevel: 'warn' }, async (req, reply) => {
    const { chatId, artifactId } = req.params;
    if (!safeChatId(chatId) || !ID_RE.test(artifactId)) {
      return reply.code(404).send({ error: 'artifact not found' });
    }
    const bearer = await hasBearer(req);
    if (bearer !== true) {
      const { sig, exp } = req.query;
      let ok = false;
      if (bearer === false && typeof sig === 'string') {
        if (exp === undefined) {
          ok = same(sig, appSig(chatId, artifactId));
        } else {
          const expMs = Number(exp);
          ok =
            Number.isInteger(expMs) &&
            expMs > Date.now() &&
            same(sig, shareSig(chatId, artifactId, expMs));
        }
      }
      if (!ok) return reply.code(401).send({ error: 'unauthenticated' });
    }
    const dir = join(deps.artifactsDir, chatId);
    // A `raw` publish (an image `view_file` result) leaves a sidecar next to
    // its `.bin`; its presence, checked first, is what tells apart the two
    // kinds an id can be. No CSP on this path — it's never HTML, so there's
    // no script for the sandbox directive to contain.
    const metaFile = join(dir, `${artifactId}.meta.json`);
    if (existsSync(metaFile)) {
      const binFile = join(dir, `${artifactId}.bin`);
      if (!existsSync(binFile)) {
        return reply.code(404).send({ error: 'artifact not found' });
      }
      const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as RawArtifactSidecar;
      return reply.code(200).header('content-type', meta.contentType).send(readFileSync(binFile));
    }
    const file = join(dir, `${artifactId}.html`);
    if (!existsSync(file)) {
      return reply.code(404).send({ error: 'artifact not found' });
    }
    return reply
      .code(200)
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-security-policy', ARTIFACT_CSP)
      .send(readFileSync(file, 'utf8'));
  });

  return unsub;
}
