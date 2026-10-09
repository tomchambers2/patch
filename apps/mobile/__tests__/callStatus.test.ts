// lib/callStatus.ts — the wording every call surface shares (spec/15 § Voice
// states): the m:ss clock, the plain mode names, the phase names (connecting
// distinct from listening), the hands-free hint and the pill's chat name.

import { describe, it, expect } from 'vitest';
import {
  callChatName,
  callModeLabel,
  callPhaseLabel,
  formatElapsed,
  handsFreeHint,
} from '../src/lib/callStatus';

describe('formatElapsed', () => {
  it('reads m:ss', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(5_400)).toBe('0:05');
    expect(formatElapsed(83_000)).toBe('1:23');
    expect(formatElapsed(3_600_000)).toBe('60:00');
  });

  it('never goes negative on a skewed clock', () => {
    expect(formatElapsed(-4_000)).toBe('0:00');
  });
});

describe('callModeLabel', () => {
  it('names the two modes plainly', () => {
    expect(callModeLabel('call')).toBe('Call');
    expect(callModeLabel('hands-free')).toBe('Hands-free');
  });
});

describe('callPhaseLabel', () => {
  it('connecting is its own state, never "Listening"', () => {
    expect(callPhaseLabel('connecting')).toBe('Connecting');
    expect(callPhaseLabel('listening')).toBe('Listening');
  });

  it('names every live phase', () => {
    expect(callPhaseLabel('transcribing')).toBe('Hearing you');
    expect(callPhaseLabel('thinking')).toBe('Thinking');
    expect(callPhaseLabel('speaking')).toBe('Speaking');
  });
});

describe('handsFreeHint', () => {
  it('no hint in a call — every utterance is a turn', () => {
    expect(handsFreeHint('call', 'patch')).toBeNull();
  });

  it('hands-free names the address word the session is gated on', () => {
    expect(handsFreeHint('hands-free', 'patch')).toBe(
      'Start with “patch” — or reply within 30s of it speaking',
    );
    expect(handsFreeHint('hands-free', '  jarvis ')).toContain('“jarvis”');
  });

  it('without a loaded word it says so rather than guessing one', () => {
    expect(handsFreeHint('hands-free', null)).toBe(
      'Start with your address word — or reply within 30s of it speaking',
    );
    expect(handsFreeHint('hands-free', '   ')).toContain('your address word');
  });
});

describe('callChatName', () => {
  it('names the special threads', () => {
    expect(callChatName('thread_manager', undefined)).toBe('Manager');
    expect(callChatName('thread_speakers', undefined)).toBe('Speakers');
  });

  it('uses the chat title, or "Chat" before the row is known', () => {
    expect(callChatName('c1', { chatId: 'c1', name: 'Garden plan', folder: '/x' })).toBe(
      'Garden plan',
    );
    expect(callChatName('c1', { chatId: 'c1', name: null, folder: '/x' })).toBe('New chat');
    expect(callChatName('c1', undefined)).toBe('Chat');
  });
});
