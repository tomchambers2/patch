// toolsPrompt.ts: the built-in patch-tools guidance, and what a Settings save
// of it stores.

import { describe, it, expect } from 'vitest';
import { getPatchToolsPrompt, toolsPromptOverride } from '../src/toolsPrompt.js';

describe('getPatchToolsPrompt', () => {
  it("says what patch's tools are for, and nothing about any particular machine", () => {
    const prompt = getPatchToolsPrompt();
    expect(prompt).toContain('# Patch tools');
    expect(prompt).toContain('patch_artifact');
    // Host facts (headless, no browser, localhost goes nowhere) are the
    // machine's own instructions, which the user owns — not patch's.
    expect(prompt).not.toContain('localhost');
    expect(prompt).not.toContain('Headless');
  });
});

describe('toolsPromptOverride: what a Settings save stores', () => {
  it('null restores the built-in default', () => {
    expect(toolsPromptOverride(null)).toBeUndefined();
  });

  it("saving the default's own text stores nothing, so later guidance still arrives", () => {
    expect(toolsPromptOverride(getPatchToolsPrompt())).toBeUndefined();
  });

  it('an edit is kept, and so is an empty field (guidance turned off)', () => {
    expect(toolsPromptOverride('# Mine')).toBe('# Mine');
    expect(toolsPromptOverride('')).toBe('');
  });
});
