// spec/06 § Sweep — the sweep's one decision call. Guards the pure parser
// (raw model reply → SweepDecision[] | null) and the SDK-backed wrapper.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { parseSweepDecisions, makeSweepDecider } from '../src/managerSweepGen.js';
import type { RunOnAccountWithCredit } from '../src/accountFailover.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import type { OAuthCheckResult } from '../src/chatRunner.js';

const silent = pino({ level: 'silent' });

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

describe('parseSweepDecisions', () => {
  it('parses a plain JSON object', () => {
    const out = parseSweepDecisions(
      '{"decisions": [{"chatId": "c1", "action": "nudge", "message": "carry on"}]}',
    );
    expect(out).toEqual([{ chatId: 'c1', action: 'nudge', message: 'carry on' }]);
  });

  it('tolerates a fenced code block', () => {
    const out = parseSweepDecisions(
      '```json\n{"decisions": [{"chatId": "c1", "action": "leave"}]}\n```',
    );
    expect(out).toEqual([{ chatId: 'c1', action: 'leave' }]);
  });

  it('parses a flag decision with flagText', () => {
    const out = parseSweepDecisions(
      '{"decisions": [{"chatId": "c1", "action": "flag", "flagText": "needs a human call"}]}',
    );
    expect(out).toEqual([{ chatId: 'c1', action: 'flag', flagText: 'needs a human call' }]);
  });

  it('returns null for invalid JSON', () => {
    expect(parseSweepDecisions('not json at all')).toBeNull();
  });

  it('returns null when decisions is missing', () => {
    expect(parseSweepDecisions('{"foo": []}')).toBeNull();
  });

  it('returns null when an action is not recognised', () => {
    expect(
      parseSweepDecisions('{"decisions": [{"chatId": "c1", "action": "approve"}]}'),
    ).toBeNull();
  });

  it('returns null when a decision is missing chatId', () => {
    expect(parseSweepDecisions('{"decisions": [{"action": "leave"}]}')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseSweepDecisions('')).toBeNull();
    expect(parseSweepDecisions('   ')).toBeNull();
  });
});

describe('makeSweepDecider', () => {
  const okOAuth = (): OAuthCheckResult => ({ ok: true, accessToken: 'tok-123' });
  const baseInput = {
    digest: '1 chat changed:\n\n- c1 — stalled',
    prompt: 'decide',
    model: 'claude-sonnet-5',
  };

  it('parses the final assistant message and reports a token estimate', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      {
        type: 'assistant',
        content: '{"decisions": [{"chatId": "c1", "action": "wake", "message": "still there?"}]}',
      },
      { type: 'result', sessionId: 'sess-1' },
    ]);
    const decide = makeSweepDecider({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    const out = await decide(baseInput);
    expect(out?.decisions).toEqual([{ chatId: 'c1', action: 'wake', message: 'still there?' }]);
    expect(out?.tokensUsed).toBeGreaterThan(0);
    const opts = sdk.lastOptions();
    expect(opts?.model).toBe(baseInput.model);
    expect(opts?.permissionMode).toBe('bypassPermissions');
    expect(opts?.oauthAccessToken).toBe('tok-123');
    expect(opts?.prompt).toContain(baseInput.prompt);
    expect(opts?.prompt).toContain(baseInput.digest);
  });

  it('returns null when OAuth is unavailable (no SDK call)', async () => {
    const sdk = createMockSdkBackend();
    const runSpy = vi.spyOn(sdk, 'run');
    const decide = makeSweepDecider({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith((): OAuthCheckResult => ({ ok: false, reason: 'no-oauth' })),
      logger: silent,
    });
    expect(await decide(baseInput)).toBeNull();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('returns null when the reply is unparseable', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: 'sure, nudging chat c1' },
      { type: 'result', sessionId: 'sess-2' },
    ]);
    const decide = makeSweepDecider({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    expect(await decide(baseInput)).toBeNull();
  });

  it('rejects with the SDK error envelope rather than reporting an empty answer', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([{ type: 'error', errorMessage: 'model overloaded' }]);
    const decide = makeSweepDecider({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    await expect(decide(baseInput)).rejects.toThrow('model overloaded');
  });
});
