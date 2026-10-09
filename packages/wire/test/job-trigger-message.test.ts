import { describe, expect, it } from 'vitest';

import { decode, encode } from '../src/codec.js';
import { ChatMessageEvent } from '../src/events.js';

// spec/08 § Action, spec/14 § Job trigger turn — a job's fire into an
// EXISTING chat rides on the user-role `chat.message` as `jobTrigger`, the
// same additive-field pattern `permissionModeChange`/`retryOfSeq` use.

describe('chat.message jobTrigger', () => {
  it('round-trips through the codec', () => {
    const ev: ChatMessageEvent = {
      type: 'chat.message',
      chatId: 'c1',
      role: 'user',
      content: '{"route":"36","etaMinutes":4}',
      seq: 7,
      jobTrigger: true,
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
    expect(parsed.jobTrigger).toBeUndefined();
  });

  it('refuses jobTrigger: false — the field is present only when true', () => {
    expect(
      ChatMessageEvent.safeParse({
        type: 'chat.message',
        chatId: 'c1',
        role: 'user',
        content: 'hello',
        seq: 1,
        jobTrigger: false,
      }).success,
    ).toBe(false);
  });
});
