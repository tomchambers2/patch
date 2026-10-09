import { test, expect } from '@playwright/test';
import { openReportedState } from './sidebarBand.js';

// spec/14 § Sidebar → Scroll regions: when the chat-list band overflows it says
// so, with the app's own scrollbar. Tom's report — "clips overflow with no
// scrollbar or fade" — is a PAINT question, so this is the one spec that has to
// look at pixels.
//
// Playwright's headless Chromium launches with `--hide-scrollbars`, which zeroes
// every scrollbar in the browser and makes the question unanswerable. Turning it
// off has to happen at file level (`test.use({ launchOptions })` forces its own
// worker, which Playwright forbids inside a describe), which is why this lives
// apart from sidebar-scroll-band.spec.ts.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

test('an overflowing band paints the app’s own scrollbar across its gutter', async ({ page }) => {
  await openReportedState(page);

  const band = await page.evaluate(() => {
    const el = document.querySelector('.sb-scroll') as HTMLElement;
    const r = el.getBoundingClientRect();
    return {
      overflowing: el.scrollHeight > el.clientHeight,
      // The gutter this band reserves (spec/14 § Sidebar — One column).
      gutter: el.offsetWidth - el.clientWidth,
      right: Math.round(r.right),
      top: Math.round(r.top),
      height: Math.round(r.height),
    };
  });
  expect(band.overflowing).toBe(true);
  expect(band.gutter).toBeGreaterThan(0);

  // Read the reserved gutter's pixels. The screenshot comes back as a PNG, so
  // the page decodes it via canvas rather than pulling in a Node image
  // dependency the repo doesn't carry.
  const strip = await page.screenshot({
    clip: { x: band.right - band.gutter, y: band.top, width: band.gutter, height: band.height },
  });
  const thumbWidth = await page.evaluate(
    async ({ dataUrl, width, height }) => {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = dataUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('no 2d context');
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, width, height);
      // The thumb is `--ink-faint` (#8a8175); the track is transparent, so it
      // shows the panel behind it. Measure the widest run of thumb columns.
      const isThumb = (x: number): boolean => {
        for (let y = 0; y < height; y++) {
          const i = (y * width + x) * 4;
          const r = data[i] as number;
          const g = data[i + 1] as number;
          const b = data[i + 2] as number;
          if (Math.abs(r - 138) < 40 && Math.abs(g - 129) < 40 && Math.abs(b - 117) < 40)
            return true;
        }
        return false;
      };
      let widest = 0;
      let run = 0;
      for (let x = 0; x < width; x++) {
        run = isThumb(x) ? run + 1 : 0;
        if (run > widest) widest = run;
      }
      return widest;
    },
    {
      dataUrl: `data:image/png;base64,${strip.toString('base64')}`,
      width: band.gutter,
      height: band.height,
    },
  );

  // The app styles its own scrollbar (index.css § Global scrollbar) at the full
  // `--scrollbar-w` this band reserves. Before the fix the band fell back to the
  // platform's `thin` scrollbar: a 6px thumb in the 10px gutter here, and an
  // auto-hiding overlay on macOS — i.e. no cue at all.
  expect(thumbWidth).toBe(band.gutter);
});
