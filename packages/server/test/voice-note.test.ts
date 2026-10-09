// spec/07 § End-to-end voice transport — POST /api/voice/note (mobile
// voice-note upload).
//
// The server does not own Whisper — the host does. This route parses the
// multipart upload (chatId + audio m4a), round-trips the clip to the host
// over the host link (`patch.voice_note.transcribe_*`, requestId-correlated),
// and on success injects the transcript as the chat's next user turn via a
// `chat.input` tagged `source: { kind: 'voice-app', surfaceKind: 'mobile' }`.
//
// These tests assert: multipart accepted; the host received the clip
// (correct base64 + format); the returned transcript; the injected chat.input
// with the voice-app source; the auth gate; unknown-chat 404; and the host's
// typed error mapping (unsupported_format → 400, other → 502).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateUserKeypair, mintSurfaceCredential } from '@patch/auth';
import type { WireEvent } from '@patch/wire';
import { buildAll } from '../src/app.js';
import { Registry } from '../src/registry.js';
import { InProcessDaemonLink } from '../src/daemon-link.js';

// A fake host transcriber: answers `patch.voice_note.transcribe_request` with
// a canned transcript (or a typed error), recording the request so the test can
// assert what the server sent. Mirrors packages/daemon handleVoiceNoteTranscribe.
class FakeTranscribeDaemon extends InProcessDaemonLink {
  lastRequest: Extract<WireEvent, { type: 'patch.voice_note.transcribe_request' }> | null = null;
  mode: 'ok' | 'unsupported' | 'failed' = 'ok';
  transcript = 'buy oat milk';

  override send(surfaceId: string, event: WireEvent): void {
    super.send(surfaceId, event);
    if (event.type !== 'patch.voice_note.transcribe_request') return;
    this.lastRequest = event;
    if (this.mode === 'ok') {
      this.emit({
        type: 'patch.voice_note.transcribe_response',
        requestId: event.requestId,
        ok: true,
        transcript: this.transcript,
      });
    } else if (this.mode === 'unsupported') {
      this.emit({
        type: 'patch.voice_note.transcribe_response',
        requestId: event.requestId,
        ok: false,
        error: { code: 'unsupported_format', message: 'local backend cannot decode m4a' },
      });
    } else {
      this.emit({
        type: 'patch.voice_note.transcribe_response',
        requestId: event.requestId,
        ok: false,
        error: { code: 'transcription_failed', message: 'groq 500' },
      });
    }
  }
}

// Build a multipart/form-data body (chatId field + audio file) for app.inject.
function multipartBody(opts: {
  chatId?: string;
  audio?: Buffer;
  filename?: string;
  mimetype?: string;
  surfaceKind?: string;
  prefix?: string;
}): { payload: Buffer; headers: Record<string, string> } {
  const boundary = '----patchtestboundary1234567890';
  const CRLF = '\r\n';
  const chunks: Buffer[] = [];
  if (opts.chatId !== undefined) {
    chunks.push(
      Buffer.from(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="chatId"${CRLF}${CRLF}` +
          `${opts.chatId}${CRLF}`,
        'utf8',
      ),
    );
  }
  if (opts.surfaceKind !== undefined) {
    chunks.push(
      Buffer.from(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="surfaceKind"${CRLF}${CRLF}` +
          `${opts.surfaceKind}${CRLF}`,
        'utf8',
      ),
    );
  }
  if (opts.prefix !== undefined) {
    chunks.push(
      Buffer.from(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="prefix"${CRLF}${CRLF}` +
          `${opts.prefix}${CRLF}`,
        'utf8',
      ),
    );
  }
  if (opts.audio !== undefined) {
    chunks.push(
      Buffer.from(
        `--${boundary}${CRLF}` +
          `Content-Disposition: form-data; name="audio"; filename="${opts.filename ?? 'voice-note.m4a'}"${CRLF}` +
          `Content-Type: ${opts.mimetype ?? 'audio/m4a'}${CRLF}${CRLF}`,
        'utf8',
      ),
    );
    chunks.push(opts.audio);
    chunks.push(Buffer.from(CRLF, 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('POST /api/voice/note', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-voice-note-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeApp() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(41));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-mobile-1',
      surfaceKind: 'mobile',
      label: 'phone',
      issuedAt: 1,
    });
    const daemonLink = new FakeTranscribeDaemon();
    const built = await buildAll({ logger: false, registry, daemonLink });
    // Seed a real chat so the existence check passes.
    daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/tmp/c1' });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-mobile-1',
      surfaceKind: 'mobile',
      label: 'phone',
    });
    return { built, daemonLink, jwt, registry };
  }

  const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

  it('transcribes the uploaded clip and injects a voice-app chat.input', async () => {
    const { built, daemonLink, jwt } = await makeApp();
    const audio = Buffer.from('fake-m4a-bytes-', 'binary');
    try {
      const body = multipartBody({ chatId: 'c1', audio });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, transcript: 'buy oat milk', text: 'buy oat milk' });

      // The host received the exact clip + format.
      expect(daemonLink.lastRequest).not.toBeNull();
      expect(daemonLink.lastRequest?.format).toBe('m4a');
      expect(daemonLink.lastRequest?.surfaceKind).toBe('mobile');
      expect(Buffer.from(daemonLink.lastRequest!.audioBase64, 'base64').equals(audio)).toBe(true);

      // The transcript was injected as a chat.input carrying the voice-app source.
      const inputs = daemonLink.sent.filter((s) => s.event.type === 'chat.input');
      expect(inputs).toHaveLength(1);
      const ev = inputs[0]!.event as Extract<WireEvent, { type: 'chat.input' }>;
      expect(ev.chatId).toBe('c1');
      expect(ev.message).toBe('buy oat milk');
      expect(ev.source).toEqual({ kind: 'voice-app', surfaceKind: 'mobile' });
      expect(ev.localId.length).toBeGreaterThan(0);
    } finally {
      await built.app.close();
    }
  });

  // --- the typed composer text rides along as `prefix` (spec/07 § 1. Voice note)
  //
  // Tom, Todoist 6hW5QcMPmf6gWhwc / 6hVhq54fM2mFf8c6: "patch starting a voice
  // note deletes all current content!" / "should append". A note commits its OWN
  // turn, so before this the half-written message sitting in the composer was
  // simply thrown away. It now leads the turn and the transcript follows it.

  it('puts the typed composer text AHEAD of the transcript in one turn', async () => {
    const { built, daemonLink, jwt } = await makeApp();
    try {
      const body = multipartBody({
        chatId: 'c1',
        audio: Buffer.from('x'),
        prefix: 'remind me to',
      });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(200);
      // `transcript` stays what Whisper heard; `text` is the turn as injected.
      expect(res.json()).toEqual({
        ok: true,
        transcript: 'buy oat milk',
        text: 'remind me to buy oat milk',
      });

      // ONE turn, not two: the typed text is not injected separately.
      const inputs = daemonLink.sent.filter((s) => s.event.type === 'chat.input');
      expect(inputs).toHaveLength(1);
      const ev = inputs[0]!.event as Extract<WireEvent, { type: 'chat.input' }>;
      expect(ev.message).toBe('remind me to buy oat milk');
      expect(ev.source).toEqual({ kind: 'voice-app', surfaceKind: 'mobile' });
    } finally {
      await built.app.close();
    }
  });

  it('joins with exactly one space however the typed text was left', async () => {
    // The composer keeps whatever whitespace the user typed; the join must not
    // turn a trailing space into a double space or a leading one into an indent.
    const { built, daemonLink, jwt } = await makeApp();
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.from('x'), prefix: '  please   ' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { text: string }).text).toBe('please buy oat milk');
      const inputs = daemonLink.sent.filter((s) => s.event.type === 'chat.input');
      const ev = inputs[0]!.event as Extract<WireEvent, { type: 'chat.input' }>;
      expect(ev.message).toBe('please buy oat milk');
    } finally {
      await built.app.close();
    }
  });

  it('an empty composer sends the transcript alone — no leading space', async () => {
    const { built, daemonLink, jwt } = await makeApp();
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.from('x'), prefix: '' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { text: string }).text).toBe('buy oat milk');
      const inputs = daemonLink.sent.filter((s) => s.event.type === 'chat.input');
      const ev = inputs[0]!.event as Extract<WireEvent, { type: 'chat.input' }>;
      expect(ev.message).toBe('buy oat milk');
    } finally {
      await built.app.close();
    }
  });

  it('keeps the typed text even when the clip transcribes to nothing', async () => {
    // Whisper hearing silence must not cost the user the words he had already
    // written — the whole point of carrying them. The turn is the typed text.
    const { built, daemonLink, jwt } = await makeApp();
    daemonLink.transcript = '   ';
    try {
      const body = multipartBody({
        chatId: 'c1',
        audio: Buffer.from('x'),
        prefix: 'book the dentist',
      });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { text: string }).text).toBe('book the dentist');
      const inputs = daemonLink.sent.filter((s) => s.event.type === 'chat.input');
      const ev = inputs[0]!.event as Extract<WireEvent, { type: 'chat.input' }>;
      expect(ev.message).toBe('book the dentist');
    } finally {
      await built.app.close();
    }
  });

  it('detects a .wav upload as the wav format', async () => {
    const { built, daemonLink, jwt } = await makeApp();
    try {
      const body = multipartBody({
        chatId: 'c1',
        audio: Buffer.from('RIFFxxxx'),
        filename: 'note.wav',
        mimetype: 'audio/wav',
      });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(200);
      expect(daemonLink.lastRequest?.format).toBe('wav');
    } finally {
      await built.app.close();
    }
  });

  it('requires auth (401 without bearer)', async () => {
    const { built } = await makeApp();
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: body.headers,
        payload: body.payload,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('rejects an unknown chatId with 404', async () => {
    const { built, jwt } = await makeApp();
    try {
      const body = multipartBody({ chatId: 'NOPE', audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(404);
    } finally {
      await built.app.close();
    }
  });

  it('rejects a missing audio file with 400', async () => {
    const { built, jwt } = await makeApp();
    try {
      const body = multipartBody({ chatId: 'c1' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(400);
    } finally {
      await built.app.close();
    }
  });

  it('maps a host unsupported_format error to 400 and injects nothing', async () => {
    const { built, daemonLink, jwt } = await makeApp();
    daemonLink.mode = 'unsupported';
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('unsupported_format');
      expect(daemonLink.sent.some((s) => s.event.type === 'chat.input')).toBe(false);
    } finally {
      await built.app.close();
    }
  });

  it('maps a host transcription failure to 502', async () => {
    const { built, daemonLink, jwt } = await makeApp();
    daemonLink.mode = 'failed';
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(502);
    } finally {
      await built.app.close();
    }
  });

  it('rejects a JWT that fails signature verification with 401 (distinct from missing bearer)', async () => {
    const { built } = await makeApp();
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { authorization: 'Bearer not-a-real-jwt', ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('rejects when no account has been bootstrapped', async () => {
    const registry = Registry.load(dir); // no bootstrapAccount() call
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink });
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { authorization: 'Bearer whatever', ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('rejects a revoked surface', async () => {
    const { built, jwt, registry } = await makeApp();
    registry.revoke('srf-mobile-1');
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('falls back to 401 when requireAuth throws an error without a statusCode', async () => {
    const { built, jwt, registry } = await makeApp();
    (registry as unknown as { getAccount: () => never }).getAccount = () => {
      throw new Error('registry backing store exploded');
    };
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('rejects a non-multipart body with 400', async () => {
    const { built, jwt } = await makeApp();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), 'content-type': 'application/json' },
        payload: { not: 'multipart' },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('expected multipart/form-data');
    } finally {
      await built.app.close();
    }
  });

  it('drains an unexpected file fieldname and still rejects a body with no `audio` field', async () => {
    const { built, jwt } = await makeApp();
    try {
      const boundary = '----patchtestboundary-wrongfield';
      const CRLF = '\r\n';
      const payload = Buffer.concat([
        Buffer.from(
          `--${boundary}${CRLF}Content-Disposition: form-data; name="chatId"${CRLF}${CRLF}c1${CRLF}`,
        ),
        Buffer.from(
          `--${boundary}${CRLF}Content-Disposition: form-data; name="notaudio"; filename="x.bin"${CRLF}` +
            `Content-Type: application/octet-stream${CRLF}${CRLF}`,
        ),
        Buffer.from('drained-bytes'),
        Buffer.from(CRLF),
        Buffer.from(`--${boundary}--${CRLF}`),
      ]);
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: {
          ...authed(jwt),
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('audio file is required');
    } finally {
      await built.app.close();
    }
  });

  it('rejects a truncated/malformed multipart body with 400 (busboy parse error)', async () => {
    const { built, jwt } = await makeApp();
    try {
      const boundary = '----patchtestboundary-truncated';
      const payload = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="x.m4a"\r\n` +
          `Content-Type: audio/m4a\r\n\r\nnot-actually-terminated-properly`,
      );
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: {
          ...authed(jwt),
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toContain('invalid multipart body');
    } finally {
      await built.app.close();
    }
  });

  it('rejects a chatId-less upload with 400', async () => {
    const { built, jwt } = await makeApp();
    try {
      const body = multipartBody({ audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('chatId is required');
    } finally {
      await built.app.close();
    }
  });

  it('rejects a present-but-empty audio field with 400', async () => {
    const { built, jwt } = await makeApp();
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.alloc(0) });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('audio file is required');
    } finally {
      await built.app.close();
    }
  });

  it("rejects an oversized clip with 400 (caught by @fastify/multipart's own fileSize limit)", async () => {
    const { built, jwt } = await makeApp();
    try {
      const big = Buffer.alloc(25 * 1024 * 1024 + 1);
      const body = multipartBody({ chatId: 'c1', audio: big });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toContain('too large');
    } finally {
      await built.app.close();
    }
  }, 15_000);

  it('detects wav from a wav mimetype even when the filename does not end in .wav', async () => {
    const { built, daemonLink, jwt } = await makeApp();
    try {
      const body = multipartBody({
        chatId: 'c1',
        audio: Buffer.from('RIFFxxxx'),
        filename: 'clip.bin',
        mimetype: 'audio/x-wav',
      });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(200);
      expect(daemonLink.lastRequest?.format).toBe('wav');
    } finally {
      await built.app.close();
    }
  });

  it('returns 504 when the host never replies to the transcribe request', async () => {
    // A plain InProcessDaemonLink (unlike FakeTranscribeDaemon) never
    // replies to the transcribe request, so this waits out the real 30s
    // STORE_REQUEST_TIMEOUT_MS.
    const user = generateUserKeypair(() => new Uint8Array(32).fill(41));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-mobile-1',
      surfaceKind: 'mobile',
      label: 'phone',
      issuedAt: 1,
    });
    const daemonLink = new InProcessDaemonLink();
    const built = await buildAll({ logger: false, registry, daemonLink });
    daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/tmp/c1' });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-mobile-1',
      surfaceKind: 'mobile',
      label: 'phone',
    });
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { authorization: `Bearer ${jwt}`, ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(504);
      expect((res.json() as { error: string }).error).toBe('daemon_timeout');
    } finally {
      await built.app.close();
    }
  }, 35_000);

  it('accepts an empty filename / absent content-type file part and still defaults to m4a', async () => {
    const { built, daemonLink, jwt } = await makeApp();
    try {
      const boundary = '----patchtestboundary-nofilename';
      const CRLF = '\r\n';
      const payload = Buffer.concat([
        Buffer.from(
          `--${boundary}${CRLF}Content-Disposition: form-data; name="chatId"${CRLF}${CRLF}c1${CRLF}`,
        ),
        // No Content-Type header on the file part, and an empty filename —
        // both are still real strings (busboy classifies by filename
        // *presence*, not content), so this exercises `.toLowerCase()` on
        // edge-case-but-real values rather than the defensive `?? ''`
        // fallback (see the v8-ignore comment in src/voice/note.ts).
        Buffer.from(
          `--${boundary}${CRLF}Content-Disposition: form-data; name="audio"; filename=""${CRLF}${CRLF}`,
        ),
        Buffer.from('raw-bytes-no-content-type'),
        Buffer.from(CRLF),
        Buffer.from(`--${boundary}--${CRLF}`),
      ]);
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: {
          ...authed(jwt),
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });
      expect(res.statusCode).toBe(200);
      expect(daemonLink.lastRequest?.format).toBe('m4a');
    } finally {
      await built.app.close();
    }
  });

  it('host transcription failure defaults code/message to internal when `error` is omitted', async () => {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(41));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-mobile-1',
      surfaceKind: 'mobile',
      label: 'phone',
      issuedAt: 1,
    });
    const daemonLink = new InProcessDaemonLink();
    const origSend = daemonLink.send.bind(daemonLink);
    daemonLink.send = (surfaceId, event) => {
      origSend(surfaceId, event);
      if (event.type === 'patch.voice_note.transcribe_request') {
        daemonLink.emit({
          type: 'patch.voice_note.transcribe_response',
          requestId: event.requestId,
          ok: true,
          // `transcript` omitted — result.ok is true but the shape is still
          // invalid, hitting the same failure branch as ok:false without an
          // `error` payload.
        });
      }
    };
    const built = await buildAll({ logger: false, registry, daemonLink });
    daemonLink.emit({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/tmp/c1' });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-mobile-1',
      surfaceKind: 'mobile',
      label: 'phone',
    });
    try {
      const body = multipartBody({ chatId: 'c1', audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { authorization: `Bearer ${jwt}`, ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(502);
      const bodyJson = res.json() as { error: string; message: string };
      expect(bodyJson.error).toBe('internal');
      expect(bodyJson.message).toBe('transcription failed');
    } finally {
      await built.app.close();
    }
  });

  it('ignores a patch.voice_note.transcribe_response frame with an unmatched requestId', async () => {
    const { built, daemonLink } = await makeApp();
    try {
      daemonLink.emit({
        type: 'patch.voice_note.transcribe_response',
        requestId: 'no-such-request-id',
        ok: true,
        transcript: 'irrelevant',
      });
      const res = await built.app.inject({ method: 'GET', url: '/api/healthz' });
      expect(res.statusCode).toBe(200);
    } finally {
      await built.app.close();
    }
  });

  it('honours a surfaceKind form field (web) on the transcribe request AND the injected source', async () => {
    const { built, daemonLink, jwt } = await makeApp();
    try {
      const body = multipartBody({
        chatId: 'c1',
        audio: Buffer.from('RIFFwav'),
        filename: 'voice-note.wav',
        mimetype: 'audio/wav',
        surfaceKind: 'web',
      });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(200);
      expect(daemonLink.lastRequest?.surfaceKind).toBe('web');
      const ev = daemonLink.sent.find((s) => s.event.type === 'chat.input')!.event as Extract<
        WireEvent,
        { type: 'chat.input' }
      >;
      expect(ev.source).toEqual({ kind: 'voice-app', surfaceKind: 'web' });
    } finally {
      await built.app.close();
    }
  });

  it('falls back to mobile for an unknown surfaceKind value', async () => {
    const { built, daemonLink, jwt } = await makeApp();
    try {
      const body = multipartBody({
        chatId: 'c1',
        audio: Buffer.from('x'),
        surfaceKind: 'smart-fridge',
      });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/note',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(200);
      expect(daemonLink.lastRequest?.surfaceKind).toBe('mobile');
    } finally {
      await built.app.close();
    }
  });
});

// POST /api/voice/transcribe — transcribe ONLY (no chat injection). Used by the
// composer dictation mic (spec/C1): the recognised text lands in the composer
// input for the user to edit, so the turn must NOT be submitted server-side.
describe('POST /api/voice/transcribe', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'patch-voice-transcribe-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeApp() {
    const user = generateUserKeypair(() => new Uint8Array(32).fill(41));
    const registry = Registry.load(dir);
    registry.bootstrapAccount({ keypair: user });
    registry.upsertSurface({
      surfaceId: 'srf-web-1',
      surfaceKind: 'web',
      label: 'web',
      issuedAt: 1,
    });
    const daemonLink = new FakeTranscribeDaemon();
    const built = await buildAll({ logger: false, registry, daemonLink });
    const jwt = await mintSurfaceCredential({
      userPrivateKey: user.privateKey,
      surfaceId: 'srf-web-1',
      surfaceKind: 'web',
      label: 'web',
    });
    return { built, daemonLink, jwt, registry };
  }
  const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}` });

  it('falls back to 401 when requireAuth throws an error without a statusCode', async () => {
    const { built, jwt, registry } = await makeApp();
    (registry as unknown as { getAccount: () => never }).getAccount = () => {
      throw new Error('registry backing store exploded');
    };
    try {
      const body = multipartBody({ audio: Buffer.from('x'), surfaceKind: 'web' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/transcribe',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('transcribes a clip and returns the transcript WITHOUT injecting a chat.input', async () => {
    const { built, daemonLink, jwt } = await makeApp();
    daemonLink.transcript = 'dictated words';
    try {
      const body = multipartBody({
        audio: Buffer.from('RIFFwav'),
        filename: 'voice.wav',
        mimetype: 'audio/wav',
        surfaceKind: 'web',
      });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/transcribe',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, transcript: 'dictated words' });
      expect(daemonLink.lastRequest?.surfaceKind).toBe('web');
      expect(daemonLink.lastRequest?.format).toBe('wav');
      // Critically: NO chat.input is injected (the user hasn't sent anything yet).
      expect(daemonLink.sent.some((s) => s.event.type === 'chat.input')).toBe(false);
    } finally {
      await built.app.close();
    }
  });

  it('requires auth (401 without bearer)', async () => {
    const { built } = await makeApp();
    try {
      const body = multipartBody({ audio: Buffer.from('x') });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/transcribe',
        headers: body.headers,
        payload: body.payload,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await built.app.close();
    }
  });

  it('rejects a missing audio file with 400', async () => {
    const { built, jwt } = await makeApp();
    try {
      const body = multipartBody({ surfaceKind: 'web' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/transcribe',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('audio file is required');
    } finally {
      await built.app.close();
    }
  });

  it('rejects a non-multipart body with 400', async () => {
    const { built, jwt } = await makeApp();
    try {
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/transcribe',
        headers: { ...authed(jwt), 'content-type': 'application/json' },
        payload: { not: 'multipart' },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe('expected multipart/form-data');
    } finally {
      await built.app.close();
    }
  });

  it('maps a host transcription failure to 502', async () => {
    const { built, daemonLink, jwt } = await makeApp();
    daemonLink.mode = 'failed';
    try {
      const body = multipartBody({ audio: Buffer.from('x'), surfaceKind: 'web' });
      const res = await built.app.inject({
        method: 'POST',
        url: '/api/voice/transcribe',
        headers: { ...authed(jwt), ...body.headers },
        payload: body.payload,
      });
      expect(res.statusCode).toBe(502);
    } finally {
      await built.app.close();
    }
  });
});
