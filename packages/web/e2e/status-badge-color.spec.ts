import { test, expect } from '@playwright/test';

// spec/14 § Status badges — every badge state carries its OWN hue: `working`
// is the orange dot (`--waiting`), `done` the green accent, and `permission`
// its own indigo (`--permission`). Shape still separates them too (working is
// a plain dot with no box-shadow that fades via opacity; permission is a crisp
// hard-edged ring), but shape is no longer the ONLY thing telling apart the
// one distinction that changes what you do next. jsdom applies no stylesheet,
// so only a real browser can prove the actual painted colour + absence of a
// glow (computed `boxShadow`) rather than just the class name.

test.describe('status badge — each state has its own hue', () => {
  test('the working badge paints --waiting orange, not the green accent', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_md');

    // chat_bus is seeded with activity: 'running' → badge 'working'.
    const workingBadge = page.locator(
      '[data-testid="chat-row-chat_bus"] [data-testid="badge-working"]',
    );
    await expect(workingBadge).toBeVisible();
    const workingColor = await workingBadge.evaluate((el) => getComputedStyle(el).backgroundColor);
    // --waiting (light mode): #c46a12 → rgb(196, 106, 18)
    expect(workingColor).toBe('rgb(196, 106, 18)');

    // No blurred glow — a clean dot with no box-shadow at all, distinct from
    // the hard multi-ring shadow `permission` uses.
    const workingShadow = await workingBadge.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(workingShadow).toBe('none');

    // chat_forked (forked-fixture) is unvisited and unread → badge 'done',
    // the green accent dot — must NOT share the working badge's orange.
    const doneBadge = page.locator(
      '[data-testid="chat-row-chat_forked"] [data-testid="badge-done"]',
    );
    await expect(doneBadge).toBeVisible();
    const doneColor = await doneBadge.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(doneColor).not.toBe(workingColor);
  });

  test('working (no glow, no ring) reads visually distinct from permission (hard ring)', async ({
    page,
  }) => {
    await page.goto('/app/dev-harness.html?chat=chat_md');
    await page.evaluate(() => {
      const w = window as unknown as {
        __store: {
          getState: () => {
            applyEvent: (e: unknown) => void;
          };
        };
      };
      w.__store.getState().applyEvent({
        type: 'chat.state',
        chatId: 'chat_scroll',
        activity: 'awaiting-permission',
        permissionMode: 'auto',
        lastUpdated: Date.now(),
      });
    });

    const permissionBadge = page.locator(
      '[data-testid="chat-row-chat_scroll"] [data-testid="badge-permission"]',
    );
    await expect(permissionBadge).toBeVisible();
    const permissionShadow = await permissionBadge.evaluate((el) => getComputedStyle(el).boxShadow);

    const workingBadge = page.locator(
      '[data-testid="chat-row-chat_bus"] [data-testid="badge-working"]',
    );
    const workingShadow = await workingBadge.evaluate((el) => getComputedStyle(el).boxShadow);

    // Not the same shadow shape — permission is a hard ring (multiple sharp
    // `0 0 <spread>px` layers), working carries no shadow at all.
    expect(permissionShadow).not.toBe(workingShadow);
  });

  test('permission carries its own hue — not the working orange, not the done green', async ({
    page,
  }) => {
    await page.goto('/app/dev-harness.html?chat=chat_md');
    await page.evaluate(() => {
      const w = window as unknown as {
        __store: {
          getState: () => {
            applyEvent: (e: unknown) => void;
          };
        };
      };
      w.__store.getState().applyEvent({
        type: 'chat.state',
        chatId: 'chat_scroll',
        activity: 'awaiting-permission',
        permissionMode: 'auto',
        lastUpdated: Date.now(),
      });
    });

    const permissionBadge = page.locator(
      '[data-testid="chat-row-chat_scroll"] [data-testid="badge-permission"]',
    );
    await expect(permissionBadge).toBeVisible();
    const permissionColor = await permissionBadge.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );

    // --permission (light mode): #574fa6 → rgb(87, 79, 166)
    expect(permissionColor).toBe('rgb(87, 79, 166)');

    // The point of the change: at 8-9px a ring-vs-fade shape difference was too
    // weak to carry the one distinction that changes what you do next, so the
    // hue must differ from BOTH neighbouring states, not just the shape.
    const workingColor = await page
      .locator('[data-testid="chat-row-chat_bus"] [data-testid="badge-working"]')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(permissionColor).not.toBe(workingColor);

    const doneColor = await page
      .locator('[data-testid="chat-row-chat_forked"] [data-testid="badge-done"]')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(permissionColor).not.toBe(doneColor);

    // The outer ring is the same hue as the dot — it used to be `--waiting`,
    // so a half-done change would leave an orange ring around an indigo dot.
    expect(
      permissionShadowRing(await permissionBadge.evaluate((el) => getComputedStyle(el).boxShadow)),
    ).toBe('rgb(87, 79, 166)');
  });
});

// Dark mode is where a badly-chosen indigo actually bites: the light-mode value
// goes muddy against the dark panel, and no light-mode assertion would notice.
test.describe('status badge — dark mode', () => {
  test('permission stays its own hue, and a distinct one, in dark mode', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/app/dev-harness.html?chat=chat_md');
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

    const permissionColor = await page
      .locator('[data-testid="chat-row-chat_scroll"] [data-testid="badge-permission"]')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    // --permission (dark): #a39ad0 → rgb(163, 154, 208). A dusty indigo of its
    // own — lifted off the light-mode value, not reused.
    expect(permissionColor).toBe('rgb(163, 154, 208)');

    const workingColor = await page
      .locator('[data-testid="chat-row-chat_bus"] [data-testid="badge-working"]')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(permissionColor).not.toBe(workingColor);
  });
});

// The permission badge's box-shadow is two stacked rings: an inner panel-coloured
// gap and an outer state-coloured ring. Pull the LAST colour out of the computed
// value — that outer ring is the one that must track the dot's own hue.
function permissionShadowRing(boxShadow: string): string {
  const colors = boxShadow.match(/rgba?\([^)]*\)/g);
  if (!colors || colors.length < 2) {
    throw new Error(`expected two stacked rings in box-shadow, got: ${boxShadow}`);
  }
  return colors[colors.length - 1];
}
