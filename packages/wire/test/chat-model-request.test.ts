import { describe, expect, it } from 'vitest';

import { decode, encode } from '../src/codec.js';
import { ChatModelRequestEvent, ChatStateEvent } from '../src/events.js';
import { WireDecodeError } from '../src/errors.js';

// spec/04 § Model — a chat's model is changeable mid-chat. Two halves ride the
// wire: the surface's `chat.model_request`, and the host's acknowledgement,
// which is the `model` it now carries on every `chat.state`.

describe('chat.model_request', () => {
  it('round-trips through the codec', () => {
    const ev: ChatModelRequestEvent = {
      type: 'chat.model_request',
      chatId: 'c1',
      model: 'claude-opus-4-1',
    };
    expect(decode(encode(ev))).toEqual(ev);
  });

  it('requires a model — there is no "clear the model" meaning', () => {
    // Unlike chat.settings' permissionMode, whose absence CLEARS the override,
    // a chat is always on some model, so a frame with none says nothing.
    expect(
      ChatModelRequestEvent.safeParse({ type: 'chat.model_request', chatId: 'c1' }).success,
    ).toBe(false);
    expect(
      ChatModelRequestEvent.safeParse({ type: 'chat.model_request', chatId: 'c1', model: '' })
        .success,
    ).toBe(false);
  });

  it('rejects an unknown field rather than dropping it', () => {
    expect(() =>
      decode(
        JSON.stringify({
          type: 'chat.model_request',
          chatId: 'c1',
          model: 'claude-opus-4-1',
          applyToRunningTurn: true,
        }),
      ),
    ).toThrow(WireDecodeError);
  });
});

describe('chat.state carries the chat model', () => {
  const base = {
    type: 'chat.state' as const,
    chatId: 'c1',
    activity: 'idle' as const,
    lastUpdated: 1,
    permissionMode: 'auto' as const,
  };

  it('accepts a model and round-trips it', () => {
    const ev: ChatStateEvent = { ...base, model: 'claude-opus-4-1' };
    expect(decode(encode(ev))).toEqual(ev);
    const decoded = decode(encode(ev));
    expect(decoded.type === 'chat.state' && decoded.model).toBe('claude-opus-4-1');
  });

  it('still accepts a frame with no model — an older host cannot send one', () => {
    // This absence is the surface's ONLY signal that a host cannot honour a
    // model change (spec/14 § Model selector), so it must stay decodable
    // rather than being made required.
    const parsed = ChatStateEvent.safeParse(base);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.model).toBeUndefined();
  });

  it('refuses an empty model rather than treating it as "no model"', () => {
    expect(ChatStateEvent.safeParse({ ...base, model: '' }).success).toBe(false);
  });
});
