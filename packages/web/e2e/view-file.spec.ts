import { test, expect } from '@playwright/test';

// spec/14 § Viewing files — `view_file` shows a file to the USER, so its row IS
// the file: a sandboxed frame with the filename and an expand control above it,
// not a disclosure that has to be opened first. The inverse of `Read`, which
// pulls bytes into the agent's context.
const VIEW_FILE_CHAT = '/app/dev-harness.html?chat=chat_view_file';
const VIEW_FILE_IMAGE_CHAT = '/app/dev-harness.html?chat=chat_view_file_image';
const VIEW_FILE_PDF_CHAT = '/app/dev-harness.html?chat=chat_view_file_pdf';

// A 1x1 red PNG, served for the artifact URL so the <img> really decodes.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test.describe('view_file', () => {
  test('renders the file inline in a sandboxed frame, no disclosure to open', async ({ page }) => {
    await page.goto(VIEW_FILE_CHAT);

    const card = page.getByTestId('view-file');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-kind', 'html');
    // It replaces the ordinary tool row entirely — nothing to expand first.
    await expect(page.getByTestId('tool-call')).toHaveCount(0);
    await expect(page.getByTestId('tool-result')).toHaveCount(0);

    // The frame points at the published page and is sandboxed WITHOUT
    // allow-same-origin, so agent-named content cannot reach the SPA's
    // stored credential.
    const frame = page.getByTestId('view-file-frame');
    await expect(frame).toHaveAttribute('src', '/api/chats/chat_view_file/artifact/deadbeef');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');

    // The filename labels it, and there is a direct open-in-new-tab route.
    await expect(page.getByTestId('view-file-expand')).toContainText('plants.html');
    await expect(page.getByTestId('view-file-open')).toHaveAttribute(
      'href',
      '/api/chats/chat_view_file/artifact/deadbeef',
    );
  });

  test('expands to a taller frame', async ({ page }) => {
    await page.goto(VIEW_FILE_CHAT);
    const card = page.getByTestId('view-file');
    await expect(card).toHaveAttribute('data-expanded', 'false');
    const before = (await page.getByTestId('view-file-frame').boundingBox())!.height;

    await page.getByTestId('view-file-expand').click();
    await expect(card).toHaveAttribute('data-expanded', 'true');
    const after = (await page.getByTestId('view-file-frame').boundingBox())!.height;
    expect(after).toBeGreaterThan(before);
  });

  test('an image result renders as a picture and opens the full-screen lightbox', async ({
    page,
  }) => {
    await page.route('**/api/chats/*/artifact/*', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PNG }),
    );
    await page.goto(VIEW_FILE_IMAGE_CHAT);

    const card = page.getByTestId('view-file');
    await expect(card).toHaveAttribute('data-kind', 'image');
    // No sandboxed frame and no height-expand control for an image — the
    // lightbox is how it gets seen full-size.
    await expect(page.getByTestId('view-file-frame')).toHaveCount(0);
    await expect(page.getByTestId('view-file-expand')).toHaveCount(0);

    const picture = page.getByTestId('view-file-image');
    await expect(picture.locator('img')).toHaveAttribute(
      'src',
      '/api/chats/chat_view_file_image/artifact/beef01',
    );

    await picture.click();
    const lightbox = page.getByTestId('image-lightbox');
    await expect(lightbox).toBeVisible();
    await expect(lightbox.locator('img')).toHaveAttribute(
      'src',
      '/api/chats/chat_view_file_image/artifact/beef01',
    );

    await page.keyboard.press('Escape');
    await expect(lightbox).toHaveCount(0);
  });

  test('a PDF result renders in the same sandboxed frame as an HTML page', async ({ page }) => {
    await page.goto(VIEW_FILE_PDF_CHAT);

    const card = page.getByTestId('view-file');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-kind', 'pdf');
    await expect(page.getByTestId('tool-call')).toHaveCount(0);
    await expect(page.getByTestId('tool-result')).toHaveCount(0);

    // Not the image/lightbox path: a sandboxed frame, same as HTML.
    const frame = page.getByTestId('view-file-frame');
    await expect(frame).toHaveAttribute('src', '/api/chats/chat_view_file_pdf/artifact/pdf001');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(page.getByTestId('view-file-image')).toHaveCount(0);

    await expect(page.getByTestId('view-file-expand')).toContainText('invoice.pdf');
    await expect(page.getByTestId('view-file-open')).toHaveAttribute(
      'href',
      '/api/chats/chat_view_file_pdf/artifact/pdf001',
    );

    // Expands to a taller frame, same control as an HTML page.
    await expect(card).toHaveAttribute('data-expanded', 'false');
    const before = (await frame.boundingBox())!.height;
    await page.getByTestId('view-file-expand').click();
    await expect(card).toHaveAttribute('data-expanded', 'true');
    const after = (await frame.boundingBox())!.height;
    expect(after).toBeGreaterThan(before);
  });
});
