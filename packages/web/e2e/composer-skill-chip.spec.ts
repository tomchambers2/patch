import { test, expect, type Page } from '@playwright/test';

// spec/14 § Skill autocomplete — a completed `/<skill>` becomes a chip
// anywhere in the message, with the same preview the `/` list shows (Patch
// Updates: "patch skill becomes a chip anywhere in the composer, with
// preview").

const CHAT = '/app/dev-harness.html?chat=chat_skill';
const CHAT_FAKE_WS = '/app/dev-harness.html?chat=chat_skill&ws=fake';

/** Frames the surface has sent, as the harness records them (see submit-chord.spec.ts). */
async function sent(page: Page): Promise<Array<{ type: string; [k: string]: unknown }>> {
  return page.evaluate(() => (window as unknown as { __wsSent: Array<{ type: string }> }).__wsSent);
}

async function stubSkillsApi(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/skills**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        skills: ['plant'],
        paths: { plant: '/home/tom/projects/bus/.claude/skills/plant/SKILL.md' },
        descriptions: { plant: 'Sow what is in season.' },
        frontmatter: {
          plant: { name: 'plant', description: 'Sow what is in season.', 'user-invocable': 'true' },
        },
      }),
    }),
  );
}

test.describe('composer skill chip', () => {
  test('mid-message `/` opens the list, and completing it makes a chip', async ({ page }) => {
    await stubSkillsApi(page);
    await page.goto(CHAT);

    const input = page.getByTestId('composer-input');
    await input.fill('please run /pl');
    await expect(page.getByTestId('composer-skill-option-plant')).toBeVisible();

    await page.getByTestId('composer-skill-option-plant').click();
    await expect(input).toHaveValue('please run /plant ');

    const chip = page.getByTestId('composer-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText('/plant');
  });

  test('typing the exact name then a space makes a chip without the menu', async ({ page }) => {
    await stubSkillsApi(page);
    await page.goto(CHAT);

    const input = page.getByTestId('composer-input');
    await input.fill('/plant ');
    await expect(page.getByTestId('composer-chip')).toBeVisible();
    await expect(page.getByTestId('composer-skill-menu')).toHaveCount(0);
  });

  test('hovering the chip shows the same preview as the `/` list', async ({ page }) => {
    await stubSkillsApi(page);
    await page.goto(CHAT);

    const input = page.getByTestId('composer-input');
    await input.fill('see /plant for details');
    const chip = page.getByTestId('composer-chip');
    await expect(chip).toBeVisible();

    await chip.hover();
    const preview = page.getByTestId('composer-chip-preview-popover');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('Sow what is in season.');
    await expect(preview).toContainText('user-invocable');

    await page.mouse.move(0, 0);
    await expect(preview).toHaveCount(0);
  });

  test('Backspace right after a chip removes the whole thing in one press', async ({ page }) => {
    await stubSkillsApi(page);
    await page.goto(CHAT);

    const input = page.getByTestId('composer-input');
    await input.fill('run /plant now');
    await expect(page.getByTestId('composer-chip')).toBeVisible();

    // Land the caret right after the chip's trailing space (before "now").
    await input.click();
    await input.press('Home');
    for (let i = 0; i < 'run /plant '.length; i++) await input.press('ArrowRight');
    await input.press('Backspace');

    await expect(input).toHaveValue('run now');
    await expect(page.getByTestId('composer-chip')).toHaveCount(0);
  });

  test('what is sent is the literal text, chip and all', async ({ page }) => {
    await stubSkillsApi(page);
    await page.goto(CHAT_FAKE_WS);

    const input = page.getByTestId('composer-input');
    await input.fill('please run /plant now');
    await expect(page.getByTestId('composer-chip')).toBeVisible();
    await input.press('Enter');

    // The wire frame carries the same literal text — a chip is compose-time
    // decoration only, never a rewrite of what is actually sent.
    await expect
      .poll(async () => (await sent(page)).filter((e) => e.type === 'chat.input').length)
      .toBe(1);
    const frame = (await sent(page)).find((e) => e.type === 'chat.input')!;
    expect(frame['message']).toBe('please run /plant now');
  });

  test('a chip already in the draft survives a reload', async ({ page }) => {
    await stubSkillsApi(page);
    await page.goto(CHAT);

    const input = page.getByTestId('composer-input');
    await input.fill('remember to /plant later');
    await expect(page.getByTestId('composer-chip')).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('composer-input')).toHaveValue('remember to /plant later');
    await expect(page.getByTestId('composer-chip')).toBeVisible();
  });
});
