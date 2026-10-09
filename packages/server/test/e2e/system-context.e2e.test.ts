// End-to-end system-reminder disclosure (spec/02 § System-reminder disclosure)
// — REAL server + REAL host over a REAL WebSocket link; only the SDK backend
// is mocked, and it writes a real transcript for replay.
//
// The path exercised:
//   POST /api/chats/:id/todos  (a surface rewrites the task list)
//     → server → real serverLink WS → real Daemon.setTodos
//   chat.input from the surface
//     → host prefixes the turn with its todo-edit <system-reminder>
//       → the agent receives it (the mock echoes its prompt)
//       → the surface receives the user chat.message with the block carried
//         out of band as systemContext, never inlined into content
//   chat.replay from a fresh surface
//     → the same systemContext rebuilt from the persisted transcript.

import { describe, it, expect, afterEach } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { startHarness, expectReply, record, until, type E2EHarness } from './harness.js';

let h: E2EHarness | undefined;
afterEach(async () => {
  if (h) await h.close();
  h = undefined;
});

type UserMessage = Extract<WireEvent, { type: 'chat.message' }>;
const userMessages = (events: WireEvent[], chatId: string): UserMessage[] =>
  events.filter(
    (e): e is UserMessage => e.type === 'chat.message' && e.chatId === chatId && e.role === 'user',
  );

describe('e2e system context: an injected reminder reaches the surface beside its turn', () => {
  it('carries a todo-edit reminder as systemContext live and on replay, never in content', async () => {
    h = await startHarness();
    const jwt = await h.mintSurface('srf-sc1');
    const client = await h.connectSurface('srf-sc1b');
    const states = record(client, ['chat.state']);

    const spawn = await h.built.app.inject({
      method: 'POST',
      url: '/api/chats',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { daemonId: h.daemonId, folder: h.folder },
    });
    expect(spawn.statusCode).toBe(202);
    const chatId = (spawn.json() as { chatId: string }).chatId;
    await until(
      () => states.some((e) => e.type === 'chat.state' && e.chatId === chatId),
      3000,
      'chat.state after spawn',
    );
    client.send({ type: 'chat.focus_change', chatId });
    const live = record(client, ['chat.message']);

    const todos = await fetch(`${h.httpBase}/api/chats/${chatId}/todos`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ todos: [{ text: 'water the tomatoes', status: 'pending' }] }),
    });
    expect(todos.status).toBe(200);
    await until(
      () =>
        states.some(
          (e) =>
            e.type === 'chat.state' &&
            e.chatId === chatId &&
            e.todos?.some((t) => t.text === 'water the tomatoes') === true,
        ),
      3000,
      'the host adopted the edited list',
    );

    client.send({ type: 'chat.input', chatId, message: 'go on then', localId: 'L-sc1' });
    const reply = await expectReply(client, chatId, 'todo-edit reminder');
    // The agent really received the block (the mock echoes its whole prompt).
    expect(reply.content).toContain('<system-reminder>');
    expect(reply.content).toContain('water the tomatoes');

    await until(() => userMessages(live, chatId).length > 0, 3000, 'live user chat.message');
    const liveUser = userMessages(live, chatId)[0]!;
    expect(liveUser.content).toBe('go on then');
    expect(liveUser.systemContext).toHaveLength(1);
    expect(liveUser.systemContext![0]!.source).toBe('patch');
    expect(liveUser.systemContext![0]!.label).toBe('Todo list updated');
    expect(liveUser.systemContext![0]!.text).toContain('water the tomatoes');

    await client.close();
    const client2 = await h.connectSurface('srf-sc1c');
    const replayed = record(client2, ['chat.message']);
    client2.replay(chatId, -1);
    await until(
      () => userMessages(replayed, chatId).some((m) => m.content === 'go on then'),
      3000,
      'replayed user turn',
    );
    const replayedUser = userMessages(replayed, chatId).find((m) => m.content === 'go on then')!;
    expect(replayedUser.systemContext).toEqual(liveUser.systemContext);
    await client2.close();
  });
});
