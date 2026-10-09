// End-to-end rename (spec/04 § Name) — REAL server + REAL host over a REAL
// WebSocket link, driven over REAL HTTP (fetch, not app.inject). The only mock
// is the SDK backend.
//
// The path exercised is the one a surface actually takes:
//   POST /api/chats/:id/rename
//     → server chat-routes → InboundDaemonLink
//       → real serverLink WS → real Daemon.setName
//         → meta.json on disk + chat.state fanned back out to the surface
//
// The last case is the one that matters most: the AI summariser and a user
// rename both write `name`, so a rename made before the first turn settles must
// win — and must not be quietly overwritten a few seconds later.

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WireEvent } from '@patch/wire';
import { startHarness, expectReply, record, until, type E2EHarness } from './harness.js';

let h: E2EHarness | undefined;
afterEach(async () => {
  if (h) await h.close();
  h = undefined;
});

/**
 * Spawn a chat via the REAL REST route and wait until the host has actually
 * created it. The spawn route is 202-Accepted — the host builds the chat
 * asynchronously — so a rename issued straight after would race it.
 */
async function spawnChat(
  harness: E2EHarness,
  jwt: string,
  folder: string,
  states: WireEvent[],
): Promise<string> {
  const res = await harness.built.app.inject({
    method: 'POST',
    url: '/api/chats',
    headers: { authorization: `Bearer ${jwt}` },
    payload: { daemonId: harness.daemonId, folder },
  });
  expect(res.statusCode).toBe(202);
  const chatId = (res.json() as { chatId: string }).chatId;
  await until(
    () => states.some((e) => e.type === 'chat.state' && e.chatId === chatId),
    3000,
    'chat.state after spawn',
  );
  return chatId;
}

/** POST the rename over real HTTP — the curl a surface issues. */
async function rename(
  harness: E2EHarness,
  jwt: string,
  chatId: string,
  name: string | null,
): Promise<Response> {
  return fetch(`${harness.httpBase}/api/chats/${chatId}/rename`, {
    method: 'POST',
    headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

describe('e2e rename: a surface renames a chat through the whole stack', () => {
  it('renames over real HTTP: host persists it and every surface sees chat.state', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('srf-r1');
    const client = await h.connectSurface('srf-r1b');
    const states = record(client, ['chat.state']);

    const chatId = await spawnChat(h, jwt, h.folder, states);

    const res = await rename(h, jwt, chatId, '  Bed Planner Rework  ');
    expect(res.status).toBe(200);

    // Fanned back out to the surface, whitespace trimmed by the host.
    await until(
      () =>
        states.some(
          (e) => e.type === 'chat.state' && e.chatId === chatId && e.name === 'Bed Planner Rework',
        ),
      3000,
      'chat.state carrying the new name',
    );

    // And durable on the host's disk, not just in memory.
    const meta = JSON.parse(
      readFileSync(join(h.patchHome, 'chats', chatId, 'meta.json'), 'utf8'),
    ) as { name: string | null };
    expect(meta.name).toBe('Bed Planner Rework');
  });

  it('clearing the name sends null back to the surface', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('srf-r2');
    const client = await h.connectSurface('srf-r2b');
    const states = record(client, ['chat.state']);

    const chatId = await spawnChat(h, jwt, h.folder, states);
    expect((await rename(h, jwt, chatId, 'Temporary Label')).status).toBe(200);
    await until(
      () => states.some((e) => e.type === 'chat.state' && e.name === 'Temporary Label'),
      3000,
      'named',
    );

    // Drop everything seen so far, so a `name: null` below can only be the clear.
    states.length = 0;
    expect((await rename(h, jwt, chatId, null)).status).toBe(200);
    await until(
      () => states.some((e) => e.type === 'chat.state' && e.chatId === chatId && e.name === null),
      3000,
      'chat.state carrying the cleared name',
    );
  });

  it('a rename made before the first turn is not overwritten by the AI summariser', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('srf-r3');
    const client = await h.connectSurface('srf-r3b');
    const states = record(client, ['chat.state']);

    const chatId = await spawnChat(h, jwt, h.folder, states);
    expect((await rename(h, jwt, chatId, 'My Own Name')).status).toBe(200);
    await until(
      () => states.some((e) => e.type === 'chat.state' && e.name === 'My Own Name'),
      3000,
      'named before the first turn',
    );

    // Now run a real turn — the point at which the summariser would fire.
    h.sdk.enqueue([{ type: 'assistant', content: 'sure thing', sessionId: 's1' }]);
    client.send({ type: 'chat.input', chatId, message: 'go', localId: 'L1' });
    await expectReply(client, chatId, 'rename-then-turn', 5000);
    await new Promise((r) => setTimeout(r, 200));

    expect(h.titleCalls()).toBe(0);
    expect(h.daemon.chatState.get(chatId)?.name).toBe('My Own Name');
    expect(states.every((e) => e.type !== 'chat.state' || e.name !== 'AI: go')).toBe(true);
  });

  it('rejects an unknown chat and an unauthenticated caller', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('srf-r4');

    expect((await rename(h, jwt, 'chat_does_not_exist_zzz', 'x')).status).toBe(404);

    const noAuth = await fetch(`${h.httpBase}/api/chats/c1/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(noAuth.status).toBe(401);
  });
});
