// I1: REAL Claude backend end-to-end (spec/10-auth.md "Claude OAuth —
// non-negotiable", spec/02-daemon.md "Session ID capture").
//
// This drives the GENUINE @anthropic-ai/claude-agent-sdk through the host's
// real backend against the host's `claude login` OAuth credential. NO MOCKS on
// this path. It proves the product's core claim — a coordination layer over
// Claude Code — actually works, not just the [mock] echo backend.
//
// Gating: OPT-IN. This spends real Claude tokens, so it runs only with
// `PATCH_REAL_CLAUDE=1` (see helpers/real-claude.ts) AND a resolvable, unexpired
// OAuth credential. It is never a false pass — when it runs, it asserts a real
// streamed completion; when it does not, it skips saying so.
//
// It used to run whenever a credential resolved, which put a paid dependency in
// the deploy gate. When the account hit its monthly spend limit this test began
// hard-failing and no deploy could ship at all — a billing state holding
// delivery hostage. A spend limit is not a product regression.
//
// Mocking this one is not an option: the assertion IS "a genuine completion, not
// a mock echo". A mocked version asserts nothing. So it is kept whole and run
// deliberately.

import { describe, expect, it } from 'vitest';
import { loadClaudeOAuth } from '@patch/auth';
import { createRealSdkBackend, type SdkEnvelope } from '../src/sdkBackend.js';
import { REAL_CLAUDE_SKIP_REASON, realClaudeEnabled } from './helpers/real-claude.js';

function resolveOAuthOrUndefined(): string | undefined {
  try {
    const cred = loadClaudeOAuth();
    // Also skip on an EXPIRED login. A resolvable-but-stale token (Date.now()
    // past expiresAt) would 401 at the API and turn this "skip if no working
    // login" gate into a HARD FAILURE — which is exactly what happened on a host
    // whose `claude login` had lapsed. An expired credential is, for this test's
    // purpose, the same as no login: skip, never a false pass.
    if (cred.expiresAt !== undefined && Date.now() >= cred.expiresAt) return undefined;
    return cred.accessToken;
  } catch {
    return undefined;
  }
}

const token = realClaudeEnabled() ? resolveOAuthOrUndefined() : undefined;
const maybe = token ? it : it.skip;

describe(`I1 real Claude backend (live OAuth)${realClaudeEnabled() ? '' : ` — SKIPPED, ${REAL_CLAUDE_SKIP_REASON}`}`, () => {
  maybe(
    'streams a genuine Claude completion (not a mock echo) and captures a session id',
    async () => {
      const backend = createRealSdkBackend();
      const ac = new AbortController();
      const events: SdkEnvelope[] = [];
      for await (const ev of backend.run({
        prompt: 'Reply with exactly the word PONG and nothing else. No punctuation.',
        cwd: '/tmp',
        abortController: ac,
        // The host resolves and passes the OAuth token; the SDK also reads its
        // own credential. We pass the resolved one to mirror the live path.
        oauthAccessToken: token!,
      })) {
        events.push(ev);
      }

      // A genuine assistant turn arrived.
      const assistantText = events
        .filter((e) => e.type === 'assistant')
        .map((e) => e.content ?? '')
        .join('');
      expect(assistantText).toMatch(/PONG/);
      // It is NOT the deterministic mock echo.
      expect(assistantText).not.toMatch(/\[mock\] echo:/);

      // spec/02 ## Streaming assistant text — the backend drives the SDK with
      // includePartialMessages, so the reply STREAMS in as assistant_delta
      // chunks ahead of the final assistant message (not a single dump). At
      // least one delta must have arrived, and the concatenated deltas must
      // be a prefix-consistent build-up of the final text.
      const deltaText = events
        .filter((e) => e.type === 'assistant_delta')
        .map((e) => e.content ?? '')
        .join('');
      expect(events.some((e) => e.type === 'assistant_delta')).toBe(true);
      expect(deltaText).toMatch(/PONG/);

      // The SDK emitted a real session id on the result envelope (spec/02
      // "Session ID capture") — a UUID, not a `mock-session-…` id.
      const result = events.find((e) => e.type === 'result');
      expect(result).toBeDefined();
      expect(typeof result!.sessionId).toBe('string');
      expect(result!.sessionId!.length).toBeGreaterThan(0);
      expect(result!.sessionId).not.toMatch(/^mock-session-/);
    },
    120_000,
  );
});
