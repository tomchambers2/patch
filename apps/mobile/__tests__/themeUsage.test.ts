// spec/15 § Dark mode — every screen and component follows the OS scheme.
//
// `lightColors` / `darkColors` in src/lib/theme.ts are static palettes; a file
// that styles from one renders the same in both schemes (which is how Jobs, the job
// editor, pairing, share and the voice overlays shipped with no dark mode).
// This gate fails on any screen/component that imports a static palette, or
// that writes a raw colour literal instead of a palette token / `fixed` value.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

const ROOT = resolve(__dirname, '..');
const SCANNED = ['app', 'src/components'];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = SCANNED.flatMap((d) => sources(join(ROOT, d))).map((f) => ({
  rel: relative(ROOT, f),
  text: readFileSync(f, 'utf8'),
}));

// Every `import { … } from '…/lib/theme'` binding list in a file.
function themeImports(text: string): string[] {
  const names: string[] = [];
  const re = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*lib\/theme['"]/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0];
      if (name) names.push(name);
    }
  }
  return names;
}

describe('spec/15 § Dark mode — no screen styles from a static palette', () => {
  it('scans a real tree', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('no file under app/ or src/components imports colors / lightColors / darkColors', () => {
    const offenders = files
      .filter((f) =>
        themeImports(f.text).some((n) => ['colors', 'lightColors', 'darkColors'].includes(n)),
      )
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('no file under app/ or src/components writes a raw hex / rgb colour literal', () => {
    const offenders: string[] = [];
    for (const f of files) {
      f.text.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        if (/['"`](#[0-9a-fA-F]{3,8}|rgba?\()/.test(line)) offenders.push(`${f.rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
