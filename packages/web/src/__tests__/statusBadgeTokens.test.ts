// spec/14 § Status badges — `permission` ("waiting on you") carries its own hue,
// distinct from the `working` orange and the `done` green. The painted result is
// proven in a real browser (e2e/status-badge-color.spec.ts); what CAN'T be seen
// there is a token defined in only SOME of the three theme blocks — a miss shows
// up only for users on the theme that lost it, and light-mode e2e would stay
// green throughout. So the wiring is locked here against the source of index.css.
//
// Asserts on the raw source rather than a brace-parsing helper, for the reasons
// scrollbarStyles.test.ts documents (nested @media blocks mis-parse).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

// The palette is declared three times: `:root` (light), the explicit dark block,
// and the `prefers-color-scheme: dark` block. Every state colour must appear in
// all three or a theme ships without it.
const THEME_BLOCKS = 3;

// Every declared value of one custom property, lowercased, without the `#`.
// The trailing colon in the pattern keeps `--waiting` from also matching
// `--waiting-tint` (and likewise for `--permission`).
function tokenValues(token: string): string[] {
  const re = new RegExp(`--${token}:\\s*#([0-9a-f]{6});`, 'gi');
  return [...css.matchAll(re)].flatMap((m) => (m[1] === undefined ? [] : [m[1].toLowerCase()]));
}

describe('permission status token', () => {
  it('is defined in all three theme blocks', () => {
    expect(tokenValues('permission')).toHaveLength(THEME_BLOCKS);
  });

  it('has a tint counterpart in all three theme blocks', () => {
    expect(tokenValues('permission-tint')).toHaveLength(THEME_BLOCKS);
  });

  // The whole point of the change: if this ever resolves to the same value as
  // --waiting, the two states are indistinguishable again and the e2e colour
  // assertion is the only thing left standing between us and a silent regression.
  it('never shares a value with --waiting in any theme', () => {
    const permission = tokenValues('permission');
    const waiting = tokenValues('waiting');
    expect(permission).toHaveLength(THEME_BLOCKS);
    expect(waiting).toHaveLength(THEME_BLOCKS);
    for (const value of permission) {
      expect(waiting).not.toContain(value);
    }
  });

  it('is a cool hue — blue-dominant, so it cannot be confused with the warm palette', () => {
    const permission = tokenValues('permission');
    expect(permission).toHaveLength(THEME_BLOCKS);
    for (const hex of permission) {
      const r = parseInt(hex.slice(0, 2), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      expect(b).toBeGreaterThan(r);
    }
  });
});

describe('permission-coloured surfaces', () => {
  it('the sidebar badge paints the permission token, dot and outer ring alike', () => {
    const badge = css.match(/\.badge\.badge-permission\s*\{[\s\S]*?\n\}/);
    expect(badge).not.toBeNull();
    expect(badge![0]).toContain('background: var(--permission);');
    // The outer ring too — a half-done change leaves an orange ring round an
    // indigo dot, which reads as a rendering bug rather than a state.
    expect(badge![0]).toContain('0 0 0 5px var(--permission);');
    expect(badge![0]).not.toContain('var(--waiting)');
  });

  // The chat header's pill is the SAME state as the sidebar dot. Left on
  // --waiting it would give one state two different colours across two surfaces.
  it('the chat-header waiting-on-you pill uses the permission token, not --waiting', () => {
    const pill = css.match(/\.waiting-pill\s*\{[^}]*\}/);
    expect(pill).not.toBeNull();
    expect(pill![0]).toContain('background: var(--permission-tint);');
    expect(pill![0]).toContain('color: var(--permission);');
    expect(pill![0]).not.toContain('--waiting');
  });

  // `working` is the state `permission` is being distinguished FROM — it must
  // stay on the orange, or the change cancels itself out.
  it('leaves the working badge on --waiting', () => {
    const working = css.match(/\.badge\.badge-working\s*\{[\s\S]*?\n\}/);
    expect(working).not.toBeNull();
    expect(working![0]).toContain('background: var(--waiting);');
    expect(working![0]).not.toContain('--permission');
  });
});
