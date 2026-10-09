// Pads — the server half (spec/14 § Pads, spec/01 § Endpoints).
//
// Three surfaces over one store (`store.ts`):
//   1. `/api/pads…` — Patch's own UI (surface bearer): list, create, rename,
//      delete, add captured screens, the app screen library.
//   2. `/api/padx/:id/:sig/…` — the editor and the Pad's files, served to an
//      iframe that cannot attach a bearer header, so the URL carries an HMAC
//      over the Pad id (server secret). The editor's own API (changes, send)
//      lives under the same prefix.
//   3. A daemon-link bridge for `patch.pad.request` — the agent's
//      `patch_pad_*` tools (create / update / reply / list).
//
// Send draws a picture of every change, then delivers the batch into the
// owning chat as a user turn over the daemon link. NO FALLBACK: a picture that
// cannot be drawn or a chat that is gone fails the Send and the changes stay
// pending.
//
// The editor and the design run same-origin with Patch: the editor reaches
// into the design's document to edit it, which an opaque origin forbids. Pads
// are authored by Tom's own agents, the same trust the standalone Pad had.

import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { PatchPadRequestEvent, type WireEvent } from '@patch/wire';
import type { DaemonLink } from '../daemon-link.js';
import type { Registry } from '../registry.js';
import type { ChatRegistry } from '../chat-registry.js';
import { loadLinkSecret } from '../artifacts.js';
import { requireAuth } from '../folder-routes.js';
import { batchMessage, type PicturePlan } from './format.js';
import { renderChangePictures, renderThumbnails } from './pictures.js';
import { ScreensError, screensFor, type Screen } from './screens.js';
import { PadError, PadStore, slugify, validId, type Device, type PadRecord } from './store.js';

const BRIDGE_SURFACE_ID = 'pads-bridge';
const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
/** A Pad's whole file set, as shipped by an agent or captured by the web UI. */
const MAX_PAD_BYTES = 40 * 1024 * 1024;
const MAX_THUMBS = 40;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

export interface PadRoutesDeps {
  logger: Logger;
  daemonLink: DaemonLink;
  registry: Registry;
  chatRegistry: ChatRegistry;
  /** `<dataDir>/pads` — one folder per Pad. */
  padsDir: string;
  /** Where the link-signing secret lives (shared with artifacts). */
  secretDir: string;
  idGenerator: () => string;
}

export interface PadView {
  id: string;
  name: string;
  app: string | null;
  chatId: string;
  device: Device;
  createdAt: number;
  updatedAt: number;
  pending: number;
  /** A batch has been sent and the agent has not replied yet. */
  working: boolean;
  screens: {
    id: string;
    name: string;
    path: string;
    width?: number;
    pending: number;
    thumbUrl: string | null;
  }[];
  /** Why the Pad's screens could not be read (a bad pad.json), when they could not. */
  screensError: string | null;
  frameUrl: string;
  thumbUrl: string | null;
  thumbError: string | null;
}

interface FileInput {
  path: string;
  data: Buffer;
}

function safeRel(rel: string): string {
  const norm = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!norm || norm.split('/').some((p) => p === '..' || p === '')) {
    throw new PadError(400, `bad file path "${rel}"`);
  }
  return norm;
}

function serveFileUnder(root: string, rel: string): { type: string; body: Buffer } {
  const base = resolve(root);
  let p = resolve(base, `.${sep}${rel}`);
  if (p !== base && !p.startsWith(base + sep)) throw new PadError(403, 'outside the pad');
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, 'index.html');
  if (!existsSync(p)) throw new PadError(404, `no file ${rel}`);
  return {
    type: TYPES[extname(p).toLowerCase()] ?? 'application/octet-stream',
    body: readFileSync(p),
  };
}

export function registerPadRoutes(app: FastifyInstance, deps: PadRoutesDeps): () => void {
  const store = new PadStore(deps.padsDir);
  const secret = loadLinkSecret(deps.secretDir);
  const sign = (id: string): string =>
    createHmac('sha256', secret).update(`pad|${id}`).digest('hex');
  const sigOk = (id: string, sig: string): boolean => {
    const want = sign(id);
    return sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
  };
  const base = (id: string): string => `/api/padx/${id}/${sign(id)}`;
  const sending = new Set<string>();
  const log = deps.logger;

  // ---------------------------------------------------------------- core --

  function screensOf(id: string): Screen[] {
    try {
      return screensFor(store.filesDir(id));
    } catch (err) {
      if (err instanceof ScreensError) throw new PadError(400, err.message);
      throw err;
    }
  }

  function thumbUrlFor(id: string, screenId: string): string | null {
    return existsSync(join(store.dir(id), 'thumbs', `${screenId}.png`))
      ? `${base(id)}/thumb/${screenId}.png?r=${store.get(id)?.thumbRev ?? 0}`
      : null;
  }

  function view(pad: PadRecord): PadView {
    let screens: Screen[] = [];
    let screensError: string | null = null;
    try {
      screens = existsSync(store.filesDir(pad.id)) ? screensFor(store.filesDir(pad.id)) : [];
    } catch (err) {
      if (!(err instanceof ScreensError)) throw err;
      screensError = err.message;
    }
    const pending = pad.changes.filter((c) => c.status === 'pending');
    return {
      id: pad.id,
      name: pad.name,
      app: pad.app,
      chatId: pad.chatId,
      device: pad.device,
      createdAt: pad.createdAt,
      updatedAt: pad.updatedAt,
      pending: pending.length,
      working: pad.batches.some((b) => b.status === 'sent'),
      screens: screens.map((s) => ({
        ...s,
        pending: pending.filter((c) => c.screen === s.id).length,
        thumbUrl: thumbUrlFor(pad.id, s.id),
      })),
      screensError,
      frameUrl: `${base(pad.id)}/`,
      thumbUrl: screens[0] ? thumbUrlFor(pad.id, screens[0].id) : null,
      thumbError: pad.thumbError ?? null,
    };
  }

  /** Replace (or add to) a Pad's files. `replace` removes what is not in `files`. */
  function writeFiles(id: string, files: FileInput[], replace: boolean): void {
    let total = 0;
    for (const f of files) total += f.data.length;
    if (total > MAX_PAD_BYTES)
      throw new PadError(413, `pad files are ${total} bytes; the limit is ${MAX_PAD_BYTES}`);
    const root = store.filesDir(id);
    if (replace) {
      // Library copies and the screens a chat added by capture live beside the
      // agent's files: a replace by the agent must not take them away.
      for (const entry of existsSync(root) ? readdirSync(root) : []) {
        if (entry.startsWith('lib-') || entry.startsWith('cap-')) continue;
        rmSync(join(root, entry), { recursive: true, force: true });
      }
    }
    for (const f of files) {
      const rel = safeRel(f.path);
      const dest = resolve(root, rel);
      if (!dest.startsWith(resolve(root) + sep))
        throw new PadError(400, `bad file path "${f.path}"`);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.data);
    }
  }

  /**
   * Draw the card thumbnails in the background. Not awaited — a create must not
   * wait on a browser — but never silent: a failure is logged and recorded on
   * the Pad, where the Pads page shows it.
   */
  function refreshThumbs(id: string): void {
    void (async () => {
      try {
        const pad = store.mustGet(id);
        const screens = screensOf(id).slice(0, MAX_THUMBS);
        await renderThumbnails({
          device: pad.device,
          items: screens.map((s) => {
            const [file, hash] = s.path.split('#') as [string, string | undefined];
            return {
              url: `${pathToFileURL(store.filesDir(id)).href}/${file}${hash !== undefined ? `#${hash}` : ''}`,
              out: join(store.dir(id), 'thumbs', `${s.id}.png`),
            };
          }),
        });
        const fresh = store.mustGet(id);
        delete fresh.thumbError;
        fresh.thumbRev = Date.now();
        store.save(fresh);
      } catch (err) {
        const message = (err as Error).message;
        log.error({ padId: id, err: message }, 'pads: thumbnails failed');
        try {
          const fresh = store.mustGet(id);
          fresh.thumbError = message;
          store.save(fresh);
        } catch {
          /* pad deleted meanwhile */
        }
      }
    })();
  }

  /** Write captured single-file screens, listing them in pad.json after what is there. */
  function addCaptured(
    id: string,
    screens: { name: string; html: string; width?: number }[],
  ): void {
    const root = store.filesDir(id);
    mkdirSync(root, { recursive: true });
    const manifestPath = join(root, 'pad.json');
    const entries = existingScreens(root, manifestPath);
    for (const s of screens) {
      if (!s.name?.trim() || typeof s.html !== 'string' || !s.html.trim()) {
        throw new PadError(400, 'each screen needs a name and html');
      }
      let n = slugify(s.name);
      let file = `cap-${n}.html`;
      for (let i = 2; existsSync(join(root, file)); i++) file = `cap-${n}-${i}.html`;
      n = file.slice(0, -5);
      // Two captures of "Chat" are two screens: the id, not the name, tells them apart.
      const used = new Set(entries.map((e) => e.id ?? slugify(e.name)));
      let sid = slugify(s.name);
      for (let i = 2; used.has(sid); i++) sid = `${slugify(s.name)}-${i}`;
      writeFileSync(join(root, file), s.html);
      entries.push({
        id: sid,
        name: s.name.trim(),
        path: file,
        ...(typeof s.width === 'number' ? { width: s.width } : {}),
      });
    }
    writeFileSync(manifestPath, JSON.stringify({ screens: entries }, null, 2));
  }

  /** Copy a library screen (with its whole pad's files, so its assets resolve) into this Pad. */
  function addFromLibrary(id: string, picks: { padId: string; screenId: string }[]): void {
    const root = store.filesDir(id);
    mkdirSync(root, { recursive: true });
    const manifestPath = join(root, 'pad.json');
    const entries = existingScreens(root, manifestPath);
    const copied = new Set<string>();
    for (const pick of picks) {
      const src = store.get(pick.padId);
      if (!src) throw new PadError(404, `no pad "${pick.padId}" to take a screen from`);
      const screen = screensOf(pick.padId).find((s) => s.id === pick.screenId);
      if (!screen) throw new PadError(404, `pad "${pick.padId}" has no screen "${pick.screenId}"`);
      const prefix = `lib-${pick.padId}`;
      if (!copied.has(prefix)) {
        copyTree(store.filesDir(pick.padId), join(root, prefix));
        copied.add(prefix);
      }
      entries.push({
        name: screen.name,
        path: `${prefix}/${screen.path}`,
        ...(screen.width ? { width: screen.width } : {}),
      });
    }
    writeFileSync(manifestPath, JSON.stringify({ screens: entries }, null, 2));
  }

  function decodeFiles(list: { path: string; base64: string }[]): FileInput[] {
    return list.map((f) => ({ path: f.path, data: Buffer.from(f.base64, 'base64') }));
  }

  function deliver(pad: PadRecord, message: string): void {
    if (!deps.chatRegistry.get(pad.chatId)) {
      throw new PadError(502, `the chat this Pad belongs to (${pad.chatId}) no longer exists`);
    }
    deps.daemonLink.send(BRIDGE_SURFACE_ID, {
      type: 'chat.input',
      chatId: pad.chatId,
      message,
      localId: deps.idGenerator(),
    });
  }

  async function sendBatch(id: string, origin: string): Promise<unknown> {
    if (sending.has(id)) throw new PadError(409, 'a send for this pad is already in progress');
    sending.add(id);
    try {
      const { pad, batch, pending } = store.openBatch(id);
      // Screen by screen, in the pad's own order: the numbering the chat reads,
      // the pictures' numbers and the batch all use this one order.
      const screens = screensOf(id);
      const order = (c: { screen: string }): number => {
        const i = screens.findIndex((x) => x.id === c.screen);
        return i < 0 ? screens.length : i;
      };
      const ordered = [...pending].sort((a, b) => order(a) - order(b));
      let pictures;
      try {
        pictures = await renderChangePictures({
          changes: ordered,
          screens,
          baseUrl: `${pathToFileURL(store.filesDir(id)).href}/`,
          outDir: store.picturesDir(id),
          prefix: batch.id,
        });
      } catch (err) {
        throw new PadError(
          500,
          `could not draw the pictures for this batch: ${(err as Error).message}`,
        );
      }
      batch.pictures = pictures
        .filter((p) => p.file)
        .map((p) => ({ name: basename(p.file as string), numbers: [p.n] }));
      const plan: PicturePlan[] = pictures.map((p) =>
        p.file
          ? { n: p.n, url: `${origin}${base(id)}/pictures/${basename(p.file)}` }
          : { n: p.n, problem: p.problem ?? 'none was drawn' },
      );
      deliver(pad, batchMessage({ pad, changes: ordered, screens, pictures: plan }));
      return store.commitBatch(id, batch);
    } finally {
      sending.delete(id);
    }
  }

  // --------------------------------------------------------------- guards --

  function fail(reply: FastifyReply, err: unknown): FastifyReply {
    if (err instanceof PadError) return reply.code(err.status).send({ error: err.message });
    log.error({ err: (err as Error).message, stack: (err as Error).stack }, 'pads: unhandled');
    return reply.code(500).send({ error: (err as Error).message });
  }

  async function authed(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    try {
      await requireAuth(req, deps.registry);
      return true;
    } catch (e) {
      reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: 'unauthenticated' });
      return false;
    }
  }

  const originOf = (req: FastifyRequest): string => {
    const proto =
      (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ??
      req.protocol;
    return `${proto}://${req.headers.host}`;
  };

  // ------------------------------------------------- 1. Patch UI (bearer) --

  const BIG = { bodyLimit: MAX_PAD_BYTES };

  app.get('/api/pads', async (req, reply) => {
    if (!(await authed(req, reply))) return;
    return { pads: store.list().map(view) };
  });

  // What the New Pad form offers under "Based on": the real screens earlier
  // Pads captured, grouped by the app they were for.
  app.get('/api/pads/library', async (req, reply) => {
    if (!(await authed(req, reply))) return;
    const apps = new Map<
      string,
      { padId: string; screenId: string; name: string; thumbUrl: string | null; device: Device }[]
    >();
    for (const pad of store.list()) {
      if (!pad.app) continue;
      const v = view(pad);
      for (const s of v.screens) {
        const list = apps.get(pad.app) ?? [];
        list.push({
          padId: pad.id,
          screenId: s.id,
          name: s.name,
          thumbUrl: s.thumbUrl,
          device: pad.device,
        });
        apps.set(pad.app, list);
      }
    }
    return { apps: [...apps].map(([app, screens]) => ({ app, screens })) };
  });

  app.post<{ Body: Record<string, any> }>('/api/pads', BIG, async (req, reply) => {
    if (!(await authed(req, reply))) return;
    try {
      const b = req.body ?? {};
      if (!deps.chatRegistry.get(String(b['chatId'] ?? ''))) {
        throw new PadError(400, `chatId "${String(b['chatId'])}" is not a chat on this server`);
      }
      const device: Device = b['device'] === 'phone' ? 'phone' : 'desktop';
      const captured = Array.isArray(b['screens']) ? b['screens'] : [];
      const picks = Array.isArray(b['from']) ? b['from'] : [];
      const pad = store.create({
        name: String(b['name'] ?? ''),
        app: typeof b['app'] === 'string' && b['app'] ? b['app'] : null,
        chatId: String(b['chatId']),
        device,
      });
      try {
        if (captured.length === 0 && picks.length === 0) {
          // Blank: one empty screen to start designing on.
          addCaptured(pad.id, [{ name: 'Screen 1', html: BLANK_PAGE }]);
        }
        if (captured.length) addCaptured(pad.id, captured);
        if (picks.length) addFromLibrary(pad.id, picks);
        screensOf(pad.id);
      } catch (err) {
        store.remove(pad.id);
        throw err;
      }
      refreshThumbs(pad.id);
      return view(store.mustGet(pad.id));
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Screens captured from the live app, added to a Pad that exists.
  app.post<{ Params: { id: string }; Body: { screens?: { name: string; html: string }[] } }>(
    '/api/pads/:id/screens',
    BIG,
    async (req, reply) => {
      if (!(await authed(req, reply))) return;
      try {
        store.mustGet(req.params.id);
        addCaptured(req.params.id, req.body?.screens ?? []);
        screensOf(req.params.id);
        store.touchFiles(req.params.id);
        refreshThumbs(req.params.id);
        return view(store.mustGet(req.params.id));
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.get<{ Params: { id: string } }>('/api/pads/:id', async (req, reply) => {
    if (!(await authed(req, reply))) return;
    try {
      return view(store.mustGet(req.params.id));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; device?: Device } }>(
    '/api/pads/:id',
    async (req, reply) => {
      if (!(await authed(req, reply))) return;
      try {
        const pad = store.mustGet(req.params.id);
        if (typeof req.body?.name === 'string' && req.body.name.trim())
          pad.name = req.body.name.trim();
        if (req.body?.device === 'desktop' || req.body?.device === 'phone')
          pad.device = req.body.device;
        store.save(pad);
        return view(pad);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.delete<{ Params: { id: string } }>('/api/pads/:id', async (req, reply) => {
    if (!(await authed(req, reply))) return;
    try {
      store.remove(req.params.id);
      return reply.code(204).send();
    } catch (err) {
      return fail(reply, err);
    }
  });

  // ---------------------------------- 2. editor + files (signed, iframe) --

  const withPad =
    (handler: (req: any, reply: FastifyReply, pad: PadRecord) => unknown) =>
    async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
      const { id, sig } = req.params as { id: string; sig: string };
      if (!validId(id) || !sigOk(id, sig))
        return reply.code(401).send({ error: 'unauthenticated' });
      try {
        return await handler(req, reply, store.mustGet(id));
      } catch (err) {
        return fail(reply, err);
      }
    };

  const sendFile = (reply: FastifyReply, root: string, rel: string): FastifyReply => {
    const f = serveFileUnder(root, rel);
    return reply
      .code(200)
      .header('content-type', f.type)
      .header('cache-control', 'no-store')
      .send(f.body);
  };

  const PFX = '/api/padx/:id/:sig';

  app.get(PFX, async (req, reply) => reply.redirect(`${req.url.split('?')[0]}/`, 301));
  app.get(
    `${PFX}/`,
    withPad((_req, reply) => sendFile(reply, PUBLIC, 'editor.html')),
  );
  for (const asset of ['editor.js', 'editor.css', 'icon.svg']) {
    app.get(
      `${PFX}/${asset}`,
      withPad((_req, reply) => sendFile(reply, PUBLIC, asset)),
    );
  }
  app.get(
    `${PFX}/f/*`,
    withPad((req, reply, pad) =>
      sendFile(reply, store.filesDir(pad.id), decodeURIComponent(req.params['*'])),
    ),
  );
  app.get(
    `${PFX}/pictures/:name`,
    withPad((req, reply, pad) => {
      if (!/^[a-z0-9-]+\.png$/i.test(req.params.name)) throw new PadError(404, 'no such picture');
      return sendFile(reply, store.picturesDir(pad.id), req.params.name);
    }),
  );
  app.get(
    `${PFX}/thumb/:name`,
    withPad((req, reply, pad) => {
      if (!/^[a-z0-9-]+\.png$/i.test(req.params.name)) throw new PadError(404, 'no such thumbnail');
      return sendFile(reply, join(store.dir(pad.id), 'thumbs'), req.params.name);
    }),
  );

  // The editor's own API.
  app.get(
    `${PFX}/api`,
    withPad((_req, _reply, pad) => ({
      design: { id: pad.id, name: pad.name, working: pad.batches.some((b) => b.status === 'sent') },
      rev: pad.filesRev,
      screens: screensOf(pad.id),
      changes: pad.changes,
      batches: pad.batches,
      device: pad.device,
    })),
  );
  app.post(
    `${PFX}/api/changes`,
    withPad((req, _reply, pad) => {
      const body = (req.body ?? {}) as { screen?: string };
      if (!screensOf(pad.id).some((x) => x.id === body.screen)) {
        throw new PadError(400, `"${String(body.screen)}" is not one of this pad's screens`);
      }
      return store.addChange(pad.id, body);
    }),
  );
  app.patch(
    `${PFX}/api/changes/:change`,
    withPad((req, _reply, pad) =>
      store.updateChange(pad.id, req.params.change, (req.body ?? {}) as Record<string, unknown>),
    ),
  );
  app.delete(
    `${PFX}/api/changes/:change`,
    withPad((req, _reply, pad) => {
      store.removeChange(pad.id, req.params.change);
      return { ok: true };
    }),
  );
  // A blank screen added from the editor itself, named after its place in the list.
  app.post(
    `${PFX}/api/screens`,
    withPad((_req, _reply, pad) => {
      const before = screensOf(pad.id);
      let n = before.length + 1;
      const used = new Set(before.map((x) => x.name));
      while (used.has(`Screen ${n}`)) n++;
      const name = `Screen ${n}`;
      addCaptured(pad.id, [
        { name, html: BLANK_PAGE.replace('<title>Screen 1</title>', `<title>${name}</title>`) },
      ]);
      const screens = screensOf(pad.id);
      store.touchFiles(pad.id);
      refreshThumbs(pad.id);
      return { screen: screens[screens.length - 1], screens };
    }),
  );
  app.post(
    `${PFX}/api/send`,
    withPad((req, _reply, pad) => sendBatch(pad.id, originOf(req))),
  );

  // ------------------------------------------------ 3. agent tools (link) --

  const unsub = deps.daemonLink.onEvent((event: WireEvent, fromDaemonId: string | null) => {
    if (event.type !== 'patch.pad.request') return;
    const reply = (
      ok: boolean,
      result?: unknown,
      error?: { code: 'invalid_input' | 'not_found' | 'internal'; message: string },
    ): void => {
      const out: WireEvent = ok
        ? { type: 'patch.pad.response', requestId: event.requestId, ok: true, result }
        : {
            type: 'patch.pad.response',
            requestId: event.requestId,
            ok: false,
            error: error ?? { code: 'internal', message: 'unknown' },
          };
      if (fromDaemonId === null) {
        log.error(
          { requestId: event.requestId },
          'pads bridge: request with no originating machine; cannot reply',
        );
        return;
      }
      deps.daemonLink.sendTo(fromDaemonId, BRIDGE_SURFACE_ID, out);
    };
    const parsed = PatchPadRequestEvent.safeParse(event);
    if (!parsed.success)
      return reply(false, undefined, { code: 'invalid_input', message: parsed.error.message });
    try {
      reply(true, handleAgentOp(parsed.data));
    } catch (err) {
      if (err instanceof PadError) {
        reply(false, undefined, {
          code: err.status === 404 ? 'not_found' : 'invalid_input',
          message: err.message,
        });
      } else {
        log.error(
          { err: (err as Error).message, stack: (err as Error).stack },
          'pads bridge: failed',
        );
        reply(false, undefined, { code: 'internal', message: (err as Error).message });
      }
    }
  });

  function owned(padId: string | undefined, chatId: string): PadRecord {
    if (!padId) throw new PadError(400, 'padId is required');
    const pad = store.get(padId);
    if (!pad) {
      throw new PadError(
        404,
        `no pad "${padId}" — create one first with patch_pad_create({ dir, name }), which returns its id`,
      );
    }
    if (pad.chatId !== chatId) {
      throw new PadError(
        400,
        `pad "${padId}" belongs to another chat; only its chat can change it`,
      );
    }
    return pad;
  }

  function handleAgentOp(req: PatchPadRequestEvent): unknown {
    switch (req.op) {
      case 'create': {
        if (!req.name) throw new PadError(400, 'name is required');
        if (!req.files?.length) throw new PadError(400, 'files are required');
        const pad = store.create({
          name: req.name,
          app: req.app ?? null,
          chatId: req.chatId,
          device: req.device ?? 'desktop',
        });
        try {
          writeFiles(pad.id, decodeFiles(req.files), true);
          screensOf(pad.id);
        } catch (err) {
          store.remove(pad.id);
          throw err;
        }
        refreshThumbs(pad.id);
        return view(store.mustGet(pad.id));
      }
      case 'update': {
        const pad = owned(req.padId, req.chatId);
        if (!req.files?.length) throw new PadError(400, 'files are required');
        const before = new Set(screensOf(pad.id).map((s) => s.id));
        writeFiles(pad.id, decodeFiles(req.files), true);
        const after = screensOf(pad.id);
        store.touchFiles(pad.id);
        refreshThumbs(pad.id);
        return {
          ...view(store.mustGet(pad.id)),
          addedScreens: after.filter((s) => !before.has(s.id)).map((s) => s.name),
        };
      }
      case 'reply': {
        const pad = owned(req.padId, req.chatId);
        if (!req.text) throw new PadError(400, 'text is required');
        store.reply(pad.id, req.text);
        return view(store.mustGet(pad.id));
      }
      case 'list':
        return {
          pads: store
            .list()
            .filter((p) => p.chatId === req.chatId)
            .map(view),
        };
    }
  }

  return unsub;
}

const BLANK_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Screen 1</title></head><body style="margin:0;min-height:100vh;font:16px system-ui,sans-serif"></body></html>';

/** The screens a Pad already lists: its manifest, else its top-level html files, else none yet. */
function existingScreens(
  root: string,
  manifestPath: string,
): { id?: string; name: string; path: string; width?: number }[] {
  if (existsSync(manifestPath)) {
    return (
      JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        screens: { id?: string; name: string; path: string }[];
      }
    ).screens;
  }
  const hasHtml = readdirSync(root).some((f) => f.toLowerCase().endsWith('.html'));
  return hasHtml
    ? screensFor(root).map(({ id, name, path, width }) => ({
        id,
        name,
        path,
        ...(width ? { width } : {}),
      }))
    : [];
}

function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const src = join(from, e.name);
    if (e.isDirectory()) copyTree(src, join(to, e.name));
    else copyFileSync(src, join(to, e.name));
  }
}
