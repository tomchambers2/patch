import { test, expect, type Page, type Route } from '@playwright/test';
import type { WireEvent } from '@patch/wire';

// Todoist "patch submitting message with an image doesnt go through
// immediately. should react immediately, show as pending" — spec/15 § Composer
// → Attachments on web/desktop. In a real browser, against a real (held)
// upload request: Send clears the composer and the message is in the stream at
// once, its image drawn from the local copy and marked `Uploading 0/1`; the
// turn goes out only once the upload lands. A failed upload stays as `Not
// uploaded` with Retry.
const HARNESS = '/app/dev-harness.html?chat=chat_md&ws=fake';

async function attachPng(page: Page, name: string): Promise<void> {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 40;
    c.height = 30;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#c33';
    ctx.fillRect(0, 0, 40, 30);
    return c.toDataURL('image/png');
  });
  await page.setInputFiles('[data-testid="composer-file-input"]', {
    name,
    mimeType: 'image/png',
    buffer: Buffer.from(dataUrl.split(',')[1]!, 'base64'),
  });
}

async function inputs(page: Page): Promise<Array<Extract<WireEvent, { type: 'chat.input' }>>> {
  return page.evaluate(() =>
    (window as unknown as { __wsSent: WireEvent[] }).__wsSent.filter(
      (e) => e.type === 'chat.input',
    ),
  ) as never;
}

/** Hold every attachment upload until the test releases it. */
async function holdUploads(page: Page): Promise<Array<Route>> {
  const held: Route[] = [];
  await page.route('**/api/chats/*/attachment', (route) => {
    held.push(route);
  });
  return held;
}

const okBody = (id: string, name: string) =>
  JSON.stringify({
    ok: true,
    ref: {
      id,
      name,
      mimeType: 'image/png',
      kind: 'image',
      url: `/api/chats/chat_md/attachment/${id}`,
    },
  });

test('a message with an image shows at once, pending, and is sent once the upload lands', async ({
  page,
}) => {
  const held = await holdUploads(page);
  await page.goto(HARNESS);
  await page.getByTestId('composer-input').fill('what is this?');
  await attachPng(page, 'shot.png');
  await expect(page.getByTestId('composer-attachment')).toHaveCount(1);
  await page.getByTestId('send-btn').click();

  // At once: composer empty, message in the stream, pending, with its image.
  await expect(page.getByTestId('composer-input')).toHaveValue('');
  await expect(page.getByTestId('composer-attachment')).toHaveCount(0);
  const msg = page.locator('.msg-user', { hasText: 'what is this?' });
  await expect(msg).toBeVisible();
  await expect(msg).toHaveClass(/sending/);
  await expect(msg.getByTestId('upload-status')).toHaveText('Uploading 0/1');
  const img = msg.getByRole('img', { name: 'shot.png' });
  await expect(img).toHaveAttribute('src', /^blob:/);
  // The local copy actually decoded and painted.
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBe(40);
  expect(await inputs(page)).toHaveLength(0);

  await expect.poll(() => held.length).toBe(1);
  await held[0]!.fulfill({
    status: 200,
    contentType: 'application/json',
    body: okBody('a1', 'shot.png'),
  });

  await expect(msg.getByTestId('upload-status')).toHaveCount(0);
  await expect.poll(async () => (await inputs(page)).length).toBe(1);
  const [input] = await inputs(page);
  expect(input).toMatchObject({
    chatId: 'chat_md',
    message: 'what is this?',
    attachments: [{ id: 'a1', name: 'shot.png', kind: 'image' }],
  });
});

test('a failed upload stays as Not uploaded, and Retry sends it', async ({ page }) => {
  const held = await holdUploads(page);
  await page.goto(HARNESS);
  await page.getByTestId('composer-input').fill('second try');
  await attachPng(page, 'retry.png');
  await page.getByTestId('send-btn').click();
  const msg = page.locator('.msg-user', { hasText: 'second try' });

  await expect.poll(() => held.length).toBe(1);
  await held[0]!.fulfill({
    status: 500,
    contentType: 'application/json',
    body: '{"error":"disk full"}',
  });
  await expect(msg.getByTestId('upload-status')).toHaveText('Not uploaded');
  await expect(msg.getByTestId('upload-retry')).toBeVisible();
  await expect(msg.getByTestId('upload-discard')).toBeVisible();

  await msg.getByTestId('upload-retry').click();
  await expect(msg.getByTestId('upload-status')).toHaveText('Uploading 0/1');
  await expect.poll(() => held.length).toBe(2);
  await held[1]!.fulfill({
    status: 200,
    contentType: 'application/json',
    body: okBody('r1', 'retry.png'),
  });
  await expect.poll(async () => (await inputs(page)).length).toBe(1);
  expect((await inputs(page))[0]).toMatchObject({
    message: 'second try',
    attachments: [{ id: 'r1' }],
  });
});
