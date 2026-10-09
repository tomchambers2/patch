import { test, expect } from '@playwright/test';

// Real-browser e2e for spec/14 § Sidebar §8: the new-chat screen's recently
// used models are the models the USER last chose. Todoist: "last used should
// default to last used in a user initiated chat, not a job (jobs often used
// sonnet)". `?recency=machine` seeds a job-spawned chat and the Manager thread,
// both newer than the one chat a person started (`chat_bus`, Sonnet 4.6), each
// on a different model.
const NEW = '/app/dev-harness.html?chat=new&recency=machine';

test('the quick models lead with the user-started chat, not a newer job chat or thread', async ({
  page,
}) => {
  await page.route('**/api/models*', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        models: [
          { id: 'claude-opus-5', label: 'Claude Opus 5' },
          { id: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
          { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
          { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
        ],
        fetchedAt: '2026-09-27T09:00:00.000Z',
      }),
    }),
  );
  await page.goto(NEW);
  const quick = page.getByTestId('new-chat-quick-models').locator('[data-testid^="model-quick-"]');
  await expect(quick).toHaveCount(3);
  const ids = await quick.evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  // The user's own model first, then the catalogue head — the job's Opus 4.1
  // and Manager's Haiku 4.5 are only there as catalogue top-up, never ahead.
  expect(ids).toEqual([
    'model-quick-claude-sonnet-4-6',
    'model-quick-claude-opus-5',
    'model-quick-claude-opus-4-1',
  ]);
});
