import { test, expect } from '@playwright/test';

// spec/14 § Tool calls — an Anthropic image content block in a tool call's
// args/result (e.g. Read loading a screenshot) renders as an actual picture,
// click-to-zoom into the same in-app lightbox a message attachment uses —
// not a dumped base64 string (Tom: "is it trying to show an image?").
const IMAGE_CHAT = '/app/dev-harness.html?chat=chat_tool_image';

test.describe('tool-call image content', () => {
  test('an image content block in a tool result renders as a picture, not raw base64, and opens the lightbox', async ({
    page,
  }) => {
    await page.goto(IMAGE_CHAT);
    await page.getByTestId('tool-result-summary').click();

    const detail = page.getByTestId('tool-result-detail');
    await expect(detail).toBeVisible();
    await expect(detail).not.toContainText('iVBORw0KGgo');

    const img = detail.getByTestId('tool-field-image').locator('img');
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute('src', /^data:image\/png;base64,/);

    await detail.getByTestId('tool-field-image').click();
    await expect(page.getByTestId('image-lightbox')).toBeVisible();
  });

  // spec/14 § Tool calls — an array's positions are not field names. Labelling
  // them printed a literal "0:" above the content array's every element (Tom:
  // "0: artifact"), which read as part of the result rather than as scaffolding.
  test("does not label the content array's elements with their indices", async ({ page }) => {
    await page.goto(IMAGE_CHAT);
    await page.getByTestId('tool-result-summary').click();

    const detail = page.getByTestId('tool-result-detail');
    await expect(detail).toBeVisible();
    const keys = await detail.locator('.tool-field-key').allTextContents();
    expect(keys).not.toContain('0');
    expect(keys).not.toContain('1');

    // The content itself still renders — both the text and the picture.
    await expect(detail).toContainText('screenshot.png');
    await expect(detail.getByTestId('tool-field-image')).toBeVisible();
  });
});
