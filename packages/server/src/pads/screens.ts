// A Pad is a set of screens, and every change belongs to exactly one.
//
// The agent declares them in `pad.json` at the top of the Pad's files:
//
//   { "screens": [
//       { "id": "credit", "name": "Credit", "path": "index.html#credit" },
//       { "name": "Agent", "path": "agent.html" } ] }
//
// `path` is a file in the Pad, optionally with a #fragment for designs that
// route with the hash. Without a manifest, each top-level .html file is a
// screen (index.html first), named by its <title>.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { slugify } from './store.js';

export class ScreensError extends Error {}

export interface Screen {
  id: string;
  name: string;
  path: string;
  /**
   * The width the screen was designed at (a captured screen keeps the width it
   * was photographed at, so its responsive layout does not change under the
   * editor). Absent: the editor uses however much room it has.
   */
  width?: number;
}

function titleOf(file: string): string | null {
  const m = /<title>([^<]*)<\/title>/i.exec(readFileSync(file, 'utf8'));
  return m?.[1]?.trim() ? m[1].trim() : null;
}

function checkPath(dir: string, path: unknown): void {
  if (typeof path !== 'string' || !path) throw new ScreensError('a screen needs a path');
  const [file] = path.split('#') as [string];
  const base = resolve(dir);
  const full = resolve(base, file);
  if (!full.startsWith(base + sep))
    throw new ScreensError(`screen path "${path}" is outside the pad`);
  if (!existsSync(full) || !statSync(full).isFile()) {
    throw new ScreensError(`screen path "${path}" is not a file in the pad`);
  }
}

export function screensFor(dir: string): Screen[] {
  const manifest = join(dir, 'pad.json');
  let screens: Screen[];
  if (existsSync(manifest)) {
    let parsed: { screens?: { id?: string; name?: string; path?: string; width?: number }[] };
    try {
      parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch (e) {
      throw new ScreensError(`pad.json is not valid JSON: ${(e as Error).message}`);
    }
    if (!Array.isArray(parsed.screens) || !parsed.screens.length) {
      throw new ScreensError('pad.json needs a non-empty "screens" list');
    }
    screens = parsed.screens.map((s, i) => {
      if (!s || typeof s.name !== 'string' || !s.name.trim())
        throw new ScreensError(`screen ${i + 1} needs a name`);
      checkPath(dir, s.path);
      if (s.width !== undefined && (!Number.isFinite(s.width) || s.width < 200 || s.width > 4000)) {
        throw new ScreensError(`screen "${s.name}" has a width outside 200–4000`);
      }
      return {
        id: s.id ? slugify(s.id) : slugify(s.name),
        name: s.name.trim(),
        path: s.path as string,
        ...(s.width !== undefined ? { width: Math.round(s.width) } : {}),
      };
    });
  } else {
    const files = readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.html'))
      .sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
    if (!files.length) throw new ScreensError('the pad has no .html files');
    screens = files.map((f) => ({
      id: slugify(f.replace(/\.html$/i, '')),
      name: titleOf(join(dir, f)) || f,
      path: f,
    }));
  }
  const seen = new Set<string>();
  for (const s of screens) {
    if (seen.has(s.id)) throw new ScreensError(`two screens share the id "${s.id}"`);
    seen.add(s.id);
  }
  return screens;
}
