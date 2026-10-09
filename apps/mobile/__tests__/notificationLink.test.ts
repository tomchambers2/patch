// Tapped-notification routing (spec/15 § Push notifications). The interesting
// half is the deep-link gate: a `deepLink` is followed only when the
// notification's own text names where it goes, and a refusal is visible rather
// than silent.

import { describe, it, expect } from 'vitest';
import {
  resolveNotificationAction,
  deepLinkWords,
  deepLinkMatchesText,
} from '../src/lib/notificationLink';

/** No text at all — for the cases where the text is irrelevant. */
const NO_TEXT = { title: 'Patch', body: '' };

describe('resolveNotificationAction — chat routing', () => {
  it('deep-links a message notification to its source chat', () => {
    expect(
      resolveNotificationAction(
        { chatId: 'chat_abc', channel: 'push', priority: 'normal' },
        {
          title: 'Patch',
          body: 'hi',
        },
      ),
    ).toEqual({ action: { type: 'chat', route: '/chats/chat_abc' } });
  });

  it('does NOT deep-link a call wake-up (handled by ConnectionService)', () => {
    expect(
      resolveNotificationAction({ kind: 'call', chatId: 'thread_manager', callId: 'c1' }, NO_TEXT),
    ).toEqual({ action: null });
  });

  it('resolves a batch notification to the batch action (spec/15 § Batch view) — never a chat', () => {
    expect(resolveNotificationAction({ kind: 'batch' }, NO_TEXT)).toEqual({
      action: { type: 'batch' },
    });
    // Even if a stray chatId were present, batch still wins — a batch
    // notification is never a source-chat notification.
    expect(resolveNotificationAction({ kind: 'batch', chatId: 'chat_abc' }, NO_TEXT)).toEqual({
      action: { type: 'batch' },
    });
  });

  it('returns no action when there is no chatId or deepLink', () => {
    expect(resolveNotificationAction({ message: 'orphan' }, NO_TEXT)).toEqual({ action: null });
  });

  it('returns no action for an empty chatId', () => {
    expect(resolveNotificationAction({ chatId: '' }, NO_TEXT)).toEqual({ action: null });
  });

  it('falls through to the chat for an empty deepLink', () => {
    expect(resolveNotificationAction({ chatId: 'chat_abc', deepLink: '' }, NO_TEXT)).toEqual({
      action: { type: 'chat', route: '/chats/chat_abc' },
    });
  });

  it('returns no action for undefined data', () => {
    expect(resolveNotificationAction(undefined, NO_TEXT)).toEqual({ action: null });
  });

  it('returns no action for an empty payload', () => {
    expect(resolveNotificationAction({}, NO_TEXT)).toEqual({ action: null });
  });

  // FCM flattens every data value to a string in transit, so a non-string here
  // means the payload was malformed at the source. Refuse it rather than
  // routing to "/chats/undefined" or "/chats/[object Object]".
  it.each([
    ['a number', 42],
    ['null', null],
    ['an object', { id: 'chat_abc' }],
    ['an array', ['chat_abc']],
  ])('returns no action when chatId is %s', (_label, chatId) => {
    expect(resolveNotificationAction({ chatId }, NO_TEXT)).toEqual({ action: null });
  });

  it('ignores a non-string deepLink and still opens the chat', () => {
    expect(resolveNotificationAction({ chatId: 'chat_abc', deepLink: 12345 }, NO_TEXT)).toEqual({
      action: { type: 'chat', route: '/chats/chat_abc' },
    });
  });

  it('routes a non-call kind to its chat normally', () => {
    expect(resolveNotificationAction({ kind: 'message', chatId: 'chat_abc' }, NO_TEXT)).toEqual({
      action: { type: 'chat', route: '/chats/chat_abc' },
    });
  });

  it('does NOT deep-link a call wake-up even when it carries a deepLink', () => {
    expect(
      resolveNotificationAction(
        { kind: 'call', chatId: 'c1', deepLink: 'https://example.com' },
        { title: 'Patch is calling', body: 'example.com' },
      ),
    ).toEqual({ action: null });
  });
});

describe('deepLinkWords', () => {
  it('takes the scheme of an app URI', () => {
    expect(deepLinkWords('citymapper://directions?startcoord=51.4,-2.6')).toContain('citymapper');
  });

  it('takes the host label of an https URI and drops the TLD', () => {
    const words = deepLinkWords('https://todoist.com/showTask?id=1');
    expect(words).toContain('todoist');
    expect(words).not.toContain('com');
    expect(words).not.toContain('https');
  });

  it('splits camelCase path/query words', () => {
    expect(deepLinkWords('https://todoist.com/showTask?id=1')).toEqual(
      expect.arrayContaining(['show', 'task']),
    );
  });

  it('drops words shorter than three letters', () => {
    expect(deepLinkWords('https://x.io/a/bb/ccc')).toEqual(['ccc']);
  });

  it('yields nothing for a URI made only of noise and numbers', () => {
    expect(deepLinkWords('https://192.168.0.1/1/2/3')).toEqual([]);
  });

  it('deduplicates repeated words', () => {
    const words = deepLinkWords('https://todoist.com/todoist/todoist');
    expect(words.filter((w) => w === 'todoist')).toHaveLength(1);
  });
});

describe('deepLinkMatchesText', () => {
  it('matches when the body names the app', () => {
    expect(
      deepLinkMatchesText('citymapper://directions?startcoord=51.4,-2.6', {
        title: 'Patch',
        body: 'Leave in 6 minutes — the walk is in Citymapper.',
      }),
    ).toBe(true);
  });

  it('matches when the title names the app', () => {
    expect(
      deepLinkMatchesText('https://todoist.com/showTask?id=1', {
        title: 'Todoist',
        body: 'Ring the plumber back.',
      }),
    ).toBe(true);
  });

  it('matches on a path word rather than the host', () => {
    expect(
      deepLinkMatchesText('https://example.org/forecast/bristol', {
        title: 'Patch',
        body: 'Rain by 4 — here is the forecast.',
      }),
    ).toBe(true);
  });

  it('does NOT match when the text mentions nothing in the link', () => {
    expect(
      deepLinkMatchesText('citymapper://directions?startcoord=51.4,-2.6', {
        title: 'Patch',
        body: 'The kitchen order has shipped.',
      }),
    ).toBe(false);
  });

  it('does NOT match a link with no identifying words', () => {
    expect(
      deepLinkMatchesText('https://192.168.0.1/1/2/3', { title: 'Patch', body: 'Anything at all' }),
    ).toBe(false);
  });

  it('does NOT match on generic URI furniture the body happens to contain', () => {
    expect(
      deepLinkMatchesText('https://www.example.com/index.html', {
        title: 'Patch',
        body: 'The app is at https://www.somewhere.com/index.html',
      }),
    ).toBe(false);
  });

  it('ignores a missing or non-string body', () => {
    expect(deepLinkMatchesText('citymapper://directions', { title: 'Patch' })).toBe(false);
    expect(deepLinkMatchesText('citymapper://directions', { title: 'Patch', body: 42 })).toBe(
      false,
    );
  });
});

describe('resolveNotificationAction — the deep-link gate', () => {
  it('opens a deepLink the notification names', () => {
    expect(
      resolveNotificationAction(
        {
          chatId: 'chat_abc',
          deepLink: 'citymapper://directions?startcoord=51.4,-2.6&endcoord=51.45,-2.58',
        },
        { title: 'Patch', body: 'Leave in 6 minutes — the route is in Citymapper.' },
      ),
    ).toEqual({
      action: {
        type: 'external',
        url: 'citymapper://directions?startcoord=51.4,-2.6&endcoord=51.45,-2.58',
      },
    });
  });

  // The bug: a push about one thing carrying a link to another still navigated
  // there. It must now land in the chat the notification came from.
  it('REFUSES a deepLink that contradicts the notification text and opens the chat instead', () => {
    const r = resolveNotificationAction(
      { chatId: 'chat_abc', deepLink: 'https://todoist.com/showTask?id=99' },
      { title: 'Patch', body: 'The garden watering finished early.' },
    );
    expect(r.action).toEqual({ type: 'chat', route: '/chats/chat_abc' });
    expect(r.rejectedDeepLink).toEqual({
      url: 'https://todoist.com/showTask?id=99',
      reason: 'link-not-named-in-notification-text',
      words: expect.arrayContaining(['todoist', 'show', 'task']),
    });
  });

  it('REFUSES a deepLink with no identifying words and says why', () => {
    const r = resolveNotificationAction(
      { chatId: 'chat_abc', deepLink: 'https://10.0.0.7/1/2' },
      { title: 'Patch', body: 'The build finished.' },
    );
    expect(r.action).toEqual({ type: 'chat', route: '/chats/chat_abc' });
    expect(r.rejectedDeepLink).toEqual({
      url: 'https://10.0.0.7/1/2',
      reason: 'link-has-no-identifying-words',
      words: [],
    });
  });

  // No silent swallow: with nothing to fall back to, the refusal is still
  // reported so the caller logs it.
  it('reports the refusal even when there is no chat to fall back to', () => {
    const r = resolveNotificationAction(
      { deepLink: 'https://todoist.com/showTask?id=99' },
      { title: 'Patch', body: 'Unrelated.' },
    );
    expect(r.action).toBeNull();
    expect(r.rejectedDeepLink?.reason).toBe('link-not-named-in-notification-text');
  });

  it('carries NO rejection when the link was followed', () => {
    const r = resolveNotificationAction(
      { chatId: 'chat_abc', deepLink: 'https://todoist.com/showTask?id=99' },
      { title: 'Patch', body: 'Todoist: ring the plumber back.' },
    );
    expect(r.rejectedDeepLink).toBeUndefined();
  });

  it('carries NO rejection when there was no link at all', () => {
    const r = resolveNotificationAction({ chatId: 'chat_abc' }, { title: 'Patch', body: 'hi' });
    expect(r.rejectedDeepLink).toBeUndefined();
  });

  it('matches case-insensitively in both directions', () => {
    const r = resolveNotificationAction(
      { chatId: 'chat_abc', deepLink: 'CityMapper://Directions' },
      { title: 'Patch', body: 'open citymapper' },
    );
    expect(r.action).toEqual({ type: 'external', url: 'CityMapper://Directions' });
  });
});
