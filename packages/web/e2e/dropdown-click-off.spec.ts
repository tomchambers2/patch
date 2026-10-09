import { test, expect } from '@playwright/test';

// spec/14 § Dismissing pop-ups (click-off) — every anchored, non-modal pop-up
// (folder picker, model picker, composer skill autocomplete) closes when the
// user clicks anywhere outside it, and a click INSIDE it leaves it open.
// Real-browser e2e against the dev harness: click-off is a pointer/event-target
// behaviour, so it is only truthfully verified in a real browser.
const NEW = '/app/dev-harness.html?chat=new';
const CHAT = '/app/dev-harness.html?chat=thread_manager';

test.describe('dropdowns close on click-off', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/models*', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          models: [
            { id: 'claude-opus-5', label: 'Claude Opus 5' },
            { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
          ],
          fetchedAt: '2026-08-03T09:00:00.000Z',
        }),
      }),
    );
  });

  test('folder picker closes when clicking outside it, and stays open on a click inside', async ({
    page,
  }) => {
    await page.goto(NEW);
    await page.getByTestId('new-chat-folder-pill').click();
    const popup = page.getByTestId('folder-popup');
    await expect(popup).toBeVisible();

    // A click INSIDE the pop-up (the ad-hoc path field) must NOT close it.
    await popup.getByTestId('new-chat-folder').click();
    await expect(popup).toBeVisible();

    // A click OUTSIDE — on the chat header, which selects nothing — closes it.
    await page.getByTestId('chat-head').click({ position: { x: 5, y: 5 } });
    await expect(popup).toBeHidden();
    await expect(page.getByTestId('new-chat-folder-pill')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  test('model picker closes when clicking outside it, without changing the model', async ({
    page,
  }) => {
    await page.goto(NEW);
    const pill = page.getByTestId('new-chat-model');
    await pill.click();
    const popup = page.getByTestId('model-popup');
    await expect(popup).toBeVisible();
    // Read the pill only once the catalogue has resolved it to a label, so the
    // comparison below is about click-off and not about load timing.
    await expect(pill).toContainText('Claude Opus 5');
    const label = (await pill.innerText()).replace('▾', '').trim();

    // Inside the list but not on an option — still open.
    await popup.click({ position: { x: 2, y: 2 } });
    await expect(popup).toBeVisible();

    await page.getByTestId('chat-head').click({ position: { x: 5, y: 5 } });
    await expect(popup).toBeHidden();
    await expect(pill).toHaveAttribute('aria-expanded', 'false');
    // Click-off selects nothing.
    expect((await pill.innerText()).replace('▾', '').trim()).toBe(label);
  });

  test('composer skill autocomplete closes on click-off and keeps the typed text', async ({
    page,
  }) => {
    await page.route('**/api/skills*', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ skills: ['plant', 'plan-travel', 'deploy'] }),
      }),
    );
    await page.goto(CHAT);
    const input = page.getByTestId('composer-input');
    await input.fill('/pl');
    const menu = page.getByTestId('composer-skill-menu');
    await expect(menu).toBeVisible();

    await page.getByTestId('chat-head').click({ position: { x: 5, y: 5 } });
    await expect(menu).toBeHidden();
    // Dismissal never clears what was typed (same as Esc).
    await expect(input).toHaveValue('/pl');
  });
});
