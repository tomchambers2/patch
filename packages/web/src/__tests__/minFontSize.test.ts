// spec/14 § Legibility — `--text-min` is the FLOOR for every UI string, and
// this is what makes that sentence enforced rather than aspirational.
//
// It was aspirational: the token existed, five rules used it, and 54 others
// undercut it (39x 12px, 10x 11px, 4x 12.5px, 1x 10px) plus four relative sizes
// that resolved below it. Nothing caught any of them, so "the fonts are too
// small on that page" was reported by hand. This test is the gate that stops it
// growing back — a new sub-floor rule fails the suite, and the only way past it
// is to add the selector to ALLOWED below with a reason, in the CSS too.
//
// Source-scanned rather than measured in a browser deliberately: this has to
// cover EVERY rule in the stylesheet, including ones no route currently renders,
// which a rendered page cannot do.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CSS_PATH = resolve(process.cwd(), 'src/index.css');
const css = readFileSync(CSS_PATH, 'utf8');

/** The floor, read from the token itself so the two can never disagree. */
function readFloorPx(): number {
  const m = /--text-min:\s*([0-9.]+)px;/.exec(css);
  if (m === null) throw new Error('--text-min is not defined in index.css');
  return Number(m[1]);
}

/**
 * Documented exceptions: selector → why. EMPTY, and that is the point — every
 * rule in the stylesheet clears the floor. An entry here must also carry the
 * same reason as a comment on the rule in `index.css`.
 */
const ALLOWED: Record<string, string> = {};

interface Offender {
  line: number;
  declaration: string;
  selector: string;
}

/** The selector heading the block a given line sits in. */
function selectorFor(lines: string[], index: number): string {
  let depth = 0;
  for (let i = index; i >= 0; i -= 1) {
    const line = lines[i] ?? '';
    const opens = line.includes('{') && !line.includes('}');
    const closes = line.includes('}') && !line.includes('{');
    if (opens) {
      if (depth === 0) return line.trim().replace(/\s*\{$/, '');
      depth -= 1;
    } else if (closes) {
      depth += 1;
    }
  }
  return '<unknown>';
}

/**
 * Every `font-size` that can resolve below the floor.
 *
 * - An absolute `px` value is compared directly.
 * - A relative value (`em`/`rem`/`%`) BELOW 1 is an offender unless it is wrapped
 *   in `max(..., var(--text-min))`: `0.85em` resolves to whatever its parent
 *   happens to be, so only the explicit clamp proves it clears the floor.
 * - `var(--text-min)` passes, and a `var(--text-min, <fallback>)` fallback does
 *   NOT: a fallback would silently paper over a missing token (no fallbacks).
 */
function offenders(floorPx: number): Offender[] {
  const lines = css.split('\n');
  const found: Offender[] = [];
  lines.forEach((line, i) => {
    const decl = /font-size:\s*([^;]+);/.exec(line);
    if (decl === null || decl[1] === undefined) return;
    const value = decl[1].trim();

    if (/^var\(--text-min\)$/.test(value)) return;
    if (/^max\(.*var\(--text-min\)\s*\)$/.test(value)) return;

    const px = /^([0-9.]+)px$/.exec(value);
    if (px !== null && Number(px[1]) >= floorPx) return;

    const rel = /^([0-9.]+)(em|rem|%)$/.exec(value);
    if (rel !== null) {
      const n = Number(rel[1]) / (rel[2] === '%' ? 100 : 1);
      if (n >= 1) return;
    } else if (px === null) {
      // `inherit`, `unset`, a non-text-min var — nothing to measure.
      if (!/^[0-9.]/.test(value)) return;
    }

    found.push({ line: i + 1, declaration: value, selector: selectorFor(lines, i) });
  });
  return found;
}

describe('spec/14 § Legibility — minimum font size is enforced, not aspirational', () => {
  const floorPx = readFloorPx();

  it('defines the floor as a token', () => {
    expect(floorPx).toBe(13);
  });

  it('no rule in index.css renders text below the floor', () => {
    const unlisted = offenders(floorPx).filter((o) => ALLOWED[o.selector] === undefined);
    // Named in the failure so the fix is obvious without opening the file.
    expect(
      unlisted.map((o) => `index.css:${o.line} ${o.selector} { font-size: ${o.declaration} }`),
    ).toEqual([]);
  });

  it('every documented exception is still real, and still says why in the CSS', () => {
    // Guards the allow-list itself: a stale entry (rule deleted or already
    // raised) must be removed rather than left granting a licence to nothing.
    const live = new Set(offenders(floorPx).map((o) => o.selector));
    for (const [selector, reason] of Object.entries(ALLOWED)) {
      expect(live.has(selector), `${selector} no longer undercuts the floor`).toBe(true);
      expect(reason.length, `${selector} needs a reason`).toBeGreaterThan(20);
      expect(css, `${selector}'s reason must also be a comment in index.css`).toContain(reason);
    }
  });

  it('the floor is actually used — the token is not decoration', () => {
    const uses = css.match(/font-size:\s*(var\(--text-min\)|max\([^;]*var\(--text-min\)\))/g) ?? [];
    expect(uses.length).toBeGreaterThan(50);
  });
});
