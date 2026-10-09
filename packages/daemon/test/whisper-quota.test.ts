// The STT provider's per-minute quota is shared between the live partials and
// the final that actually becomes the turn. Live partials re-transcribe the
// growing utterance about once a second, so a long sentence can spend the whole
// allowance painting the overlay — and then the final gets refused and the user
// has spoken into the void. These pin the rule that stops that: partials give
// way, finals wait and retry.

import { describe, test, expect, vi } from 'vitest';
import pino from 'pino';
import {
  GroqWhisperBackend,
  PartialBudgetExhaustedError,
  parseRetryAfterMs,
} from '../src/audio/whisper.js';

const logger = pino({ level: 'silent' });
const PCM = new Int16Array(16_000);

function okResponse(text: string): Response {
  return new Response(JSON.stringify({ text }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function rateLimited(message = 'Rate limit reached. Please try again in 1.5s.'): Response {
  return new Response(JSON.stringify({ error: { message } }), { status: 429 });
}

function backend(fetchImpl: typeof fetch, now: () => number = () => 0): GroqWhisperBackend {
  return new GroqWhisperBackend({
    backend: 'groq',
    logger,
    groqApiKey: 'k',
    fetchImpl,
    nowMs: now,
  });
}

describe('parseRetryAfterMs', () => {
  test('prefers the retry-after header, in seconds', () => {
    expect(parseRetryAfterMs('', '3')).toBe(3000);
    expect(parseRetryAfterMs('', '0')).toBe(0);
  });

  test('falls back to the wait Groq states in the message body', () => {
    expect(parseRetryAfterMs('Please try again in 3s', null)).toBe(3000);
    expect(parseRetryAfterMs('Please try again in 1.5s', null)).toBe(1500);
    expect(parseRetryAfterMs('Please try again in 250ms', null)).toBe(250);
  });

  test('reports no stated wait rather than inventing one', () => {
    expect(parseRetryAfterMs('slow down', null)).toBeNull();
  });
});

describe('quota reserve', () => {
  test('partials give way once they have used their share of the minute', async () => {
    const fetchImpl = vi.fn(async () => okResponse('hello')) as unknown as typeof fetch;
    const w = backend(fetchImpl);
    // The budget is under the provider's limit on purpose; every partial up to
    // it goes through.
    let sent = 0;
    for (;;) {
      try {
        await w.transcribe(PCM, { priority: 'partial' });
        sent++;
      } catch (err) {
        expect(err).toBeInstanceOf(PartialBudgetExhaustedError);
        break;
      }
      if (sent > 50) throw new Error('partials were never throttled');
    }
    expect(sent).toBeGreaterThan(0);

    // And the final still gets through, which is the entire point.
    await expect(w.transcribe(PCM, { priority: 'final' })).resolves.toBe('hello');
  });

  test('the window rolls, so a later utterance gets partials again', async () => {
    const fetchImpl = vi.fn(async () => okResponse('hi')) as unknown as typeof fetch;
    let now = 0;
    const w = backend(fetchImpl, () => now);
    for (let i = 0; i < 12; i++) await w.transcribe(PCM, { priority: 'partial' });
    await expect(w.transcribe(PCM, { priority: 'partial' })).rejects.toBeInstanceOf(
      PartialBudgetExhaustedError,
    );
    now += 60_001;
    await expect(w.transcribe(PCM, { priority: 'partial' })).resolves.toBe('hi');
  });

  test('a final is never refused by the reserve, however many partials ran', async () => {
    const fetchImpl = vi.fn(async () => okResponse('the words')) as unknown as typeof fetch;
    const w = backend(fetchImpl);
    for (let i = 0; i < 40; i++) {
      await w.transcribe(PCM, { priority: 'partial' }).catch(() => undefined);
    }
    await expect(w.transcribe(PCM, { priority: 'final' })).resolves.toBe('the words');
  });
});

describe('a final rides out a 429', () => {
  test('waits the stated delay and retries, rather than losing the turn', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls++;
        return calls === 1 ? rateLimited() : okResponse('what I said');
      }) as unknown as typeof fetch;
      const w = backend(fetchImpl);
      const p = w.transcribe(PCM, { priority: 'final' });
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(p).resolves.toBe('what I said');
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('gives up loudly once the retries are spent', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(async () => rateLimited()) as unknown as typeof fetch;
      const w = backend(fetchImpl);
      const p = w.transcribe(PCM, { priority: 'final' }).catch((e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(p).resolves.toMatch(/groq whisper 429/);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a partial does not retry — it is expendable by design', async () => {
    const fetchImpl = vi.fn(async () => rateLimited()) as unknown as typeof fetch;
    const w = backend(fetchImpl);
    await expect(w.transcribe(PCM, { priority: 'partial' })).rejects.toThrow(/429/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('a non-429 failure is reported straight away, not retried', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('bad key', { status: 401 }),
    ) as unknown as typeof fetch;
    const w = backend(fetchImpl);
    await expect(w.transcribe(PCM, { priority: 'final' })).rejects.toThrow(/401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('a request that never comes back', () => {
  test('is bounded, so a stalled connection cannot wedge the session', async () => {
    // There was no timeout at all. A transcription that never resolved left the
    // turn unrun, no error on the wire and the call sitting mute — exactly what
    // "I spoke and nothing happened" looks like from the outside.
    const fetchImpl = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_ok, fail) => {
          init?.signal?.addEventListener('abort', () => fail(new Error('TimeoutError')));
        }),
    ) as unknown as typeof fetch;
    const w = new GroqWhisperBackend({
      backend: 'groq',
      logger,
      groqApiKey: 'k',
      fetchImpl,
      requestTimeoutMs: 20,
    });
    await expect(w.transcribe(PCM, { priority: 'final' })).rejects.toThrow();
  });

  test('the uploaded audio is snapshotted before any await, not read from the live ring', async () => {
    // `pcm` is a zero-copy view into the session's reusable utterance ring, and
    // the mic keeps writing into it. Building the request body lazily meant a
    // retry uploaded whatever the ring held by then instead of what was said.
    const ring = new Int16Array(8);
    ring.fill(1000);
    const bodies: number[] = [];
    const fetchImpl = vi.fn(async (_url: string, init?: { body?: FormData }) => {
      const file = init?.body?.get('file') as Blob;
      const bytes = new Int16Array(await file.arrayBuffer());
      // Skip the 44-byte (22-sample) WAV header.
      bodies.push(bytes[22] ?? 0);
      // Scribble over the ring the way an incoming mic frame would.
      ring.fill(-1);
      return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
    }) as unknown as typeof fetch;
    const w = new GroqWhisperBackend({ backend: 'groq', logger, groqApiKey: 'k', fetchImpl });
    await w.transcribe(ring, { priority: 'final' });
    expect(bodies).toEqual([1000]);
  });
});
