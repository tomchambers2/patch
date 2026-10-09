// Bring the standalone Pad service's designs into Patch's Pads (spec/14 § Pads).
//
// Each `<from>/designs/<slug>.json` becomes `<padsDir>/<slug>/`: its folder's
// files, its changes and batches exactly as they stood (a batch awaiting the
// agent's reply is still awaiting it), its journal and its pictures. A design
// whose folder is gone, whose screens cannot be read or whose slug already
// exists in Patch is reported and left alone — never half-imported, never
// overwritten. NO FALLBACK: the caller exits non-zero if any design failed.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { screensFor, ScreensError } from './screens.js';
import { PadStore, validId, type PadRecord } from './store.js';

export interface ImportResult {
  imported: string[];
  skipped: { slug: string; reason: string }[];
  failed: { slug: string; reason: string }[];
}

interface StandaloneDesign {
  slug: string;
  name: string;
  dir: string;
  chat: string;
  createdAt: number;
  updatedAt: number;
  changes: PadRecord['changes'];
  batches: PadRecord['batches'];
}

function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const src = join(from, e.name);
    if (e.isDirectory()) copyTree(src, join(to, e.name));
    else copyFileSync(src, join(to, e.name));
  }
}

export function importStandalone(opts: { from: string; padsDir: string }): ImportResult {
  const designsDir = join(opts.from, 'designs');
  if (!existsSync(designsDir)) throw new Error(`no designs folder at ${designsDir}`);
  const store = new PadStore(opts.padsDir);
  const out: ImportResult = { imported: [], skipped: [], failed: [] };
  const slugs = readdirSync(designsDir)
    .filter((n) => n.endsWith('.json') && !n.endsWith('.journal.jsonl'))
    .map((n) => n.slice(0, -5))
    .sort();
  for (const slug of slugs) {
    try {
      const design = JSON.parse(
        readFileSync(join(designsDir, `${slug}.json`), 'utf8'),
      ) as StandaloneDesign;
      if (!validId(slug)) throw new Error(`"${slug}" is not a valid pad id`);
      if (store.get(slug)) {
        out.skipped.push({ slug, reason: 'already in Patch' });
        continue;
      }
      if (!existsSync(design.dir)) throw new Error(`its folder ${design.dir} no longer exists`);
      screensFor(design.dir); // refuses a design whose screens cannot be read
      const dest = store.dir(slug);
      copyTree(design.dir, store.filesDir(slug));
      const journal = join(designsDir, `${slug}.journal.jsonl`);
      if (existsSync(journal)) copyFileSync(journal, join(dest, 'journal.jsonl'));
      const pictures = join(opts.from, 'pictures', slug);
      if (existsSync(pictures)) copyTree(pictures, store.picturesDir(slug));
      store.import({
        id: slug,
        name: design.name,
        app: null,
        chatId: design.chat,
        device: 'desktop',
        createdAt: design.createdAt,
        updatedAt: design.updatedAt,
        filesRev: Date.now(),
        changes: design.changes,
        batches: design.batches,
      });
      out.imported.push(slug);
    } catch (err) {
      const reason =
        err instanceof ScreensError
          ? `its screens cannot be read: ${err.message}`
          : (err as Error).message;
      out.failed.push({ slug, reason });
    }
  }
  return out;
}
