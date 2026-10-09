import { describe, it, expect } from 'vitest';
import { resolveDeepLink } from '../src/lib/deepLink';

describe('resolveDeepLink (launcher long-press shortcuts + patch:// links)', () => {
  it('routes the Manager voice-note shortcut to a voice-note action', () => {
    expect(resolveDeepLink('patch://voice-note?chat=thread_manager')).toEqual({
      kind: 'voice-note',
      chatId: 'thread_manager',
    });
  });

  it('defaults voice-note to Manager when no chat param is given', () => {
    expect(resolveDeepLink('patch://voice-note')).toEqual({
      kind: 'voice-note',
      chatId: 'thread_manager',
    });
  });

  it('routes the New chat shortcut to the new-chat sheet', () => {
    expect(resolveDeepLink('patch://new-chat')).toEqual({
      kind: 'navigate',
      route: '/new-chat',
    });
  });

  it('routes the Open Speakers shortcut to the Speakers chat detail', () => {
    expect(resolveDeepLink('patch://chats/thread_speakers')).toEqual({
      kind: 'navigate',
      route: '/chats/thread_speakers',
    });
  });

  it('also resolves when the whole "chats/<id>" segment lands in `path` (host empty)', () => {
    // A triple-slash form: withoutScheme = "/chats/id123" → hostname="" (the
    // "host === 'chats'" branch is false), so the chatId comes out of
    // path.split('/').slice(1) instead of `path` directly.
    expect(resolveDeepLink('patch:///chats/thread_speakers')).toEqual({
      kind: 'navigate',
      route: '/chats/thread_speakers',
    });
  });

  it('returns null for "chats" with no id at all', () => {
    expect(resolveDeepLink('patch://chats')).toBeNull();
  });

  it('ignores a bare credential deep link (handled by bootstrap)', () => {
    expect(resolveDeepLink('patch://?credential=abc.def.ghi')).toBeNull();
  });

  it('returns null for null/empty/unknown links', () => {
    expect(resolveDeepLink(null)).toBeNull();
    expect(resolveDeepLink(undefined)).toBeNull();
    expect(resolveDeepLink('patch://nonsense')).toBeNull();
  });
});
