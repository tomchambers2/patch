// Link preview REST route.
//
// GET /api/link-preview?url=<url> — server-side fetches a link that appears in
// a chat message and extracts its <title>/OpenGraph description/image, so the
// web surface can render a small inline preview. Fetched server-side (not by
// the browser) because the target's CORS policy would otherwise block it, and
// because it keeps every previewed site seeing the server's IP rather than
// the caller's on every preview open.
//
// NO FALLBACK: an invalid/unfetchable URL is a 4xx/502 the client surfaces,
// never a silently empty preview.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { verifySurfaceCredential } from '@patch/auth';
import type { Registry } from './registry.js';

async function requireAuth(req: FastifyRequest, registry: Registry): Promise<void> {
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
  try {
    const claims = await verifySurfaceCredential(jwt, { userPublicKey: account.userPublicKey });
    if (registry.isRevoked(claims.surface_id)) throw generic();
  } catch {
    throw generic();
  }
}

export interface LinkPreviewRoutesDeps {
  logger: Logger;
  registry: Registry;
}

const FETCH_TIMEOUT_MS = 5_000;

// Blocks the obvious SSRF targets (loopback/private/link-local) reachable from
// the server's own network. Not exhaustive DNS-rebinding protection — this is
// a single-user personal app previewing links the account owner pasted, not a
// public-facing service.
function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

// Matches the full <meta ...> tag first so `content` and `property`/`name`
// can appear in either order, then pulls `content` out of just that tag.
function extractMetaContent(
  html: string,
  attr: 'property' | 'name',
  value: string,
): string | undefined {
  const tagRe = new RegExp(`<meta[^>]*\\b${attr}=["']${value}["'][^>]*>`, 'i');
  const tag = tagRe.exec(html)?.[0];
  if (!tag) return undefined;
  const content = /content=["']([^"']*)["']/i.exec(tag)?.[1];
  return content?.trim() || undefined;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
}

function parsePreview(html: string, baseUrl: string): Omit<LinkPreview, 'url'> {
  const title =
    extractMetaContent(html, 'property', 'og:title') ??
    /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  const description =
    extractMetaContent(html, 'property', 'og:description') ??
    extractMetaContent(html, 'name', 'description');
  const rawImage = extractMetaContent(html, 'property', 'og:image');
  let image: string | undefined;
  if (rawImage) {
    try {
      image = new URL(rawImage, baseUrl).toString();
    } catch {
      image = undefined;
    }
  }
  return {
    ...(title ? { title: decodeEntities(title) } : {}),
    ...(description ? { description: decodeEntities(description) } : {}),
    ...(image ? { image } : {}),
  };
}

const IMAGE_FETCH_TIMEOUT_MS = 5_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export function registerLinkPreviewRoutes(app: FastifyInstance, deps: LinkPreviewRoutesDeps): void {
  function validateUrl(
    raw: string,
  ): { ok: true; target: URL } | { ok: false; status: number; error: string; message: string } {
    if (!raw) {
      return { ok: false, status: 400, error: 'invalid_url', message: 'url is required' };
    }
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      return { ok: false, status: 400, error: 'invalid_url', message: 'url is not a valid URL' };
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return {
        ok: false,
        status: 400,
        error: 'invalid_url',
        message: 'only http/https URLs are supported',
      };
    }
    if (isBlockedHost(target.hostname)) {
      return {
        ok: false,
        status: 400,
        error: 'blocked_host',
        message: 'this host cannot be previewed',
      };
    }
    return { ok: true, target };
  }

  app.get<{ Querystring: { url?: string } }>('/api/link-preview', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const validated = validateUrl((req.query?.url ?? '').toString().trim());
    if (!validated.ok) {
      return reply
        .code(validated.status)
        .send({ error: validated.error, message: validated.message });
    }
    const { target } = validated;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(target.toString(), {
        signal: controller.signal,
        redirect: 'follow',
        headers: { accept: 'text/html', 'user-agent': 'Patch-LinkPreview/1.0' },
      });
    } catch (e) {
      deps.logger.warn(
        { url: target.toString(), err: (e as Error).message },
        'link-preview fetch failed',
      );
      return reply.code(502).send({ error: 'fetch_failed', message: (e as Error).message });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      return reply.code(502).send({ error: 'fetch_failed', message: `upstream ${res.status}` });
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) {
      return reply
        .code(415)
        .send({ error: 'unsupported_content_type', message: contentType || 'unknown' });
    }
    const html = await res.text();
    const preview = parsePreview(html, target.toString());
    return reply.code(200).send({ url: target.toString(), ...preview } satisfies LinkPreview);
  });

  // GET /api/link-preview/image?url=<absolute image url> — proxies the OG
  // image a preview points at, same-origin. A plain `<img src>` can't attach
  // this app's bearer auth, but more importantly the CSP that locks
  // `img-src` down to `'self'`/`data:`/`blob:` (packages/server/src/app.ts)
  // would block the browser loading an arbitrary third-party image URL
  // directly regardless of auth — every preview image rendered as broken.
  // Routing it through here keeps the previewed site seeing the server's IP
  // rather than the caller's, same rationale as the HTML fetch above, and the
  // web client turns the bytes into an object URL (same pattern as the file
  // browser's binary preview in chat-routes.ts).
  app.get<{ Querystring: { url?: string } }>('/api/link-preview/image', async (req, reply) => {
    try {
      await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }
    const validated = validateUrl((req.query?.url ?? '').toString().trim());
    if (!validated.ok) {
      return reply
        .code(validated.status)
        .send({ error: validated.error, message: validated.message });
    }
    const { target } = validated;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(target.toString(), {
        signal: controller.signal,
        redirect: 'follow',
        headers: { accept: 'image/*', 'user-agent': 'Patch-LinkPreview/1.0' },
      });
    } catch (e) {
      deps.logger.warn(
        { url: target.toString(), err: (e as Error).message },
        'link-preview image fetch failed',
      );
      return reply.code(502).send({ error: 'fetch_failed', message: (e as Error).message });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      return reply.code(502).send({ error: 'fetch_failed', message: `upstream ${res.status}` });
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) {
      return reply
        .code(415)
        .send({ error: 'unsupported_content_type', message: contentType || 'unknown' });
    }
    const contentLength = Number(res.headers.get('content-length') ?? '0');
    if (contentLength > MAX_IMAGE_BYTES) {
      return reply
        .code(413)
        .send({ error: 'image_too_large', message: 'image exceeds size limit' });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      return reply
        .code(413)
        .send({ error: 'image_too_large', message: 'image exceeds size limit' });
    }
    return reply
      .code(200)
      .header('content-type', contentType)
      .header('cache-control', 'private, max-age=3600')
      .send(buf);
  });
}
