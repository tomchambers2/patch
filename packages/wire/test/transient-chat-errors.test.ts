import { describe, it, expect } from 'vitest';
import { ChatErrorCode, TRANSIENT_CHAT_ERROR_CODES, isTransientChatError } from '../src/index.js';

// spec/04 § Activity — `daemon_unavailable` is the server's own notice that the
// host↔server link dropped mid-turn. It describes a passing condition of the
// link, not the outcome of a turn, and it resolves on its own when the host
// comes back and the turn resumes. Every OTHER code records a turn that really
// failed and must survive in the transcript until the user acts on it (spec/12
// § No fallbacks). This file is the lock on that distinction: a code added here
// by accident is a failure silently erased from every surface.
describe('transient chat error codes', () => {
  it('is exactly daemon_unavailable — nothing else self-clears', () => {
    expect([...TRANSIENT_CHAT_ERROR_CODES]).toEqual(['daemon_unavailable']);
  });

  it('every transient code is a real ChatErrorCode', () => {
    for (const code of TRANSIENT_CHAT_ERROR_CODES) {
      expect(ChatErrorCode.safeParse(code).success).toBe(true);
    }
  });

  it('isTransientChatError says yes to daemon_unavailable and no to real turn failures', () => {
    expect(isTransientChatError('daemon_unavailable')).toBe(true);
    for (const code of [
      'sdk_error',
      'claude_oauth_missing',
      'claude_session_missing',
      'claude_session_invalid',
      'folder_not_found',
      'permission_mode_downgraded',
    ]) {
      expect(isTransientChatError(code)).toBe(false);
    }
  });

  it('isTransientChatError says no to an absent or unrecognised code', () => {
    // An `error` timeline entry from an older surface may carry no code at all,
    // and an unknown code is a failure this build does not understand — neither
    // is licence to delete the entry.
    expect(isTransientChatError(undefined)).toBe(false);
    expect(isTransientChatError('something_from_the_future')).toBe(false);
  });

  // spec/02 § Permission mode's plan-mode exception — `permission_mode_downgraded`
  // is unaffected by the exception: it stays a real, durable turn failure for
  // every downgrade target except `plan`. `plan` is not carved out of this set
  // as a "sometimes transient" code — it never produces this code at all
  // (chatRunner.ts records it as an ordinary mode-change instead), so the
  // failure this code names is always genuine wherever it appears.
  it('permission_mode_downgraded stays a durable error code — the plan exception means it is never RAISED for `plan`, not that it self-clears', () => {
    expect(isTransientChatError('permission_mode_downgraded')).toBe(false);
    expect(TRANSIENT_CHAT_ERROR_CODES).not.toContain('permission_mode_downgraded');
  });
});
