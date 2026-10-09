// End-to-end file-operations suite — the round trip the file browser's
// create / rename / delete makes, through the FULL real stack:
//
//   surface HTTP  POST /api/chats/:id/files { op, path, to? }
//       → server chat-routes → REAL InboundDaemonLink over the REAL serverLink
//         WebSocket
//       → host handleFileOpRequest (mutates the chat folder on disk)
//       → patch.file_op.response back over the link
//       → server resolves the pending request → a typed HTTP status.
//
// These are destructive operations on real files, so the properties worth
// proving end to end are the refusals: an occupied destination, a non-empty
// directory and an escaping path must all come back as a status the surface
// can show, with the disk untouched.

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  await until(() => harness.built.chatRegistry.get(chatId) !== undefined, 5000);
  return chatId;
}

function post(harness: E2EHarness, jwt: string, chatId: string, body: unknown) {
  return harness.built.app.inject({
    method: 'POST',
    url: `/api/chats/${chatId}/files`,
    headers: { authorization: `Bearer ${jwt}` },
    payload: body,
  });
}

describe('e2e file operations over the real server↔host path', () => {
  it('creates a file and a folder, and the tree listing then sees them', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('fop-1');
    const chatId = await spawnChat(h, jwt, h.folder);

    const made = await post(h, jwt, chatId, { op: 'create', path: 'notes.md' });
    expect(made.statusCode).toBe(200);
    expect((made.json() as { path: string }).path).toBe('notes.md');
    expect(readFileSync(join(h.folder, 'notes.md'), 'utf8')).toBe('');

    const dir = await post(h, jwt, chatId, { op: 'create_dir', path: 'src' });
    expect(dir.statusCode).toBe(200);

    const list = await h.built.app.inject({
      method: 'GET',
      url: `/api/chats/${chatId}/files?path=`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    const entries = (list.json() as { entries: Array<{ name: string; type: string }> }).entries;
    expect(entries.some((e) => e.name === 'notes.md' && e.type === 'file')).toBe(true);
    expect(entries.some((e) => e.name === 'src' && e.type === 'dir')).toBe(true);
  });

  it('renames a file and deletes it', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('fop-2');
    writeFileSync(join(h.folder, 'a.ts'), 'BYTES');
    const chatId = await spawnChat(h, jwt, h.folder);

    const renamed = await post(h, jwt, chatId, { op: 'rename', path: 'a.ts', to: 'b.ts' });
    expect(renamed.statusCode).toBe(200);
    expect((renamed.json() as { path: string }).path).toBe('b.ts');
    expect(readFileSync(join(h.folder, 'b.ts'), 'utf8')).toBe('BYTES');

    const deleted = await post(h, jwt, chatId, { op: 'delete', path: 'b.ts' });
    expect(deleted.statusCode).toBe(200);
    expect(existsSync(join(h.folder, 'b.ts'))).toBe(false);
  });

  it('refuses a rename onto an existing file with 409, both files intact', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('fop-3');
    writeFileSync(join(h.folder, 'a.ts'), 'SOURCE');
    writeFileSync(join(h.folder, 'b.ts'), 'DESTINATION');
    const chatId = await spawnChat(h, jwt, h.folder);

    const res = await post(h, jwt, chatId, { op: 'rename', path: 'a.ts', to: 'b.ts' });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('exists');
    expect(readFileSync(join(h.folder, 'a.ts'), 'utf8')).toBe('SOURCE');
    expect(readFileSync(join(h.folder, 'b.ts'), 'utf8')).toBe('DESTINATION');
  });

  it('refuses to delete a non-empty directory with 409, contents intact', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('fop-4');
    mkdirSync(join(h.folder, 'src'), { recursive: true });
    writeFileSync(join(h.folder, 'src', 'a.ts'), 'IMPORTANT');
    const chatId = await spawnChat(h, jwt, h.folder);

    const res = await post(h, jwt, chatId, { op: 'delete', path: 'src' });

    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('not_empty');
    expect(readFileSync(join(h.folder, 'src', 'a.ts'), 'utf8')).toBe('IMPORTANT');
  });

  it('refuses an escaping path at the HTTP boundary, before any host round trip', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('fop-5');
    const chatId = await spawnChat(h, jwt, h.folder);

    const traverse = await post(h, jwt, chatId, { op: 'delete', path: '../outside.txt' });
    expect(traverse.statusCode).toBe(400);
    expect((traverse.json() as { error: string }).error).toBe('path_invalid');

    const absolute = await post(h, jwt, chatId, { op: 'delete', path: '/etc/hosts' });
    expect(absolute.statusCode).toBe(400);

    const empty = await post(h, jwt, chatId, { op: 'delete', path: '' });
    expect(empty.statusCode).toBe(400);
  });

  it('refuses an unknown op and a rename with no destination', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('fop-6');
    writeFileSync(join(h.folder, 'a.ts'), 'BYTES');
    const chatId = await spawnChat(h, jwt, h.folder);

    const badOp = await post(h, jwt, chatId, { op: 'chmod', path: 'a.ts' });
    expect(badOp.statusCode).toBe(400);
    expect((badOp.json() as { error: string }).error).toBe('op_invalid');

    const noTo = await post(h, jwt, chatId, { op: 'rename', path: 'a.ts' });
    expect(noTo.statusCode).toBe(400);
    expect(readFileSync(join(h.folder, 'a.ts'), 'utf8')).toBe('BYTES');
  });

  it('404s an operation on a path that is not there, and on an unknown chat', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('fop-7');
    const chatId = await spawnChat(h, jwt, h.folder);

    const missing = await post(h, jwt, chatId, { op: 'delete', path: 'gone.ts' });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { error: string }).error).toBe('not_found');

    const noChat = await post(h, jwt, 'chat-that-does-not-exist', { op: 'delete', path: 'a.ts' });
    expect(noChat.statusCode).toBe(404);
  });

  it('requires a credential — an unauthenticated delete never reaches the disk', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('fop-8');
    writeFileSync(join(h.folder, 'a.ts'), 'BYTES');
    const chatId = await spawnChat(h, jwt, h.folder);

    const res = await h.built.app.inject({
      method: 'POST',
      url: `/api/chats/${chatId}/files`,
      payload: { op: 'delete', path: 'a.ts' },
    });

    expect(res.statusCode).toBe(401);
    expect(readFileSync(join(h.folder, 'a.ts'), 'utf8')).toBe('BYTES');
  });
});
