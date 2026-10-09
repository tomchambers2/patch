// Hosted speech-to-text for the DICTATION surface (spec/07 § Voice — a config
// matrix). Dictation is STT only — no agent turn, nothing to front — so a
// hosted `backend` for it is simply a different transcriber behind the exact
// same pipeline `local` uses: the `VoiceSession` a dictation / voice-note WSS
// session runs, and the one-shot `patch.voice_note.transcribe_request` RPC the
// composer's upload and `POST /api/voice/note` use. Both backends here
// implement `WhisperBackend`, so neither path needs to know which engine it is
// talking to — the selection happens once, in audio/server.ts and in
// `pickDictationTranscriber` below.
//
//   openai — `POST /v1/audio/transcriptions` (gpt-4o-mini-transcribe), one
//            request per clip.
//   gemini — `models/<m>:generateContent` with the clip inline and a
//            transcribe-verbatim instruction, one request per clip.
//
// Neither offers live partials (`supportsLivePartials: false`): the interim
// preview is produced by RE-transcribing the growing utterance about once a
// second (session.ts `maybeTranscribePartial`), and on a per-request paid
// backend that multiplies the cost of every dictation by its length in
// seconds. spec/07 § Live transcript: a backend that offers no partials emits
// none, and its surfaces show the input level instead.
//
// NO SILENT FALLBACK: a backend with no key on this host is refused
// (`voice_key_missing`); a failed request throws (and the caller reports it as
// `openai_unavailable` / `gemini_unavailable` or a failed transcription); it
// is never answered by quietly transcribing with Whisper instead.

import type { Logger } from 'pino';
import { voiceKeyMissingMessage, type VoiceBackend } from '@patch/wire/audio';
import { pcm16ToWav, type TranscribeOptions, type WhisperBackend } from './whisper.js';
import { readKey, type KeySource } from './keySource.js';

export const DEFAULT_OPENAI_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
/** Gemini's documented audio-understanding model as of 2026-09-24 (ai.google.dev/gemini-api/docs/audio). */
export const DEFAULT_GEMINI_TRANSCRIBE_MODEL = 'gemini-3.8-flash';

const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const GEMINI_TRANSCRIBE_PROMPT =
  'Transcribe the speech in this audio verbatim, in English. Output ONLY the words spoken — ' +
  'no quotation marks, labels, timestamps or commentary. If nothing is spoken, output nothing.';

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Thrown for a failed hosted transcription; carries the provider so callers can map the error code. */
export class HostedSttError extends Error {
  override readonly name = 'HostedSttError';
  constructor(
    readonly backend: Exclude<VoiceBackend, 'local'>,
    message: string,
  ) {
    super(message);
  }
}

interface HostedSttBase {
  logger: Logger;
  /** Resolved per request (keySource.ts), so a changed key applies to the next clip. */
  apiKey: KeySource;
  model?: string;
  /** Test seam — defaults to the global fetch. */
  fetchImpl?: FetchLike;
}

function mimeFor(format: 'm4a' | 'wav'): string {
  return format === 'wav' ? 'audio/wav' : 'audio/m4a';
}

async function failureText(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  return `HTTP ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`;
}

export class OpenAITranscribeBackend implements WhisperBackend {
  readonly supportsLivePartials = false;
  private readonly opts: HostedSttBase;
  constructor(opts: HostedSttBase) {
    this.opts = opts;
  }

  async transcribe(pcm: Int16Array, _opts?: TranscribeOptions): Promise<string> {
    return this.transcribeClip(pcm16ToWav(pcm, 16000), 'wav');
  }

  async transcribeClip(audio: Buffer, format: 'm4a' | 'wav'): Promise<string> {
    const form = new FormData();
    const bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
    form.append('file', new Blob([bytes], { type: mimeFor(format) }), `clip.${format}`);
    form.append('model', this.opts.model ?? DEFAULT_OPENAI_TRANSCRIBE_MODEL);
    form.append('language', 'en');
    form.append('response_format', 'json');
    const doFetch = this.opts.fetchImpl ?? fetch;
    const apiKey = readKey(this.opts.apiKey);
    if (apiKey === undefined) {
      throw new HostedSttError('openai', 'OPENAI_REALTIME_API_KEY is no longer set on this host');
    }
    let res: Response;
    try {
      res = await doFetch(OPENAI_TRANSCRIBE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
    } catch (err) {
      throw new HostedSttError(
        'openai',
        `OpenAI transcription request failed: ${(err as Error).message}`,
      );
    }
    if (!res.ok) {
      throw new HostedSttError('openai', `OpenAI transcription failed: ${await failureText(res)}`);
    }
    const json = (await res.json()) as { text?: unknown };
    if (typeof json.text !== 'string') {
      throw new HostedSttError('openai', 'OpenAI transcription returned no text field');
    }
    return json.text.trim();
  }

  async close(): Promise<void> {}
}

interface GeminiGenerateResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  promptFeedback?: { blockReason?: string };
}

export class GeminiTranscribeBackend implements WhisperBackend {
  readonly supportsLivePartials = false;
  private readonly opts: HostedSttBase;
  constructor(opts: HostedSttBase) {
    this.opts = opts;
  }

  async transcribe(pcm: Int16Array, _opts?: TranscribeOptions): Promise<string> {
    return this.transcribeClip(pcm16ToWav(pcm, 16000), 'wav');
  }

  async transcribeClip(audio: Buffer, format: 'm4a' | 'wav'): Promise<string> {
    const model = this.opts.model ?? DEFAULT_GEMINI_TRANSCRIBE_MODEL;
    const url = `${GEMINI_API_BASE}/models/${model.replace(/^models\//, '')}:generateContent`;
    const doFetch = this.opts.fetchImpl ?? fetch;
    const apiKey = readKey(this.opts.apiKey);
    if (apiKey === undefined) {
      throw new HostedSttError('gemini', 'GEMINI_API_KEY is no longer set on this host');
    }
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { text: GEMINI_TRANSCRIBE_PROMPT },
                { inline_data: { mime_type: mimeFor(format), data: audio.toString('base64') } },
              ],
            },
          ],
          generationConfig: { temperature: 0 },
        }),
      });
    } catch (err) {
      throw new HostedSttError(
        'gemini',
        `Gemini transcription request failed: ${(err as Error).message}`,
      );
    }
    if (!res.ok) {
      throw new HostedSttError('gemini', `Gemini transcription failed: ${await failureText(res)}`);
    }
    const json = (await res.json()) as GeminiGenerateResponse;
    if (json.promptFeedback?.blockReason) {
      throw new HostedSttError(
        'gemini',
        `Gemini refused the clip: ${json.promptFeedback.blockReason}`,
      );
    }
    const parts = json.candidates?.[0]?.content?.parts;
    if (!parts) throw new HostedSttError('gemini', 'Gemini transcription returned no candidate');
    return parts
      .map((p) => p.text ?? '')
      .join('')
      .trim();
  }

  async close(): Promise<void> {}
}

export interface DictationTranscribers {
  local: WhisperBackend;
  gemini?: WhisperBackend | undefined;
  openai?: WhisperBackend | undefined;
}

/**
 * The transcriber the dictation surface is configured for, or an error naming
 * exactly why it can't run (the key for that backend isn't on this host).
 * Never substitutes `local` for a hosted choice.
 */
export function pickDictationTranscriber(
  backend: VoiceBackend,
  transcribers: DictationTranscribers,
):
  | { ok: true; whisper: WhisperBackend }
  | { ok: false; backend: 'gemini' | 'openai'; message: string } {
  if (backend === 'local') return { ok: true, whisper: transcribers.local };
  const t = transcribers[backend];
  if (t) return { ok: true, whisper: t };
  return { ok: false, backend, message: voiceKeyMissingMessage('dictation', backend) };
}

/**
 * The hosted transcribers, each offered only while this host HAS its key.
 * `gemini` / `openai` are getters: with a live key source (the host's
 * provider-key store) a key set or revoked from Settings changes what the next
 * dictation picks, with no rebuild.
 */
export function createDictationTranscribers(opts: {
  logger: Logger;
  local: WhisperBackend;
  geminiApiKey?: KeySource;
  geminiModel?: string | undefined;
  openaiApiKey?: KeySource;
  openaiModel?: string | undefined;
}): DictationTranscribers {
  const gemini = new GeminiTranscribeBackend({
    logger: opts.logger,
    apiKey: opts.geminiApiKey,
    ...(opts.geminiModel ? { model: opts.geminiModel } : {}),
  });
  const openai = new OpenAITranscribeBackend({
    logger: opts.logger,
    apiKey: opts.openaiApiKey,
    ...(opts.openaiModel ? { model: opts.openaiModel } : {}),
  });
  return {
    local: opts.local,
    get gemini(): WhisperBackend | undefined {
      return readKey(opts.geminiApiKey) !== undefined ? gemini : undefined;
    },
    get openai(): WhisperBackend | undefined {
      return readKey(opts.openaiApiKey) !== undefined ? openai : undefined;
    },
  };
}
