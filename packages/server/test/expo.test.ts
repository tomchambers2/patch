// Direct unit coverage of src/notifications/expo.ts — ExpoPushBackend posts to
// Expo's push API (https://exp.host/--/api/v2/push/send) and maps its
// response into the PushBackend contract. Mocks global `fetch` — no real
// network call is ever made.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExpoPushBackend, URGENT_CHANNEL_ID, URGENT_SOUND } from '../src/notifications/expo.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ExpoPushBackend.send — tokens.length === 0 short-circuit', () => {
  it('returns zero counts without calling fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new ExpoPushBackend();
    const result = await backend.send([], { title: 't', body: 'b' });
    expect(result).toEqual({ delivered: 0, failed: [], permanentlyRejected: [] });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('ExpoPushBackend.send — request shape', () => {
  it('posts to the Expo push endpoint with title/body/data and high priority', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ data: [{ status: 'ok', id: 'ticket-1' }] }));
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new ExpoPushBackend();
    const result = await backend.send(['ExponentPushToken[tok-a]'], {
      title: 'Patch',
      body: 'hello',
      data: { chatId: 'c1' },
    });
    expect(result).toEqual({ delivered: 1, failed: [], permanentlyRejected: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual([
      {
        to: 'ExponentPushToken[tok-a]',
        title: 'Patch',
        body: 'hello',
        data: { chatId: 'c1' },
        priority: 'high',
      },
    ]);
  });

  it('sets priority=high for an urgent push', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ data: [{ status: 'ok', id: 'ticket-1' }] }));
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new ExpoPushBackend();
    await backend.send(['ExponentPushToken[tok-a]'], { title: 't', body: 'b', urgent: true });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const [message] = JSON.parse(init.body as string) as Array<{ priority: string }>;
    expect(message.priority).toBe('high');
  });

  it.each([
    ['normal', {}],
    ['silent', { silent: true }],
    ['urgent', { urgent: true, urgentSound: true }],
  ])('sends a %s push at high priority so Doze cannot defer it', async (_rung, flags) => {
    const fetchSpy = vi.fn(async () => jsonResponse({ data: [{ status: 'ok', id: 'ticket-1' }] }));
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new ExpoPushBackend();
    await backend.send(['ExponentPushToken[tok-a]'], { title: 't', body: 'b', ...flags });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const [message] = JSON.parse(init.body as string) as Array<{ priority: string }>;
    expect(message.priority).toBe('high');
  });

  it('puts a silent push on the quiet channel with no sound', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ data: [{ status: 'ok', id: 'ticket-1' }] }));
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new ExpoPushBackend();
    await backend.send(['ExponentPushToken[tok-a]'], { title: 't', body: 'b', silent: true });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const [message] = JSON.parse(init.body as string) as Array<{
      channelId?: string;
      sound?: unknown;
    }>;
    expect(message.channelId).toBe('patch_quiet');
    expect(message.sound).toBeNull();
  });

  it('puts an urgent-sound push on the urgent channel with the default sound', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ data: [{ status: 'ok', id: 'ticket-1' }] }));
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new ExpoPushBackend();
    await backend.send(['ExponentPushToken[tok-a]'], {
      title: 't',
      body: 'b',
      urgent: true,
      urgentSound: true,
    });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const [message] = JSON.parse(init.body as string) as Array<{
      channelId?: string;
      sound?: unknown;
    }>;
    expect(message.channelId).toBe(URGENT_CHANNEL_ID);
    expect(URGENT_CHANNEL_ID).toBe('patch_urgent_alert');
    expect(URGENT_SOUND).toBe('patch_urgent');
    expect(message.sound).toBe('default');
  });

  it('omits data when not given', async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ data: [{ status: 'ok', id: 'ticket-1' }] }));
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new ExpoPushBackend();
    await backend.send(['ExponentPushToken[tok-a]'], { title: 't', body: 'b' });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const [message] = JSON.parse(init.body as string) as Array<Record<string, unknown>>;
    expect('data' in message).toBe(false);
  });
});

describe('ExpoPushBackend.send — response mapping', () => {
  it('maps a mix of ok / error tickets to delivered/failed', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({
        data: [
          { status: 'ok', id: 'ticket-1' },
          {
            status: 'error',
            message: 'device not registered',
            details: { error: 'DeviceNotRegistered' },
          },
          { status: 'error', message: 'rate limited', details: { error: 'MessageRateExceeded' } },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new ExpoPushBackend();
    const result = await backend.send(['tok-a', 'tok-b', 'tok-c'], { title: 't', body: 'b' });
    expect(result.delivered).toBe(1);
    expect(result.failed).toEqual(['tok-b', 'tok-c']);
    // Only DeviceNotRegistered is a permanent rejection — a rate limit is
    // transient and must not prune the token (NO FALLBACK: only prune on an
    // explicit permanent-rejection code).
    expect(result.permanentlyRejected).toEqual(['tok-b']);
  });

  it('does not prune a token whose error has no details at all', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ data: [{ status: 'error', message: 'unknown failure' }] }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new ExpoPushBackend();
    const result = await backend.send(['tok-a'], { title: 't', body: 'b' });
    expect(result.failed).toEqual(['tok-a']);
    expect(result.permanentlyRejected).toEqual([]);
  });

  it('throws when the Expo push API returns a non-2xx status', async () => {
    const fetchSpy = vi.fn(async () => new Response('bad request', { status: 400 }));
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new ExpoPushBackend();
    await expect(backend.send(['tok-a'], { title: 't', body: 'b' })).rejects.toThrow(/400/);
  });
});

describe('ExpoPushBackend.send — chunking', () => {
  it('splits more than 100 tokens across multiple requests', async () => {
    const tokens = Array.from({ length: 150 }, (_, i) => `tok-${i}`);
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      const messages = JSON.parse(init.body as string) as Array<{ to: string }>;
      return jsonResponse({ data: messages.map(() => ({ status: 'ok', id: 'x' })) });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const backend = new ExpoPushBackend();
    const result = await backend.send(tokens, { title: 't', body: 'b' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const firstChunk = JSON.parse(
      (fetchSpy.mock.calls[0] as [string, RequestInit])[1].body as string,
    ) as Array<{ to: string }>;
    const secondChunk = JSON.parse(
      (fetchSpy.mock.calls[1] as [string, RequestInit])[1].body as string,
    ) as Array<{ to: string }>;
    expect(firstChunk).toHaveLength(100);
    expect(secondChunk).toHaveLength(50);
    expect(result.delivered).toBe(150);
  });
});
