// spec/08 § Recurrence — the natural-language → RRULE translator. Mirrors
// titleGen.test.ts's structure: the sanitizer's own coverage, then the
// one-shot generator's behaviour given a credential (model/folder/token
// wiring, the UNSURE escape hatch, error propagation, OAuth failure, abort).

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import {
  sanitizeRecurrenceRule,
  makeRecurrenceTranslator,
  RECURRENCE_TRANSLATE_MODEL,
} from '../src/recurrenceTranslate.js';
import type { RunOnAccountWithCredit } from '../src/accountFailover.js';
import { createMockSdkBackend } from '../src/sdkBackend.js';
import type { OAuthCheckResult } from '../src/chatRunner.js';

const silent = pino({ level: 'silent' });

const baseInput = {
  requestId: 'req-1',
  phrase: 'every 3rd Sunday between May and August',
  folder: '/home/patch',
};

/** Same stand-in as titleGen.test.ts's `runWith` — see there for the rationale. */
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

describe('sanitizeRecurrenceRule', () => {
  it('passes a clean RRULE through unchanged', () => {
    expect(sanitizeRecurrenceRule('FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0')).toBe(
      'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0',
    );
  });

  it('strips a defensive leading RRULE: label', () => {
    expect(sanitizeRecurrenceRule('RRULE:FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0')).toBe(
      'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0',
    );
  });

  it('strips surrounding quotes/backticks', () => {
    expect(sanitizeRecurrenceRule('"FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0"')).toBe(
      'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0',
    );
  });

  it('takes only the first non-empty line of a multi-line reply', () => {
    expect(
      sanitizeRecurrenceRule('FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0\nThat should do it.'),
    ).toBe('FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0');
  });

  it('collapses internal whitespace the model sometimes adds around semicolons', () => {
    expect(sanitizeRecurrenceRule('FREQ=WEEKLY; BYDAY=SU; BYHOUR=9; BYMINUTE=0')).toBe(
      'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0',
    );
  });

  it('returns null for empty / whitespace-only input', () => {
    expect(sanitizeRecurrenceRule('')).toBeNull();
    expect(sanitizeRecurrenceRule('   ')).toBeNull();
  });
});

describe('makeRecurrenceTranslator', () => {
  const okOAuth = (): OAuthCheckResult => ({ ok: true, accessToken: 'tok-123' });

  it('uses the translate model, the daemon-home folder, OAuth token, and returns the sanitized rrule', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant_delta', content: 'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;' },
      { type: 'assistant_delta', content: 'BYMONTH=5,6,7,8;BYHOUR=9;BYMINUTE=0' },
      {
        type: 'assistant',
        content: 'FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;BYMONTH=5,6,7,8;BYHOUR=9;BYMINUTE=0',
      },
      { type: 'result', sessionId: 'sess-1' },
    ]);
    const translate = makeRecurrenceTranslator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    const rrule = await translate(baseInput);
    expect(rrule).toBe('FREQ=MONTHLY;BYDAY=SU;BYSETPOS=3;BYMONTH=5,6,7,8;BYHOUR=9;BYMINUTE=0');
    const opts = sdk.lastOptions();
    expect(opts?.model).toBe(RECURRENCE_TRANSLATE_MODEL);
    expect(opts?.permissionMode).toBe('bypassPermissions');
    expect(opts?.oauthAccessToken).toBe('tok-123');
    expect(opts?.cwd).toBe(baseInput.folder);
    expect(opts?.resumeSessionId).toBeUndefined();
    expect(opts?.prompt).toContain(baseInput.phrase);
  });

  it('falls back to assembled delta text when no final assistant message arrives', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant_delta', content: 'FREQ=WEEKLY;BYDAY=SU;' },
      { type: 'assistant_delta', content: 'BYHOUR=9;BYMINUTE=0' },
      { type: 'result', sessionId: 'sess-2' },
    ]);
    const translate = makeRecurrenceTranslator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    expect(await translate(baseInput)).toBe('FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0');
  });

  it("honours the model's own UNSURE — resolves to null, not a stripped-down guess", async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: 'UNSURE' },
      { type: 'result', sessionId: 'sess-3' },
    ]);
    const translate = makeRecurrenceTranslator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    expect(await translate({ ...baseInput, phrase: 'sometime, whenever' })).toBeNull();
  });

  it('treats UNSURE case-insensitively and with surrounding whitespace', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: '  unsure  ' },
      { type: 'result', sessionId: 'sess-3b' },
    ]);
    const translate = makeRecurrenceTranslator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    expect(await translate(baseInput)).toBeNull();
  });

  it('rejects with the SDK error envelope rather than reporting an empty answer', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant_delta', content: 'partial' },
      { type: 'error', errorMessage: 'model overloaded' },
    ]);
    const translate = makeRecurrenceTranslator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    await expect(translate(baseInput)).rejects.toThrow('model overloaded');
  });

  it('resolves to null (without calling the SDK) when OAuth resolution rejects', async () => {
    const sdk = createMockSdkBackend();
    const translate = makeRecurrenceTranslator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(() => {
        throw new Error('token store unavailable');
      }),
      logger: silent,
    });
    expect(await translate(baseInput)).toBeNull();
    expect(sdk.lastOptions()).toBeUndefined();
  });

  it('resolves to null when the OAuth gate reports not-ok', async () => {
    const sdk = createMockSdkBackend();
    const translate = makeRecurrenceTranslator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(() => ({ ok: false, reason: 'no-oauth-account' })),
      logger: silent,
    });
    expect(await translate(baseInput)).toBeNull();
    expect(sdk.lastOptions()).toBeUndefined();
  });

  it('resolves to null with no logger configured at all (optional-chaining paths)', async () => {
    const translate = makeRecurrenceTranslator({
      sdkBackend: createMockSdkBackend(),
      runOnAccountWithCredit: runWith(() => ({ ok: false, reason: 'no-oauth-account' })),
    });
    await expect(translate(baseInput)).resolves.toBeNull();
  });

  it('rejects when the SDK run throws', async () => {
    const throwingBackend = {
      async *run(): AsyncGenerator<never> {
        throw new Error('sdk exploded');
      },
    };
    const translate = makeRecurrenceTranslator({
      sdkBackend: throwingBackend,
      runOnAccountWithCredit: runWith(okOAuth),
      logger: silent,
    });
    await expect(translate(baseInput)).rejects.toThrow('sdk exploded');
  });

  it('asks the host for a credential and names no account — a translation has none of its own', async () => {
    const sdk = createMockSdkBackend();
    sdk.enqueue([
      { type: 'assistant', content: 'FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0' },
      { type: 'result', sessionId: 'sess-acct' },
    ]);
    const resolveOAuth = vi.fn((): OAuthCheckResult => ({ ok: true, accessToken: 'tok' }));
    const translate = makeRecurrenceTranslator({
      sdkBackend: sdk,
      runOnAccountWithCredit: runWith(resolveOAuth),
      logger: silent,
    });
    const rrule = await translate(baseInput);
    expect(rrule).toBe('FREQ=WEEKLY;BYDAY=SU;BYHOUR=9;BYMINUTE=0');
    expect(resolveOAuth).toHaveBeenCalledWith();
  });

  it('aborts the in-flight SDK call once the timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      const backend = {
        run(opts: { abortController: AbortController }): AsyncIterable<never> {
          return {
            [Symbol.asyncIterator]() {
              return {
                next: () =>
                  new Promise((resolve) => {
                    opts.abortController.signal.addEventListener('abort', () => {
                      resolve({ value: undefined, done: true });
                    });
                  }),
              };
            },
          };
        },
      };
      const translate = makeRecurrenceTranslator({
        sdkBackend: backend,
        runOnAccountWithCredit: runWith(okOAuth),
        logger: silent,
      });
      const promise = translate(baseInput);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await promise).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
