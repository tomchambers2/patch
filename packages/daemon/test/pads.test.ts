// patch_pad_* — the host side of Pads (spec/14 § Pads, spec/06 § Cross-chat
// toolset). POST /internal/pad reads a folder from the chat folder, hands the
// files to the server (injected hook) and stamps a Pad card — a slim
// `chat.artifact` with id `pad-<padId>` — into the chat's stream. NO FALLBACK:
// every rejection (unknown chat, escaping dir, empty folder, link down, a server
// refusal) is a loud error and stamps nothing.

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
import { PadClient, bundleDir, PadInputError, type PadRequestInput } from '../src/pads.js';

const LOCAL_KEY = 'local-secret';
const AUTH = { authorization: `Bearer ${LOCAL_KEY}` };
const silent = pino({ level: 'silent' });

async function setup(opts: { serverRefuses?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'patch-pad-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-pad-folder-'));
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
  const calls: PadRequestInput[] = [];
  const app = await buildControl({
    localKey: LOCAL_KEY,
    daemon,
    padRequest: async (req) => {
      calls.push(req);
      if (opts.serverRefuses) throw new Error(opts.serverRefuses);
      if (req.op === 'list') return { pads: [] };
      return { id: 'care-screens', name: req.name ?? 'Care screens', screens: [] };
    },
  });
  return { app, chatId, folder, events, calls };
}

const cards = (events: WireEvent[]) => events.filter((e) => e.type === 'chat.artifact');
const post = (app: Awaited<ReturnType<typeof setup>>['app'], payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/internal/pad', headers: AUTH, payload });

describe('bundleDir', () => {
  it('reads every file under the folder, skipping dotfiles and node_modules', () => {
    const folder = mkdtempSync(join(tmpdir(), 'pad-bundle-'));
    mkdirSync(join(folder, 'care', 'img'), { recursive: true });
    mkdirSync(join(folder, 'care', 'node_modules'), { recursive: true });
    writeFileSync(join(folder, 'care', 'index.html'), '<p>hi</p>');
    writeFileSync(join(folder, 'care', 'img', 'a.png'), 'png');
    writeFileSync(join(folder, 'care', '.secret'), 'x');
    writeFileSync(join(folder, 'care', 'node_modules', 'x.js'), 'x');
    const files = bundleDir(folder, 'care');
    expect(files.map((f) => f.path).sort()).toEqual(['img/a.png', 'index.html']);
    expect(
      Buffer.from(files.find((f) => f.path === 'index.html')!.base64, 'base64').toString(),
    ).toBe('<p>hi</p>');
  });
  it('refuses absolute, escaping, missing and empty folders', () => {
    const folder = mkdtempSync(join(tmpdir(), 'pad-bundle-'));
    mkdirSync(join(folder, 'empty'));
    expect(() => bundleDir(folder, '/etc')).toThrow(PadInputError);
    expect(() => bundleDir(folder, '../x')).toThrow(/inside the chat folder/);
    expect(() => bundleDir(folder, 'nope')).toThrow(/no such folder/);
    expect(() => bundleDir(folder, 'empty')).toThrow(/no files/);
    mkdirSync(join(folder, 'loose'));
    writeFileSync(join(folder, 'loose', 'a.html'), 'x');
    expect(() => bundleDir(folder, 'loose')).toThrow('no index.html or pad.json in loose');
  });
});

describe('POST /internal/pad', () => {
  it('create ships the folder and stamps a Pad card', async () => {
    const { app, chatId, folder, events, calls } = await setup();
    mkdirSync(join(folder, 'care'));
    writeFileSync(join(folder, 'care', 'index.html'), '<title>Home</title>');
    const res = await post(app, {
      op: 'create',
      callerChatId: chatId,
      dir: 'care',
      name: 'Care screens',
      app: 'Dog Log',
      device: 'phone',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'care-screens' });
    expect(calls[0]).toMatchObject({
      op: 'create',
      chatId,
      name: 'Care screens',
      app: 'Dog Log',
      device: 'phone',
    });
    expect(calls[0]!.files).toHaveLength(1);
    expect(cards(events).at(-1)).toMatchObject({
      artifactId: 'pad-care-screens',
      title: 'Care screens',
      url: '/pads/care-screens',
      path: 'pad:care-screens',
    });
  });

  it('update and reply refresh the same card; list stamps nothing', async () => {
    const { app, chatId, folder, events } = await setup();
    mkdirSync(join(folder, 'care'));
    writeFileSync(join(folder, 'care', 'index.html'), 'x');
    expect(
      (await post(app, { op: 'update', callerChatId: chatId, padId: 'care-screens', dir: 'care' }))
        .statusCode,
    ).toBe(200);
    expect(
      (await post(app, { op: 'reply', callerChatId: chatId, padId: 'care-screens', text: 'done' }))
        .statusCode,
    ).toBe(200);
    expect(cards(events).map((c) => (c as { artifactId: string }).artifactId)).toEqual([
      'pad-care-screens',
      'pad-care-screens',
    ]);
    const before = cards(events).length;
    expect((await post(app, { op: 'list', callerChatId: chatId })).statusCode).toBe(200);
    expect(cards(events)).toHaveLength(before);
  });

  it('is loud about every failure and stamps nothing', async () => {
    const { app, chatId, folder, events } = await setup();
    mkdirSync(join(folder, 'care'));
    writeFileSync(join(folder, 'care', 'index.html'), 'x');
    expect(
      (await post(app, { op: 'create', callerChatId: 'ghost', dir: 'care', name: 'x' })).statusCode,
    ).toBe(404);
    const escape = await post(app, { op: 'create', callerChatId: chatId, dir: '../x', name: 'x' });
    expect(escape.statusCode).toBe(400);
    expect(escape.json().message).toMatch(/inside the chat folder/);
    expect((await post(app, { op: 'create', callerChatId: chatId, dir: 'care' })).statusCode).toBe(
      400,
    ); // no name
    expect(
      cards(events).filter((e) => (e as { artifactId: string }).artifactId.startsWith('pad-')),
    ).toHaveLength(0);
  });

  it('a server refusal is a 502 with the server’s reason and no card', async () => {
    const { app, chatId, folder, events } = await setup({
      serverRefuses: 'pad "x" belongs to another chat',
    });
    mkdirSync(join(folder, 'care'));
    writeFileSync(join(folder, 'care', 'index.html'), 'x');
    const res = await post(app, { op: 'update', callerChatId: chatId, padId: 'x', dir: 'care' });
    expect(res.statusCode).toBe(502);
    expect(res.json().message).toBe('pad "x" belongs to another chat');
    expect(cards(events)).toHaveLength(0);
  });
});

describe('PadClient', () => {
  it('parks the request until the matching response arrives', async () => {
    const sent: WireEvent[] = [];
    const client = new PadClient({
      emit: (e) => sent.push(e),
      isLinkOnline: () => true,
      idGen: () => 'r1',
    });
    const p = client.request({ op: 'list', chatId: 'c1' });
    expect(sent[0]).toMatchObject({
      type: 'patch.pad.request',
      requestId: 'r1',
      op: 'list',
      chatId: 'c1',
    });
    expect(
      client.handleResponse({ type: 'patch.pad.response', requestId: 'other', ok: true }),
    ).toBe(false);
    expect(
      client.handleResponse({
        type: 'patch.pad.response',
        requestId: 'r1',
        ok: true,
        result: { pads: [] },
      }),
    ).toBe(true);
    await expect(p).resolves.toEqual({ pads: [] });
  });
  it('rejects with the server’s message, when the link is down, and on timeout', async () => {
    const client = new PadClient({
      emit: () => {},
      isLinkOnline: () => true,
      idGen: () => 'r2',
      requestTimeoutMs: 20,
    });
    const p = client.request({ op: 'reply', chatId: 'c1', padId: 'x', text: 't' });
    client.handleResponse({
      type: 'patch.pad.response',
      requestId: 'r2',
      ok: false,
      error: { code: 'not_found', message: 'no pad "x"' },
    });
    await expect(p).rejects.toThrow('no pad "x"');
    await expect(client.request({ op: 'list', chatId: 'c1' })).rejects.toThrow(/timed out/);
    const down = new PadClient({ emit: () => {}, isLinkOnline: () => false });
    await expect(down.request({ op: 'list', chatId: 'c1' })).rejects.toThrow(/offline/);
  });
});
