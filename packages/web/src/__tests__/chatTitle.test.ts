// spec/04 § Name — the chat title is the AI-generated `name`; until it lands the
// row reads "New chat". The folder basename, the first user message and the
// preview snippet are NEVER used as the title (the folder made every unnamed
// chat in a project look identically named; the message produced garbage like a
// raw `[Attachments]` path).

import { describe, it, expect } from 'vitest';
import { deriveChatTitle } from '../lib/chatTitle.js';

const ULID = '01KVBD4HJF0N90DYVTDWEBH7FP';

describe('deriveChatTitle', () => {
  it('uses the server name (the AI title / override) when present', () => {
    expect(deriveChatTitle('Bus route planning')).toBe('Bus route planning');
  });

  it('reads "New chat" until the name lands, never the folder', () => {
    expect(deriveChatTitle(null)).toBe('New chat');
    expect(deriveChatTitle('')).toBe('New chat');
    expect(deriveChatTitle('   ')).toBe('New chat');
    expect(deriveChatTitle(null)).not.toBe(ULID);
  });

  it('returns the name as given — the row, not this helper, handles overflow', () => {
    const long = 'a'.repeat(200);
    expect(deriveChatTitle(long)).toBe(long);
  });

  it('never returns the first user message or an attachment path as the title', () => {
    // There is no message/preview parameter: an unnamed chat is "New chat".
    expect(deriveChatTitle(null)).not.toContain('[Attachments]');
  });
});
