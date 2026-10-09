// spec/14 § Legibility — the minimum text size is a whole-app rule, so mobile
// gets the same gate web does (`packages/web/src/__tests__/minFontSize.test.ts`).
//
// Mobile had no floor token at all and 65 sub-floor literals (41x 12, 23x 11,
// 1x 10) scattered across 14 files. `textMin` in `src/lib/theme.ts` is now the
// one place the floor is written, alongside `space` and `radii`; this test is
// what stops a fresh literal creeping back in.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { textMin } from '../src/lib/theme';

const ROOT = resolve(__dirname, '..');
const SCANNED = ['app', 'src'];

/**
 * Documented exceptions: `file:line` → why. EMPTY, and that is the point.
 * An entry here must also carry the same reason as a comment at that call site.
 */
const ALLOWED: Record<string, string> = {};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.expo' || entry === 'android') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

interface Offender {
  where: string;
  value: string;
}

function offenders(): Offender[] {
  const found: Offender[] = [];
  for (const root of SCANNED) {
    for (const file of sources(join(ROOT, root))) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // Numeric literals only. `fontSize: textMin` (and any other named
          // constant) is what a compliant call site looks like.
          const m = /fontSize:\s*([0-9]+(?:\.[0-9]+)?)/.exec(line);
          if (m === null) return;
          if (Number(m[1]) >= textMin) return;
          found.push({ where: `${relative(ROOT, file)}:${i + 1}`, value: m[1] });
        });
    }
  }
  return found;
}

describe('spec/14 § Legibility — mobile enforces the same minimum font size', () => {
  it('the floor matches web`s --text-min', () => {
    const webCss = readFileSync(resolve(ROOT, '../../packages/web/src/index.css'), 'utf8');
    const m = /--text-min:\s*([0-9.]+)px;/.exec(webCss);
    if (m === null) throw new Error('--text-min is not defined in web`s index.css');
    expect(textMin).toBe(Number(m[1]));
  });

  it('no screen or component sets a font size below the floor', () => {
    const unlisted = offenders().filter((o) => ALLOWED[o.where] === undefined);
    expect(unlisted.map((o) => `${o.where} fontSize: ${o.value}`)).toEqual([]);
  });

  it('every documented exception is still real and still says why', () => {
    const live = new Set(offenders().map((o) => o.where));
    for (const [where, reason] of Object.entries(ALLOWED)) {
      expect(live.has(where), `${where} no longer undercuts the floor`).toBe(true);
      const [file] = where.split(':');
      expect(readFileSync(join(ROOT, file), 'utf8')).toContain(reason);
    }
  });

  it('the floor is actually used, not just declared', () => {
    let uses = 0;
    for (const root of SCANNED) {
      for (const file of sources(join(ROOT, root))) {
        uses += (readFileSync(file, 'utf8').match(/fontSize:\s*textMin/g) ?? []).length;
      }
    }
    expect(uses).toBeGreaterThan(60);
  });
});
