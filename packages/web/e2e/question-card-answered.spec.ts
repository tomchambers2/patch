import { test, expect } from '@playwright/test';

// spec/14 § Main chat panel — Question prompts: "the card already shows the
// questions, the options, the selections and the outcome". Todoist: "patch
// previous question answers are not being stored" — the resolved card used
// to draw every option unselected and the outcome alone, because the picked
// state lived only in the component's own memory and this harness fixture
// loads the card fresh from the store's `permissionAnswers`, exactly as a
// reload or a remount would. A real browser is what settles whether the
// painted `.selected` styling actually shows, not just the `data-selected`
// attribute jsdom would already agree on.
const HARNESS = '/app/dev-harness.html?chat=chat_question_answered';

test.describe('a resolved question card still shows what was picked', () => {
  test('single-select: the chosen option is visibly selected, the other is not', async ({
    page,
  }) => {
    await page.goto(HARNESS);

    const luxon = page.getByTestId('question-option').filter({ hasText: 'Luxon' }).first();
    const dateFns = page.getByTestId('question-option').filter({ hasText: 'date-fns' }).first();
    await expect(luxon).toHaveAttribute('data-selected', 'true');
    await expect(luxon).toHaveClass(/selected/);
    await expect(dateFns).toHaveAttribute('data-selected', 'false');
    await expect(page.getByTestId('permission-outcome').first()).toHaveText('Answered');
  });

  test('multiSelect: every picked option is visibly selected', async ({ page }) => {
    await page.goto(HARNESS);

    const search = page.getByTestId('question-option').filter({ hasText: 'Search' }).first();
    const sync = page.getByTestId('question-option').filter({ hasText: 'Sync' }).first();
    const exportOpt = page.getByTestId('question-option').filter({ hasText: 'Export' }).first();
    await expect(search).toHaveAttribute('data-selected', 'true');
    await expect(sync).toHaveAttribute('data-selected', 'true');
    await expect(exportOpt).toHaveAttribute('data-selected', 'false');
  });

  test('a free-text Other answer is drawn read-only, since the live textarea only mounts while answerable', async ({
    page,
  }) => {
    await page.goto(HARNESS);

    const other = page.getByTestId('question-other').last();
    await expect(other).toHaveAttribute('data-selected', 'true');
    // No editable box left on a resolved card.
    await expect(page.getByTestId('question-other-input')).toHaveCount(0);
    const answer = page.getByTestId('question-other-answer').last();
    await expect(answer).toHaveText('Temporal, once it ships');
  });
});
