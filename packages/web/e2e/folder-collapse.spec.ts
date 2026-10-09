import { test, expect, type Page } from '@playwright/test';

// spec/14 § Sidebar §4 — a project folds its chat rows away, leaving just its
// header and a count of what is hidden, and stays folded across a reload.
// Driven against the dev harness (real Sidebar + real CSS, no backend).
const HARNESS = '/app/dev-harness.html?chat=thread_manager';

// The seeded projects. Collapse is keyed on the FULL PATH, so these are the
// testid suffixes too.
const BUS = '/home/tom/projects/bus';
const PORTFOLIO = '/home/tom/projects/portfolio';

/** The rows drawn under one project's header. */
function folderRows(page: Page, folder: string) {
  return page
    .locator('.sb-folder')
    .filter({ has: page.getByTestId(`folder-collapse-${folder}`) })
    .locator('.sb-row');
}

test.describe('collapsing a project', () => {
  test('folds the rows away, keeps the header, and counts what is hidden', async ({ page }) => {
    await page.goto(HARNESS);
    const rows = folderRows(page, BUS);
    const before = await rows.count();
    expect(before).toBeGreaterThan(1);
    await expect(page.getByTestId('chat-row-chat_bus')).toBeVisible();
    // Nothing is counted while the project is open — the count IS the fold.
    await expect(page.getByTestId(`folder-count-${BUS}`)).toHaveCount(0);

    await page.getByTestId(`folder-collapse-${BUS}`).click();

    await expect(rows).toHaveCount(0);
    await expect(page.getByTestId('chat-row-chat_bus')).toHaveCount(0);
    // The header survives the fold, still naming the project.
    const toggle = page.getByTestId(`folder-collapse-${BUS}`);
    await expect(toggle).toBeVisible();
    await expect(toggle.locator('.folder-head-label')).toHaveText(/bus/i);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId(`folder-count-${BUS}`)).toHaveText(String(before));
  });

  test('leaves every other project alone', async ({ page }) => {
    await page.goto(HARNESS);
    const portfolioBefore = await folderRows(page, PORTFOLIO).count();
    expect(portfolioBefore).toBeGreaterThan(1);

    await page.getByTestId(`folder-collapse-${BUS}`).click();

    await expect(folderRows(page, BUS)).toHaveCount(0);
    await expect(folderRows(page, PORTFOLIO)).toHaveCount(portfolioBefore);
    await expect(page.getByTestId('chat-row-chat_md')).toBeVisible();
    await expect(page.getByTestId(`folder-count-${PORTFOLIO}`)).toHaveCount(0);
  });

  test('survives a reload, and unfolds again on a second click', async ({ page }) => {
    await page.goto(HARNESS);
    const before = await folderRows(page, BUS).count();
    await page.getByTestId(`folder-collapse-${BUS}`).click();
    await expect(folderRows(page, BUS)).toHaveCount(0);

    await page.reload();

    await expect(page.getByTestId(`folder-count-${BUS}`)).toHaveText(String(before));
    await expect(folderRows(page, BUS)).toHaveCount(0);
    await expect(folderRows(page, PORTFOLIO).first()).toBeVisible();

    await page.getByTestId(`folder-collapse-${BUS}`).click();
    await expect(folderRows(page, BUS)).toHaveCount(before);
    await expect(page.getByTestId(`folder-count-${BUS}`)).toHaveCount(0);
  });

  test('a state filter suspends the fold, and it comes back when the filter comes off', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await page.getByTestId(`folder-collapse-${BUS}`).click();
    await expect(folderRows(page, BUS)).toHaveCount(0);

    // Filtering is the user asking to see a set of chats: a fold that hid one
    // of the matches would read as the filter having missed it.
    await page.getByTestId('state-filter').selectOption('working');
    const matches = await folderRows(page, BUS).count();
    expect(matches).toBeGreaterThan(0);
    await expect(page.getByTestId(`folder-count-${BUS}`)).toHaveCount(0);

    // The fold is suspended, not cleared.
    await page.getByTestId('state-filter').selectOption('all');
    await expect(folderRows(page, BUS)).toHaveCount(0);
    await expect(page.getByTestId(`folder-count-${BUS}`)).toBeVisible();
  });

  // A collapsed project's rows are out of the shift-click order (spec/14 §4) —
  // the range is what the user can see, which is the rule that order was
  // published under in the first place.
  test('a shift-click range skips over a collapsed project', async ({ page }) => {
    await page.goto(HARNESS);
    const heads = page.locator('.folder-head-toggle');
    // Folders are ordered by activity, so read the drawn order rather than
    // assuming it. Need one to collapse BETWEEN the anchor and the target.
    const paths = await heads.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-testid')!.replace('folder-collapse-', '')),
    );
    expect(paths.length).toBeGreaterThanOrEqual(3);
    const [first, middle, last] = [paths[0]!, paths[1]!, paths[2]!];

    await page.getByTestId(`folder-collapse-${middle}`).click();
    const hidden = Number(await page.getByTestId(`folder-count-${middle}`).innerText());
    expect(hidden).toBeGreaterThan(0);

    await folderRows(page, first).first().click();
    await folderRows(page, last)
      .first()
      .click({ modifiers: ['Shift'] });

    // Every selected row is one the user can actually see.
    const selectedRows = await page.locator('.sb-row[aria-selected="true"]').count();
    await expect(page.getByTestId('selection-count')).toHaveText(`${selectedRows} selected`);
    // The fold still holds — nothing in it was swept into the range.
    await expect(folderRows(page, middle)).toHaveCount(0);
    await expect(page.getByTestId(`folder-count-${middle}`)).toHaveText(String(hidden));
  });

  test('the header stays one row — the count does not push the archive buttons out', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await page.getByTestId(`folder-collapse-${BUS}`).click();
    const head = page
      .locator('.sb-folder')
      .filter({ has: page.getByTestId(`folder-collapse-${BUS}`) })
      .locator('.folder-head');
    await head.hover();
    const headBox = (await head.boundingBox())!;
    const countBox = (await page.getByTestId(`folder-count-${BUS}`).boundingBox())!;
    const archiveBox = (await page.getByTestId(`folder-archive-${BUS}`).boundingBox())!;
    // Count then archive cluster, both inside the header, on one line.
    expect(countBox.x + countBox.width).toBeLessThanOrEqual(archiveBox.x + 1);
    expect(archiveBox.x + archiveBox.width).toBeLessThanOrEqual(headBox.x + headBox.width + 1);
    expect(headBox.height).toBeLessThan(40);
  });
});
