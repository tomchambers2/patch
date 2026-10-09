// spec/14 § Main chat panel — Question prompts, § Discoverability.
//
// Tom, App Updates: "patch show CMD + enter (or windows version) on the answer
// question button, since enter is newline". The chord the card advertises has to
// be the one the KEYBOARD has, so both branches are pinned here — and so is the
// rule that an unreadable probe resolves to the PC naming rather than to
// nothing. `shortcutLabel` is the one renderer every control goes through
// (lib/shortcuts.ts); this file pins the platform read it hangs off.

import { describe, it, expect } from 'vitest';
import { isMacKeyboard, sendChordSpoken, type KeyboardPlatformProbe } from '../lib/sendChord.js';
import { shortcutLabel } from '../lib/shortcuts.js';

/** The send chord as a control draws it, for a given keyboard. */
const sendChordLabel = (probe: KeyboardPlatformProbe | null): string => shortcutLabel('⌘↵', probe);

const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const WIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

describe('sendChord', () => {
  it('reads a Mac from userAgentData first', () => {
    const probe: KeyboardPlatformProbe = {
      userAgentData: { platform: 'macOS' },
      platform: 'Win32',
      userAgent: WIN_UA,
    };
    expect(isMacKeyboard(probe)).toBe(true);
    expect(sendChordLabel(probe)).toBe('⌘↵');
    expect(sendChordSpoken(probe)).toBe('Command-Enter');
  });

  it('reads Windows from userAgentData first', () => {
    // The inverse: the modern signal wins over the legacy ones either way, so a
    // frozen/spoofed `navigator.platform` cannot promise a ⌘ key.
    const probe: KeyboardPlatformProbe = {
      userAgentData: { platform: 'Windows' },
      platform: 'MacIntel',
      userAgent: MAC_UA,
    };
    expect(isMacKeyboard(probe)).toBe(false);
    expect(sendChordLabel(probe)).toBe('Ctrl+Enter');
    expect(sendChordSpoken(probe)).toBe('Control-Enter');
  });

  it('falls back through navigator.platform where userAgentData is absent', () => {
    expect(sendChordLabel({ platform: 'MacIntel', userAgent: MAC_UA })).toBe('⌘↵');
    expect(sendChordLabel({ platform: 'Win32', userAgent: WIN_UA })).toBe('Ctrl+Enter');
    expect(sendChordLabel({ platform: 'Linux x86_64', userAgent: WIN_UA })).toBe('Ctrl+Enter');
  });

  it('reads the user-agent string where nothing else is populated', () => {
    expect(sendChordLabel({ userAgent: MAC_UA })).toBe('⌘↵');
    expect(sendChordLabel({ userAgent: WIN_UA })).toBe('Ctrl+Enter');
  });

  it('ignores an empty signal rather than deciding on it', () => {
    // An empty `userAgentData.platform` is not "not a Mac" — it is silence, and
    // stopping there would print Ctrl+Enter to a Mac with a perfectly good UA.
    expect(sendChordLabel({ userAgentData: { platform: '' }, platform: 'MacIntel' })).toBe('⌘↵');
    expect(sendChordLabel({ platform: '', userAgent: MAC_UA })).toBe('⌘↵');
  });

  it('names a real key when nothing can be told, rather than nothing', () => {
    for (const probe of [null, {}, { userAgentData: {} }] as (KeyboardPlatformProbe | null)[]) {
      expect(isMacKeyboard(probe)).toBe(false);
      expect(sendChordLabel(probe)).toBe('Ctrl+Enter');
      expect(sendChordSpoken(probe)).toBe('Control-Enter');
    }
  });
});
