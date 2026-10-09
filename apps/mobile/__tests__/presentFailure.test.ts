import { describe, it, expect } from 'vitest';
import { presentFailure, formatReset } from '../src/lib/usage';

describe('presentFailure', () => {
  it('drops the replay prefix and restates a limit reset in the local zone', () => {
    const now = Date.parse('2026-10-08T12:00:00Z');
    const at = Date.parse('2026-10-12T04:00:00Z');
    const out = presentFailure(
      'This turn failed: Usage limit reached on Work — the weekly window. It resets at 2026-10-12T04:00:00Z.',
      now,
    );
    expect(out).toBe(
      `Usage limit reached on Work — the weekly window. It resets at ${formatReset(at, now)}.`,
    );
  });
  it('leaves other failures in full', () => {
    expect(presentFailure('This turn failed: Codex process exited (0)')).toBe(
      'Codex process exited (0)',
    );
  });
});
