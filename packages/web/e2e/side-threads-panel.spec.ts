import { test, expect } from '@playwright/test';

// spec/14 § Side threads panel — the docked panel reads as one tidy column:
// tab strip, transcript, then composer pinned at the bottom, all inside the
// panel's own width, and sending from a draft doesn't hop to another tab.
const history = {
  events: [
    { type: 'chat.message', seq: 3, role: 'user', content: 'Why did you pick this approach?' },
    {
      type: 'chat.message',
      seq: 4,
      role: 'assistant',
      content: 'It keeps the change small and reuses the existing store.',
    },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.route('**/api/chats/*/history*', (r) => r.fulfill({ json: history }));
  await page.goto('/app/dev-harness.html?chat=chat_forked&sideThreads=1');
});

test('the panel lays out tabs, transcript and composer inside its own column', async ({ page }) => {
  const panel = page.getByTestId('side-threads-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('stp-msg')).toHaveCount(2);
  await page.screenshot({ path: 'test-results/side-threads-panel.png' });

  const p = (await panel.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(p.x + p.width).toBeLessThanOrEqual(viewport.width + 1);
  for (const id of ['stp-tabs', 'stp-composer-chat_forked-b2', 'stp-send-chat_forked-b2']) {
    const b = (await page.getByTestId(id).boundingBox())!;
    expect(b.x).toBeGreaterThanOrEqual(p.x - 1);
    expect(b.x + b.width).toBeLessThanOrEqual(p.x + p.width + 1);
    expect(b.y + b.height).toBeLessThanOrEqual(p.y + p.height + 1);
  }
  // Composer sits below the transcript.
  const stream = (await page.getByTestId('stp-stream-chat_forked-b2').boundingBox())!;
  const composer = (await page.getByTestId('stp-composer-chat_forked-b2').boundingBox())!;
  expect(composer.y).toBeGreaterThanOrEqual(stream.y + stream.height - 1);
});

test('sending a message in a tab stays on that tab', async ({ page }) => {
  await page.getByTestId('stp-composer-chat_forked-b2').fill('and what about X?');
  await page.getByTestId('stp-send-chat_forked-b2').click();
  await expect(page.getByTestId('stp-body-chat_forked-b2')).toBeVisible();
  await expect(page.getByTestId('stp-tab-chat_forked-b2')).toHaveClass(/active/);
  await expect(page).toHaveURL(/chat=chat_forked/);
});

test('the panel follows the chat in the focused tab, hiding for others and returning with it', async ({
  page,
}) => {
  const panel = page.getByTestId('side-threads-panel');
  await expect(panel).toBeVisible();
  await page.getByTestId('chat-row-chat_md').click({ button: 'middle' });
  await expect(page.locator('.pane-tab')).toHaveCount(2);
  await expect(panel).toHaveCount(0);

  // Splitting the only pane must not break the render either.
  await page.keyboard.press('Meta+\\');
  await expect(page.locator('.pane')).toHaveCount(2);
  await page.locator('.pane-tab', { hasText: 'forked-fixture' }).click();
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('stp-tab-chat_forked-b2')).toBeVisible();
});
