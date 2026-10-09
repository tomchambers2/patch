// C1: OAuth gate (spec/10-auth.md "Claude OAuth — non-negotiable").
//
// Before any SDK query() the host re-checks ~/.claude.json. Missing/expired
// → emit `daemon.unauthenticated` and REFUSE the query. NO FALLBACK to an API
// key. We also assert ANTHROPIC_API_KEY is stripped from the env the real SDK
// backend passes to query().

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { CLAUDE_BACKEND_ID, type WireEvent } from '@patch/wire';
import type { LoadClaudeOAuthOptions } from '@patch/auth';
import { Daemon, type OAuthCheckResult } from '../src/chatRunner.js';
import { createMetaStore } from '../src/meta.js';
import { createMockSdkBackend, type SdkEnvelope } from '../src/sdkBackend.js';

const silent = pino({ level: 'silent' });

function setup(resolveOAuth: () => OAuthCheckResult) {
  const home = mkdtempSync(join(tmpdir(), 'patch-oauth-'));
  const folder = mkdtempSync(join(tmpdir(), 'patch-oauth-folder-'));
  mkdirSync(folder, { recursive: true });
  const sdk = createMockSdkBackend();
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: sdk,
    resolveOAuth,
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, sdk, events, folder };
}

describe('C1 OAuth gate', () => {
  it('OAuth missing → daemon.unauthenticated emitted and query refused (no SDK run)', async () => {
    const { daemon, sdk, events, folder } = setup(() => ({
      ok: false,
      reason: 'Claude OAuth not found at /x/.claude.json. Run `claude login`.',
    }));
    const chatId = await daemon.spawnChat({ folder, prompt: 'hello' });
    await new Promise((r) => setTimeout(r, 20));

    const unauth = events.find((e) => e.type === 'daemon.unauthenticated');
    expect(unauth).toBeDefined();
    expect(unauth && 'reason' in unauth && unauth.reason).toMatch(/claude login/i);

    // The SDK backend was never invoked — refused before query().
    expect(sdk.lastOptions()).toBeUndefined();

    // No assistant message ever flowed; chat is left idle (re-runnable once
    // `claude login` happens), not errored.
    const messages = events.filter((e) => e.type === 'chat.message');
    expect(messages).toHaveLength(0);
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
  });

  it('OAuth present → query runs and the resolved token reaches the SDK', async () => {
    const { daemon, sdk, events, folder } = setup(() => ({
      ok: true,
      accessToken: 'live-oauth-token',
    }));
    sdk.enqueue([{ type: 'assistant', content: 'ok', sessionId: 'S' }]);
    await daemon.spawnChat({ folder, prompt: 'hello' });
    await new Promise((r) => setTimeout(r, 20));

    expect(sdk.lastOptions()?.oauthAccessToken).toBe('live-oauth-token');
    expect(events.some((e) => e.type === 'daemon.unauthenticated')).toBe(false);
    // The turn ran: its user message and the reply, in that order.
    expect(
      events.filter((e) => e.type === 'chat.message').map((e) => (e as { role: string }).role),
    ).toEqual(['user', 'assistant']);
  });

  it('gate is re-checked on EVERY query — a credential expiring mid-life refuses the next turn', async () => {
    let valid = true;
    const { daemon, sdk, events, folder } = setup(() =>
      valid
        ? { ok: true, accessToken: 'tok' }
        : { ok: false, reason: 'token expired; re-run `claude login`' },
    );
    sdk.enqueue([{ type: 'assistant', content: 'first', sessionId: 'S' }]);
    const chatId = await daemon.spawnChat({ folder, prompt: 'hi' });
    await new Promise((r) => setTimeout(r, 20));
    expect(events.filter((e) => e.type === 'chat.message')).toHaveLength(2);

    // Credential expires before the next user turn.
    valid = false;
    events.length = 0;
    await daemon.sendInput({ chatId, message: 'again', localId: 'L2' });
    expect(events.some((e) => e.type === 'daemon.unauthenticated')).toBe(true);
    // A turn refused at the gate never reaches the SDK, so it is never
    // persisted — and must therefore never consume a canonical seq either.
    expect(events.filter((e) => e.type === 'chat.message')).toHaveLength(0);
  });
});

// The exact message the real Claude Agent SDK throws when Anthropic refuses the
// credential the host handed it — captured from the live host log.
const REJECTED_MESSAGE =
  'Claude Code returned an error result: Failed to authenticate. API Error: 401 ' +
  '{"type":"error","error":{"type":"authentication_error","message":"OAuth access token is invalid."},"request_id":null}';

function setupBackend(runImpl: () => AsyncGenerator<SdkEnvelope>): {
  daemon: Daemon;
  events: WireEvent[];
  folder: string;
} {
  const home = mkdtempSync(join(tmpdir(), 'patch-oauth-rejected-'));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'patch-oauth-rejected-folder-')));
  mkdirSync(folder, { recursive: true });
  const events: WireEvent[] = [];
  let id = 0;
  const daemon = new Daemon({
    daemonId: 'd1',
    metaStore: createMetaStore(home),
    sdkBackend: { run: () => runImpl() },
    // The gate PASSES: the credential is present and not locally expired. Only
    // the API knows it is dead.
    oauthAccessToken: 'locally-valid-but-revoked',
    emit: (e) => events.push(e),
    logger: silent,
    now: () => 1_700_000_000_000,
    generateChatId: () => `chat-${++id}`,
  });
  return { daemon, events, folder };
}

function errorEntries(events: WireEvent[]): { code: string; message: string }[] {
  return events
    .filter((e) => e.type === 'chat.error')
    .map((e) => (e as { error: { code: string; message: string } }).error);
}

// A credential the pre-query gate accepts but the API rejects mid-turn is
// handled identically to a missing one (spec/10 § Backend credentials) — not as
// a generic SDK fault with the raw API JSON as its message.
describe('C1 credential rejected by the API', () => {
  it('thrown 401 authentication_error → daemon.unauthenticated, human chat.error, chat left idle', async () => {
    const { daemon, events, folder } = setupBackend(async function* () {
      throw new Error(REJECTED_MESSAGE);
    });
    const chatId = await daemon.spawnChat({ folder, prompt: 'hello' });
    await new Promise((r) => setTimeout(r, 20));

    // Settings / the disconnected banner learn this host has no usable Claude
    // credential — without this the app claims to be connected and every turn
    // dies silently.
    const unauth = events.find((e) => e.type === 'daemon.unauthenticated');
    expect(unauth).toMatchObject({ daemonId: 'd1', backendId: CLAUDE_BACKEND_ID });

    const errors = errorEntries(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe('claude_oauth_missing');
    // The raw API JSON is log-only: not something a person can act on.
    expect(errors[0]!.message).not.toContain('{"type":"error"');
    expect(errors[0]!.message).not.toContain('401');
    expect(errors[0]!.message).toMatch(/sign in/i);

    // The turn never ran, so the chat is re-runnable the moment the credential
    // is replaced — not errored (which would also inflate doctor's count).
    expect(daemon.chatState.get(chatId)?.activity).toBe('idle');
    expect(daemon.chatState.get(chatId)?.status).not.toBe('errored');
  });

  it('401 authentication_error arriving as an error ENVELOPE is classified the same way', async () => {
    const { daemon, events, folder } = setupBackend(async function* () {
      yield { type: 'error' as const, errorMessage: REJECTED_MESSAGE };
    });
    await daemon.spawnChat({ folder, prompt: 'hello' });
    await new Promise((r) => setTimeout(r, 20));

    expect(events.find((e) => e.type === 'daemon.unauthenticated')).toMatchObject({
      daemonId: 'd1',
      backendId: CLAUDE_BACKEND_ID,
    });
    const errors = errorEntries(events);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.code).toBe('claude_oauth_missing');
    expect(errors[0]!.message).not.toContain('{"type":"error"');
  });

  it('an ordinary SDK failure is still a generic sdk_error and still errors the chat', async () => {
    const { daemon, events, folder } = setupBackend(async function* () {
      throw new Error('model overloaded');
    });
    const chatId = await daemon.spawnChat({ folder, prompt: 'hello' });
    await new Promise((r) => setTimeout(r, 20));

    expect(events.some((e) => e.type === 'daemon.unauthenticated')).toBe(false);
    expect(errorEntries(events)[0]).toMatchObject({
      code: 'sdk_error',
      message: 'model overloaded',
    });
    expect(daemon.chatState.get(chatId)?.activity).toBe('errored');
  });

  it('a 401 from the agent\u2019s own tool call is NOT read as our credential failing', async () => {
    const { daemon, events, folder } = setupBackend(async function* () {
      throw new Error('Bash failed: curl https://example.com/api returned API Error: 401');
    });
    await daemon.spawnChat({ folder, prompt: 'hello' });
    await new Promise((r) => setTimeout(r, 20));

    expect(events.some((e) => e.type === 'daemon.unauthenticated')).toBe(false);
    expect(errorEntries(events)[0]!.code).toBe('sdk_error');
  });

  it('a stale Claude session is still claude_session_invalid, not a credential problem', async () => {
    const { daemon, events, folder } = setupBackend(async function* () {
      throw new Error(
        'Claude Code returned an error result: No conversation found with session ID: d78511b4-8260-4251-8b5e-8c26d28c3ec5',
      );
    });
    await daemon.spawnChat({ folder, prompt: 'hello' });
    await new Promise((r) => setTimeout(r, 20));

    expect(events.some((e) => e.type === 'daemon.unauthenticated')).toBe(false);
    expect(errorEntries(events)[0]!.code).toBe('claude_session_invalid');
  });
});

describe('C1 ANTHROPIC_API_KEY stripping (real SDK backend)', () => {
  it('strips ANTHROPIC_API_KEY from the env passed to query() and sets the OAuth token', async () => {
    // Stand up a fake SDK module so the real backend can be exercised without
    // the multi-MB native install. The fake captures the options it's handed.
    let captured: { env?: Record<string, string | undefined> } | undefined;
    vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
      query: (args: { options: { env: Record<string, string | undefined> } }) => {
        captured = { env: args.options.env };
        return (async function* () {
          yield { type: 'result', session_id: 'sess-real' };
        })();
      },
    }));
    // Pollute the process env to prove it gets stripped.
    process.env['ANTHROPIC_API_KEY'] = 'sk-should-be-removed';
    try {
      const { createRealSdkBackend } = await import('../src/sdkBackend.js');
      const backend = createRealSdkBackend();
      const ac = new AbortController();
      const out: unknown[] = [];
      for await (const ev of backend.run({
        prompt: 'hi',
        cwd: '/tmp',
        abortController: ac,
        oauthAccessToken: 'oauth-tok',
      })) {
        out.push(ev);
      }
      expect(captured?.env).toBeDefined();
      expect(captured!.env!['ANTHROPIC_API_KEY']).toBeUndefined();
      expect(captured!.env!['CLAUDE_CODE_OAUTH_TOKEN']).toBe('oauth-tok');
    } finally {
      delete process.env['ANTHROPIC_API_KEY'];
      vi.doUnmock('@anthropic-ai/claude-agent-sdk');
    }
  });
});

// makeResolveOAuth: the gate is a no-op under the mock backend so the test
// stack / local-dev can run agent turns without a real `claude login`.
describe('C1 makeResolveOAuth — backend-aware gate', () => {
  /**
   * Loader options describing ONLY the fixture's machine. `env: {}` and a
   * non-darwin platform shut out the env token and the Keychain, but patch's own
   * store outranks every legacy source and defaults to `~/.patch/claude-oauth.json`
   * in the REAL home — so on a host that has connected an account through patch
   * (every host, this box included) these cases resolved the operator's
   * live token: "a missing credential refuses" came back ok, and the token
   * assertions came back a real `sk-ant-oat01-…`. `storePath` inside the
   * fixture's own dir makes the store absent, as these cases intend.
   */
  const loadOptions = (dir: string): LoadClaudeOAuthOptions => ({
    env: {},
    platform: 'linux' as NodeJS.Platform,
    storePath: join(dir, 'claude-oauth.json'),
  });

  it('mock backend returns ok WITHOUT reading ~/.claude.json (no real-credential precondition)', async () => {
    const { makeResolveOAuth } = await import('../src/registration.js');
    // Point claudeCredentialsPath at a path that does NOT exist — proving the
    // mock path never touches it.
    const resolve = makeResolveOAuth({
      sdkBackend: 'mock',
      claudeCredentialsPath: '/no/such/.credentials.json',
    });
    const res = await resolve();
    expect(res.ok).toBe(true);
    expect(res.ok && res.accessToken).toBe('mock-oauth-token');
  });

  it('real backend still enforces the gate — a missing credential refuses', async () => {
    const { makeResolveOAuth } = await import('../src/registration.js');
    // Force a deterministic miss regardless of the host: no env token, a
    // non-existent credentials file, and a non-darwin platform so the Keychain
    // branch (which on a dev Mac DOES hold a real token) is never consulted.
    const resolve = makeResolveOAuth({
      sdkBackend: 'real',
      claudeCredentialsPath: '/no/such/.credentials.json',
      loadOptions: loadOptions(mkdtempSync(join(tmpdir(), 'oauth-gate-miss-'))),
    });
    const res = await resolve();
    expect(res.ok).toBe(false);
    expect(!res.ok && res.reason).toMatch(/claude login/i);
  });

  // KNOWN HOST DEFECT regression: a real-backend credential that is expired
  // (or within the refresh skew) and carries a refresh token must be
  // self-refreshed BEFORE the token is handed to the SDK — not 401 every query.
  it('real backend self-refreshes a stale credential and returns the rotated access token', async () => {
    const { writeFileSync, mkdtempSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { makeResolveOAuth } = await import('../src/registration.js');

    const dir = mkdtempSync(join(tmpdir(), 'oauth-gate-refresh-'));
    const file = join(dir, '.credentials.json');
    // expiresAt in the past → stale.
    writeFileSync(
      file,
      JSON.stringify({
        claudeAiOauth: { accessToken: 'stale-acc', refreshToken: 'ref-1', expiresAt: 1 },
      }),
    );

    let refreshCalled = false;
    const fakeFetch = (async () => {
      refreshCalled = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'fresh-acc',
          refresh_token: 'ref-2',
          expires_in: 3600,
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const resolve = makeResolveOAuth({
      sdkBackend: 'real',
      claudeCredentialsPath: file,
      loadOptions: loadOptions(dir),
      refreshOptions: { fetchImpl: fakeFetch },
    });
    const res = await resolve();
    expect(refreshCalled).toBe(true);
    expect(res.ok).toBe(true);
    expect(res.ok && res.accessToken).toBe('fresh-acc');
    // Rotated credential was written back to the same file.
    const persisted = JSON.parse(readFileSync(file, 'utf8'));
    expect(persisted.claudeAiOauth.accessToken).toBe('fresh-acc');
    expect(persisted.claudeAiOauth.refreshToken).toBe('ref-2');
  });

  it('real backend does NOT refresh a credential that is comfortably fresh', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { makeResolveOAuth } = await import('../src/registration.js');

    const dir = mkdtempSync(join(tmpdir(), 'oauth-gate-fresh-'));
    const file = join(dir, '.credentials.json');
    writeFileSync(
      file,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'good-acc',
          refreshToken: 'ref-1',
          expiresAt: Date.now() + 60 * 60_000,
        },
      }),
    );
    let refreshCalled = false;
    const fakeFetch = (async () => {
      refreshCalled = true;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    const resolve = makeResolveOAuth({
      sdkBackend: 'real',
      claudeCredentialsPath: file,
      loadOptions: loadOptions(dir),
      refreshOptions: { fetchImpl: fakeFetch },
    });
    const res = await resolve();
    expect(refreshCalled).toBe(false);
    expect(res.ok && res.accessToken).toBe('good-acc');
  });
});

// Sanity: the host refuses construction if neither OAuth source is given.
describe('C1 OAuth construction guard', () => {
  it('throws when neither resolveOAuth nor oauthAccessToken is supplied', () => {
    const home = mkdtempSync(join(tmpdir(), 'patch-oauth-guard-'));
    expect(
      () =>
        new Daemon({
          daemonId: 'd1',
          metaStore: createMetaStore(home),
          sdkBackend: createMockSdkBackend(),
          emit: () => undefined,
          logger: silent,
        }),
    ).toThrow(/resolveOAuth \/ oauthAccessToken/);
  });
});
