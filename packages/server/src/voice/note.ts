// Voice-note upload route (spec/07 § End-to-end voice transport —
// "Voice note (single utterance)", Mobile).
//
// On mobile a streaming PCM tap isn't available, so the surface records the
// note locally and uploads it as ONE file to `POST /api/voice/note`
// (multipart: `chatId` + `audio` m4a). This route:
//   1. verifies the surface credential (same gate as the sibling /api routes),
//   2. hands the clip to the host — which owns Whisper — over the host
//      link, correlated by `requestId` exactly like `/api/skills`
//      (`patch.voice_note.transcribe_*`), and awaits the transcript,
//   3. injects the turn — the optional `prefix` field (text already typed into
//      the composer the note was started from) followed by the transcript — as
//      the target chat's next user turn via a `chat.input` tagged
//      `source: { kind: 'voice-app', surfaceKind: 'mobile' }`
//      (the host prepends `[voice • mobile]` — see specialThreads
//      `voicePrefixForSource`), exactly as a streamed note would land, and
//   4. returns `{ ok: true, transcript, text }` — `transcript` is what Whisper
//      heard, `text` is the turn as injected.
//
// NO FALLBACK: a missing/invalid/revoked credential → 401; an unknown chat →
// 404; the host being silent → 504; a transcription failure surfaces the
// host's typed error (`unsupported_format` → 400, else 502). The note is
// NEVER silently dropped.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { verifySurfaceCredential } from '@patch/auth';
import type { VoiceAppSurfaceKind, WireEvent } from '@patch/wire';
import type { Registry } from '../registry.js';
import type { ChatRegistry } from '../chat-registry.js';
import type { DaemonLink } from '../daemon-link.js';

const TRANSCRIBE_REQUEST_TIMEOUT_MS = 30_000;
/** Reject clips larger than this before spending a host round-trip on them. */
const MAX_CLIP_BYTES = 25 * 1024 * 1024;

const VALID_SURFACE_KINDS: readonly VoiceAppSurfaceKind[] = ['web', 'desktop', 'mobile'];
function normaliseSurfaceKind(raw: string | undefined): VoiceAppSurfaceKind {
  // Default 'mobile' for back-compat: the mobile surface (the original caller)
  // does not send the field. Web/desktop send their own kind so the host tags
  // the turn `[voice • web]` / `[voice • desktop]` rather than lying "mobile".
  if (raw === undefined) return 'mobile';
  return VALID_SURFACE_KINDS.includes(raw as VoiceAppSurfaceKind)
    ? (raw as VoiceAppSurfaceKind)
    : 'mobile';
}

async function requireAuth(
  req: FastifyRequest,
  registry: Registry,
): Promise<{ surfaceId: string }> {
  const generic = (): Error & { statusCode?: number } => {
    const e = new Error('unauthenticated') as Error & { statusCode?: number };
    e.statusCode = 401;
    return e;
  };
  const account = registry.getAccount();
  if (!account) throw generic();
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) throw generic();
  const jwt = authHeader.slice('Bearer '.length).trim();
  let claims;
  try {
    claims = await verifySurfaceCredential(jwt, { userPublicKey: account.userPublicKey });
  } catch {
    throw generic();
  }
  if (registry.isRevoked(claims.surface_id)) throw generic();
  return { surfaceId: claims.surface_id };
}

export interface VoiceNoteRouteDeps {
  logger: Logger;
  registry: Registry;
  chatRegistry: ChatRegistry;
  daemonLink: DaemonLink;
  idGenerator: () => string;
}

export function registerVoiceNoteRoute(app: FastifyInstance, deps: VoiceNoteRouteDeps): void {
  // Correlate `patch.voice_note.transcribe_response` frames back to the
  // awaiting HTTP call (same pattern as secrets/skills/files RPCs).
  const pending = new Map<
    string,
    {
      resolve: (ev: Extract<WireEvent, { type: 'patch.voice_note.transcribe_response' }>) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  deps.daemonLink.onEvent((event: WireEvent) => {
    if (event.type !== 'patch.voice_note.transcribe_response') return;
    const w = pending.get(event.requestId);
    if (!w) return;
    pending.delete(event.requestId);
    clearTimeout(w.timeout);
    w.resolve(event);
  });

  function awaitDaemon(
    surfaceId: string,
    build: (requestId: string) => WireEvent,
  ): Promise<Extract<WireEvent, { type: 'patch.voice_note.transcribe_response' }> | 'timeout'> {
    const requestId = deps.idGenerator();
    return new Promise((resolveP) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        resolveP('timeout');
      }, TRANSCRIBE_REQUEST_TIMEOUT_MS);
      pending.set(requestId, { resolve: resolveP, timeout });
      deps.daemonLink.send(surfaceId, build(requestId));
    });
  }

  // Shared multipart parser for both routes: an optional `chatId` field, an
  // optional `surfaceKind` field, and the `audio` file (whose extension/mimetype
  // picks m4a vs wav). Returns `{ error }` for a non-multipart / malformed body.
  async function parseAudio(req: FastifyRequest): Promise<
    | { error: string }
    | {
        chatId?: string;
        audio?: Buffer;
        format: 'm4a' | 'wav';
        surfaceKindRaw?: string;
        prefix?: string;
      }
  > {
    if (!req.isMultipart()) return { error: 'expected multipart/form-data' };
    let chatId: string | undefined;
    let audio: Buffer | undefined;
    let surfaceKindRaw: string | undefined;
    let prefix: string | undefined;
    let format: 'm4a' | 'wav' = 'm4a';
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'audio') {
            // Drain unexpected files so the stream doesn't stall.
            await part.toBuffer();
            continue;
          }
          audio = await part.toBuffer();
          // `?? ''`: defensive only — @fastify/multipart types `filename`/
          // `mimetype` as always-`string` for a file-type part (busboy uses
          // filename presence to decide file vs field), so this default is
          // unreachable via a real multipart upload.
          /* v8 ignore next 2 */
          const name = (part.filename ?? '').toLowerCase();
          const mime = (part.mimetype ?? '').toLowerCase();
          if (name.endsWith('.wav') || mime.includes('wav')) format = 'wav';
          else format = 'm4a';
        } else if (part.fieldname === 'chatId') {
          chatId = String(part.value);
        } else if (part.fieldname === 'surfaceKind') {
          surfaceKindRaw = String(part.value);
        } else if (part.fieldname === 'prefix') {
          prefix = String(part.value);
        }
      }
    } catch (err) {
      return { error: `invalid multipart body: ${(err as Error).message}` };
    }
    return { chatId, audio, format, surfaceKindRaw, prefix };
  }

  // Hand a clip to the host (it owns Whisper) and await the transcript, mapping
  // the host's typed outcome onto an HTTP shape. Shared by both routes.
  async function transcribe(
    surfaceId: string,
    surfaceKind: VoiceAppSurfaceKind,
    format: 'm4a' | 'wav',
    audio: Buffer,
  ): Promise<{ ok: true; transcript: string } | { ok: false; status: number; body: object }> {
    const audioBase64 = audio.toString('base64');
    const result = await awaitDaemon(surfaceId, (requestId) => ({
      type: 'patch.voice_note.transcribe_request',
      requestId,
      surfaceKind,
      format,
      audioBase64,
    }));
    if (result === 'timeout') {
      deps.logger.warn('voice: host transcription timed out');
      return { ok: false, status: 504, body: { error: 'daemon_timeout' } };
    }
    if (!result.ok || typeof result.transcript !== 'string') {
      const code = result.error?.code ?? 'internal';
      const status = code === 'unsupported_format' ? 400 : 502;
      return {
        ok: false,
        status,
        body: { error: code, message: result.error?.message ?? 'transcription failed' },
      };
    }
    return { ok: true, transcript: result.transcript };
  }

  app.post('/api/voice/note', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }

    const parsed = await parseAudio(req);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    const { chatId, audio, format } = parsed;
    const surfaceKind = normaliseSurfaceKind(parsed.surfaceKindRaw);
    const prefix = parsed.prefix ?? '';

    if (!chatId || chatId.length === 0) {
      return reply.code(400).send({ error: 'chatId is required' });
    }
    if (!audio || audio.byteLength === 0) {
      return reply.code(400).send({ error: 'audio file is required' });
    }
    // Unreachable via HTTP: @fastify/multipart's own `fileSize` limit (app.ts,
    // registered at the same 25MB ceiling this route was sized for) always
    // truncates/rejects an oversized part first, landing in the parse `catch`
    // above with a 400, so `audio.byteLength` can never exceed this here.
    /* v8 ignore next 3 */
    if (audio.byteLength > MAX_CLIP_BYTES) {
      return reply.code(413).send({ error: 'audio clip too large' });
    }

    // NO SILENT FALLBACK (mirrors /send-to, /voice/token): a note for an
    // unknown chatId must be rejected, not transcribed-then-dropped.
    if (!deps.chatRegistry.get(chatId)) {
      return reply.code(404).send({ error: `chat not found: ${chatId}` });
    }

    const result = await transcribe(auth.surfaceId, surfaceKind, format, audio);
    if (!result.ok) return reply.code(result.status).send(result.body);

    // The surface may have had text already typed into the composer the note was
    // started from (spec/07 § 1. Voice note — the new-chat composer's mic). That
    // text LEADS the turn and the transcript is appended to it, one space
    // between, the same join dictation uses. An empty side of the join is simply
    // absent — never a bare space, never a dropped half.
    const text = [prefix.trim(), result.transcript.trim()].filter((p) => p.length > 0).join(' ');

    // Inject it as the chat's next user turn. The server is one of
    // the two legitimate attachers of `source` (the voice-device
    // hook, and this route); it goes straight to the host link (not the surface
    // ingress path, which strips `source`). The host prepends `[voice • <kind>]`.
    deps.daemonLink.send(auth.surfaceId, {
      type: 'chat.input',
      chatId,
      message: text,
      localId: deps.idGenerator(),
      source: { kind: 'voice-app', surfaceKind },
    });

    // `transcript` is what Whisper heard; `text` is the turn that was actually
    // injected. The caller echoes `text`, so its local bubble matches the
    // persisted turn and reconciles against it instead of duplicating.
    return reply.code(200).send({ ok: true, transcript: result.transcript, text });
  });

  // POST /api/voice/transcribe — transcribe ONLY (no chat injection). The
  // composer mic (spec/C1) records a clip and drops the recognised text into the
  // composer input for the user to edit before sending, so the turn must NOT be
  // submitted here. Same auth gate + host round-trip as /voice/note, minus the
  // chatId + chat.input inject.
  app.post('/api/voice/transcribe', async (req, reply) => {
    let auth;
    try {
      auth = await requireAuth(req, deps.registry);
    } catch (e) {
      return reply
        .code((e as Error & { statusCode?: number }).statusCode ?? 401)
        .send({ error: (e as Error).message });
    }

    const parsed = await parseAudio(req);
    if ('error' in parsed) return reply.code(400).send({ error: parsed.error });
    const { audio, format } = parsed;
    const surfaceKind = normaliseSurfaceKind(parsed.surfaceKindRaw);

    if (!audio || audio.byteLength === 0) {
      return reply.code(400).send({ error: 'audio file is required' });
    }
    /* v8 ignore next 3 -- same @fastify/multipart fileSize guard as /voice/note. */
    if (audio.byteLength > MAX_CLIP_BYTES) {
      return reply.code(413).send({ error: 'audio clip too large' });
    }

    const result = await transcribe(auth.surfaceId, surfaceKind, format, audio);
    if (!result.ok) return reply.code(result.status).send(result.body);
    return reply.code(200).send({ ok: true, transcript: result.transcript });
  });
}
