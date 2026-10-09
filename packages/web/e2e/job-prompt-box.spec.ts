import { test, expect } from '@playwright/test';

// "larger box for skill/prompt editor in jobs" (spec/14 § Jobs view — Prompt).
// A job's prompt is usually several paragraphs of instructions, but the field
// was a bare <textarea>, so the browser gave it its 2-row default: writing or
// reviewing a prompt meant scrolling a two-line slot. Only a real browser can
// prove the fix — `rows` and a class name are markup, the height a user
// actually gets is computed style, which jsdom does not do.

const FOLDER = '/home/tom/projects/bus';
const NEW_JOB = '/app/dev-harness.html?route=/jobs/new';

/** A single-line <input> on the same form — the "small field" baseline. */
const SINGLE_LINE = 'job-name';

async function stubJobApis(page: import('@playwright/test').Page): Promise<void> {
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
      body: JSON.stringify({ skills: ['plant'], paths: {} }),
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

test.describe('job editor — the Prompt box is big enough to write a prompt in', () => {
  test('the spawn Prompt box opens tall, and far taller than a single-line field', async ({
    page,
  }) => {
    await stubJobApis(page);
    await page.goto(NEW_JOB);

    const prompt = page.getByTestId('job-spawn-prompt');
    await expect(prompt).toBeVisible();

    const box = await prompt.boundingBox();
    const name = await page.getByTestId(SINGLE_LINE).boundingBox();
    if (box === null || name === null) throw new Error('prompt or name field has no box');

    // A real editing box, not a slot. 200px is roughly ten lines at this
    // font size — enough to hold a whole short prompt on screen at once.
    expect(box.height).toBeGreaterThanOrEqual(200);
    expect(box.height).toBeGreaterThan(name.height * 4);
  });

  test('a long prompt fits without the box collapsing to a scroll-slot', async ({ page }) => {
    await stubJobApis(page);
    await page.goto(NEW_JOB);

    const prompt = page.getByTestId('job-spawn-prompt');
    const before = await prompt.boundingBox();
    await prompt.fill(
      Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1} of the job's instructions.`).join(
        '\n',
      ),
    );
    const after = await prompt.boundingBox();
    if (before === null || after === null) throw new Error('prompt has no box');

    // Typing must not shrink the field, and the box stays tall enough that most
    // of a 12-line prompt is on screen rather than hidden behind its scrollbar.
    expect(after.height).toBeGreaterThanOrEqual(before.height);
    expect(after.height).toBeGreaterThanOrEqual(200);
  });

  test('it can be dragged taller but never wider than the form column', async ({ page }) => {
    await stubJobApis(page);
    await page.goto(NEW_JOB);

    const prompt = page.getByTestId('job-spawn-prompt');
    const resize = await prompt.evaluate((el) => getComputedStyle(el).resize);
    expect(resize).toBe('vertical');

    // Widening would break the field out of the 600px form column, so the
    // field must not already exceed the form it sits in.
    const box = await prompt.boundingBox();
    const form = await page.locator('.job-editor form').boundingBox();
    if (box === null || form === null) throw new Error('prompt or form has no box');
    expect(box.width).toBeLessThanOrEqual(form.width + 1);
  });

  test('the taller box does not strand Save — the panel still scrolls to it', async ({ page }) => {
    await stubJobApis(page);
    await page.goto(NEW_JOB);

    const save = page.getByTestId('job-save');
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
  });

  test('the message action gets the same large Prompt box', async ({ page }) => {
    await stubJobApis(page);
    await page.goto(NEW_JOB);

    const spawnHeight = (await page.getByTestId('job-spawn-prompt').boundingBox())?.height;
    await page.getByTestId('job-action-type').selectOption('message');

    const prompt = page.getByTestId('job-message-prompt');
    await expect(prompt).toBeVisible();
    const box = await prompt.boundingBox();
    if (box === null || spawnHeight === undefined) throw new Error('a prompt box is missing');
    expect(box.height).toBeCloseTo(spawnHeight, 0);
  });

  test('the JSONata filter box stays small — only the Prompt grew', async ({ page }) => {
    await stubJobApis(page);
    await page.goto(NEW_JOB);
    await page.getByTestId('job-trigger-type').selectOption('webhook');

    const filter = page.getByTestId('job-filter');
    await expect(filter).toBeVisible();
    const filterBox = await filter.boundingBox();
    const promptBox = await page.getByTestId('job-spawn-prompt').boundingBox();
    if (filterBox === null || promptBox === null) throw new Error('a box is missing');
    expect(filterBox.height).toBeLessThan(promptBox.height);
  });
});
