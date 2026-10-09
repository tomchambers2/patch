// spec/04 § History — the one client-safe copy of the `openai/` prefix
// check, so a surface's model picker can tell a same-provider model change
// from a cross-provider one without depending on @patch/daemon.

import { describe, it, expect } from 'vitest';
import { harnessForModel } from '../src/events.js';

describe('harnessForModel', () => {
  it('treats an openai/-prefixed model as codex', () => {
    expect(harnessForModel('openai/gpt-5-codex')).toBe('codex');
  });

  it('treats anything else as claude', () => {
    expect(harnessForModel('claude-opus-5')).toBe('claude');
    expect(harnessForModel('claude-sonnet-5')).toBe('claude');
  });

  it('treats null/undefined as claude — no model yet is not a codex chat', () => {
    expect(harnessForModel(null)).toBe('claude');
    expect(harnessForModel(undefined)).toBe('claude');
  });
});
