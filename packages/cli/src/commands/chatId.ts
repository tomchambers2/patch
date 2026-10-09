// spec/17 § Commands — "`<id>` accepts the full ULID or a unique prefix".
//
// The host and server routes take exact ids only, so a prefix is resolved
// here, against the same chat list `patch chats list` reads on this transport
// (archived included — `get`/`archive --archived false` on an archived chat
// must still find it). Anything that is not a partial ULID (a full id, or a
// special thread's `thread_manager`-style id) is passed through untouched.

import type { Transport } from '../transport/index.js';
import { pickPath } from './_common.js';

const ULID_LENGTH = 26;
const ULID_PREFIX = /^[0-9A-HJKMNP-TV-Z]+$/;

export async function resolveChatId(t: Transport, id: string): Promise<string> {
  const upper = id.toUpperCase();
  if (id.length >= ULID_LENGTH || !ULID_PREFIX.test(upper)) return id;
  const path = pickPath(t, '/chats', '/api/chats');
  const { chats } = await t.get<{ chats: { chatId: string }[] }>(`${path}?archived=include`);
  const matches = chats.map((c) => c.chatId).filter((c) => c.startsWith(upper));
  if (matches.length === 1) return matches[0]!;
  const where = t.kind === 'uds' ? 'on this machine' : 'on this account';
  if (matches.length === 0) {
    throw new Error(`no chat ${where} has an id starting ${id}`);
  }
  throw new Error(`${id} is ambiguous: it starts ${matches.length} chats (${matches.join(', ')})`);
}
