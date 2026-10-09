// End-to-end file-browser suite (J1) — the round-trip the desktop file browser
// uses to load a file's CONTENT, exercised through the FULL real stack for the
// first time:
//
//   surface HTTP  GET /api/chats/:id/files?path=…&content=1
//       → server chat-routes → REAL InboundDaemonLink send over the REAL
//         serverLink WebSocket
//       → host handleFilesRequest (reads the chat folder off disk)
//       → patch.files.response back over the link
//       → server resolves the pending request → HTTP 200 { content }.
//
// Unit tests mocked `api.getFileContent`, so this server↔host path had ZERO
// coverage — exactly the "two components never tested together" gap. A silent
// regression here (content stripped, wrong path, host not wired) would make
// the browser show an empty editor with no error ("the file doesn't load").

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, until, type E2EHarness } from './harness.js';

let h: E2EHarness | undefined;
afterEach(async () => {
  if (h) await h.close();
  h = undefined;
});

async function spawnChat(harness: E2EHarness, jwt: string, folder: string): Promise<string> {
  const res = await harness.built.app.inject({
    method: 'POST',
    url: '/api/chats',
    headers: { authorization: `Bearer ${jwt}` },
    payload: { daemonId: harness.daemonId, folder },
  });
  expect(res.statusCode).toBe(202);
  const chatId = (res.json() as { chatId: string }).chatId;
  // The host emits chat.spawned over the link; wait until the server's
  // ChatRegistry admits it (the /files route 404s otherwise).
  await until(() => harness.built.chatRegistry.get(chatId) !== undefined, 5000);
  return chatId;
}

describe('e2e file browser: content loads over the real server↔host path', () => {
  it('returns a file’s real content (the load the browser makes)', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('files-1');
    writeFileSync(join(h.folder, 'hello.ts'), 'export const answer = 42;\n');
    const chatId = await spawnChat(h, jwt, h.folder);

    const res = await h.built.app.inject({
      method: 'GET',
      url: `/api/chats/${chatId}/files?path=hello.ts&content=1`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { path: string; content: string; size: number };
    expect(body.content).toBe('export const answer = 42;\n');
    expect(body.path).toBe('hello.ts');
    expect(body.size).toBeGreaterThan(0);
  });

  it('loads content of a nested file, and lists the directory', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('files-2');
    mkdirSync(join(h.folder, 'src'), { recursive: true });
    writeFileSync(join(h.folder, 'src', 'deep.md'), '# deep\n');
    const chatId = await spawnChat(h, jwt, h.folder);

    // Directory listing (tree) sees the folder.
    const list = await h.built.app.inject({
      method: 'GET',
      url: `/api/chats/${chatId}/files?path=`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(list.statusCode).toBe(200);
    const entries = (list.json() as { entries: Array<{ name: string; type: string }> }).entries;
    expect(entries.some((e) => e.name === 'src' && e.type === 'dir')).toBe(true);

    // Content of the nested file.
    const res = await h.built.app.inject({
      method: 'GET',
      url: `/api/chats/${chatId}/files?path=${encodeURIComponent('src/deep.md')}&content=1`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { content: string }).content).toBe('# deep\n');
  });

  it('a missing file surfaces a real 404 (not a silent empty editor)', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('files-3');
    const chatId = await spawnChat(h, jwt, h.folder);

    const res = await h.built.app.inject({
      method: 'GET',
      url: `/api/chats/${chatId}/files?path=nope.ts&content=1`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('not_found');
  });
});

// Editor overhaul (binary preview): GET /api/chats/:id/files/raw round-trips
// the SAME host link as the JSON route above but answers with real bytes
// under the file's Content-Type — the path an <img>/<embed> preview reads.
describe('e2e file browser: GET /files/raw serves real bytes over the same host path', () => {
  it('serves a binary file’s exact bytes with the right Content-Type', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('files-raw-1');
    // A tiny real PNG header — bytes that would mangle if the server decoded
    // them as UTF-8 anywhere along the way (proves the base64 round-trip).
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad, 0xbe]);
    writeFileSync(join(h.folder, 'pic.png'), bytes);
    const chatId = await spawnChat(h, jwt, h.folder);

    const res = await h.built.app.inject({
      method: 'GET',
      url: `/api/chats/${chatId}/files/raw?path=pic.png`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(res.rawPayload, bytes)).toBe(0);
  });

  it('a missing file 404s the same way as the JSON route', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('files-raw-2');
    const chatId = await spawnChat(h, jwt, h.folder);

    const res = await h.built.app.inject({
      method: 'GET',
      url: `/api/chats/${chatId}/files/raw?path=nope.png`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe('not_found');
  });

  it('rejects a path escaping the chat folder', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('files-raw-3');
    const chatId = await spawnChat(h, jwt, h.folder);

    const res = await h.built.app.inject({
      method: 'GET',
      url: `/api/chats/${chatId}/files/raw?path=${encodeURIComponent('../../etc/passwd')}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires auth, same as every other files route', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('files-raw-4');
    const chatId = await spawnChat(h, jwt, h.folder);

    const res = await h.built.app.inject({
      method: 'GET',
      url: `/api/chats/${chatId}/files/raw?path=pic.png`,
    });
    expect(res.statusCode).toBe(401);
  });
});
