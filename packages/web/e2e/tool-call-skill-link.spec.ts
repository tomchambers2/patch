import { test, expect } from '@playwright/test';

// spec/14 ## Main chat panel — a `Skill` tool call's row names the skill and
// links straight to its own `SKILL.md` (the same Edit-link mechanism the Jobs
// view's Skill field already offers — `job-skill-edit-link.spec.ts`), with a
// tooltip carrying the skill's frontmatter description. Only a real browser
// proves the whole path end to end: the link opens a Monaco file tab, on the
// skill's own file, with the file's real content in it.

// `chat_skill`'s seeded timeline (dev-harness.tsx) is one `Skill` tool call
// naming `plant`, on the same folder `?fileStub=skill`'s stub tree uses —
// which already has `.claude/skills/plant/SKILL.md`. `fileStub`, not
// `editor=browse`: the file now opens as its own tab (spec/14 § Panes and
// tabs), which would replace the chat tab the link itself lives in.
const CHAT = '/app/dev-harness.html?chat=chat_skill&fileStub=skill';

async function stubSkillsApi(
  page: import('@playwright/test').Page,
  skills: {
    skills: string[];
    paths?: Record<string, string>;
    descriptions?: Record<string, string>;
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

test.describe('chat transcript — Skill tool call link', () => {
  test('shows a link with the description as its tooltip, and opens the skill file on click', async ({
    page,
  }) => {
    await stubSkillsApi(page, {
      skills: ['plant'],
      paths: { plant: '/home/tom/projects/bus/.claude/skills/plant/SKILL.md' },
      descriptions: { plant: 'Sow what is in season.' },
    });
    await page.goto(CHAT);
    // Nothing has opened a file tab yet — the click under test is what does.
    await expect(page.getByTestId('browse-editor')).toHaveCount(0);

    const link = page.getByTestId('tool-call-skill-link');
    await expect(link).toBeVisible();
    await expect(link).toContainText('plant');
    await expect(link).toHaveAttribute('title', 'Sow what is in season.');

    await link.click();

    // spec/14 § Panes and tabs: the link opens the skill's own file as its
    // own tab. Monaco is lazy-loaded, and a cold dev server can take a while
    // to serve that chunk the first time — same generous timeout
    // job-script-gate.spec.ts uses for the same reason.
    const editor = page.getByTestId('browse-editor');
    await expect(editor).toBeVisible({ timeout: 20_000 });
    await expect(editor).toContainText('SKILL.md');
    // Its real content is loaded — not an empty editor, and not another file's.
    await expect(editor).toContainText('Sow what is in season');
  });

  test('says why rather than offering a link the file browser cannot honour', async ({ page }) => {
    // A machine-wide `~/.claude/skills` skill is outside the chat folder the
    // browser is rooted at, so there is no link to give. NO FALLBACK — the
    // reason is stated instead of a link that would fail on click.
    await stubSkillsApi(page, {
      skills: ['plant'],
      paths: { plant: '/home/tom/.claude/skills/plant.md' },
      descriptions: { plant: 'Sow what is in season.' },
    });
    await page.goto(CHAT);

    await expect(page.getByTestId('tool-call-skill-link')).toHaveCount(0);
    await expect(page.getByTestId('tool-call-skill-unavailable')).toContainText(
      'outside this folder',
    );
  });
});
