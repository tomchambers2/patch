// Direct coverage of the REST client (src/api/rest.ts): the shared `request`
// helper's branches (credential attach, JSON vs. non-JSON body, error shapes,
// empty body) plus every `api.*` method (mostly one fetch call each — this
// pins the method + URL + body contract so a route refactor can't silently
// break the wire shape).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { api, ApiError } from '../api/rest.js';
import { saveCredential, clearCredential } from '../lib/credential.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearCredential();
  fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearCredential();
});

function lastCall(): [string, RequestInit] {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
  return call;
}

describe('request() helper', () => {
  it('attaches no authorization header when there is no stored credential', async () => {
    await api.healthz();
    const [, init] = lastCall();
    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toBeNull();
  });

  it('attaches a bearer authorization header when a credential is stored', async () => {
    const b64url = (o: unknown) =>
      btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    saveCredential(`${b64url({ alg: 'EdDSA' })}.${b64url({ surface_id: 'web-1' })}.sig`);
    await api.healthz();
    const [, init] = lastCall();
    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toMatch(/^Bearer /);
  });

  it('sets content-type: application/json and serializes the body when a body is given', async () => {
    await api.createChat({ daemonId: 'd1', folder: '~/p' });
    const [, init] = lastCall();
    const headers = init.headers as Headers;
    expect(headers.get('content-type')).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ daemonId: 'd1', folder: '~/p' }));
  });

  it('sends a null body (no content-type) when no body is given', async () => {
    await api.listChats();
    const [, init] = lastCall();
    const headers = init.headers as Headers;
    expect(headers.get('content-type')).toBeNull();
    expect(init.body).toBeNull();
  });

  it('returns null for a 2xx response with an empty body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const result = await api.deleteChat('c1');
    expect(result).toBeNull();
  });

  it('falls back to the raw text when the body is not valid JSON', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const result = await api.healthz();
    expect(result).toBe('not json');
  });

  it('throws ApiError with the server-provided error message on a non-2xx JSON response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'folder not found' }, 404));
    await expect(api.createChat({ daemonId: 'd1', folder: '~/missing' })).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      message: 'folder not found',
    });
  });

  it('throws ApiError with a generic "HTTP <status>" message when the error body has no `error` field', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(api.healthz()).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      message: 'HTTP 500',
    });
  });

  it('throws ApiError with a generic message when the error body is not an object (raw text)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('plain text error', { status: 502 }));
    await expect(api.healthz()).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      message: 'HTTP 502',
    });
  });

  it('ApiError carries the parsed body for callers that need it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'bad', detail: 'x' }, 400));
    try {
      await api.healthz();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).body).toEqual({ error: 'bad', detail: 'x' });
    }
  });
});

describe('api.* methods — URL/method/body contracts', () => {
  it('healthz / me / listChats / listChatsArchived / folders — simple GETs', async () => {
    await api.healthz();
    expect(lastCall()[0]).toBe('/api/healthz');
    await api.me();
    expect(lastCall()[0]).toBe('/api/auth/me');
    await api.listChats();
    expect(lastCall()[0]).toBe('/api/chats');
    await api.listChatsArchived();
    expect(lastCall()[0]).toBe('/api/chats?archived=only');
    await api.folders();
    expect(lastCall()[0]).toBe('/api/folders');
  });

  it('createChat POSTs to /api/chats with the body', async () => {
    await api.createChat({ daemonId: 'd1', folder: '~/p', prompt: 'go', name: 'n', localId: 'l1' });
    const [url, init] = lastCall();
    expect(url).toBe('/api/chats');
    expect(init.method).toBe('POST');
  });

  it('deleteChat DELETEs /api/chats/:id', async () => {
    await api.deleteChat('c1');
    const [url, init] = lastCall();
    expect(url).toBe('/api/chats/c1');
    expect(init.method).toBe('DELETE');
  });

  it('restoreChat POSTs /api/chats/:id/restore and listChatsDeleted GETs the deleted filter (E5)', async () => {
    await api.restoreChat('c1');
    const [url, init] = lastCall();
    expect(url).toBe('/api/chats/c1/restore');
    expect(init.method).toBe('POST');
    await api.listChatsDeleted();
    expect(lastCall()[0]).toBe('/api/chats?deleted=only');
  });

  // spec/14 § Sidebar item 6: every lifecycle list pages ("load a limited
  // number... then load more on scroll"); Hidden and Automations additionally
  // page oldest-first, matching their FIFO display order.
  it('the five lifecycle lists carry limit/offset, and Hidden/Automations carry order=asc', async () => {
    await api.listChatsArchived();
    expect(lastCall()[0]).toBe('/api/chats?archived=only');
    await api.listChatsArchived({ limit: 30, offset: 30 });
    expect(lastCall()[0]).toBe('/api/chats?archived=only&limit=30&offset=30');

    await api.listChatsDeleted({ limit: 20 });
    expect(lastCall()[0]).toBe('/api/chats?deleted=only&limit=20');

    await api.listChatsSnoozed({ offset: 10 });
    expect(lastCall()[0]).toBe('/api/chats?snoozed=only&offset=10');

    await api.listChatsHidden();
    expect(lastCall()[0]).toBe('/api/chats?hidden=only&order=asc');
    await api.listChatsHidden({ limit: 30, offset: 0 });
    expect(lastCall()[0]).toBe('/api/chats?hidden=only&order=asc&limit=30&offset=0');

    await api.listChatsAutomations();
    expect(lastCall()[0]).toBe('/api/chats?automations=only&order=asc');
  });

  it('job CRUD + lifecycle endpoints', async () => {
    await api.listJobs();
    expect(lastCall()[0]).toBe('/api/jobs');
    await api.getJob('j1');
    expect(lastCall()[0]).toBe('/api/jobs/j1');
    await api.createJob({ name: 'x' });
    expect(lastCall()).toEqual(['/api/jobs', expect.objectContaining({ method: 'POST' })]);
    await api.patchJob('j1', { enabled: false });
    expect(lastCall()).toEqual(['/api/jobs/j1', expect.objectContaining({ method: 'PATCH' })]);
    await api.deleteJob('j1');
    expect(lastCall()).toEqual(['/api/jobs/j1', expect.objectContaining({ method: 'DELETE' })]);
    await api.enableJob('j1');
    expect(lastCall()[0]).toBe('/api/jobs/j1/enable');
    await api.disableJob('j1');
    expect(lastCall()[0]).toBe('/api/jobs/j1/disable');
  });

  it('jobRuns defaults limit to 5 and accepts an override', async () => {
    await api.jobRuns('j1');
    expect(lastCall()[0]).toBe('/api/jobs/j1/runs?limit=5');
    await api.jobRuns('j1', 20);
    expect(lastCall()[0]).toBe('/api/jobs/j1/runs?limit=20');
  });

  it('archiveChat / pinChat POST their boolean body', async () => {
    await api.archiveChat('c1', true);
    expect(lastCall()).toEqual([
      '/api/chats/c1/archive',
      expect.objectContaining({ body: JSON.stringify({ archived: true }) }),
    ]);
    await api.pinChat('c1', false);
    expect(lastCall()).toEqual([
      '/api/chats/c1/pin',
      expect.objectContaining({ body: JSON.stringify({ pinned: false }) }),
    ]);
  });

  it('voiceToken POSTs chatId/role/surfaceKind:web', async () => {
    await api.voiceToken('c1', 'voice-note');
    const [url, init] = lastCall();
    expect(url).toBe('/api/voice/token');
    expect(init.body).toBe(
      JSON.stringify({ chatId: 'c1', role: 'voice-note', surfaceKind: 'web' }),
    );
  });

  it('pushRegister', async () => {
    await api.pushRegister('tok', 'android');
    expect(lastCall()[0]).toBe('/api/auth/push/register');
  });

  it('revoke() with no id omits the body; revoke(id) includes it', async () => {
    await api.revoke();
    let [, init] = lastCall();
    expect(init.body).toBeNull();
    await api.revoke('surface-9');
    [, init] = lastCall();
    expect(init.body).toBe(JSON.stringify({ id: 'surface-9' }));
  });

  it('settings / setProjectFolders / surfacePairStart / daemonPairStart', async () => {
    await api.settings();
    expect(lastCall()[0]).toBe('/api/settings');
    await api.setProjectFolders(['~/a', '~/b']);
    expect(lastCall()).toEqual([
      '/api/auth/folders',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ folders: ['~/a', '~/b'] }),
      }),
    ]);
    await api.surfacePairStart();
    expect(lastCall()[0]).toBe('/api/auth/pair/start');
    await api.daemonPairStart();
    expect(lastCall()[0]).toBe('/api/auth/daemon/pair/start');
  });

  it('listFilesRecursive / getFileContent / getFileContentAtHead / skills', async () => {
    await api.listFilesRecursive('c1');
    expect(lastCall()[0]).toBe('/api/chats/c1/files?recursive=1&maxEntries=5000');
    await api.listFilesRecursive('c1', 100);
    expect(lastCall()[0]).toBe('/api/chats/c1/files?recursive=1&maxEntries=100');
    await api.getFileContent('c1', 'a.ts');
    expect(lastCall()[0]).toBe('/api/chats/c1/files?path=a.ts&content=1');
    await api.getFileContentAtHead('c1', 'a.ts');
    expect(lastCall()[0]).toBe('/api/chats/c1/files?path=a.ts&content=1&ref=head');
    await api.skills('~/p', 'd1');
    expect(lastCall()[0]).toBe('/api/skills?folder=~%2Fp&daemonId=d1');
  });

  // Editor overhaul (binary preview): its own small fetch (not `request()`,
  // which always JSON-parses) — same URL/auth contract, body read as a Blob.
  it('getFileRawBlob hits the raw route with auth and returns a Blob', async () => {
    const b64url = (o: unknown) =>
      btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    saveCredential(`${b64url({ alg: 'EdDSA' })}.${b64url({ surface_id: 'web-1' })}.sig`);
    const blob = await api.getFileRawBlob('c1', 'src/pic.png');
    expect(lastCall()[0]).toBe('/api/chats/c1/files/raw?path=src%2Fpic.png');
    const [, init] = lastCall();
    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toMatch(/^Bearer /);
    // Not `toBeInstanceOf(Blob)` — jsdom's `Response.blob()` and this file's
    // global `Blob` can be different realms under vitest, so `instanceof`
    // is not reliable here; shape-check instead.
    expect(typeof blob.arrayBuffer).toBe('function');
    expect(blob.size).toBeGreaterThan(0);
  });

  it('getFileRawBlob throws an ApiError on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'not_found' }, 404));
    await expect(api.getFileRawBlob('c1', 'nope.png')).rejects.toMatchObject({
      status: 404,
      message: 'not_found',
    });
  });

  // The host is ALWAYS on the query — browsing is addressed to one machine and
  // is never the surface's own filesystem (spec/04 § Browsing). `dir` is the
  // only optional part; omitted, the host answers with its browsable roots.
  it('browseFolders always names the host, and adds dir only when given', async () => {
    await api.browseFolders('d1');
    expect(lastCall()[0]).toBe('/api/folders/browse?daemonId=d1');
    await api.browseFolders('d1', '~/projects');
    expect(lastCall()[0]).toBe('/api/folders/browse?daemonId=d1&dir=~%2Fprojects');
  });
});

describe('api.uploadAttachment', () => {
  it('attaches the bearer header, posts multipart form data, and returns the ref on success', async () => {
    const b64url = (o: unknown) =>
      btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    saveCredential(`${b64url({ alg: 'EdDSA' })}.${b64url({ surface_id: 'web-1' })}.sig`);
    const ref = { id: 'a1', name: 'x.png', mimeType: 'image/png', kind: 'image', url: '/x' };
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, ref }));
    const file = new File(['bytes'], 'x.png', { type: 'image/png' });
    const result = await api.uploadAttachment('c1', file);
    expect(result).toEqual({ ok: true, ref });
    const [url, init] = lastCall();
    expect(url).toBe('/api/chats/c1/attachment');
    expect(init.method).toBe('POST');
    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toMatch(/^Bearer /);
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('works with no stored credential (no authorization header)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        ref: { id: 'a1', name: 'x', mimeType: 'x', kind: 'file', url: '/x' },
      }),
    );
    const file = new File(['bytes'], 'x.txt', { type: 'text/plain' });
    await api.uploadAttachment('c1', file);
    const [, init] = lastCall();
    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toBeNull();
  });

  // spec/15 § Composer — the original renders, the downscaled copy feeds the agent.
  it('sends the original as `file` and the downscaled copy as `model`', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        ref: { id: 'a1', name: 'x.png', mimeType: 'image/png', kind: 'image', url: '/x' },
      }),
    );
    const original = new File(['original-bytes'], 'x.png', { type: 'image/png' });
    const model = new File(['small'], 'x.jpg', { type: 'image/jpeg' });
    await api.uploadAttachment('c1', original, model);
    const [, init] = lastCall();
    const form = init.body as FormData;
    expect((form.get('file') as File).name).toBe('x.png');
    expect((form.get('model') as File).name).toBe('x.jpg');
  });

  it('omits the `model` part when there is no downscaled copy', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        ref: { id: 'a1', name: 'x.txt', mimeType: 'text/plain', kind: 'file', url: '/x' },
      }),
    );
    await api.uploadAttachment('c1', new File(['bytes'], 'x.txt', { type: 'text/plain' }));
    const [, init] = lastCall();
    const form = init.body as FormData;
    expect(form.get('file')).not.toBeNull();
    expect(form.get('model')).toBeNull();
  });

  it('throws ApiError on a non-2xx response, with the server error message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'file too large' }, 413));
    const file = new File(['bytes'], 'x.png', { type: 'image/png' });
    await expect(api.uploadAttachment('c1', file)).rejects.toMatchObject({
      name: 'ApiError',
      status: 413,
      message: 'file too large',
    });
  });

  it('throws ApiError with a generic message when the error body has no `error` field', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
    const file = new File(['bytes'], 'x.png', { type: 'image/png' });
    await expect(api.uploadAttachment('c1', file)).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      message: 'HTTP 500',
    });
  });

  it('falls back to raw text when the success body is not valid JSON (defensive)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const file = new File(['bytes'], 'x.png', { type: 'image/png' });
    const result = await api.uploadAttachment('c1', file);
    expect(result).toBe('not json');
  });
});

describe('api.voiceNote (voice-note upload)', () => {
  const wavBlob = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });

  it('posts chatId + surfaceKind=web + audio multipart and returns the transcript', async () => {
    const b64url = (o: unknown) =>
      btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    saveCredential(`${b64url({ alg: 'EdDSA' })}.${b64url({ surface_id: 'web-1' })}.sig`);
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, transcript: 'buy oat milk' }));
    const result = await api.voiceNote('c1', wavBlob(), '');
    expect(result).toEqual({ ok: true, transcript: 'buy oat milk' });
    const [url, init] = lastCall();
    expect(url).toBe('/api/voice/note');
    expect(init.method).toBe('POST');
    expect((init.headers as Headers).get('authorization')).toMatch(/^Bearer /);
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as unknown as FormData;
    expect(form.get('chatId')).toBe('c1');
    expect(form.get('surfaceKind')).toBe('web');
    expect(form.get('audio')).toBeInstanceOf(Blob);
  });

  it('works with no stored credential (no authorization header)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, transcript: 'hi' }));
    await api.voiceNote('c1', wavBlob(), '');
    expect((lastCall()[1].headers as Headers).get('authorization')).toBeNull();
  });

  it('throws ApiError on a non-2xx with the server error message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'unsupported_format' }, 400));
    await expect(api.voiceNote('c1', wavBlob(), '')).rejects.toMatchObject({
      name: 'ApiError',
      status: 400,
      message: 'unsupported_format',
    });
  });

  it('throws ApiError with a generic message when the error body has no `error` field', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 502 }));
    await expect(api.voiceNote('c1', wavBlob(), '')).rejects.toMatchObject({
      name: 'ApiError',
      status: 502,
      message: 'HTTP 502',
    });
  });

  it('falls back to raw text when the success body is not valid JSON (defensive)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const result = await api.voiceNote('c1', wavBlob(), '');
    expect(result as unknown).toBe('not json');
  });
});

describe('api.voiceTranscribe (composer dictation)', () => {
  const wavBlob = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });

  it('posts surfaceKind=web + audio (NO chatId) and returns the transcript', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, transcript: 'hello world' }));
    const result = await api.voiceTranscribe(wavBlob());
    expect(result).toEqual({ ok: true, transcript: 'hello world' });
    const [url, init] = lastCall();
    expect(url).toBe('/api/voice/transcribe');
    expect(init.method).toBe('POST');
    const form = init.body as unknown as FormData;
    expect(form.get('chatId')).toBeNull();
    expect(form.get('surfaceKind')).toBe('web');
    expect(form.get('audio')).toBeInstanceOf(Blob);
  });

  it('attaches the bearer header when a credential is stored', async () => {
    const b64url = (o: unknown) =>
      btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    saveCredential(`${b64url({ alg: 'EdDSA' })}.${b64url({ surface_id: 'web-1' })}.sig`);
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, transcript: 'x' }));
    await api.voiceTranscribe(wavBlob());
    expect((lastCall()[1].headers as Headers).get('authorization')).toMatch(/^Bearer /);
  });

  it('throws ApiError on a non-2xx with the server error message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'daemon_timeout' }, 504));
    await expect(api.voiceTranscribe(wavBlob())).rejects.toMatchObject({
      name: 'ApiError',
      status: 504,
      message: 'daemon_timeout',
    });
  });

  it('throws ApiError with a generic message when the error body has no `error` field', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
    await expect(api.voiceTranscribe(wavBlob())).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      message: 'HTTP 500',
    });
  });

  it('falls back to raw text when the success body is not valid JSON (defensive)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not json', { status: 200 }));
    const result = await api.voiceTranscribe(wavBlob());
    expect(result as unknown).toBe('not json');
  });
});

describe('checkHooks gateway failure', () => {
  it.each([502, 503, 504])(
    'explains an HTTP %i as the server being unreachable',
    async (status) => {
      fetchMock.mockResolvedValueOnce(new Response('Bad Gateway', { status }));
      await expect(api.checkHooks('c1', 'hi')).rejects.toThrow(
        new RegExp(
          `Patch server unreachable \\(HTTP ${status}\\).*message was not sent.*try again`,
          'i',
        ),
      );
    },
  );

  it('keeps the server-supplied error for a JSON failure', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'invalid body' }, 400));
    await expect(api.checkHooks('c1', 'hi')).rejects.toThrow('invalid body');
  });
});

describe('checkHooks timeout', () => {
  it('rejects instead of hanging when the server never answers', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(
        (_path: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      );
      const p = api.checkHooks('c1', 'hi');
      const settled = expect(p).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(20_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});
