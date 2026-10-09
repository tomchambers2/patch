// Items 3 / 18 — empty-state copy (spec/15 § Empty states). Helper text is
// always a plain sentence — no parentheses, no brackets — and the canonical
// empty-chat copy replaces the old parenthesised "(No messages yet)".

import { describe, it, expect } from 'vitest';
import { EMPTY_STATES } from '../src/lib/emptyStates';

describe('empty-state copy', () => {
  it('the empty chat uses the canonical unbracketed copy', () => {
    expect(EMPTY_STATES.chat.title).toBe('No messages yet');
    expect(EMPTY_STATES.chat.body).toBe('Type below to start the conversation.');
  });

  it('no title or body contains a parenthesis or bracket', () => {
    for (const copy of Object.values(EMPTY_STATES)) {
      for (const text of [copy.title, copy.body]) {
        expect(text).not.toMatch(/[()[\]]/);
      }
    }
  });

  it('provides copy for every canonical empty surface', () => {
    for (const key of ['chat', 'chats', 'jobs', 'devices', 'secrets', 'chatSearch']) {
      expect(EMPTY_STATES[key as keyof typeof EMPTY_STATES]).toBeDefined();
    }
  });

  // The read-only mirror thread (Speakers) has no composer, so the
  // empty state must NOT invite typing (spec/15 § Chat detail — read-only
  // mirrors). Guards against a copy edit that reintroduces a "type below" line.
  it('the read-only mirror empty state has NO "type below" invitation', () => {
    expect(EMPTY_STATES.mirror.body).not.toMatch(/type/i);
    expect(EMPTY_STATES.mirror.body).not.toMatch(/below/i);
    // Its copy just explains that messages arrive on their own.
    expect(EMPTY_STATES.mirror).toEqual({
      title: 'Nothing here yet',
      body: 'Messages appear here as they arrive.',
    });
    // The composer-backed chat empty state DOES invite typing — the two differ.
    expect(EMPTY_STATES.chat.body).toMatch(/type/i);
    expect(EMPTY_STATES.mirror.body).not.toBe(EMPTY_STATES.chat.body);
  });

  it('every empty-state body is a single plain sentence (ends with a full stop)', () => {
    for (const copy of Object.values(EMPTY_STATES)) {
      expect(copy.body.trim()).toMatch(/\.$/);
    }
  });
});
