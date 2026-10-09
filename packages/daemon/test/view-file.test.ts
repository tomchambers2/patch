// view_file — the host side of Patch's "show this to the user" tool
// (spec/14-design-web.md § Tool calls).
//
// POST /internal/view_file reads an image or HTML file from the chat folder,
// wraps it as a page, hands it to the server (injected publish hook) and
// returns a SMALL ack. Two properties matter and are asserted throughout:
//
//   1. The file's bytes never appear in the response. That is the whole point
//      of the tool — Read feeds Claude, view_file feeds the screen.
//   2. Unlike patch_artifact it stamps NO `chat.artifact` card; the result
//      renders inline where the call happened.
//
// NO FALLBACK: unknown chat, escaping path, unsupported extension, missing
// file, oversize and a failed publish are all loud errors that publish nothing.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { WireEvent } from '@patch/wire';
import { Daemon } from '../src/chatRunner.js';
import { buildControl } from '../src/control.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import { MAX_VIEW_IMAGE_BYTES, MAX_VIEW_PDF_BYTES } from '../src/artifacts.js';

const LOCAL_KEY = 'local-secret';
const AUTH = { authorization: `Bearer ${LOCAL_KEY}` };
const silent = pino({ level: 'silent' });

/** A real 1x1 PNG, so the wrapper is exercised on genuine binary bytes. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A minimal-but-real one-page PDF (no fonts/xref niceties Chromium doesn't
 * need to embed a data URI), so the wrapper is exercised on genuine bytes. */
const PDF_MINIMAL = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 100 100]>>endobj\n' +
    'trailer<</Root 1 0 R>>',
  'utf8',
);

interface PublishCall {
  chatId: string;
  artifactId: string;
  title: string;
  path: string;
  html?: string;
  raw?: { contentType: string; base64: string };
}

async function setup(opts: { publishFails?: boolean; noPublisher?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-viewfile-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-viewfile-folder-'));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: createMockSdkBackend(),
    oauthAccessToken: 'x',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
  });
  const chatId = await daemon.spawnChat({ folder, prompt: 'hi' });
  await new Promise((r) => setTimeout(r, 20));
  const published: PublishCall[] = [];
  const app = await buildControl({
    localKey: LOCAL_KEY,
    daemon,
    ...(opts.noPublisher
      ? {}
      : {
          publishArtifact: async (req: PublishCall) => {
            published.push(req);
            if (opts.publishFails) throw new Error('host link offline');
            return { url: `/api/chats/${req.chatId}/artifact/${req.artifactId}` };
          },
        }),
  });
  return { app, daemon, chatId, folder, events, published };
}

describe('POST /internal/view_file (view_file)', () => {
  it('publishes an image raw, with its own content-type, and returns an ack WITHOUT the bytes', async () => {
    const { app, chatId, folder, events, published } = await setup();
    try {
      writeFileSync(join(folder, 'shot.png'), PNG_1X1);
      const res = await app.inject({
        method: 'POST',
        url: '/internal/view_file',
        headers: AUTH,
        payload: { callerChatId: chatId, file_path: 'shot.png' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; kind: string; url: string; name: string };
      expect(body.ok).toBe(true);
      expect(body.kind).toBe('image');
      expect(body.name).toBe('shot.png');
      expect(body.url).toMatch(/^\/api\/chats\/.+\/artifact\/[0-9a-f]+$/);

      // The whole point: the image never enters the model's context. The ack
      // is small and carries no base64 whatsoever.
      const ackBody = res.body;
      expect(ackBody).not.toContain(PNG_1X1.toString('base64'));
      expect(ackBody.length).toBeLessThan(400);

      // Published RAW, not wrapped in an HTML page: an `<img src>` needs to
      // decode real image bytes at that URL, not an HTML document embedding
      // them as a data URI (spec/14 § Viewing files).
      expect(published).toHaveLength(1);
      expect(published[0]!.html).toBeUndefined();
      expect(published[0]!.raw).toEqual({
        contentType: 'image/png',
        base64: PNG_1X1.toString('base64'),
      });

      // Unlike patch_artifact, no card is stamped into the stream.
      expect(events.find((e) => e.type === 'chat.artifact')).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('publishes a PDF as a page carrying it as a data URI', async () => {
    const { app, chatId, folder, events, published } = await setup();
    try {
      writeFileSync(join(folder, 'invoice.pdf'), PDF_MINIMAL);
      const res = await app.inject({
        method: 'POST',
        url: '/internal/view_file',
        headers: AUTH,
        payload: { callerChatId: chatId, file_path: 'invoice.pdf' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; kind: string; url: string; name: string };
      expect(body.ok).toBe(true);
      expect(body.kind).toBe('pdf');
      expect(body.name).toBe('invoice.pdf');

      // The bytes never enter the ack — same guarantee as an image.
      expect(res.body).not.toContain(PDF_MINIMAL.toString('base64'));

      expect(published).toHaveLength(1);
      expect(published[0]!.html).toContain(
        `data:application/pdf;base64,${PDF_MINIMAL.toString('base64')}`,
      );
      expect(events.find((e) => e.type === 'chat.artifact')).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('rejects an oversize PDF rather than publishing a page that will bounce', async () => {
    const { app, chatId, folder, published } = await setup();
    try {
      writeFileSync(join(folder, 'huge.pdf'), Buffer.alloc(MAX_VIEW_PDF_BYTES + 1, 1));
      const res = await app.inject({
        method: 'POST',
        url: '/internal/view_file',
        headers: AUTH,
        payload: { callerChatId: chatId, file_path: 'huge.pdf' },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { message: string }).message).toContain('limit');
      expect(published).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('publishes an HTML file as a live page', async () => {
    const { app, chatId, folder, published } = await setup();
    try {
      writeFileSync(join(folder, 'plants.html'), '<h1>West Point</h1>', 'utf8');
      const res = await app.inject({
        method: 'POST',
        url: '/internal/view_file',
        headers: AUTH,
        payload: { callerChatId: chatId, file_path: 'plants.html' },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { kind: string }).kind).toBe('html');
      expect(published[0]!.html).toContain('<h1>West Point</h1>');
      expect(published[0]!.html.toLowerCase()).toContain('<html');
    } finally {
      await app.close();
    }
  });

  it('accepts an ABSOLUTE path inside the chat folder', async () => {
    const { app, chatId, folder } = await setup();
    try {
      writeFileSync(join(folder, 'abs.png'), PNG_1X1);
      const res = await app.inject({
        method: 'POST',
        url: '/internal/view_file',
        headers: AUTH,
        payload: { callerChatId: chatId, file_path: join(folder, 'abs.png') },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { name: string }).name).toBe('abs.png');
    } finally {
      await app.close();
    }
  });

  it('gives the same URL when the same file is viewed twice', async () => {
    const { app, chatId, folder } = await setup();
    try {
      writeFileSync(join(folder, 'same.png'), PNG_1X1);
      const payload = { callerChatId: chatId, file_path: 'same.png' };
      const a = await app.inject({
        method: 'POST',
        url: '/internal/view_file',
        headers: AUTH,
        payload,
      });
      const b = await app.inject({
        method: 'POST',
        url: '/internal/view_file',
        headers: AUTH,
        payload,
      });
      expect((a.json() as { url: string }).url).toBe((b.json() as { url: string }).url);
    } finally {
      await app.close();
    }
  });

  // Viewing a page must not clobber the artifact card published from the same
  // file — the two ids are namespaced apart.
  it('does not collide with patch_artifact on the same path', async () => {
    const { app, chatId, folder } = await setup();
    try {
      writeFileSync(join(folder, 'both.html'), '<p>x</p>', 'utf8');
      const viewed = await app.inject({
        method: 'POST',
        url: '/internal/view_file',
        headers: AUTH,
        payload: { callerChatId: chatId, file_path: 'both.html' },
      });
      const published = await app.inject({
        method: 'POST',
        url: '/internal/artifact',
        headers: AUTH,
        payload: { callerChatId: chatId, path: 'both.html' },
      });
      expect((viewed.json() as { url: string }).url).not.toBe(
        (published.json() as { url: string }).url,
      );
    } finally {
      await app.close();
    }
  });

  it('rejects a path escaping the chat folder', async () => {
    const { app, chatId, published } = await setup();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/view_file',
        headers: AUTH,
        payload: { callerChatId: chatId, file_path: '../../etc/passwd.png' },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('invalid_input');
      expect(published).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('rejects a file type it cannot show, naming Read as the alternative', async () => {
    const { app, chatId, folder, published } = await setup();
    try {
      writeFileSync(join(folder, 'notes.txt'), 'hello', 'utf8');
      const res = await app.inject({
        method: 'POST',
        url: '/internal/view_file',
        headers: AUTH,
        payload: { callerChatId: chatId, file_path: 'notes.txt' },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { message: string }).message).toContain('Read');
      expect(published).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('404s a missing file', async () => {
    const { app, chatId, published } = await setup();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/view_file',
        headers: AUTH,
        payload: { callerChatId: chatId, file_path: 'nope.png' },
      });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: string }).error).toBe('view_file_not_found');
      expect(published).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('404s an unknown chat', async () => {
    const { app } = await setup();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/internal/view_file',
        headers: AUTH,
        payload: { callerChatId: 'nope', file_path: 'a.png' },
      });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: string }).error).toBe('chat_not_found');
    } finally {
      await app.close();
    }
  });

  // base64 inflates by 4/3, so an image near the artifact ceiling would produce
  // a page the server refuses. Caught here, on the SOURCE, with the real limit.
  it('rejects an oversize image rather than publishing a page that will bounce', async () => {
    const { app, chatId, folder, published } = await setup();
    try {
      writeFileSync(join(folder, 'huge.png'), Buffer.alloc(MAX_VIEW_IMAGE_BYTES + 1, 1));
      const res = await app.inject({
        method: 'POST',
        url: '/internal/view_file',
        headers: AUTH,
        payload: { callerChatId: chatId, file_path: 'huge.png' },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { message: string }).message).toContain('limit');
      expect(published).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('surfaces a publish failure instead of returning a URL that 404s', async () => {
    const { app, chatId, folder, events } = await setup({ publishFails: true });
    try {
      writeFileSync(join(folder, 'x.png'), PNG_1X1);
      const res = await app.inject({
        method: 'POST',
        url: '/internal/view_file',
        headers: AUTH,
        payload: { callerChatId: chatId, file_path: 'x.png' },
      });
      expect(res.statusCode).toBe(502);
      expect((res.json() as { error: string }).error).toBe('view_file_publish_failed');
      expect(events.find((e) => e.type === 'chat.artifact')).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('503s when the host has no artifact publisher wired', async () => {
    const { app, chatId, folder } = await setup({ noPublisher: true });
    try {
      writeFileSync(join(folder, 'x.png'), PNG_1X1);
      const res = await app.inject({
        method: 'POST',
        url: '/internal/view_file',
        headers: AUTH,
        payload: { callerChatId: chatId, file_path: 'x.png' },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});
