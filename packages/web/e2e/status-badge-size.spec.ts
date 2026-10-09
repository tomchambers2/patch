import { test, expect } from '@playwright/test';

// spec/14 § Status badges — every badge state is drawn at the SAME footprint
// (the 8-9px dot the sidebar row reserves a track for). Only hue and shape vary.
//
// REGRESSION (Todoist "new chat thing is massive"): `StatusBadge` used to emit
// a bare variant class — `class="badge permission"` — and `index.css` carries a
// completely unrelated `.permission` rule for the transcript's APPROVAL CARD
// (`padding: 12px; margin: 12px 0; border-radius: var(--radius)`). Neither
// `.badge` nor `.badge.permission` reset padding or margin, so the card's
// padding leaked onto the 8px dot: 8px content + 24px padding = a 32px purple
// blob that overlapped the row title, with 12px of vertical margin under it.
// Only a real browser can catch this — jsdom applies no stylesheet, so a
// getComputedStyle assertion there passes vacuously.

const SIDEBAR_BADGE_MAX_PX = 12;

async function seedPermission(page: import('@playwright/test').Page): Promise<void> {
  // The harness publishes the store on module eval; `goto` can resolve first.
  await page.waitForFunction(() => '__store' in window);
  await page.evaluate(() => {
    const w = window as unknown as {
      __store: { getState: () => { applyEvent: (e: unknown) => void } };
    };
    w.__store.getState().applyEvent({
      type: 'chat.state',
      chatId: 'chat_scroll',
      activity: 'awaiting-permission',
      permissionMode: 'auto',
      lastUpdated: Date.now(),
    });
  });
}

test.describe('status badge — every state is the same size', () => {
  test('the permission badge is a dot, not a padded card-sized blob', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_md');
    await seedPermission(page);

    const permission = page.locator(
      '[data-testid="chat-row-chat_scroll"] [data-testid="badge-permission"]',
    );
    await expect(permission).toBeVisible();

    // The approval card's box model must not reach the dot at all.
    const box = await permission.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        paddingTop: s.paddingTop,
        paddingRight: s.paddingRight,
        paddingBottom: s.paddingBottom,
        paddingLeft: s.paddingLeft,
        marginTop: s.marginTop,
        marginBottom: s.marginBottom,
        borderRadius: s.borderTopLeftRadius,
      };
    });
    expect(box.paddingTop).toBe('0px');
    expect(box.paddingRight).toBe('0px');
    expect(box.paddingBottom).toBe('0px');
    expect(box.paddingLeft).toBe('0px');
    expect(box.marginTop).toBe('0px');
    expect(box.marginBottom).toBe('0px');
    // Round: `.permission`'s `var(--radius)` stole the 50% that makes it a dot.
    expect(box.borderRadius).toBe('50%');

    const rect = (await permission.boundingBox())!;
    expect(rect).not.toBeNull();
    expect(rect.width).toBeLessThanOrEqual(SIDEBAR_BADGE_MAX_PX);
    expect(rect.height).toBeLessThanOrEqual(SIDEBAR_BADGE_MAX_PX);
  });

  test('permission matches the working and done dots it sits beside', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_md');
    await seedPermission(page);

    const permission = page.locator(
      '[data-testid="chat-row-chat_scroll"] [data-testid="badge-permission"]',
    );
    // chat_bus is seeded `running` → `working`; chat_forked unread → `done`.
    const working = page.locator('[data-testid="chat-row-chat_bus"] [data-testid="badge-working"]');
    const done = page.locator('[data-testid="chat-row-chat_forked"] [data-testid="badge-done"]');
    await expect(permission).toBeVisible();
    await expect(working).toBeVisible();
    await expect(done).toBeVisible();

    const [p, w, d] = await Promise.all([
      permission.boundingBox(),
      working.boundingBox(),
      done.boundingBox(),
    ]);

    // Within a pixel of its neighbours on both axes. `working` is drawn a hair
    // larger (9px vs 8px) on purpose, hence the tolerance rather than equality.
    expect(Math.abs(p!.width - w!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(p!.height - w!.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(p!.width - d!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(p!.height - d!.height)).toBeLessThanOrEqual(1);
  });
});
