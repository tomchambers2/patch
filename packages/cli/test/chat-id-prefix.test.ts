// spec/17 § Commands: `<id>` accepts the full ULID or a unique prefix.
// 2026-09-29: `patch chats get 01M3N32N` 404'd while the full id worked.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveChatId } from '../src/commands/chatId.js';
import type { Transport } from '../src/transport/index.js';

const A = '01M3N32N9T7V75JCV7XHY9NRHM';
const B = '01M3N32NAAAAAAAAAAAAAAAAAA';
const C = '01M3N6CN87R4K73FD3PRWPN0RW';

function fake(kind: 'uds' | 'rest', chats: string[]): Transport & { gets: string[] } {
  const gets: string[] = [];
  const t = {
    kind,
    gets,
    async get<T>(path: string): Promise<T> {
      gets.push(path);
      return { chats: chats.map((chatId) => ({ chatId })) } as T;
    },
    post: async () => {
      throw new Error('unused');
    },
    patch: async () => {
      throw new Error('unused');
    },
    delete: async () => {
      throw new Error('unused');
    },
  };
  return t as unknown as Transport & { gets: string[] };
}

test('a unique prefix resolves to the full id, archived chats included', async () => {
  const t = fake('uds', [A, C]);
  assert.equal(await resolveChatId(t, '01M3N32N'), A);
  assert.deepEqual(t.gets, ['/chats?archived=include']);
});

test('prefixes are case-insensitive and resolve over REST against the account list', async () => {
  const t = fake('rest', [A, C]);
  assert.equal(await resolveChatId(t, '01m3n6cn'), C);
  assert.deepEqual(t.gets, ['/api/chats?archived=include']);
});

test('a full id and a special thread id pass straight through without a lookup', async () => {
  const t = fake('uds', []);
  assert.equal(await resolveChatId(t, A), A);
  assert.equal(await resolveChatId(t, 'thread_manager'), 'thread_manager');
  assert.deepEqual(t.gets, []);
});

test('an ambiguous prefix is refused, naming every match', async () => {
  await assert.rejects(resolveChatId(fake('uds', [A, B, C]), '01M3N32N'), (err: Error) => {
    assert.match(err.message, /ambiguous/);
    assert.ok(err.message.includes(A) && err.message.includes(B));
    return true;
  });
});

test('a prefix nothing matches says so rather than 404ing on the prefix', async () => {
  await assert.rejects(resolveChatId(fake('uds', [C]), '01M3N32N'), /no chat on this machine/);
});
