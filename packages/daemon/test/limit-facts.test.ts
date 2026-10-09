// The provider states its limit in STRUCTURED form; Patch used to re-read it out
// of the sentence. `limitFactsOf` pulls the fields, and `TurnFailedError`
// carries them through the error boundary where they were previously dropped.
//
// The fixture is a real message, copied from
// ~/.claude/projects/<folder>/b7f4684a-….jsonl — the 7 Sep app-update run that
// died on a spend limit and left its Todoist task untouched for four days.

import { describe, it, expect } from 'vitest';
import { limitFactsOf } from '../src/sdkBackend.js';

/** The shape Claude Code actually emits, trimmed to the fields that matter. */
const SPEND_LIMIT_MESSAGE = {
  type: 'assistant',
  message: {
    model: '<synthetic>',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: "You've hit your monthly spend limit · raise it at claude.ai/settings/usage · your session limit resets 6pm (UTC)",
      },
    ],
    usage: { input_tokens: 0, output_tokens: 0 },
  },
  quotaLimits: {
    status: 'rejected',
    resetsAt: 1788804000,
    unifiedRateLimitFallbackAvailable: false,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
  },
  error: 'rate_limit',
  isApiErrorMessage: true,
  apiErrorStatus: 429,
  session_id: 'b7f4684a-84b7-4b45-a91a-31322dbba45c',
};

describe('limitFactsOf', () => {
  it('reads the limit off the message instead of out of its prose', () => {
    expect(limitFactsOf(SPEND_LIMIT_MESSAGE)).toEqual({
      kind: 'rate_limit',
      status: 'rejected',
      rateLimitType: 'five_hour',
      // 1788804000s = 2026-09-07T18:00Z — the "6pm (UTC)" the text states,
      // exact and needing no interpretation.
      resetsAt: 1788804000_000,
    });
  });

  it('normalises seconds to the milliseconds everything else uses', () => {
    // Getting this wrong parks the turn either in the year 58000 or instantly,
    // and both look like the retry ladder being broken.
    const secs = limitFactsOf({ quotaLimits: { resetsAt: 1788804000 } })?.resetsAt;
    const ms = limitFactsOf({ quotaLimits: { resetsAt: 1788804000_000 } })?.resetsAt;
    expect(secs).toBe(1788804000_000);
    expect(ms).toBe(1788804000_000);
  });

  it('says nothing rather than guessing when the message states no limit', () => {
    expect(limitFactsOf({ type: 'assistant', message: { content: [] } })).toBeUndefined();
    expect(limitFactsOf(null)).toBeUndefined();
    expect(limitFactsOf('a string')).toBeUndefined();
  });

  it('carries a typed error kind even with no quota block', () => {
    expect(limitFactsOf({ error: 'billing_error' })).toEqual({ kind: 'billing_error' });
  });

  it('ignores quota fields of the wrong type rather than passing junk on', () => {
    expect(limitFactsOf({ quotaLimits: { status: 7, resetsAt: 'soon' } })).toBeUndefined();
  });
});
