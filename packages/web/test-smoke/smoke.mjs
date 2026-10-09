// Standalone Playwright smoke for group 17. Runs against the docker-compose
// test stack (`docker compose -f docker-compose.test.yml up -d`).
//
// Usage:  node packages/web/test-smoke/smoke.mjs
//
// Definition-of-done: load /app/, screenshot, assert brand row is visible.
// We hit the pairing screen (no credential) — that's expected, and the
// brand row sits inside the pairing screen heading.

import { chromium } from 'playwright';

const URL = process.env.PATCH_SMOKE_URL ?? 'http://localhost:13000/app/';
const SCREENSHOT = process.env.PATCH_SMOKE_SCREENSHOT ?? '/tmp/patch-group17-smoke.png';

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.screenshot({ path: SCREENSHOT, fullPage: true });

// Brand row check — pairing screen has the wordmark.
const brand = await page.locator('h1, .brand-mark').first().textContent();
if (!brand || !/patch/i.test(brand)) {
  throw new Error(`brand mark missing — saw ${JSON.stringify(brand)}`);
}

// SPA mounted? Test that the pairing input is present.
await page.waitForSelector('[data-testid="pairing-screen"], [data-testid="app-shell"]', {
  timeout: 5000,
});

if (errors.length > 0) {
  console.error('runtime errors:\n' + errors.join('\n'));
  await browser.close();
  process.exit(1);
}

console.log(`smoke OK — ${URL} loaded, screenshot saved to ${SCREENSHOT}`);
await browser.close();
