import { describe, expect, it } from 'vitest';

import { decode, encode } from '../src/codec.js';
import { ChatMessageEvent } from '../src/events.js';

// spec/20-hooks.md § On the agent's response, spec/14 § Agent-response hooks
// — a `block` resubmit rides on the user-role `chat.message` as
// `hookTrigger`, the same additive-field pattern `jobTrigger` uses.

describe('chat.message hookTrigger', () => {
  it('round-trips through the codec', () => {
    const ev: ChatMessageEvent = {
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: '[hook: blocked]\n"no secrets": the reply contains a credential',
      seq: 7,
      hookTrigger: { hooks: [{ hookId: 'h1', hookName: 'no secrets' }] },
    };
    expect(decode(encode(ev))).toEqual(ev);
  });

  it('carries more than one blocking hook when several fired together', () => {
    const ev: ChatMessageEvent = {
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'combined analysis',
      seq: 7,
      hookTrigger: {
        hooks: [
          { hookId: 'h1', hookName: 'no secrets' },
          { hookId: 'h2', hookName: 'tone check' },
        ],
      },
    };
    expect(decode(encode(ev))).toEqual(ev);
  });

  it('is optional, so a host that predates it still sends a valid message', () => {
    const parsed = ChatMessageEvent.parse({
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: 'hello',
      seq: 1,
    });
    expect(parsed.hookTrigger).toBeUndefined();
  });
});
