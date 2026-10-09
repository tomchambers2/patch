// Item 16 — "New chat" always lands on the freshly-created chat, NEVER on
// Manager (spec/15 ## New chat flow).

import { describe, it, expect } from 'vitest';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { newChatRoute, NEW_CHAT_DRAFT_KEY } from '../src/lib/newChat';

describe('newChatRoute', () => {
  it('routes to the new chat detail, flagged as just created', () => {
    expect(newChatRoute('01HXNEWCHATID')).toBe('/chats/01HXNEWCHATID?justCreated=1');
  });

  it('refuses to route a new chat to Manager', () => {
    expect(() => newChatRoute(SPECIAL_THREAD_IDS.manager)).toThrow();
  });

  it('refuses an empty chat id', () => {
    expect(() => newChatRoute('')).toThrow();
  });
});

describe('NEW_CHAT_DRAFT_KEY', () => {
  it('can never be a real chat id', () => {
    expect(NEW_CHAT_DRAFT_KEY).not.toMatch(/^(chat|thread)_/);
  });
});
