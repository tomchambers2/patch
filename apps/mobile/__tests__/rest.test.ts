// api/rest.ts — the REST client. NO FALLBACK: any non-2xx throws ApiError.
// `request()` (auth header, JSON body, JSON/plain-text response parsing,
// error-body shape) backs every `api.*` method except voiceNote/
// uploadAttachment, which build their own multipart FormData — those two are
// exercised directly. Every method call is asserted for its
// URL/method/body shape (100% function coverage), and the shared `request()`
// helper's branches are covered via a couple of representative calls.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { api, ApiError } from '../src/api/rest';
import { saveCredential, clearCredential } from '../src/lib/credential';
import { TEST_SERVER_URL as SERVER_URL } from './stubs/mmkv';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  clearCredential();
});

function lastCall(): [string, RequestInit] {
  const call = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return call;
}

describe('request() — shared helper branches', () => {
  it('omits the authorization header with no saved credential', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ chats: [] }));
    await api.listChats();
    const [, init] = lastCall();
    expect((init.headers as Headers).has('authorization')).toBe(false);
  });

  it('adds a bearer authorization header when a credential is saved', async () => {
    saveCredential('jwt-token');
    fetchMock.mockResolvedValue(jsonResponse({ chats: [] }));
    await api.listChats();
    const [, init] = lastCall();
    expect((init.headers as Headers).get('authorization')).toBe('Bearer jwt-token');
  });

  it('serializes a body as JSON with a content-type header', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await api.pinChat('c1', true);
    const [, init] = lastCall();
    expect((init.headers as Headers).get('content-type')).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ pinned: true }));
  });

  it('sends a null body when the call has none', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ chats: [] }));
    await api.listChats();
    const [, init] = lastCall();
    expect(init.body).toBeNull();
  });

  it('parses a non-JSON 200 response body as plain text', async () => {
    fetchMock.mockResolvedValue(
      new Response('pong', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const result = await api.revoke('s1');
    expect(result).toBe('pong');
  });

  it('parses an empty 200 response body as null', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));
    const result = await api.revoke('s1');
    expect(result).toBeNull();
  });

  it('throws ApiError with the server error message on a non-2xx JSON error body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'chat not found' }, 404));
    await expect(api.getJob('missing')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: 'chat not found',
    });
  });

  it('throws ApiError with a generic HTTP-status message when the error body has no `error` field', async () => {
    fetchMock.mockResolvedValue(new Response('server exploded', { status: 500 }));
    await expect(api.getJob('x')).rejects.toMatchObject({ status: 500, message: 'HTTP 500' });
  });

  it('carries the host-side detail through, not just the bare error code', async () => {
    // A host failure comes back as `{error: <code>, message: <detail>}`.
    // "internal" on its own is useless to the user — the detail is what names
    // the actual cause (e.g. an EACCES on the chat folder).
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: 'internal', message: "EACCES: permission denied, open '/x/.patch/attachments/y'" },
        502,
      ),
    );
    await expect(api.getJob('x')).rejects.toMatchObject({
      status: 502,
      message: "internal: EACCES: permission denied, open '/x/.patch/attachments/y'",
    });
  });

  it('a voice surface with no provider key: the host sentence alone, no code prefix', async () => {
    const message =
      'Dictation is set to gemini, but GEMINI_API_KEY is not set on this host. ' +
      'Switch Dictation to another backend in Settings → Voice.';
    fetchMock.mockResolvedValue(jsonResponse({ error: 'voice_key_missing', message }, 502));
    await expect(api.getJob('x')).rejects.toMatchObject({ status: 502, message });
  });

  it('ApiError carries the raw parsed body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'nope', detail: 'x' }, 400));
    try {
      await api.getJob('x');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).body).toEqual({ error: 'nope', detail: 'x' });
    }
  });
});

describe('api.* — every method call shape', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(jsonResponse({}));
  });

  // spec/03 § Host files — a HOST and an absolute path, no chat.
  it('hostFilesList() with no path asks for home', async () => {
    await api.hostFilesList('d 1');
    expect(lastCall()[0]).toBe(`${SERVER_URL}/api/hosts/d%201/files`);
  });
  it('hostFilesList() with a path names it', async () => {
    await api.hostFilesList('d1', '/home/tom/.claude');
    expect(lastCall()[0]).toBe(`${SERVER_URL}/api/hosts/d1/files?path=%2Fhome%2Ftom%2F.claude`);
  });
  it('hostFileRead()', async () => {
    await api.hostFileRead('d1', '/etc/hosts');
    expect(lastCall()[0]).toBe(`${SERVER_URL}/api/hosts/d1/files/content?path=%2Fetc%2Fhosts`);
  });
  it('hostFileWrite() PUTs the content with the version it was opened at', async () => {
    await api.hostFileWrite('d1', { path: '/a.md', content: 'x', baseVersion: 'v1' });
    const [url, init] = lastCall();
    expect(url).toBe(`${SERVER_URL}/api/hosts/d1/files/content`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({
      path: '/a.md',
      content: 'x',
      baseVersion: 'v1',
    });
  });
  it('me()', async () => {
    await api.me();
    expect(lastCall()[0]).toBe(`${SERVER_URL}/api/auth/me`);
  });
  // `snoozed=include` is load-bearing: the default response OMITS snoozed chats,
  // and the phone draws them in their own section (spec/15 ## Chats tab §6)
  // rather than hiding them, so a plain /api/chats would leave that section
  // empty on cold start.
  it('listChats() asks for snoozed chats too', async () => {
    await api.listChats();
    expect(lastCall()[0]).toBe(`${SERVER_URL}/api/chats?snoozed=include`);
  });
  // spec/03 § Chat search — the query is encoded; limit/offset only when given;
  // the caller's AbortSignal reaches fetch so a superseded query is cancelled.
  it('searchChats() with just a query', async () => {
    await api.searchChats('pan cakes & syrup');
    const [url, init] = lastCall();
    expect(url).toBe(`${SERVER_URL}/api/chats/search?q=pan+cakes+%26+syrup`);
    expect(init.signal ?? undefined).toBeUndefined();
  });
  it('searchChats() with a page and a signal', async () => {
    const ctrl = new AbortController();
    await api.searchChats('pan', { limit: 20, offset: 40, signal: ctrl.signal });
    const [url, init] = lastCall();
    expect(url).toBe(`${SERVER_URL}/api/chats/search?q=pan&limit=20&offset=40`);
    expect(init.signal).toBe(ctrl.signal);
  });
  it('snoozeChat() posts the ABSOLUTE wake time', async () => {
    await api.snoozeChat('c1', 1_800_000_000_000);
    const [url, init] = lastCall();
    expect(url).toBe(`${SERVER_URL}/api/chats/c1/snooze`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ snoozedUntil: 1_800_000_000_000 });
  });
  it('snoozeChat(null) unsnoozes', async () => {
    await api.snoozeChat('c1', null);
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ snoozedUntil: null });
  });
  it('createChat()', async () => {
    await api.createChat({ folder: '~/x', prompt: 'hi', name: 'n' });
    const [url, init] = lastCall();
    expect(url).toBe(`${SERVER_URL}/api/chats`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ folder: '~/x', prompt: 'hi', name: 'n' });
  });
  it('deleteChat()', async () => {
    await api.deleteChat('c1');
    const [url, init] = lastCall();
    expect(url).toBe(`${SERVER_URL}/api/chats/c1`);
    expect(init.method).toBe('DELETE');
  });
  it('archiveChat()', async () => {
    await api.archiveChat('c1', true);
    const [url, init] = lastCall();
    expect(url).toBe(`${SERVER_URL}/api/chats/c1/archive`);
    expect(JSON.parse(init.body as string)).toEqual({ archived: true });
  });
  it('pinChat()', async () => {
    await api.pinChat('c1', false);
    expect(JSON.parse(lastCall()[1].body as string)).toEqual({ pinned: false });
  });
  it('voiceToken()', async () => {
    await api.voiceToken('c1', 'voice-call');
    const [url, init] = lastCall();
    expect(url).toBe(`${SERVER_URL}/api/voice/token`);
    expect(JSON.parse(init.body as string)).toEqual({
      chatId: 'c1',
      role: 'voice-call',
      surfaceKind: 'mobile',
    });
  });
  it('pushRegister()', async () => {
    await api.pushRegister('expo-tok');
    const [url, init] = lastCall();
    expect(url).toBe(`${SERVER_URL}/api/auth/push/register`);
    expect(JSON.parse(init.body as string)).toEqual({
      token: 'expo-tok',
      platform: 'android-expo',
    });
  });
  it('pairComplete()', async () => {
    await api.pairComplete({ nonce: 'n', devicePublicKey: 'k', clientType: 'surface-mobile' });
    expect(lastCall()[0]).toBe(`${SERVER_URL}/api/auth/pair/complete`);
  });
  it('revoke()', async () => {
    await api.revoke('surf1');
    const [url, init] = lastCall();
    expect(url).toBe(`${SERVER_URL}/api/auth/revoke`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ id: 'surf1' });
  });
  it('settings()', async () => {
    await api.settings();
    expect(lastCall()[0]).toBe(`${SERVER_URL}/api/settings`);
  });
  it('healthz()', async () => {
    await api.healthz();
    expect(lastCall()[0]).toBe(`${SERVER_URL}/api/healthz`);
  });
  it('version() validates the report and rejects a partial one', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ checkedAt: 'x' }));
    await expect(api.version()).rejects.toThrow(/malformed \/api\/version/);
    expect(lastCall()[0]).toBe(`${SERVER_URL}/api/version`);
  });
  it('surfacePairStart()', async () => {
    await api.surfacePairStart();
    const [url, init] = lastCall();
    expect(url).toBe(`${SERVER_URL}/api/auth/pair/start`);
    expect(init.method).toBe('POST');
  });
  it('daemonPairStart()', async () => {
    await api.daemonPairStart();
    const [url, init] = lastCall();
    expect(url).toBe(`${SERVER_URL}/api/auth/daemon/pair/start`);
    expect(init.method).toBe('POST');
  });
  it('daemonManifest()', async () => {
    await api.daemonManifest();
    expect(lastCall()[0]).toBe(`${SERVER_URL}/api/daemon/daemon-latest.json`);
  });
  it('daemonInstallCommand()', async () => {
    await api.daemonInstallCommand('linux');
    expect(lastCall()[0]).toBe(`${SERVER_URL}/api/daemon/install-command?os=linux`);
  });
  it('listSecrets()', async () => {
    await api.listSecrets();
    expect(lastCall()[0]).toBe(`${SERVER_URL}/api/secrets`);
  });
  it('setSecret()', async () => {
    await api.setSecret('key one', 'val');
    const [url, init] = lastCall();
    expect(url).toBe(`${SERVER_URL}/api/secrets/${encodeURIComponent('key one')}`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ value: 'val' });
  });
  it('deleteSecret()', async () => {
    await api.deleteSecret('key');
    const [url, init] = lastCall();
    expect(url).toBe(`${SERVER_URL}/api/secrets/key`);
    expect(init.method).toBe('DELETE');
  });
  it('listJobs()', async () => {
    await api.listJobs();
    expect(lastCall()[0]).toBe(`${SERVER_URL}/api/jobs`);
  });
  it('getJob()', async () => {
    await api.getJob('job1');
    expect(lastCall()[0]).toBe(`${SERVER_URL}/api/jobs/job1`);
  });
  it('createJob()', async () => {
    await api.createJob({ name: 'n' });
    const [url, init] = lastCall();
    expect(url).toBe(`${SERVER_URL}/api/jobs`);
    expect(init.method).toBe('POST');
  });
  it('patchJob()', async () => {
    await api.patchJob('job1', { name: 'n2' });
    const [url, init] = lastCall();
    expect(url).toBe(`${SERVER_URL}/api/jobs/job1`);
    expect(init.method).toBe('PATCH');
  });
  it('deleteJob()', async () => {
    await api.deleteJob('job1');
    expect(lastCall()[1].method).toBe('DELETE');
  });
  it('enableJob()', async () => {
    await api.enableJob('job1');
    expect(lastCall()[0]).toBe(`${SERVER_URL}/api/jobs/job1/enable`);
  });
  it('disableJob()', async () => {
    await api.disableJob('job1');
    expect(lastCall()[0]).toBe(`${SERVER_URL}/api/jobs/job1/disable`);
  });
  it('folders()', async () => {
    await api.folders();
    expect(lastCall()[0]).toBe(`${SERVER_URL}/api/folders`);
  });
  // Browsing is addressed to ONE machine (spec/04 § Browsing) — the daemonId is
  // required and always on the query, because it is never the phone's own
  // filesystem being listed.
  it('browseFolders() with no dir', async () => {
    await api.browseFolders('host-a');
    expect(lastCall()[0]).toBe(`${SERVER_URL}/api/folders/browse?daemonId=host-a`);
  });
  it('browseFolders() with a dir', async () => {
    await api.browseFolders('host-a', '~/a b');
    expect(lastCall()[0]).toBe(
      `${SERVER_URL}/api/folders/browse?daemonId=host-a&dir=${encodeURIComponent('~/a b')}`,
    );
  });
  it('skills()', async () => {
    await api.skills('~/x', 'd1');
    expect(lastCall()[0]).toBe(
      `${SERVER_URL}/api/skills?folder=${encodeURIComponent('~/x')}&daemonId=d1`,
    );
  });
});

describe('api.voiceNote — multipart upload (spec/07)', () => {
  it('uploads the clip as multipart form data and returns the transcript', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, transcript: 'hello world' }));
    const result = await api.voiceNote('c1', 'file:///tmp/clip.m4a');
    expect(result).toEqual({ ok: true, transcript: 'hello world' });
    const [url, init] = lastCall();
    expect(url).toBe(`${SERVER_URL}/api/voice/note`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('includes the authorization header when credentialed', async () => {
    saveCredential('jwt-token');
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, transcript: '' }));
    await api.voiceNote('c1', 'file:///tmp/clip.m4a');
    const [, init] = lastCall();
    expect((init.headers as Headers).get('authorization')).toBe('Bearer jwt-token');
  });

  it('throws ApiError on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'transcription failed' }, 500));
    await expect(api.voiceNote('c1', 'file:///tmp/clip.m4a')).rejects.toMatchObject({
      status: 500,
      message: 'transcription failed',
    });
  });

  it('a non-JSON error body falls back to an HTTP-status message', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 502 }));
    await expect(api.voiceNote('c1', 'file:///tmp/clip.m4a')).rejects.toMatchObject({
      status: 502,
      message: 'HTTP 502',
    });
  });
});

describe('api.uploadAttachment — multipart upload (spec/15 § Composer)', () => {
  it('uploads the file as multipart form data and returns the ref', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ok: true,
        ref: { id: 'a1', name: 'x.png', mimeType: 'image/png', kind: 'image', url: '/x' },
      }),
    );
    const result = await api.uploadAttachment('c1', {
      uri: 'file:///tmp/x.png',
      name: 'x.png',
      mimeType: 'image/png',
    });
    expect(result.ref.id).toBe('a1');
    const [url, init] = lastCall();
    expect(url).toBe(`${SERVER_URL}/api/chats/c1/attachment`);
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('includes the authorization header when credentialed', async () => {
    saveCredential('jwt-token');
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, ref: {} }));
    await api.uploadAttachment('c1', { uri: 'x', name: 'x', mimeType: 'image/png' });
    const [, init] = lastCall();
    expect((init.headers as Headers).get('authorization')).toBe('Bearer jwt-token');
  });

  it('URL-encodes the chatId', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, ref: {} }));
    await api.uploadAttachment('c 1', { uri: 'x', name: 'x', mimeType: 'text/plain' });
    expect(lastCall()[0]).toBe(`${SERVER_URL}/api/chats/${encodeURIComponent('c 1')}/attachment`);
  });

  it('throws ApiError on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'too large' }, 413));
    await expect(
      api.uploadAttachment('c1', { uri: 'x', name: 'x', mimeType: 'image/jpeg' }),
    ).rejects.toMatchObject({ status: 413, message: 'too large' });
  });

  it('a non-JSON error body falls back to an HTTP-status message', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    await expect(
      api.uploadAttachment('c1', { uri: 'x', name: 'x', mimeType: 'image/jpeg' }),
    ).rejects.toMatchObject({ status: 500, message: 'HTTP 500' });
  });
});
