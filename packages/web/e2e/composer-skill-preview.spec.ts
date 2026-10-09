import { test, expect } from '@playwright/test';

// spec/14 § Skill autocomplete — the highlighted row in the composer's `/`
// list gets a preview panel beside it: full description, the rest of the
// frontmatter, and an Edit link (the same mechanism `tool-call-skill-link.spec.ts`
// proves end to end for the transcript's Skill tool-call link).

// `chat_skill`'s folder (`/home/tom/projects/bus`) is the same one
// `?fileStub=skill`'s stub tree uses, which already has a real
// `.claude/skills/plant/SKILL.md` — stubbed WITHOUT opening a Files tab over
// the composer this spec is actually testing (spec/14 § Panes and tabs: a
// file now opens as its own tab, which would replace the chat tab the
// composer lives in).
const CHAT = '/app/dev-harness.html?chat=chat_skill&fileStub=skill';

async function stubSkillsApi(
  page: import('@playwright/test').Page,
  skills: {
    skills: string[];
    paths?: Record<string, string>;
    descriptions?: Record<string, string>;
    frontmatter?: Record<string, Record<string, string>>;
  },
): Promise<void> {
  await page.route('**/api/skills**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(skills),
    }),
  );
}

test.describe('composer skill menu — preview panel', () => {
  test('shows the description on a second line, and the full preview beside the highlighted row', async ({
    page,
  }) => {
    await stubSkillsApi(page, {
      skills: ['plant'],
      paths: { plant: '/home/tom/projects/bus/.claude/skills/plant/SKILL.md' },
      descriptions: { plant: 'Sow what is in season.' },
      frontmatter: {
        plant: {
          name: 'plant',
          description: 'Sow what is in season.',
          'user-invocable': 'true',
        },
      },
    });
    await page.goto(CHAT);

    const input = page.getByTestId('composer-input');
    await input.fill('/plant');

    const option = page.getByTestId('composer-skill-option-plant');
    await expect(option).toBeVisible();
    await expect(option.locator('.composer-skill-desc')).toHaveText('Sow what is in season.');

    const preview = page.getByTestId('composer-skill-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('Sow what is in season.');
    await expect(preview).toContainText('user-invocable');
    await expect(preview).toContainText('true');

    // Beside the list, not above it, on a desktop-width viewport.
    const menuBox = await page.getByTestId('composer-skill-menu').boundingBox();
    const previewBox = await preview.boundingBox();
    expect(menuBox && previewBox && previewBox.x >= menuBox.x + menuBox.width - 1).toBe(true);

    await page.getByTestId('composer-skill-preview-edit').click();
    // spec/14 § Panes and tabs: the Edit link opens the skill's file as its
    // own tab, not a docked rail.
    const editor = page.getByTestId('browse-editor');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await expect(editor).toContainText('SKILL.md');
  });

  test('a skill with no frontmatter shows no preview beyond its name and Edit link', async ({
    page,
  }) => {
    await stubSkillsApi(page, {
      skills: ['plant'],
      paths: { plant: '/home/tom/projects/bus/.claude/skills/plant/SKILL.md' },
    });
    await page.goto(CHAT);

    const input = page.getByTestId('composer-input');
    await input.fill('/plant');

    const option = page.getByTestId('composer-skill-option-plant');
    await expect(option).toBeVisible();
    await expect(option.locator('.composer-skill-desc')).toHaveCount(0);

    const preview = page.getByTestId('composer-skill-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('plant');
    await expect(page.getByTestId('composer-skill-preview-desc')).toHaveCount(0);
    await expect(page.getByTestId('composer-skill-preview-fields')).toHaveCount(0);
    await expect(page.getByTestId('composer-skill-preview-edit')).toBeVisible();
  });
});
