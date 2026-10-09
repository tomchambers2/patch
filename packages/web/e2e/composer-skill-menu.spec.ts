import { test, expect } from '@playwright/test';

// Real-browser e2e for the composer's skill autocomplete defaulting to the
// last-used skill (spec/14 § Skill autocomplete). Runs against the dev harness
// with `/api/skills` stubbed — no host needed.
const CHAT = '/app/dev-harness.html?chat=thread_manager';

test.describe('composer skill menu — defaults to the last used skill', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/skills*', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ skills: ['plant', 'plan-travel', 'deploy'] }),
      }),
    );
  });

  test('completing a skill makes it the top (highlighted) option next time', async ({ page }) => {
    await page.goto(CHAT);
    const input = page.getByTestId('composer-input');
    await input.fill('/');
    await expect(page.getByTestId('composer-skill-option-deploy')).toBeVisible();
    // Natural (server) order on first use, with the built-in leading: nothing
    // has been completed in this folder yet, so there is no last-used skill to
    // outrank it.
    await expect(page.locator('.composer-skill-option')).toHaveText([
      '/clearClear the visible chat transcript',
      '/plant',
      '/plan-travel',
      '/deploy',
    ]);
    await page.getByTestId('composer-skill-option-deploy').click();
    await expect(input).toHaveValue('/deploy ');

    // Reload: the folder's last-used skill is now first AND highlighted, so
    // `/` + Enter re-runs it.
    await page.reload();
    const next = page.getByTestId('composer-input');
    await next.fill('/');
    // `/deploy` now leads — AHEAD of the built-in. That ordering is the whole
    // point: spec/14 promises `/` + Enter re-runs the last-used skill, and the
    // Enter below is what proves it did not fire `/clear` instead.
    await expect(page.locator('.composer-skill-option')).toHaveText([
      '/deploy',
      '/clearClear the visible chat transcript',
      '/plant',
      '/plan-travel',
    ]);
    await expect(page.locator('.composer-skill-option').first()).toHaveClass(/active/);
    await next.press('Enter');
    await expect(next).toHaveValue('/deploy ');
  });
});

// spec/14 § Skill autocomplete — the list is re-read from the host on every
// open, so a skill created on the host mid-session shows up on the next `/`
// with no reload.
test.describe('composer skill menu — picks up skills added on the host', () => {
  test('re-opening the menu shows a skill that appeared since the last open', async ({ page }) => {
    let skills = ['plant', 'deploy'];
    await page.route('**/api/skills*', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ skills }),
      }),
    );
    await page.goto(CHAT);
    const input = page.getByTestId('composer-input');
    await input.fill('/');
    await expect(page.getByTestId('composer-skill-option-plant')).toBeVisible();
    await expect(page.getByTestId('composer-skill-option-brand-new')).toHaveCount(0);

    // The host gains a skill while the app stays open.
    skills = ['plant', 'deploy', 'brand-new'];

    // Filtering within the SAME open re-uses the list this open started with.
    await input.fill('/b');
    await expect(page.getByTestId('composer-skill-option-brand-new')).toHaveCount(0);

    // Closing and re-opening the menu re-reads it — no reload.
    await input.fill('');
    await expect(page.getByTestId('composer-skill-menu')).toHaveCount(0);
    await input.fill('/');
    await expect(page.getByTestId('composer-skill-option-brand-new')).toBeVisible();
  });
});
