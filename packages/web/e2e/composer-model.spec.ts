import { test, expect } from '@playwright/test';
import type { WireEvent } from '@patch/wire';

// Real-browser e2e (dev harness, real Composer + real CSS, no backend) for the
// model readout in the composer's action row: both the readout and, since it is
// the same thing, the control that changes a live chat's model (spec/04 §
// Model, spec/14 § Model selector). It moved out of the header crumb, which had
// grown too crowded, to sit beside the approval mode — the other setting that
// applies to the next turn.

// The catalogue is fetched per machine when the picker opens (spec/02 § Model
// catalogue), and the harness has no backend behind `/api/models`. Answering it
// here is what makes the pop-up show its real list rather than its (equally
// real, but not what these tests are about) error state.
const CATALOGUE = {
  models: [
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { id: 'claude-opus-4-1', label: 'Opus 4.1' },
  ],
  fetchedAt: '2026-01-01T00:00:00.000Z',
};

test.describe('composer model', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/models*', (route) =>
      route.fulfill({ json: CATALOGUE, contentType: 'application/json' }),
    );
  });

  test('sits in the composer row beside the approval mode, not in the header', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    const model = page.getByTestId('chat-model');
    await expect(model).toBeVisible();
    await expect(model).toContainText('claude-sonnet-4-6');
    await expect(page.getByTestId('chat-head').getByTestId('chat-model')).toHaveCount(0);
    await expect(page.locator('.composer-actions').getByTestId('chat-model')).toHaveCount(1);

    const mode = (await page.getByTestId('permission-mode').boundingBox())!;
    const modelBox = (await model.boundingBox())!;
    const send = (await page.getByTestId('send-btn').boundingBox())!;
    // After the approval mode, before Send, on the row's one centre line.
    expect(modelBox.x).toBeGreaterThanOrEqual(mode.x + mode.width);
    expect(modelBox.x + modelBox.width).toBeLessThanOrEqual(send.x);
    expect(Math.abs(modelBox.y + modelBox.height / 2 - (send.y + send.height / 2))).toBeLessThan(2);
  });

  test('renders no model control for a chat with no known model', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_md');
    await expect(page.getByTestId('chat-title')).toBeVisible();
    await expect(page.getByTestId('chat-model')).toHaveCount(0);
  });

  test('it opens the model list upward, on top of everything', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await page.getByTestId('chat-model').click();
    const popup = page.getByTestId('model-popup');
    await expect(popup).toBeVisible();
    await expect(page.getByTestId('model-option-claude-opus-4-1')).toBeVisible();
    // The pop-up says which turn the change lands on — a switch presented as
    // instant would misdescribe the turn already running (spec/04 § Model).
    await expect(page.getByTestId('model-popup-note')).toBeVisible();

    // It must be genuinely on top: the row has to be the element a click at its
    // own centre actually reaches, not something painted over it.
    const option = page.getByTestId('model-option-claude-opus-4-1');
    const box = (await option.boundingBox())!;
    const onTop = await page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x as number, y as number);
        return el?.closest('[data-testid="model-option-claude-opus-4-1"]') !== null;
      },
      [box.x + box.width / 2, box.y + box.height / 2],
    );
    expect(onTop).toBe(true);
  });

  test('choosing a model sends chat.model_request and shows the choice as pending', async ({
    page,
  }) => {
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await page.getByTestId('chat-model').click();
    await page.getByTestId('model-option-claude-opus-4-1').click();

    await expect(page.getByTestId('model-popup')).toHaveCount(0);
    const sent = await page.evaluate(
      () => (window as unknown as { __wsSent: WireEvent[] }).__wsSent,
    );
    expect(
      sent.filter(
        (e) => (e as { type: string }).type === 'chat.model_request',
      ) as unknown as Array<{ chatId: string; model: string }>,
    ).toEqual([{ type: 'chat.model_request', chatId: 'chat_bus', model: 'claude-opus-4-1' }]);

    // The harness has no host to answer, so the pill stays visibly unsettled —
    // it reads the choice, marked pending, never as an accomplished switch.
    const pill = page.getByTestId('chat-model');
    await expect(pill).toContainText('claude-opus-4-1');
    await expect(pill).toHaveClass(/is-pending/);
  });
});
