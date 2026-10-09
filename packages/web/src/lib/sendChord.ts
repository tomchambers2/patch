// Which keys send, written for the keyboard that will press them
// (spec/14 § Main chat panel — Question prompts).
//
// The question card's `Other` box maps Enter the opposite way round to every
// other field in the app: `↵` and `⇧↵` put in a newline and only `⌘↵` / `Ctrl↵`
// sends. Nothing on screen said so, so a long answer was typed into a box whose
// send key had to be guessed. The Send answer button states the chord — which
// means the chord has to be the right one for the keyboard, not merely one of
// the two.
//
// This module answers only WHICH KEYBOARD is attached. Turning a chord into the
// glyphs or words that keyboard uses is `lib/shortcuts.ts`'s `shortcutLabel`,
// which every control in the app goes through.
//
// The platform read is deliberately the BROWSER'S. A host's reported
// `platform` is the machine the agent runs on, and it is routinely a different
// machine from the one being typed on — reading it prints `⌘` to a Windows user
// whose agent happens to live on a Mac, naming a key that keyboard does not
// have.

/** The parts of `navigator` that say what keyboard is attached. */
export interface KeyboardPlatformProbe {
  userAgentData?: { platform?: string } | undefined;
  platform?: string | undefined;
  userAgent?: string | undefined;
}

function currentProbe(): KeyboardPlatformProbe | null {
  return typeof navigator === 'undefined' ? null : (navigator as KeyboardPlatformProbe);
}

/**
 * Is the keyboard at this surface a Mac one?
 *
 * The first of the three signals that says anything decides, most specific
 * first: `userAgentData.platform` is the one browsers still populate honestly,
 * `navigator.platform` the long-standing one, and the UA string the last
 * resort. NO FALLBACK in the silent sense — a probe that says nothing at all is
 * not a Mac, deterministically, so the button can always name a real key
 * instead of drawing an empty or hedged chord.
 */
export function isMacKeyboard(probe: KeyboardPlatformProbe | null = currentProbe()): boolean {
  if (!probe) return false;
  const uaData = probe.userAgentData?.platform;
  if (typeof uaData === 'string' && uaData.length > 0) return /mac/i.test(uaData);
  const platform = probe.platform;
  if (typeof platform === 'string' && platform.length > 0) return /mac/i.test(platform);
  const ua = probe.userAgent;
  if (typeof ua === 'string' && ua.length > 0) return /mac os x|macintosh/i.test(ua);
  return false;
}

/**
 * The same chord in words, for the accessible name. `⌘↵` read out as glyphs is
 * noise, so the button is named in the keys' own words instead.
 */
export function sendChordSpoken(probe: KeyboardPlatformProbe | null = currentProbe()): string {
  return isMacKeyboard(probe) ? 'Command-Enter' : 'Control-Enter';
}
