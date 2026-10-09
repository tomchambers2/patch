// spec/06 § Session rotation. Guards the SDK-backed digest generator: it must
// RESUME the outgoing session (not start fresh), use bypassPermissions, and
// resolve to null (never throw, never guess) on any failure.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { makeDigestGenerator } from '../src/rotationDigest.js';
import type { RunOnAccountWithCredit } from '../src/accountFailover.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import type { OAuthCheckResult } from '../src/chatRunner.js';

const silent = pino({ level: 'silent' });

const baseInput = {
  chatId: 'thread_manager',
  resumeSessionId: 'sess-outgoing-1',
  folder: '/home/tom/.patch/threads/manager',
};

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
    return await run(resolved.accessToken);
  };

describe('makeDigestGenerator', () => {
  const okOAuth = (): OAuthCheckResult => ({ ok: true, accessToken: 'tok-123' });

  it('resumes the outgoing session (not a fresh one) and returns its reply', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      {
        type: 'assistant',
        content: 'Tom is mid-way through a kitchen renovation; ping only for blockers.',
      },
      { type: 'result', sessionId: baseInput.resumeSessionId },
    ]);
    const gen = makeDigestGenerator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    const out = await gen(baseInput);
    expect(out).toBe('Tom is mid-way through a kitchen renovation; ping only for blockers.');
    const opts = sdk.lastOptions();
    expect(opts?.resumeSessionId).toBe(baseInput.resumeSessionId);
    expect(opts?.permissionMode).toBe('bypassPermissions');
    expect(opts?.oauthAccessToken).toBe('tok-123');
    expect(opts?.cwd).toBe(baseInput.folder);
  });

  it('falls back to assembled delta text when no final assistant message arrives', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant_delta', content: 'Nothing standing ' },
      { type: 'assistant_delta', content: 'open right now.' },
      { type: 'result', sessionId: baseInput.resumeSessionId },
    ]);
    const gen = makeDigestGenerator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    expect(await gen(baseInput)).toBe('Nothing standing open right now.');
  });

  it('returns null on an empty reply rather than an empty-string digest', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([{ type: 'result', sessionId: baseInput.resumeSessionId }]);
    const gen = makeDigestGenerator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    expect(await gen(baseInput)).toBeNull();
  });

  it('returns null when OAuth is unavailable (no SDK call)', async () => {
    const sdk = createMockSdkBackend();
    const runSpy = vi.spyOn(sdk, 'run');
    const gen = makeDigestGenerator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith((): OAuthCheckResult => ({ ok: false, reason: 'no-oauth' })),
      logger: silent,
    });
    expect(await gen(baseInput)).toBeNull();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('caps an unreasonably long digest rather than passing it through whole', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: 'x'.repeat(5000) },
      { type: 'result', sessionId: baseInput.resumeSessionId },
    ]);
    const gen = makeDigestGenerator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    const out = await gen(baseInput);
    expect(out?.length).toBeLessThanOrEqual(2000);
    expect(out?.endsWith('…')).toBe(true);
  });
});
