import { describe, expect, it } from 'vitest';

import { decode, encode } from '../src/codec.js';
import { ChatMessageEvent } from '../src/events.js';

// spec/02 § Permission mode — the record of a mid-conversation mode change
// rides on the `system` `chat.message` that marks it, the same way a
// compaction boundary carries its figures.

describe('chat.message permissionModeChange', () => {
  it('round-trips through the codec', () => {
    const ev: ChatMessageEvent = {
      type: 'chat.message',
      chatId: 'c1',
      role: 'system',
      content: 'Permission mode → acceptEdits',
      seq: 7,
      permissionModeChange: 'acceptEdits',
    };
    expect(decode(encode(ev))).toEqual(ev);
  });

  it('is optional, so a host that predates it still sends a valid message', () => {
    const parsed = ChatMessageEvent.parse({
      type: 'chat.message',
      chatId: 'c1',
      role: 'assistant',
      content: 'hello',
      seq: 1,
    });
    expect(parsed.permissionModeChange).toBeUndefined();
  });

  // spec/02 § Permission mode's plan-mode exception — Claude Code moving a
  // chat to `plan` itself is recorded the same way a person's own switch is,
  // with this one extra field naming who made the change.
  it('permissionModeChangeAutomatic rides alongside permissionModeChange and round-trips', () => {
    const ev: ChatMessageEvent = {
      type: 'chat.message',
      chatId: 'c1',
      role: 'system',
      content: 'Permission mode → plan (set by Claude Code)',
      seq: 8,
      permissionModeChange: 'plan',
      permissionModeChangeAutomatic: true,
    };
    expect(decode(encode(ev))).toEqual(ev);
  });

  it('permissionModeChangeAutomatic is absent on an ordinary (human) mode change', () => {
    const parsed = ChatMessageEvent.parse({
      type: 'chat.message',
      chatId: 'c1',
      role: 'system',
      content: 'Permission mode → acceptEdits',
      seq: 7,
      permissionModeChange: 'acceptEdits',
    });
    expect(parsed.permissionModeChangeAutomatic).toBeUndefined();
  });

  it('refuses permissionModeChangeAutomatic: false — the field is present only when true', () => {
    expect(
      ChatMessageEvent.safeParse({
        type: 'chat.message',
        chatId: 'c1',
        role: 'system',
        content: 'Permission mode → plan',
        seq: 9,
        permissionModeChange: 'plan',
        permissionModeChangeAutomatic: false,
      }).success,
    ).toBe(false);
  });

  it('refuses a mode outside the set rather than coercing it', () => {
    expect(
      ChatMessageEvent.safeParse({
        type: 'chat.message',
        chatId: 'c1',
        role: 'system',
        content: 'Permission mode → dontAsk',
        seq: 2,
        permissionModeChange: 'dontAsk',
      }).success,
    ).toBe(false);
  });
});
