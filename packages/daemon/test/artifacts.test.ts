// patch_artifact — the host side of Patch's own Artifact tool
// (spec/14-design-web.md § Artifacts, spec/06 § Cross-chat toolset).
//
// POST /internal/artifact reads an HTML file from the chat folder, hands it to
// the server (injected publish hook), and stamps a slim `chat.artifact` into
// the chat's wire stream. NO FALLBACK: every rejection path (unknown chat,
// escaping path, wrong extension, missing file, oversize, link down) is a loud
// error and publishes nothing.

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
import { ArtifactPublisher, ArtifactLinkOfflineError } from '../src/artifacts.js';

// The control socket is gated as a whole (spec/02 § Control IPC): every
// route but /healthz needs the host's local key.
const LOCAL_KEY = 'local-secret';
const AUTH = { authorization: `Bearer ${LOCAL_KEY}` };

const silent = pino({ level: 'silent' });

interface PublishCall {
  chatId: string;
  artifactId: string;
  title: string;
  path: string;
  html: string;
}

async function setup(opts: { publishFails?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-artifact-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-artifact-folder-'));
  mkdirSync(folder, { recursive: true });
  const sdk = createMockSdkBackend();
  const events: WireEvent[] = [];
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: sdk,
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
    publishArtifact: async (req: PublishCall) => {
      published.push(req);
      if (opts.publishFails) throw new Error('host link offline');
      return { url: `/api/chats/${req.chatId}/artifact/${req.artifactId}` };
    },
  });
  return { app, daemon, chatId, folder, events, published };
}

describe('POST /internal/artifact (patch_artifact)', () => {
  it('publishes an HTML file and emits a slim chat.artifact', async () => {
    const { app, chatId, folder, events, published } = await setup();
    try {
      const doc = '<!doctype html><html><body><p>hi</p></body></html>';
      writeFileSync(join(folder, 'report.html'), doc, 'utf8');
      const res = await app.inject({
        method: 'POST',
        url: '/internal/artifact',
        headers: AUTH,
        payload: { callerChatId: chatId, path: 'report.html', title: 'Report' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; url: string; artifactId: string; title: string };
      expect(body.ok).toBe(true);
      expect(body.title).toBe('Report');
      expect(body.url).toBe(`/api/chats/${chatId}/artifact/${body.artifactId}`);

      expect(published).toHaveLength(1);
      expect(published[0]!.html).toBe(doc);

      const ev = events.find((e) => e.type === 'chat.artifact') as
        | Extract<WireEvent, { type: 'chat.artifact' }>
        | undefined;
      expect(ev).toBeDefined();
      expect(ev!.url).toBe(body.url);
      expect(ev!.title).toBe('Report');
      expect(ev!.path).toBe('report.html');
      expect(typeof ev!.seq).toBe('number');
      // Slim by design — the page body never rides the chat stream.
      expect(JSON.stringify(ev)).not.toContain('<p>hi</p>');
    } finally {
      await app.close();
    }
  });

  it('defaults the title to the filename and wraps a fragment in a document', async () => {
    const { app, chatId, folder, published } = await setup();
    try {
      writeFileSync(join(folder, 'notes.html'), '<h1>bare</h1>', 'utf8');
      const res = await app.inject({
        method: 'POST',
        url: '/internal/artifact',
        headers: AUTH,
        payload: { callerChatId: chatId, path: 'notes.html' },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { title: string }).title).toBe('notes.html');
      expect(published[0]!.html).toContain('<h1>bare</h1>');
      expect(published[0]!.html.toLowerCase()).toContain('<html');
      expect(published[0]!.html).toContain('<title>notes.html</title>');
    } finally {
      await app.close();
    }
  });

  it('gives the same artifactId (same URL) when the same file is republished', async () => {
    const { app, chatId, folder } = await setup();
    try {
      writeFileSync(join(folder, 'a.html'), '<p>1</p>', 'utf8');
      const first = await app.inject({
        method: 'POST',
        url: '/internal/artifact',
        headers: AUTH,
        payload: { callerChatId: chatId, path: 'a.html' },
      });
      writeFileSync(join(folder, 'a.html'), '<p>2</p>', 'utf8');
      const second = await app.inject({
        method: 'POST',
        url: '/internal/artifact',
        headers: AUTH,
        payload: { callerChatId: chatId, path: 'a.html' },
      });
      expect((second.json() as { artifactId: string }).artifactId).toBe(
        (first.json() as { artifactId: string }).artifactId,
      );
      writeFileSync(join(folder, 'b.html'), '<p>3</p>', 'utf8');
      const other = await app.inject({
        method: 'POST',
        url: '/internal/artifact',
        headers: AUTH,
        payload: { callerChatId: chatId, path: 'b.html' },
      });
      expect((other.json() as { artifactId: string }).artifactId).not.toBe(
        (first.json() as { artifactId: string }).artifactId,
      );
    } finally {
      await app.close();
    }
  });

  it('rejects an unknown chat, an escaping path, a non-HTML file and a missing file', async () => {
    const { app, chatId, folder, events, published } = await setup();
    try {
      writeFileSync(join(folder, 'notes.md'), '# hi', 'utf8');

      const unknown = await app.inject({
        method: 'POST',
        url: '/internal/artifact',
        headers: AUTH,
        payload: { callerChatId: 'nope', path: 'x.html' },
      });
      expect(unknown.statusCode).toBe(404);

      const escaping = await app.inject({
        method: 'POST',
        url: '/internal/artifact',
        headers: AUTH,
        payload: { callerChatId: chatId, path: '../escape.html' },
      });
      expect(escaping.statusCode).toBe(400);

      const absolute = await app.inject({
        method: 'POST',
        url: '/internal/artifact',
        headers: AUTH,
        payload: { callerChatId: chatId, path: '/etc/hosts' },
      });
      expect(absolute.statusCode).toBe(400);

      const markdown = await app.inject({
        method: 'POST',
        url: '/internal/artifact',
        headers: AUTH,
        payload: { callerChatId: chatId, path: 'notes.md' },
      });
      expect(markdown.statusCode).toBe(400);
      expect(markdown.json().message).toMatch(/html/i);

      const missing = await app.inject({
        method: 'POST',
        url: '/internal/artifact',
        headers: AUTH,
        payload: { callerChatId: chatId, path: 'nothing-here.html' },
      });
      expect(missing.statusCode).toBe(404);

      expect(published).toHaveLength(0);
      expect(events.some((e) => e.type === 'chat.artifact')).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('fails loudly when the server cannot take the page — no chat.artifact, no URL', async () => {
    const { app, chatId, folder, events } = await setup({ publishFails: true });
    try {
      writeFileSync(join(folder, 'x.html'), '<p>x</p>', 'utf8');
      const res = await app.inject({
        method: 'POST',
        url: '/internal/artifact',
        headers: AUTH,
        payload: { callerChatId: chatId, path: 'x.html' },
      });
      expect(res.statusCode).toBe(502);
      expect(events.some((e) => e.type === 'chat.artifact')).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('503s when no publish hook is wired (no silent no-op)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-artifact-nohook-'));
    const folder = mkdtempSync(join(tmpdir(), 'patch-artifact-nohook-folder-'));
    const sdk = createMockSdkBackend();
    const daemon = new Daemon({
      daemonId: 'd1',
      metaStore: createMetaStore(home),
      sdkBackend: sdk,
      oauthAccessToken: 'x',
      emit: () => undefined,
      logger: silent,
    });
    const chatId = await daemon.spawnChat({ folder, prompt: 'hi' });
    await new Promise((r) => setTimeout(r, 20));
    const app = await buildControl({ localKey: LOCAL_KEY, daemon });
    try {
      writeFileSync(join(folder, 'x.html'), '<p>x</p>', 'utf8');
      const res = await app.inject({
        method: 'POST',
        url: '/internal/artifact',
        headers: AUTH,
        payload: { callerChatId: chatId, path: 'x.html' },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});

describe('ArtifactPublisher (host→server RPC)', () => {
  it('emits a publish_request and resolves with the URL the server replies', async () => {
    const emitted: WireEvent[] = [];
    const pub = new ArtifactPublisher({
      emit: (e) => emitted.push(e),
      isLinkOnline: () => true,
      idGen: () => 'req-1',
    });
    const p = pub.publish({
      chatId: 'c1',
      artifactId: 'abc',
      title: 'T',
      path: 'a.html',
      html: '<p>x</p>',
    });
    expect(emitted[0]!.type).toBe('patch.artifact.publish_request');
    pub.handleResponse({
      type: 'patch.artifact.publish_response',
      requestId: 'req-1',
      ok: true,
      url: '/api/chats/c1/artifact/abc',
    });
    await expect(p).resolves.toEqual({ url: '/api/chats/c1/artifact/abc' });
  });

  it('rejects on a server error and when the link is offline (no silent success)', async () => {
    const pub = new ArtifactPublisher({
      emit: () => undefined,
      isLinkOnline: () => true,
      idGen: () => 'req-2',
    });
    const p = pub.publish({
      chatId: 'c1',
      artifactId: 'abc',
      title: 'T',
      path: 'a.html',
      html: '<p>x</p>',
    });
    pub.handleResponse({
      type: 'patch.artifact.publish_response',
      requestId: 'req-2',
      ok: false,
      error: { code: 'internal', message: 'disk full' },
    });
    await expect(p).rejects.toThrow(/disk full/);

    const offline = new ArtifactPublisher({ emit: () => undefined, isLinkOnline: () => false });
    await expect(
      offline.publish({
        chatId: 'c1',
        artifactId: 'abc',
        title: 'T',
        path: 'a.html',
        html: '<p>x</p>',
      }),
    ).rejects.toThrow(ArtifactLinkOfflineError);
  });

  it('times out rather than hanging when no response ever arrives', async () => {
    const pub = new ArtifactPublisher({
      emit: () => undefined,
      isLinkOnline: () => true,
      idGen: () => 'req-3',
      requestTimeoutMs: 20,
    });
    await expect(
      pub.publish({
        chatId: 'c1',
        artifactId: 'abc',
        title: 'T',
        path: 'a.html',
        html: '<p>x</p>',
      }),
    ).rejects.toThrow(/timed out/);
  });

  // `raw` (a view_file image) travels the same RPC as `html` — served
  // byte-for-byte with its own content-type instead of wrapped as a page.
  it('emits a raw publish_request and resolves with the URL the server replies', async () => {
    const emitted: WireEvent[] = [];
    const pub = new ArtifactPublisher({
      emit: (e) => emitted.push(e),
      isLinkOnline: () => true,
      idGen: () => 'req-4',
    });
    const p = pub.publish({
      chatId: 'c1',
      artifactId: 'img1',
      title: 'shot.png',
      path: 'shot.png',
      raw: { contentType: 'image/png', base64: 'Zm9v' },
    });
    const sent = emitted[0] as Extract<WireEvent, { type: 'patch.artifact.publish_request' }>;
    expect(sent.type).toBe('patch.artifact.publish_request');
    expect(sent.raw).toEqual({ contentType: 'image/png', base64: 'Zm9v' });
    expect(sent.html).toBeUndefined();
    pub.handleResponse({
      type: 'patch.artifact.publish_response',
      requestId: 'req-4',
      ok: true,
      url: '/api/chats/c1/artifact/img1',
    });
    await expect(p).resolves.toEqual({ url: '/api/chats/c1/artifact/img1' });
  });

  // NO FALLBACK: giving both or neither is a caller bug, not a 50/50 guess at
  // which one was meant.
  it('rejects when zero or both of html/raw are given', async () => {
    const pub = new ArtifactPublisher({ emit: () => undefined, isLinkOnline: () => true });
    await expect(
      pub.publish({ chatId: 'c1', artifactId: 'abc', title: 'T', path: 'a.html' }),
    ).rejects.toThrow(/exactly one of html\/raw/);
    await expect(
      pub.publish({
        chatId: 'c1',
        artifactId: 'abc',
        title: 'T',
        path: 'a.html',
        html: '<p>x</p>',
        raw: { contentType: 'image/png', base64: 'Zm9v' },
      }),
    ).rejects.toThrow(/exactly one of html\/raw/);
  });
});
