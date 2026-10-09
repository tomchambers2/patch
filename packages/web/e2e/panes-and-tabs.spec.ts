import { test, expect, type Page, type Locator } from '@playwright/test';

// spec/14 § Panes and tabs — real-browser e2e for the parts that need actual
// pointer/DataTransfer/localStorage behaviour jsdom can't give: dragging a
// tab (reorder, move to another pane, split onto an edge), dragging a
// divider, persistence across a reload, and the keyboard shortcuts. Click/
// close/activate and the hide-when-trivial rule are covered more cheaply in
// src/__tests__/PaneArea.test.tsx.

const HARNESS = '/app/dev-harness.html?chat=chat_bus';

/** Pane tabs only — the sidebar's own Chats/Batch switch is ALSO `role="tab"`
 *  (spec/14 § Sidebar §1b), so a bare `getByRole('tab')` over-matches. */
function paneTabs(page: Page): Locator {
  return page.locator('.pane-tab');
}

/**
 * Right-click a sidebar row and wait for its context menu — retrying the
 * right-click itself (not the whole test) a few times first. This box runs
 * every agent's chats at once, and
 * a `contextmenu` landing in the same tick as this fixture's own live-updating
 * wake countdown can lose the race under that load; a stray right-click that
 * opens nothing is the symptom, not a product bug, and worth one retry rather
 * than a flaky spec.
 */
async function openRowMenu(page: Page, testId: string): Promise<void> {
  const row = page.getByTestId(testId);
  const menu = page.locator('[role="menu"]');
  for (let attempt = 0; attempt < 3; attempt++) {
    await row.click({ button: 'right' });
    try {
      await menu.waitFor({ state: 'visible', timeout: 3000 });
      return;
    } catch {
      /* retry */
    }
  }
  await menu.waitFor({ state: 'visible' });
}

test.describe('panes and tabs — opening', () => {
  test('a sidebar click replaces the active pane’s tab; middle-click opens a new one', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    // The common case: one pane, one tab, no tab bar at all.
    await expect(paneTabs(page)).toHaveCount(0);

    await page.getByTestId('chat-row-chat_md').click();
    // Still a single tab — the click REPLACED it, not added a second one —
    // and it's the one just clicked, not the one the harness opened with.
    await expect(paneTabs(page)).toHaveCount(0);
    await expect(page.locator('.chat-head-title .chat-title')).toHaveText('July Seasonal Food');

    await page.getByTestId('chat-row-chat_table').click({ button: 'middle' });
    const tabs = paneTabs(page);
    await expect(tabs).toHaveCount(2);
    await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
  });

  test('right-click → Open in new tab, then opening the SAME chat again focuses it rather than duplicating', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await openRowMenu(page, 'chat-row-chat_md');
    await page.getByText('Open in new tab').click();
    await expect(paneTabs(page)).toHaveCount(2);

    await page.getByTestId('chat-row-chat_bus').click();
    const tabs = paneTabs(page);
    await expect(tabs).toHaveCount(2); // not duplicated
    await expect(tabs.filter({ hasText: 'bus-watch' })).toHaveAttribute('aria-selected', 'true');
  });

  test('right-click → Open in new window pops a real window at /chats/:id', async ({ page }) => {
    await page.goto(HARNESS);
    await openRowMenu(page, 'chat-row-chat_md');
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      page.getByText('Open in new window').click(),
    ]);
    expect(new URL(popup.url()).pathname).toBe('/app/chats/chat_md');
    await popup.close();
  });
});

test.describe('panes and tabs — drag and drop', () => {
  test('dragging a tab reorders it within the bar', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('chat-row-chat_md').click({ button: 'middle' });
    await page.getByTestId('chat-row-chat_table').click({ button: 'middle' });
    const tabs = paneTabs(page);
    await expect(tabs).toHaveCount(3);
    const order = async (): Promise<(string | null)[]> =>
      tabs.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
    const before = await order();

    // Drag the LAST tab to the FIRST position.
    await tabs.nth(2).dragTo(tabs.nth(0), { targetPosition: { x: 2, y: 10 } });

    const after = await order();
    expect(after[0]).toBe(before[2]);
    expect(after).not.toEqual(before);
  });

  test('dragging a tab forward onto the right half of the next one lands it there, not at the end', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await page.getByTestId('chat-row-chat_md').click({ button: 'middle' });
    await page.getByTestId('chat-row-chat_table').click({ button: 'middle' });
    const tabs = paneTabs(page);
    await expect(tabs).toHaveCount(3);
    const ids = await tabs.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));

    const second = (await tabs.nth(1).boundingBox())!;
    await tabs.nth(0).dragTo(tabs.nth(1), { targetPosition: { x: second.width - 4, y: 10 } });

    const after = await tabs.evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
    expect(after).toEqual([ids[1], ids[0], ids[2]]);
  });

  test('dragging a tab onto another pane moves it there', async ({ page }) => {
    await page.goto(HARNESS);
    await openRowMenu(page, 'chat-row-chat_md');
    await page.getByText('Open to the side').click();
    await expect(page.locator('.pane')).toHaveCount(2);

    const leftPane = page.locator('.pane').first();
    const rightPane = page.locator('.pane').last();
    const leftTab = leftPane.locator('.pane-tab');
    await expect(leftTab).toHaveCount(1);
    await expect(rightPane.locator('.pane-tab')).toHaveCount(1);

    await leftTab.first().dragTo(rightPane.locator('.pane-content').first());

    // The left pane's only tab moved away — closing it collapses the split
    // back to one pane (spec/14 § Panes and tabs — "closing a pane's last
    // tab closes the pane").
    await expect(page.locator('.pane')).toHaveCount(1);
    await expect(paneTabs(page)).toHaveCount(2);
  });

  test('dragging a tab onto a pane edge splits it', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('chat-row-chat_md').click({ button: 'middle' });
    const tabs = paneTabs(page);
    await expect(tabs).toHaveCount(2);

    const content = page.locator('.pane-content').first();
    const box = (await content.boundingBox())!;
    await tabs.last().dragTo(content, {
      // Far right edge of the pane content — inside the 25% "right" drop zone.
      targetPosition: { x: box.width - 10, y: box.height / 2 },
    });

    await expect(page.locator('.pane')).toHaveCount(2);
    // One tab per pane now — still 2 bars (now a second PANE, not just a
    // second tab, has appeared; spec/14 § Panes and tabs shows a bar once
    // there's more than one pane, even with one tab each).
    await expect(paneTabs(page)).toHaveCount(2);
  });

  test('a divider drag resizes the two panes', async ({ page }) => {
    await page.goto(HARNESS);
    await openRowMenu(page, 'chat-row-chat_md');
    await page.getByText('Open to the side').click();

    const panes = page.locator('.pane');
    const beforeLeft = (await panes.first().boundingBox())!;
    const divider = page.locator('.pane-divider');
    const dBox = (await divider.boundingBox())!;

    await page.mouse.move(dBox.x + dBox.width / 2, dBox.y + dBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(dBox.x + 150, dBox.y + dBox.height / 2);
    await page.mouse.up();

    const afterLeft = (await panes.first().boundingBox())!;
    expect(afterLeft.width).toBeGreaterThan(beforeLeft.width + 50);
  });
});

test.describe('panes and tabs — persistence', () => {
  test('the whole layout survives a reload', async ({ page }) => {
    await page.goto(HARNESS);
    await openRowMenu(page, 'chat-row-chat_md');
    await page.getByText('Open to the side').click();
    await page.getByTestId('chat-row-chat_table').click({ button: 'middle' });
    await expect(page.locator('.pane')).toHaveCount(2);
    await expect(paneTabs(page)).toHaveCount(3);

    await page.reload();

    await expect(page.locator('.pane')).toHaveCount(2);
    await expect(paneTabs(page)).toHaveCount(3);
  });
});

test.describe('panes and tabs — keyboard', () => {
  test('⌘W closes the active tab', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('chat-row-chat_md').click({ button: 'middle' });
    await expect(paneTabs(page)).toHaveCount(2);
    await page.keyboard.press('Meta+w');
    await expect(paneTabs(page)).toHaveCount(0); // back to one tab, no bar
  });

  test('⌘⌥→ switches to the next tab', async ({ page }) => {
    await page.goto(HARNESS);
    await page.getByTestId('chat-row-chat_md').click({ button: 'middle' });
    const tabs = paneTabs(page);
    // The just-opened (second) tab is the active one; switch back to the
    // first before exercising the chord.
    await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
    await tabs.first().click();
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('Meta+Alt+ArrowRight');
    await expect(tabs.last()).toHaveAttribute('aria-selected', 'true');
  });

  test('⌘\\ splits the active pane', async ({ page }) => {
    await page.goto(HARNESS);
    await expect(page.locator('.pane')).toHaveCount(1);
    await page.keyboard.press('Meta+Backslash');
    await expect(page.locator('.pane')).toHaveCount(2);
  });
});
