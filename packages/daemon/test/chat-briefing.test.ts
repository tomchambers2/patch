import { describe, it, expect } from 'vitest';
import { chatBriefing, withBriefing } from '../src/audio/chatBriefing.js';

describe('chat briefing', () => {
  it('is empty for a chat with nothing in it, and adds nothing to the instructions', () => {
    expect(chatBriefing([])).toBe('');
    expect(withBriefing('be brief', '')).toBe('be brief');
  });

  it('names the chat, how it began and the recent exchange, oldest first', () => {
    const text = chatBriefing([
      { role: 'user', text: '(This chat is titled "Voice fixes".)' },
      { role: 'user', text: '(It began with the user saying: "the voice is broken")' },
      { role: 'user', text: 'try again' },
      { role: 'model', text: 'fixed it' },
    ]);
    expect(text).toContain('This chat is titled "Voice fixes"');
    expect(text.indexOf('User: try again')).toBeLessThan(text.indexOf('Agent: fixed it'));
    expect(text).toMatch(/not a new chat/);
  });

  it('shortens long messages and keeps the newest when there is too much', () => {
    const long = `${'word '.repeat(400)}END`;
    const turns = Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('model' as const),
      text: `message ${i} ${long}`,
    }));
    const text = chatBriefing(turns);
    expect(text).not.toContain('END');
    expect(text).toContain('message 59');
    expect(text).not.toContain('message 0 ');
    expect(text.length).toBeLessThan(9_000);
  });
});
