// A picture of every change, for the chat that receives the batch.
//
// Text can name an element but not show what it sits among, so each change is
// drawn on its own screen: the Pad is opened at that screen, at the size Tom
// was looking at it, with his other pending edits on that screen applied; the
// page is scrolled to the element and the change is marked on it and numbered
// to match the message. A move shows where the element came from, a deletion
// shows what went, a note sits where he pinned it, a drawing as he drew it.
//
// NO FALLBACK: if a picture cannot be drawn the Send fails and stays pending.
// A change whose element is no longer on its screen still gets a picture of
// the screen, captioned as such, rather than being skipped.

import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Change } from './store.js';
import type { Screen } from './screens.js';

const DEFAULT_VIEWPORT = { w: 1280, h: 800 };
const here = dirname(fileURLToPath(import.meta.url));
// Runs inside the design page, so it is plain JS shipped as text.
const ANNOTATE_SRC = (): string => readFileSync(join(here, 'public', 'annotate.js'), 'utf8');

export interface Picture {
  n: number;
  file: string | null;
  found?: boolean;
  problem?: string;
}

/** playwright is heavy and only Send and thumbnails need it: load it on demand. */
async function launch() {
  const { chromium } = await import('playwright');
  return chromium.launch();
}

export async function renderChangePictures(opts: {
  changes: Change[];
  screens: Screen[];
  /** Where the pad's files are served, ending in `/`. */
  baseUrl: string;
  outDir: string;
  prefix: string;
}): Promise<Picture[]> {
  const { changes, screens, baseUrl, outDir, prefix } = opts;
  if (!changes.length) return [];
  mkdirSync(outDir, { recursive: true });
  const src = ANNOTATE_SRC();
  const browser = await launch();
  const contexts = new Map<string, Awaited<ReturnType<typeof browser.newContext>>>();
  try {
    const out: Picture[] = [];
    for (const [i, c] of changes.entries()) {
      const n = i + 1;
      const screen = screens.find((s) => s.id === c.screen);
      if (!screen) {
        out.push({ n, file: null, problem: `screen "${c.screen}" is no longer in the pad` });
        continue;
      }
      const vp = c.viewport ?? DEFAULT_VIEWPORT;
      const vkey = `${vp.w}x${vp.h}`;
      if (!contexts.has(vkey)) {
        contexts.set(
          vkey,
          await browser.newContext({
            viewport: { width: vp.w, height: vp.h },
            deviceScaleFactor: 2,
          }),
        );
      }
      const page = await contexts.get(vkey)!.newPage();
      try {
        const [file, hash] = screen.path.split('#') as [string, string | undefined];
        await page.goto(
          `${baseUrl}${file}?pad-picture=${n}${hash !== undefined ? `#${hash}` : ''}`,
          {
            waitUntil: 'load',
            timeout: 20_000,
          },
        );
        await page.waitForTimeout(250);
        const sameScreen = changes.filter((x) => x.screen === c.screen);
        const run = (): Promise<{ found: boolean; needHeight: number }> =>
          page.evaluate(
            `(${src})(${JSON.stringify({ others: sameScreen, cur: c, n })})`,
          ) as Promise<{
            found: boolean;
            needHeight: number;
          }>;
        let { found, needHeight } = await run();
        // A drawing or note taller than the screen gets a taller picture, so
        // none of it is cut off.
        if (needHeight > vp.h) {
          await page.setViewportSize({ width: vp.w, height: Math.min(needHeight, 3000) });
          await page.reload({ waitUntil: 'load' });
          await page.waitForTimeout(250);
          ({ found } = await run());
        }
        const path = join(outDir, `${prefix}-${n}.png`);
        await page.screenshot({ path });
        out.push({ n, file: path, found });
      } finally {
        await page.close();
      }
    }
    return out;
  } finally {
    await browser.close();
  }
}

/** Card thumbnails: each screen at the pad's device size. One browser for the batch. */
export async function renderThumbnails(opts: {
  items: { url: string; out: string }[];
  device: 'desktop' | 'phone';
}): Promise<void> {
  if (!opts.items.length) return;
  const browser = await launch();
  try {
    const vp = opts.device === 'phone' ? { width: 390, height: 844 } : { width: 1280, height: 800 };
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
    for (const item of opts.items) {
      mkdirSync(dirname(item.out), { recursive: true });
      const page = await ctx.newPage();
      try {
        await page.goto(item.url, { waitUntil: 'load', timeout: 20_000 });
        await page.waitForTimeout(300);
        await page.screenshot({ path: item.out });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
}
