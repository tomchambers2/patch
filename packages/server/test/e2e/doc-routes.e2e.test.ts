// End-to-end document-editor suite — spec/14 § Document editor, step 2 of 3 —
// through the FULL real stack:
//
//   surface HTTP  GET /api/chats/:id/doc / POST /api/chats/:id/doc/action
//       → server chat-routes → REAL InboundDaemonLink over the REAL serverLink
//         WebSocket
//       → host handleDocRequest / handleDocActionRequest → Host methods
//         (chatRunner.ts), reading/writing the sidecar on real disk
//       → patch.doc(.action).response back over the link
//       → server resolves the pending request → a typed HTTP status.

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
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

function getDoc(harness: E2EHarness, jwt: string, chatId: string, path: string) {
  return harness.built.app.inject({
    method: 'GET',
    url: `/api/chats/${chatId}/doc?path=${encodeURIComponent(path)}`,
    headers: { authorization: `Bearer ${jwt}` },
  });
}

function docAction(
  harness: E2EHarness,
  jwt: string,
  chatId: string,
  path: string,
  action: unknown,
) {
  return harness.built.app.inject({
    method: 'POST',
    url: `/api/chats/${chatId}/doc/action`,
    headers: { authorization: `Bearer ${jwt}` },
    payload: { path, action },
  });
}

describe('e2e document editor over the real server↔host path', () => {
  it('defaults an untouched .md file to change mode', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('doc-1');
    writeFileSync(join(h.folder, 'notes.md'), '# Notes\n');
    const chatId = await spawnChat(h, jwt, h.folder);

    const res = await getDoc(h, jwt, chatId, 'notes.md');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      mode: 'change',
      suggestions: [],
      threads: [],
      versions: [],
    });
  });

  it('switches mode and it is readable right back', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('doc-2');
    writeFileSync(join(h.folder, 'notes.md'), '# Notes\n');
    const chatId = await spawnChat(h, jwt, h.folder);

    const set = await docAction(h, jwt, chatId, 'notes.md', { op: 'set_mode', mode: 'propose' });
    expect(set.statusCode).toBe(200);
    expect((set.json() as { mode: string }).mode).toBe('propose');

    const get = await getDoc(h, jwt, chatId, 'notes.md');
    expect((get.json() as { mode: string }).mode).toBe('propose');
  });

  it('a comment thread round-trips: add, reply, resolve', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('doc-3');
    writeFileSync(join(h.folder, 'notes.md'), 'Hello world.\n');
    const chatId = await spawnChat(h, jwt, h.folder);

    const added = await docAction(h, jwt, chatId, 'notes.md', {
      op: 'add_comment',
      anchor: 'Hello',
      text: 'tone?',
    });
    expect(added.statusCode).toBe(200);
    const threadId = (added.json() as { threads: Array<{ id: string }> }).threads[0]!.id;

    const replied = await docAction(h, jwt, chatId, 'notes.md', {
      op: 'reply_comment',
      threadId,
      text: 'fine',
    });
    expect(replied.statusCode).toBe(200);
    expect(
      (replied.json() as { threads: Array<{ comments: unknown[] }> }).threads[0]!.comments,
    ).toHaveLength(2);

    const resolved = await docAction(h, jwt, chatId, 'notes.md', {
      op: 'resolve_comment',
      threadId,
      resolved: true,
    });
    expect(resolved.statusCode).toBe(200);
    expect(
      (resolved.json() as { threads: Array<{ resolved: boolean }> }).threads[0]!.resolved,
    ).toBe(true);
  });

  it('accept_all applies pending suggestions and the file on disk changes', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('doc-4');
    writeFileSync(join(h.folder, 'notes.md'), 'one two\n');
    const chatId = await spawnChat(h, jwt, h.folder);
    await docAction(h, jwt, chatId, 'notes.md', { op: 'set_mode', mode: 'propose' });

    // No surface-facing "suggest" op exists — only the agent's MCP tool
    // creates one. Exercise accept_all against a suggestion seeded directly
    // through the host, the same shape `patch_doc_suggest` lands.
    const suggested = h.daemon.suggestDoc(chatId, 'notes.md', 'one', 'ONE');
    expect(suggested.ok).toBe(true);

    const accepted = await docAction(h, jwt, chatId, 'notes.md', { op: 'accept_all' });
    expect(accepted.statusCode).toBe(200);
    expect(readFileSync(join(h.folder, 'notes.md'), 'utf8')).toBe('ONE two\n');
  });

  it('restore_version writes the file back to that version', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('doc-5');
    writeFileSync(join(h.folder, 'notes.md'), 'ignored\n');
    const chatId = await spawnChat(h, jwt, h.folder);
    h.daemon.writeFile(chatId, 'notes.md', 'v1\n');
    h.daemon.writeFile(chatId, 'notes.md', 'v2\n');

    const before = await getDoc(h, jwt, chatId, 'notes.md');
    const v1Id = (before.json() as { versions: Array<{ id: string }> }).versions[0]!.id;

    const restored = await docAction(h, jwt, chatId, 'notes.md', {
      op: 'restore_version',
      versionId: v1Id,
    });
    expect(restored.statusCode).toBe(200);
    expect(readFileSync(join(h.folder, 'notes.md'), 'utf8')).toBe('v1\n');
  });

  it('404s a doc request for an unknown chat', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('doc-6');
    const res = await getDoc(h, jwt, 'no-such-chat', 'notes.md');
    expect(res.statusCode).toBe(404);
  });

  it('400s a doc action with no action.op', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('doc-7');
    writeFileSync(join(h.folder, 'notes.md'), 'x\n');
    const chatId = await spawnChat(h, jwt, h.folder);
    const res = await docAction(h, jwt, chatId, 'notes.md', {});
    expect(res.statusCode).toBe(400);
  });
});
