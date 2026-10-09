import { test, expect } from '@playwright/test';

// Real-browser check for spec/14 § Message links: a message link carries a
// preview toggle icon; clicking it fetches (stubbed here) and renders an
// inline mini-preview without navigating away. `chat_link_preview` seeds one
// assistant message with a single link — see dev-harness.tsx.
const HARNESS = '/app/dev-harness.html?chat=chat_link_preview';
const MESSAGE_LINK = 'a[href="https://example.com/foraging-guide"]:not([data-testid])';

test.describe('a message link carries an inline preview toggle', () => {
  test('clicking the toggle icon fetches and shows the preview inline', async ({ page }) => {
    await page.route('**/api/link-preview**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          url: 'https://example.com/foraging-guide',
          title: 'A Guide to Foraging',
          description: 'What to look for this season.',
        }),
      });
    });
    await page.goto(HARNESS);

    // The message's own link — not the open-in-browser icon beside it, which
    // carries the same href.
    const link = page.locator(MESSAGE_LINK);
    await expect(link).toBeVisible();
    const toggle = page.locator('[data-testid="link-preview-toggle"]');
    await expect(toggle).toBeVisible();
    await expect(page.locator('[data-testid="link-preview-card"]')).toHaveCount(0);

    await toggle.click();

    const card = page.locator('[data-testid="link-preview-card"]');
    await expect(card).toBeVisible();
    await expect(card).toContainText('A Guide to Foraging');
    await expect(card).toContainText('What to look for this season.');

    // The link itself still points at the real target — the icon is an
    // addition, not a replacement for normal navigation.
    await expect(link).toHaveAttribute('href', 'https://example.com/foraging-guide');

    // Clicking again collapses it.
    await toggle.click();
    await expect(card).toHaveCount(0);
  });

  test('a failed preview fetch shows an error, not a silent blank card', async ({ page }) => {
    await page.route('**/api/link-preview**', async (route) => {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'fetch_failed', message: 'upstream 503' }),
      });
    });
    await page.goto(HARNESS);

    await page.locator('[data-testid="link-preview-toggle"]').click();

    const card = page.locator('[data-testid="link-preview-card"]');
    await expect(card).toBeVisible();
    // rest.ts's error path surfaces the response body's `error` code.
    await expect(card).toContainText('fetch_failed');
  });

  // Todoist: "patch link preview is broken" — every preview showed no image,
  // because the server's CSP (packages/server/src/app.ts) allows images only
  // from 'self', data: and blob:, and the og:image is a third-party URL. The
  // vite dev server sends no CSP, so the harness document is served here with
  // the production img-src directive: a plain `<img src="https://…">` is then
  // blocked exactly as it was in the app, and only the proxied blob: renders.
  test('the preview image renders under the production img-src policy', async ({ page }) => {
    await page.route('**/app/dev-harness.html**', async (route) => {
      const res = await route.fetch();
      await route.fulfill({
        response: res,
        headers: { ...res.headers(), 'content-security-policy': "img-src 'self' data: blob:" },
      });
    });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGN0a9BnYGBgYmBgYGBgAAALvQD5RRAoZwAAAABJRU5ErkJggg==',
      'base64',
    );
    const imageUrls: string[] = [];
    await page.route('**/api/link-preview/image**', async (route) => {
      imageUrls.push(new URL(route.request().url()).searchParams.get('url') ?? '');
      await route.fulfill({ status: 200, contentType: 'image/png', body: png });
    });
    await page.route('**/api/link-preview?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          url: 'https://example.com/foraging-guide',
          title: 'A Guide to Foraging',
          image: 'https://cdn.example.com/og/foraging.png',
        }),
      });
    });
    await page.goto(HARNESS);

    await page.locator('[data-testid="link-preview-toggle"]').click();

    const img = page.locator('[data-testid="link-preview-card"] img.link-preview-image');
    await expect(img).toBeVisible();
    // Actually decoded, not a broken-image box.
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(2);
    expect(await img.getAttribute('src')).toMatch(/^blob:/);
    expect(imageUrls).toEqual(['https://cdn.example.com/og/foraging.png']);
  });

  // "…also add an external browser button icon to the right so its easy to
  // open in desktop browser". A target=_blank open is what the desktop shell's
  // link policy hands to the OS browser (packages/desktop/src/link-policy.ts
  // routeWindowOpen); a plain click on the link itself goes to Patch's own
  // panel instead.
  test('an open-in-browser icon sits to the right of the link', async ({ page }) => {
    await page.goto(HARNESS);

    const link = page.locator(MESSAGE_LINK);
    const toggle = page.locator('[data-testid="link-preview-toggle"]');
    const external = page.locator('[data-testid="link-preview-external"]');
    await expect(external).toBeVisible();
    await expect(external).toHaveAttribute('href', 'https://example.com/foraging-guide');
    await expect(external).toHaveAttribute('target', '_blank');

    const linkBox = await link.boundingBox();
    const toggleBox = await toggle.boundingBox();
    const externalBox = await external.boundingBox();
    if (!linkBox || !toggleBox || !externalBox) throw new Error('link controls have no box');
    // After the link and after the preview toggle, on the link's own line.
    expect(externalBox.x).toBeGreaterThanOrEqual(linkBox.x + linkBox.width - 1);
    expect(externalBox.x).toBeGreaterThanOrEqual(toggleBox.x + toggleBox.width - 1);
    const mid = (b: { y: number; height: number }): number => b.y + b.height / 2;
    expect(Math.abs(mid(externalBox) - mid(linkBox))).toBeLessThan(linkBox.height);

    // It opens a new page (the real browser, on desktop) rather than
    // navigating this one.
    const [popup] = await Promise.all([page.waitForEvent('popup'), external.click()]);
    expect(popup.url()).toContain('example.com/foraging-guide');
    expect(page.url()).toContain('dev-harness.html');
  });
});
