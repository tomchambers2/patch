import { test, expect } from '@playwright/test';

// Real-browser layout checks for the composer + the markdown transcript. jsdom
// can't measure layout, so these assert COMPUTED styles / element heights against
// the dev harness (real components, real CSS). `?chat=chat_bus` is a regular chat
// — full composer + a seeded markdown assistant reply (see dev-harness.tsx).
const HARNESS = '/app/dev-harness.html?chat=chat_bus';

test.describe('composer + transcript layout', () => {
  test('composer footer has no background fill (transparent)', async ({ page }) => {
    await page.goto(HARNESS);
    const composer = page.locator('.composer');
    await expect(composer).toBeVisible();
    const bg = await composer.evaluate((el) => getComputedStyle(el).backgroundColor);
    // A filled panel would be an opaque rgb(...); transparent is rgba(0,0,0,0).
    expect(bg).toBe('rgba(0, 0, 0, 0)');
  });

  test('composer has no top divider line above the input', async ({ page }) => {
    await page.goto(HARNESS);
    const composer = page.locator('.composer');
    await expect(composer).toBeVisible();
    const topBorder = await composer.evaluate((el) => {
      const s = getComputedStyle(el);
      return { width: s.borderTopWidth, style: s.borderTopStyle };
    });
    // No rule → 0px / none (a divider would be 1px solid).
    expect(topBorder.width === '0px' || topBorder.style === 'none').toBe(true);
  });

  test('the message textarea auto-grows as content wraps to multiple lines', async ({ page }) => {
    await page.goto(HARNESS);
    const input = page.locator('.composer-input');
    await input.click();
    const before = await input.evaluate((el) => el.getBoundingClientRect().height);
    await input.fill('one\ntwo\nthree\nfour\nfive');
    await page.waitForTimeout(50); // let the resize effect run a frame
    const after = await input.evaluate((el) => el.getBoundingClientRect().height);
    // Five lines must be visibly taller than the single-row start (~40px).
    expect(after).toBeGreaterThan(before + 30);
  });

  test('the input never shows a scrollbar while it grows/contracts under the cap', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const input = page.locator('.composer-input');
    await input.click();

    // A handful of lines — comfortably under the 200px cap. The field must
    // expand to fit with NO scrollbar (overflow hidden, content fully visible).
    await input.fill('one\ntwo\nthree\nfour\nfive');
    await page.waitForTimeout(50); // let the resize effect run a frame
    const under = await input.evaluate((el) => {
      const t = el as HTMLTextAreaElement;
      return {
        overflowY: getComputedStyle(t).overflowY,
        scrollHeight: t.scrollHeight,
        clientHeight: t.clientHeight,
      };
    });
    // No scrollbar: overflow is hidden AND the content isn't clipped/scrolled.
    expect(under.overflowY).toBe('hidden');
    expect(under.scrollHeight).toBeLessThanOrEqual(under.clientHeight + 1);
  });

  test('the input caps its height and only then allows an internal scrollbar', async ({ page }) => {
    await page.goto(HARNESS);
    const input = page.locator('.composer-input');
    await input.click();

    // Far more lines than fit in the 200px cap: the field must stop growing at
    // the cap and scroll internally (never push the chat off-screen).
    const many = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    await input.fill(many);
    await page.waitForTimeout(50);
    const over = await input.evaluate((el) => {
      const t = el as HTMLTextAreaElement;
      return {
        overflowY: getComputedStyle(t).overflowY,
        height: t.getBoundingClientRect().height,
        scrollHeight: t.scrollHeight,
      };
    });
    // Height is clamped at the 200px cap (allow a small border/padding delta).
    expect(over.height).toBeLessThanOrEqual(202);
    // Past the cap the content genuinely overflows, so a scrollbar is allowed.
    expect(over.overflowY).toBe('auto');
    expect(over.scrollHeight).toBeGreaterThan(over.height);
  });

  test('markdown paragraphs use tight spacing, not the browser default ~16px', async ({ page }) => {
    await page.goto(HARNESS);
    const p = page.locator('.msg-assistant .content p').first();
    await expect(p).toBeVisible();
    const marginTop = await p.evaluate((el) => parseFloat(getComputedStyle(el).marginTop));
    // Our fix is ~0.35em (≈5.6px); the browser default <p> margin is ~16px.
    expect(marginTop).toBeLessThan(10);
  });

  test('markdown headings and dividers are compact (h2 top-margin well under default)', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const h2 = page.locator('.msg-assistant .content h2').nth(1); // second heading (has one above it)
    await expect(h2).toBeVisible();
    const marginTop = await h2.evaluate((el) => parseFloat(getComputedStyle(el).marginTop));
    // ~0.7em (≈11px) vs the browser default ~21px for an h2.
    expect(marginTop).toBeLessThan(14);
  });
});

test.describe('composer action buttons — Stop or Send, never both', () => {
  // chat_bus is seeded with activity:'running' (dev-harness.tsx). An empty
  // composer shows Stop alone on the right edge; typing swaps it for Send.
  test('Stop alone when empty, Send alone once there is text', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_bus');

    const stop = page.getByTestId('stop-btn');
    const send = page.getByTestId('send-btn');
    await expect(stop).toBeVisible();
    await expect(send).toHaveCount(0);

    await page.getByTestId('composer-input').fill('next');
    await expect(send).toBeVisible();
    await expect(stop).toHaveCount(0);

    await page.getByTestId('composer-input').fill('');
    await expect(stop).toBeVisible();
    await expect(send).toHaveCount(0);
  });

  type Harness = {
    __store: {
      setState(fn: (s: { chats: Record<string, object> }) => object): void;
    };
  };
  const setActivity = (page: import('@playwright/test').Page, activity: string) =>
    page.evaluate((a) => {
      (window as unknown as Harness).__store.setState((s) => ({
        chats: { ...s.chats, chat_bus: { ...s.chats['chat_bus'], activity: a } },
      }));
    }, activity);

  test('Stop stays while the turn waits on a permission', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await setActivity(page, 'awaiting-permission');
    await expect(page.getByTestId('stop-btn')).toBeVisible();
  });

  test('Stop appears right after Send, before the host confirms running', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await setActivity(page, 'idle');
    await expect(page.getByTestId('stop-btn')).toHaveCount(0);
    await page.getByTestId('composer-input').fill('hello');
    await page.getByTestId('composer-input').press('Enter');
    await expect(page.getByTestId('stop-btn')).toBeVisible();
  });
});
