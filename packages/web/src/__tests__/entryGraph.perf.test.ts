// spec/14 ## Startup cost — "the entry graph carries only what first paint
// needs".
//
// Tom, patch/todo.md — "Check app for performance". `main.tsx` statically
// imported `lib/monaco-loader.js`, which pulls `monaco-editor/esm/vs/editor/
// editor.main.js` — the whole editor, every monarch tokenizer and the rich
// JSON/CSS/HTML/TS language services. Static import means it is in the ENTRY
// chunk: every surface, on every cold start, downloads/parses/evaluates the
// file editor before a single chat can render — including the phone, and
// including the (normal) session that never opens a file. The EditorRail
// already `lazy()`-loads the editor components, so the weight was being paid
// eagerly for a feature that was already deferred.
//
// This walks the STATIC import graph from the entry and asserts nothing heavy
// is reachable. Static-only is the point: `import()` is what puts a module in
// its own chunk, so a dynamic edge is precisely the fix.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const ROOT = resolve(process.cwd(), 'src');

/** Specifiers that must never be reachable from the entry by static import. */
const HEAVY = [/(^|\/)monaco-editor/, /@monaco-editor\//];

/** Static `import ... from 'x'` / `import 'x'` — deliberately NOT `import('x')`. */
function staticSpecifiers(src: string): string[] {
  const out: string[] = [];
  const from = /(^|\n)\s*import\s[^;]*?from\s*['"]([^'"]+)['"]/g;
  const bare = /(^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  for (const re of [from, bare]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) out.push(m[2]!);
  }
  return out;
}

function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = join(dirname(fromFile), spec).replace(/\.js$/, '');
  for (const cand of [
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/** Every module statically reachable from `entry`, plus the bare specifiers seen. */
function walk(entry: string): { files: string[]; bare: Array<{ file: string; spec: string }> } {
  const seen = new Set<string>();
  const bare: Array<{ file: string; spec: string }> = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of staticSpecifiers(readFileSync(file, 'utf8'))) {
      const rel = resolveRelative(file, spec);
      if (rel) queue.push(rel);
      else bare.push({ file, spec });
    }
  }
  return { files: [...seen], bare };
}

describe('entry chunk weight', () => {
  const graph = walk(join(ROOT, 'main.tsx'));

  it('walks a real graph (guard against the walker silently finding nothing)', () => {
    expect(graph.files.length).toBeGreaterThan(20);
    expect(graph.bare.some((b) => b.spec === 'react')).toBe(true);
  });

  it('does not statically reach the Monaco editor from the entry', () => {
    const offenders = graph.bare.filter((b) => HEAVY.some((re) => re.test(b.spec)));
    expect(
      offenders.map((o) => `${o.file.slice(ROOT.length + 1)} → ${o.spec}`),
      'the file editor must load on demand, not in the entry chunk',
    ).toEqual([]);
  });

  it('the EditorRail still boots the self-hosted loader before mounting an editor', () => {
    // The bootstrap installs MonacoEnvironment + `loader.config({ monaco })`;
    // without it @monaco-editor/react reaches for the CSP-blocked CDN. Moving
    // it off the entry means the RAIL now owns triggering it — on the same
    // dynamic path as the editor components themselves.
    const rail = readFileSync(join(ROOT, 'components/EditorRail.tsx'), 'utf8');
    expect(rail).toMatch(/import\(\s*['"]\.\.\/lib\/monaco-loader\.js['"]\s*\)/);
  });
});
