// Hosted dictation transcribers (hosted-stt.ts). `fetch` is faked — OpenAI and
// Gemini are paid APIs and nothing here may reach them.

import { describe, test, expect, vi } from 'vitest';
import pino from 'pino';
import {
  OpenAITranscribeBackend,
  GeminiTranscribeBackend,
  HostedSttError,
  createDictationTranscribers,
  pickDictationTranscriber,
  DEFAULT_OPENAI_TRANSCRIBE_MODEL,
  DEFAULT_GEMINI_TRANSCRIBE_MODEL,
} from '../src/audio/hosted-stt.js';
import type { WhisperBackend } from '../src/audio/whisper.js';

const logger = pino({ level: 'silent' });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('OpenAITranscribeBackend', () => {
  test('posts the clip as multipart to the transcription endpoint with a bearer key', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ text: '  buy more milk  ' }));
    const t = new OpenAITranscribeBackend({ logger, apiKey: 'o-key', fetchImpl });
    expect(t.supportsLivePartials).toBe(false);
    const text = await t.transcribeClip(Buffer.from('RIFF....'), 'wav');
    expect(text).toBe('buy more milk');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer o-key');
    const form = init.body as FormData;
    expect(form.get('model')).toBe(DEFAULT_OPENAI_TRANSCRIBE_MODEL);
    expect(form.get('language')).toBe('en');
    const file = form.get('file') as File;
    expect(file.name).toBe('clip.wav');
    expect(file.type).toBe('audio/wav');
  });

  test('raw PCM from a live session is wrapped as a 16 kHz WAV', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ text: 'hi' }));
    const t = new OpenAITranscribeBackend({ logger, apiKey: 'k', fetchImpl, model: 'custom' });
    await t.transcribe(new Int16Array(1600));
    const form = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    const file = form.get('file') as File;
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
    expect(bytes.readUInt32LE(24)).toBe(16000);
    expect(form.get('model')).toBe('custom');
  });

  test('an m4a note goes up as audio/m4a', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ text: 'x' }));
    await new OpenAITranscribeBackend({ logger, apiKey: 'k', fetchImpl }).transcribeClip(
      Buffer.from('a'),
      'm4a',
    );
    const file = (
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData
    ).get('file') as File;
    expect(file.name).toBe('clip.m4a');
    expect(file.type).toBe('audio/m4a');
  });

  test('HTTP failure, network failure and a malformed body all throw — never an empty transcript', async () => {
    const http = new OpenAITranscribeBackend({
      logger,
      apiKey: 'k',
      fetchImpl: async () => new Response('{"error":"quota"}', { status: 429 }),
    });
    await expect(http.transcribeClip(Buffer.from('a'), 'wav')).rejects.toThrow(/HTTP 429.*quota/);
    const net = new OpenAITranscribeBackend({
      logger,
      apiKey: 'k',
      fetchImpl: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    await expect(net.transcribeClip(Buffer.from('a'), 'wav')).rejects.toBeInstanceOf(
      HostedSttError,
    );
    const bad = new OpenAITranscribeBackend({
      logger,
      apiKey: 'k',
      fetchImpl: async () => jsonResponse({}),
    });
    await expect(bad.transcribeClip(Buffer.from('a'), 'wav')).rejects.toThrow(/no text/);
    await bad.close();
  });
});

describe('GeminiTranscribeBackend', () => {
  test('sends the clip inline to generateContent with the key header and joins the text parts', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'call ' }, { text: 'mum ' }] } }] }),
    );
    const t = new GeminiTranscribeBackend({ logger, apiKey: 'g-key', fetchImpl });
    expect(t.supportsLivePartials).toBe(false);
    expect(await t.transcribeClip(Buffer.from('m4a-bytes'), 'm4a')).toBe('call mum');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_TRANSCRIBE_MODEL}:generateContent`,
    );
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key');
    const body = JSON.parse(init.body as string) as {
      contents: Array<{
        parts: Array<{ text?: string; inline_data?: { mime_type: string; data: string } }>;
      }>;
    };
    const parts = body.contents[0]!.parts;
    expect(parts[0]!.text).toMatch(/verbatim/);
    expect(parts[1]!.inline_data).toEqual({
      mime_type: 'audio/m4a',
      data: Buffer.from('m4a-bytes').toString('base64'),
    });
  });

  test('a models/-prefixed override is not doubled in the URL; PCM goes up as WAV', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
    );
    await new GeminiTranscribeBackend({
      logger,
      apiKey: 'k',
      model: 'models/x-flash',
      fetchImpl,
    }).transcribe(new Int16Array(160));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/models/x-flash:generateContent');
    expect(init.body as string).toContain('audio/wav');
  });

  test('HTTP failure, a blocked clip and no candidate all throw', async () => {
    const mk = (fetchImpl: () => Promise<Response>): GeminiTranscribeBackend =>
      new GeminiTranscribeBackend({ logger, apiKey: 'k', fetchImpl });
    await expect(
      mk(async () => new Response('nope', { status: 403 })).transcribeClip(Buffer.from('a'), 'wav'),
    ).rejects.toThrow(/HTTP 403/);
    await expect(
      mk(async () => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } })).transcribeClip(
        Buffer.from('a'),
        'wav',
      ),
    ).rejects.toThrow(/SAFETY/);
    await expect(
      mk(async () => jsonResponse({ candidates: [] })).transcribeClip(Buffer.from('a'), 'wav'),
    ).rejects.toThrow(/no candidate/);
    await expect(
      mk(async () => {
        throw new Error('reset');
      }).transcribeClip(Buffer.from('a'), 'wav'),
    ).rejects.toThrow(/reset/);
  });
});

describe('picking the dictation transcriber', () => {
  const local = { supportsLivePartials: true } as WhisperBackend;
  test('only the backends with a key exist', () => {
    const t = createDictationTranscribers({ logger, local, openaiApiKey: 'o' });
    expect(t.local).toBe(local);
    expect(t.openai).toBeInstanceOf(OpenAITranscribeBackend);
    expect(t.gemini).toBeUndefined();
    const both = createDictationTranscribers({
      logger,
      local,
      geminiApiKey: 'g',
      geminiModel: 'gm',
      openaiApiKey: 'o',
      openaiModel: 'om',
    });
    expect(both.gemini).toBeInstanceOf(GeminiTranscribeBackend);
  });
  test('local → local; a hosted backend with no key → an error naming the env var, never local', () => {
    const t = createDictationTranscribers({ logger, local });
    expect(pickDictationTranscriber('local', t)).toEqual({ ok: true, whisper: local });
    expect(pickDictationTranscriber('gemini', t)).toMatchObject({
      ok: false,
      backend: 'gemini',
      message:
        'Dictation is set to gemini, but GEMINI_API_KEY is not set on this host. ' +
        'Switch Dictation to another backend in Settings → Voice.',
    });
    expect(pickDictationTranscriber('openai', t)).toMatchObject({
      ok: false,
      backend: 'openai',
      message: expect.stringContaining('OPENAI_REALTIME_API_KEY'),
    });
    const withGemini = createDictationTranscribers({ logger, local, geminiApiKey: 'g' });
    const picked = pickDictationTranscriber('gemini', withGemini);
    expect(picked.ok && picked.whisper).toBe(withGemini.gemini);
  });
});
