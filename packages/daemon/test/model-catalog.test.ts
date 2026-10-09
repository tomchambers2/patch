// spec/02 § Model catalogue — the selectable models come from Anthropic, read
// with the Claude Code OAuth credential the host already holds, cached for a
// TTL. This is the fix for the picker going stale (todo: "should regularly
// update models, opus 5 is missing"): a model released after the last deploy is
// selectable without a code change.
//
// NO FALLBACK: a missing credential or a non-2xx upstream throws — the catalogue
// never invents or serves a hand-maintained list.

import { describe, it, expect, vi } from 'vitest';
import type { WireEvent } from '@patch/wire';
import { ModelCatalog, MODELS_TTL_MS } from '../src/modelCatalog.js';
import type { RunOnAccountWithCredit } from '../src/accountFailover.js';
import type { OAuthCheckResult } from '../src/chatRunner.js';
import { handleModelsRequest } from '../src/index.js';

const silentLogger = {
  warn: () => {},
  info: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Parameters<typeof handleModelsRequest>[3];

const OK_BODY = {
  data: [
    {
      type: 'model',
      id: 'claude-haiku-4-5',
      display_name: 'Claude Haiku 4.5',
      created_at: '2025-10-01T00:00:00Z',
    },
    {
      type: 'model',
      id: 'claude-opus-5',
      display_name: 'Claude Opus 5',
      created_at: '2026-06-24T00:00:00Z',
    },
    {
      type: 'model',
      id: 'claude-sonnet-5',
      display_name: 'Claude Sonnet 5',
      created_at: '2026-02-01T00:00:00Z',
    },
  ],
  has_more: false,
};

function okFetch(body: unknown = OK_BODY) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

/**
 * Stand-in for the host's real `runOnAccountWithCredit`, which walks every
 * stored account. These tests are about the generator's own behaviour given a
 * credential, so this wraps a single resolver: no credential (or a resolver
 * that throws) yields null without running, and a failing run yields null —
 * the same two outcomes the real runner produces once it is out of accounts.
 */
const runWith =
  (oauth: () => OAuthCheckResult): RunOnAccountWithCredit =>
  async (_label, run) => {
    let resolved: OAuthCheckResult;
    try {
      resolved = oauth();
    } catch {
      return null;
    }
    if (!resolved.ok) return null;
    // Real errors propagate, exactly as the host's runner propagates
    // anything that is not an out-of-credit account.
    return await run(resolved.accessToken);
  };

describe('ModelCatalog', () => {
  it('reads Anthropic /v1/models with the OAuth bearer and returns models newest-first', async () => {
    const fetchImpl = okFetch();
    const catalog = new ModelCatalog({
      runOnAccountWithCredit: runWith(() => ({ ok: true, accessToken: 'tok-123' })),
      fetchImpl,
    });

    const snap = await catalog.get();

    expect(snap.models.map((m) => m.id)).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]);
    expect(snap.models[0]).toEqual({ id: 'claude-opus-5', label: 'Claude Opus 5' });
    expect(typeof snap.fetchedAt).toBe('string');

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(call[0])).toContain('https://api.anthropic.com/v1/models');
    const headers = (call[1] as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBe('Bearer tok-123');
    expect(headers['anthropic-beta']).toContain('oauth');
    expect(headers['anthropic-version']).toBeTruthy();
  });

  it('serves the cached catalogue inside the TTL and re-reads once it expires', async () => {
    const fetchImpl = okFetch();
    let now = 1_000_000;
    const catalog = new ModelCatalog({
      runOnAccountWithCredit: runWith(() => ({ ok: true, accessToken: 'tok' })),
      fetchImpl,
      now: () => now,
    });

    await catalog.get();
    await catalog.get();
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    now += MODELS_TTL_MS + 1;
    await catalog.get();
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it('serves the last good catalogue when a refresh fails inside its cached life', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return { ok: true, status: 200, json: async () => OK_BODY, text: async () => '' };
      }
      throw new Error('network down');
    }) as unknown as typeof fetch;
    let now = 0;
    const catalog = new ModelCatalog({
      runOnAccountWithCredit: runWith(() => ({ ok: true, accessToken: 'tok' })),
      fetchImpl,
      now: () => now,
    });

    const first = await catalog.get();
    now += MODELS_TTL_MS + 1;
    const second = await catalog.get();

    expect(second.models).toEqual(first.models);
    expect(second.stale).toBe(true);
  });

  it('throws when the OAuth credential is unavailable (NO FALLBACK)', async () => {
    const catalog = new ModelCatalog({
      runOnAccountWithCredit: runWith(() => ({ ok: false, reason: 'no credential' })),
      fetchImpl: okFetch(),
    });
    await expect(catalog.get()).rejects.toThrow(/oauth/i);
  });

  it('throws on a non-2xx from Anthropic rather than returning an invented list', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'unauthorized',
    })) as unknown as typeof fetch;
    const catalog = new ModelCatalog({
      runOnAccountWithCredit: runWith(() => ({ ok: true, accessToken: 'tok' })),
      fetchImpl,
    });
    await expect(catalog.get()).rejects.toThrow(/401/);
  });

  it('throws when Anthropic returns an empty model list (never a silent empty picker)', async () => {
    const catalog = new ModelCatalog({
      runOnAccountWithCredit: runWith(() => ({ ok: true, accessToken: 'tok' })),
      fetchImpl: okFetch({ data: [], has_more: false }),
    });
    await expect(catalog.get()).rejects.toThrow(/no models/i);
  });
});

describe('patch.models.request', () => {
  it('answers with the catalogue', async () => {
    const catalog = new ModelCatalog({
      runOnAccountWithCredit: runWith(() => ({ ok: true, accessToken: 'tok' })),
      fetchImpl: okFetch(),
    });
    const sent: WireEvent[] = [];
    await handleModelsRequest(
      { type: 'patch.models.request', daemonId: 'd1', requestId: 'm1' },
      catalog,
      (e) => sent.push(e),
      silentLogger,
      'd1',
    );
    expect(sent[0]).toMatchObject({
      type: 'patch.models.response',
      daemonId: 'd1',
      requestId: 'm1',
      errors: [],
    });
    const models = (sent[0] as Extract<WireEvent, { type: 'patch.models.response' }>).models;
    expect(models.map((m) => m.id)).toContain('claude-opus-5');
    // Every entry names the backend serving it — a chosen model selects the
    // backend the chat runs on (spec/02 § Model catalogue).
    expect(models.every((m) => m.backend === 'claude-code')).toBe(true);
  });

  it('answers ok:false with the reason when the catalogue cannot be read', async () => {
    const catalog = new ModelCatalog({
      runOnAccountWithCredit: runWith(() => ({ ok: false, reason: 'no credential' })),
      fetchImpl: okFetch(),
    });
    const sent: WireEvent[] = [];
    await handleModelsRequest(
      { type: 'patch.models.request', daemonId: 'd1', requestId: 'm2' },
      catalog,
      (e) => sent.push(e),
      silentLogger,
      'd1',
    );
    // The failure is returned AGAINST THE BACKEND, alongside whatever did
    // resolve — there is no whole-host ok flag any more, because the host is
    // no longer the unit that succeeds or fails (spec/02 § Model catalogue).
    expect(sent[0]).toMatchObject({
      type: 'patch.models.response',
      daemonId: 'd1',
      requestId: 'm2',
      models: [],
      errors: [{ backend: 'claude-code', code: 'oauth_unavailable' }],
    });
  });
});
