import { test, expect } from '@playwright/test';

// "Hide chat" in the job editor (spec/14 § Jobs view — Hide chat, § Controls).
// It was a bare native <input type="checkbox"> inside a bare <label>, and the
// job editor styles every label as a column-flex stack so a text field can put
// its caption above its input. That rule caught this label too, so the box
// rendered centred on its own line floating above the words. Only a real
// browser can prove the fix: "are these two on the same line" is computed
// geometry, which jsdom does not do.

const FOLDER = '/home/tom/projects/bus';
const NEW_JOB = '/app/dev-harness.html?route=/jobs/new';

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

/** The switch's own label element — the `.toggle` <label> that wraps it. */
const CONTROL = '.job-editor label.toggle:has([data-testid="job-spawn-hidden"])';

test.describe('job editor — Hide chat is a toggle, laid out inline', () => {
  test('the switch and its label sit on one line, not stacked', async ({ page }) => {
    await stubJobApis(page);
    await page.goto(NEW_JOB);

    const control = page.locator(CONTROL);
    await expect(control).toBeVisible();

    const track = await control.locator('.toggle-track').boundingBox();
    const label = await control.locator('.toggle-label').boundingBox();
    if (track === null || label === null) throw new Error('toggle track or label has no box');

    // Same line: their vertical centres agree, within a couple of px of
    // optical alignment slack.
    const trackMid = track.y + track.height / 2;
    const labelMid = label.y + label.height / 2;
    expect(Math.abs(trackMid - labelMid)).toBeLessThanOrEqual(2);

    // Side by side, switch first — not the words with a box floating over them.
    expect(track.x + track.width).toBeLessThanOrEqual(label.x);
  });

  test('the whole control is one line tall', async ({ page }) => {
    await stubJobApis(page);
    await page.goto(NEW_JOB);

    const box = await page.locator(CONTROL).boundingBox();
    const name = await page.getByTestId('job-name').boundingBox();
    if (box === null || name === null) throw new Error('control or name field has no box');

    // Stacked, it was the switch's height plus the text's plus the gap. Inline,
    // it is the taller of the two — comfortably under a text field's height.
    expect(box.height).toBeLessThanOrEqual(28);
    expect(box.height).toBeLessThan(name.height);
  });

  test('it renders as a switch, not a native checkbox', async ({ page }) => {
    await stubJobApis(page);
    await page.goto(NEW_JOB);

    const input = page.getByTestId('job-spawn-hidden');
    await expect(input).toHaveAttribute('role', 'switch');

    // The real input is visually hidden behind the track, so it must not be
    // wearing the job editor's field chrome (border / padding / fill).
    const chrome = await input.evaluate((el) => {
      const s = getComputedStyle(el);
      return { opacity: s.opacity, borderWidth: s.borderTopWidth, padding: s.paddingTop };
    });
    expect(chrome.opacity).toBe('0');
    expect(chrome.borderWidth).toBe('0px');
    expect(chrome.padding).toBe('0px');

    // The track is what the user sees, and it flips accent-filled when on.
    const trackOff = await page.locator(`${CONTROL} .toggle-track`).evaluate((el) => {
      return getComputedStyle(el).backgroundColor;
    });
    await page.locator(CONTROL).click();
    await expect(input).toBeChecked();
    const trackOn = await page.locator(`${CONTROL} .toggle-track`).evaluate((el) => {
      return getComputedStyle(el).backgroundColor;
    });
    expect(trackOn).not.toBe(trackOff);
  });

  test('no bare native checkbox is left anywhere in the job editor', async ({ page }) => {
    await stubJobApis(page);
    await page.goto(NEW_JOB);
    await expect(page.locator('.job-editor form')).toBeVisible();

    // spec/14 § Controls — "No bare native checkboxes anywhere in the UI."
    // A checkbox is allowed only as the hidden input inside a .toggle.
    const bare = await page
      .locator('.job-editor input[type="checkbox"]:not(.toggle-input)')
      .count();
    expect(bare).toBe(0);
  });

  test('the text fields around it still stack caption above input', async ({ page }) => {
    await stubJobApis(page);
    await page.goto(NEW_JOB);

    // The fix must not have been "turn off the column stack for every label".
    const name = page.getByTestId('job-name');
    const caption = page.locator('.job-editor label:has([data-testid="job-name"])');
    const nameBox = await name.boundingBox();
    const captionBox = await caption.boundingBox();
    if (nameBox === null || captionBox === null) throw new Error('name field has no box');

    // The caption text sits above the input, so the label is taller than it.
    expect(captionBox.height).toBeGreaterThan(nameBox.height + 8);
    expect(nameBox.y).toBeGreaterThan(captionBox.y);
  });
});
