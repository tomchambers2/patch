import { test, expect } from '@playwright/test';

// "link to the skill from the job page so easy to edit" (spec/14 § Jobs view).
// A job names the skill it runs; changing what the job DOES should not mean
// leaving Patch to hunt down a SKILL.md by hand. Only a real browser can prove
// the whole path end to end: the link opens the skill's own file as its own
// pane tab (the rich document editor by default — spec/14 § Document editor,
// § Panes and tabs), with the file's real content in it and editable.
//
// `?fileStub=skill` mounts the harness's in-memory file API WITHOUT opening a
// Files tab over the job editor form this spec is actually driving (spec/14 §
// Panes and tabs: a file tab would replace whichever tab is active, and
// there is only one pane here).

// The harness's most-recently-used (host, folder) pair — what a new job seeds
// to, and where `chat_bus` sits, so a chat exists to open the file through.
const FOLDER = '/home/tom/projects/bus';
const NEW_JOB = '/app/dev-harness.html?route=/jobs/new&fileStub=skill';

async function stubJobApis(
  page: import('@playwright/test').Page,
  skills: { skills: string[]; paths?: Record<string, string> },
): Promise<void> {
  await page.route('**/api/folders**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hosts: [{ daemonId: 'd1', roots: [FOLDER], recent: [] }] }),
    }),
  );
  await page.route('**/api/skills**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(skills),
    }),
  );
  await page.route('**/api/jobs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: [] }),
    }),
  );
}

test.describe('job editor — Edit link on the chosen skill', () => {
  test('opens the skill’s own file in the editor, with its content, ready to edit', async ({
    page,
  }) => {
    await stubJobApis(page, {
      skills: ['plant'],
      paths: { plant: `${FOLDER}/.claude/skills/plant/SKILL.md` },
    });
    await page.goto(NEW_JOB);

    const skill = page.getByTestId('job-spawn-skill');
    await expect(skill.locator('option[value="plant"]')).toHaveCount(1);
    await skill.selectOption('plant');

    const edit = page.getByTestId('job-spawn-skill-edit');
    await expect(edit).toBeVisible();
    await edit.click();

    // spec/14 § Panes and tabs: the link opens the skill's own file as its
    // own tab, showing its real content.
    const editor = page.getByTestId('browse-editor');
    await expect(editor).toBeVisible();
    await expect(editor).toContainText('SKILL.md');
    // Its real content is loaded — not an empty editor, and not another file's.
    await expect(editor).toContainText('Sow what is in season');
    // Editable and saveable, which is the point of the link.
    await expect(page.getByTestId('browse-save')).toBeVisible();
  });

  test('says why rather than offering a link the file browser cannot honour', async ({ page }) => {
    // A machine-wide `~/.claude/skills` skill is outside the chat folder the
    // browser is rooted at, so there is no link to give. NO FALLBACK — the
    // reason is stated instead of a link that would fail on click.
    await stubJobApis(page, {
      skills: ['plant'],
      paths: { plant: '/home/tom/.claude/skills/plant.md' },
    });
    await page.goto(NEW_JOB);
    await page.getByTestId('job-spawn-skill').selectOption('plant');
    await expect(page.getByTestId('job-spawn-skill-edit')).toHaveCount(0);
    await expect(page.getByTestId('job-spawn-skill-edit-unavailable')).toContainText(
      'outside this folder',
    );
  });
});
