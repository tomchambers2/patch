import { test, expect } from '@playwright/test';

// Real-browser e2e (dev harness, real ChatRoute + real CSS, no backend) for the
// provider-level context panel — spec/02 § Provider-level context, spec/14 §
// Main chat panel: Claude Code's OWN provider-level context (environment,
// model identity, token counts, ...) as distinct from Patch's own five
// hand-injected `<system-reminder>` reminders (system-context e2e coverage
// lives elsewhere). jsdom already covers the reducer's dedup/count logic
// (chatStore.test.ts) and the collapsed-row rendering (ChatRoute.test.tsx);
// what only a real browser shows is that the panel actually sits with the
// chat's other standing banners above the transcript, and that a real click
// expands it.
//
// `chat_provider_context` is seeded in dev-harness.tsx with two provider
// entries, one of them (`total_tokens_reminder`) delivered twice — through the
// real `chat.provider_context` reducer, not a hand-written fixture.
const HARNESS = '/app/dev-harness.html?chat=chat_provider_context';

test.describe('provider-level context panel', () => {
  test('shows one collapsed row per providerType, naming a repeat with a count', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    const rows = page.getByTestId('provider-context');
    await expect(rows).toHaveCount(2);

    const summaries = page.getByTestId('provider-context-summary');
    await expect(summaries.nth(0)).toContainText('Model');
    // The row that recurred names how many times, rather than only showing
    // the latest occurrence with no sign the earlier one ever happened.
    await expect(summaries.nth(1)).toContainText('Tokens remaining ×2');
    // Collapsed by default — this is furniture for verification, not
    // something read on every turn.
    await expect(page.getByTestId('provider-context-detail')).toHaveCount(0);
  });

  test('expands on click to the LATEST text, sits above the transcript', async ({ page }) => {
    await page.goto(HARNESS);
    const summaries = page.getByTestId('provider-context-summary');
    await summaries.nth(1).click();
    await expect(page.getByTestId('provider-context-detail')).toContainText(
      '14,900,112 tokens left',
    );

    const panel = await page.getByTestId('provider-context-panel').boundingBox();
    const stream = await page.getByTestId('chat-stream').boundingBox();
    expect(panel).not.toBeNull();
    expect(stream).not.toBeNull();
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(stream!.y + 1);
  });

  test('a chat with none shows no panel at all', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_md');
    await expect(page.getByTestId('chat-main')).toBeVisible();
    await expect(page.getByTestId('provider-context-panel')).toHaveCount(0);
  });

  // providerContextVerbosity (spec/14 § /settings details — Transcript): the
  // account preference the panel's default expand state reads.
  test('off hides the panel even though the chat has entries', async ({ page }) => {
    await page.goto(`${HARNESS}&providerContextVerbosity=off`);
    await expect(page.getByTestId('chat-main')).toBeVisible();
    await expect(page.getByTestId('provider-context-panel')).toHaveCount(0);
  });

  test('full opens every row on load, and a click can still close one', async ({ page }) => {
    await page.goto(`${HARNESS}&providerContextVerbosity=full`);
    const rows = page.getByTestId('provider-context');
    await expect(rows).toHaveCount(2);
    await expect(page.getByTestId('provider-context-detail')).toHaveCount(2);

    await page.getByTestId('provider-context-summary').first().click();
    await expect(page.getByTestId('provider-context-detail')).toHaveCount(1);
  });
});
