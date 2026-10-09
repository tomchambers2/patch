// Codex has no auto-compaction of its own for a freshly-injected thread
// (spec/04 § History — "rely on the harness's own compaction... if it errors,
// trim the OLDEST records until it fits and note the cut"). Claude Code
// compacts on its own; this is Codex's side of that rule.

import { describe, it, expect } from 'vitest';
import type { LoggedEvent } from '@patch/wire';
import { injectWithTrim, isContextOverflowError } from '../src/codexBackend.js';
import type { TrackEntry } from '../src/nativeReconstruct.js';

function track(n: number): TrackEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    record: { seq: i, at: i },
    event: {
      type: 'chat.message',
      chatId: 'c1',
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}`,
      seq: 0,
    } satisfies LoggedEvent,
  }));
}

describe('isContextOverflowError', () => {
  it('recognizes context/token-limit shaped messages', () => {
    expect(isContextOverflowError(new Error('context window exceeded'))).toBe(true);
    expect(isContextOverflowError(new Error('input exceeds the model context length'))).toBe(true);
    expect(isContextOverflowError(new Error('token limit reached'))).toBe(true);
    expect(isContextOverflowError(new Error('too many tokens in request'))).toBe(true);
  });

  it('does not misclassify an unrelated error', () => {
    expect(isContextOverflowError(new Error('thread not found'))).toBe(false);
    expect(isContextOverflowError(new Error('ECONNRESET'))).toBe(false);
  });
});

describe('injectWithTrim', () => {
  it('injects the whole track in one call when it fits', async () => {
    const calls: unknown[] = [];
    const trimmed = await injectWithTrim(track(4), async (items) => {
      calls.push(items);
    });
    expect(trimmed).toBe(0);
    expect(calls).toHaveLength(1);
    expect((calls[0] as unknown[]).length).toBe(4);
  });

  it('trims the OLDEST records and retries until the target accepts it', async () => {
    const calls: unknown[][] = [];
    const trimmed = await injectWithTrim(track(8), async (items) => {
      calls.push(items);
      // Rejects until only 2 of the original 8 track entries remain.
      if (items.length > 2) throw new Error('context window exceeded');
    });
    expect(trimmed).toBe(6);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[calls.length - 1]).toHaveLength(2);
    // The KEPT entries are the newest ones, not an arbitrary slice.
    const lastCallText = JSON.stringify(calls[calls.length - 1]);
    expect(lastCallText).toContain('message 6');
    expect(lastCallText).toContain('message 7');
    expect(lastCallText).not.toContain('message 0');
  });

  it('rethrows a non-overflow error without trimming anything', async () => {
    await expect(
      injectWithTrim(track(4), async () => {
        throw new Error('thread not found');
      }),
    ).rejects.toThrow('thread not found');
  });

  it('gives up and rethrows once trimming reaches a single entry that still overflows', async () => {
    await expect(
      injectWithTrim(track(3), async () => {
        throw new Error('context window exceeded');
      }),
    ).rejects.toThrow('context window exceeded');
  });

  it('does nothing for an empty track', async () => {
    let called = false;
    const trimmed = await injectWithTrim([], async () => {
      called = true;
    });
    expect(trimmed).toBe(0);
    expect(called).toBe(false);
  });
});
