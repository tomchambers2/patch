// spec/14 § "Thinking…" indicator — all three dots share one beat, pulsing
// together rather than travelling in sequence, and the pulse is opacity alone.
//
// The stagger it replaces was three lines of `animation-delay` plus a
// `translateY` hop in the keyframes; any one of them coming back re-creates
// the travelling wave (or, with the dots in phase, a whole-row jump). None of
// that is visible to a DOM test — jsdom computes no animation — and an e2e
// screenshot of a loop can't tell "in sync" from "caught mid-cycle", so the
// wiring is locked here against the source of index.css.
//
// Asserts on the raw source rather than a brace-parsing helper, for the reasons
// scrollbarStyles.test.ts documents (nested @media blocks mis-parse).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

function rule(selector: string): string {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`);
  const found = css.match(re);
  expect(found).not.toBeNull();
  return found![0];
}

describe('"Thinking…" typing indicator', () => {
  it('gives every dot the same animation, with no per-child delay', () => {
    expect(rule('.thinking-dots span')).toContain('animation: thinking-blink');

    // The stagger: a delay on either of the trailing dots puts them on their
    // own beat, which is the travelling wave back again.
    expect(css).not.toMatch(/\.thinking-dots span:nth-child\([23]\)/);
    expect(rule('.thinking-dots span')).not.toContain('animation-delay');
  });

  it('pulses opacity only — no vertical hop for the row to jump on', () => {
    const keyframes = css.match(/@keyframes thinking-blink\s*\{[\s\S]*?\n\}/);
    expect(keyframes).not.toBeNull();
    expect(keyframes![0]).not.toContain('translate');
    expect(keyframes![0]).toContain('opacity');
  });

  it('pulses between the dots’ resting opacity and full', () => {
    expect(rule('.thinking-dots span')).toContain('opacity: 0.35;');
    const keyframes = css.match(/@keyframes thinking-blink\s*\{[\s\S]*?\n\}/)![0];
    expect(keyframes).toContain('opacity: 0.35;');
    expect(keyframes).toContain('opacity: 1;');
  });

  it('eases the pulse rather than stepping it, so the blink is smooth', () => {
    expect(rule('.thinking-dots span')).toContain('ease-in-out');
  });
});
