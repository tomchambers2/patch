import { test, expect, type Page } from '@playwright/test';

// Tom, Patch Updates: "ugly" — screenshot of the approval card: a solid tan
// slab with Deny and Approve & resume bypass both in the same brick red. The
// card is now an outlined panel (the waiting hue survives as the border) and
// only Approve is a filled button; Deny is a quiet outlined control.
const HARNESS = '/app/dev-harness.html?chat=chat_question_styles';
const CARD = '[data-testid="permission"]:not([data-resolved])';

async function token(page: Page, name: string): Promise<string> {
  return page.evaluate((n) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${n})`;
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, name);
}

async function assertCard(page: Page): Promise<void> {
  const card = page.locator(CARD).first();
  await expect(card).toBeVisible();
  const waitingTint = await token(page, '--waiting-tint');
  const waiting = await token(page, '--waiting');
  const voice = await token(page, '--voice');
  const accent = await token(page, '--accent');

  const s = await card.evaluate((el) => {
    const c = getComputedStyle(el);
    return { bg: c.backgroundColor, border: c.borderTopColor, width: c.borderTopWidth };
  });
  expect(s.bg).not.toBe(waitingTint);
  expect(s.width).not.toBe('0px');
  expect(s.border).toBe(waiting);

  const btn = (name: string) =>
    card
      .locator('.permission-buttons button')
      .filter({ hasText: name })
      .first()
      .evaluate((el) => {
        const c = getComputedStyle(el);
        return { bg: c.backgroundColor, border: c.borderTopWidth };
      });
  const approve = await btn('Approve');
  const deny = await btn('Deny');
  expect(approve.bg).toBe(accent);
  expect(deny.bg).not.toBe(voice);
  expect(deny.bg).not.toBe(accent);
  expect(deny.border).not.toBe('0px');
}

for (const scheme of ['light', 'dark'] as const) {
  test(`approval card is an outlined panel with one filled button (${scheme})`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(HARNESS);
    await assertCard(page);
  });
}
