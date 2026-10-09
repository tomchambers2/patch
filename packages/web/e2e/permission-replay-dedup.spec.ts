import { test, expect } from '@playwright/test';
import type { WireEvent } from '@patch/wire';

// spec/14 § Main chat panel → Permission cards, spec/12 § "No message
// deduplication beyond seq" — the host's `replayChat` (G2-d1) deliberately
// re-emits the canonical `chat.permission_request` for every STILL-PENDING
// permission on a chat, so a surface that reconnected after the prompt was
// produced gets the card. That re-emit is NOT gated on the replay's `fromSeq`
// the way transcript events are, so every subsequent replay re-delivers it:
// leaving a chat that is paused on a Write approval and coming back replays
// from a further-on cursor and the permission arrives again. Without an
// already-held guard keyed on `requestId`, the Approve/Deny card was appended a
// second time and the user saw two identical cards for one request.
const HARNESS = '/app/dev-harness.html?chat=chat_replay_dupe';
const CHAT_ID = 'chat_replay_dupe';

function applyEvent(page: import('@playwright/test').Page, event: WireEvent) {
  return page.evaluate(
    (e) => {
      const store = (
        window as unknown as {
          __store: { getState: () => { applyEvent: (ev: Record<string, unknown>) => void } };
        }
      ).__store;
      store.getState().applyEvent(e);
    },
    event as unknown as WireEvent,
  );
}

/**
 * One replay of a chat paused on a Write approval: the user turn, then the
 * pending permission the host re-emits with it.
 */
async function deliverReplay(page: import('@playwright/test').Page) {
  await applyEvent(page, {
    type: 'chat.message',
    chatId: CHAT_ID,
    role: 'user',
    content: 'add a config file',
    seq: 0,
  } as WireEvent);
  await applyEvent(page, {
    type: 'chat.permission_request',
    chatId: CHAT_ID,
    requestId: 'req-write-1',
    request: {
      tool: 'Write',
      args: { file_path: '/home/tom/projects/bus/config.ts', content: 'export default {};' },
      description: 'Write config.ts',
    },
    seq: 1,
  } as WireEvent);
}

test.describe('a re-delivered replay draws one permission card, not two', () => {
  test('a second replay of a still-pending Write approval does not duplicate the card', async ({
    page,
  }) => {
    await page.goto(HARNESS);

    await deliverReplay(page);
    const stream = page.getByTestId('chat-stream');
    // Baseline: one card, with its Approve/Deny affordance, before any re-delivery.
    await expect(stream.getByTestId('permission')).toHaveCount(1);
    await expect(stream.getByTestId('permission')).toContainText('Write');
    await expect(stream.getByRole('button', { name: /^Approve 1$/ })).toHaveCount(1);

    // The host replays the chat again — the still-pending permission comes
    // with it, exactly as `replayChat` sends it.
    await deliverReplay(page);

    await expect(stream.getByTestId('permission')).toHaveCount(1);
    // And only one set of buttons: a second card would double every control,
    // leaving two Approve buttons for one request.
    await expect(stream.getByRole('button', { name: /^Approve 1$/ })).toHaveCount(1);
    // One outstanding request offers no sweep — "Approve all outstanding" is
    // drawn only when there is genuinely more than one (spec/14).
    await expect(stream.getByTestId('permission-approve-all')).toHaveCount(0);

    // The transcript still reads user turn → one card, in order.
    const entries = stream.locator('[data-testid="msg"], [data-testid="permission"]');
    const kinds = await entries.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-testid')),
    );
    expect(kinds).toEqual(['msg', 'permission']);

    // The store's `pendingPermissions` is deduped too, not just the DOM — a
    // doubled entry there inflates the awaiting-permission state and makes the
    // `2` / "Approve all" sweep resolve the same request twice.
    const pending = await page.evaluate((chatId) => {
      const store = (
        window as unknown as {
          __store: {
            getState: () => {
              chats: Record<string, { pendingPermissions: { requestId: string }[] }>;
            };
          };
        }
      ).__store;
      return store.getState().chats[chatId]?.pendingPermissions.map((p) => p.requestId) ?? [];
    }, CHAT_ID);
    expect(pending).toEqual(['req-write-1']);
  });

  test('two genuinely different permission requests still both render', async ({ page }) => {
    // Guard against over-deduping: a turn can pause on more than one approval,
    // which is the whole reason "Approve all outstanding" exists.
    await page.goto(HARNESS);
    await deliverReplay(page);
    await applyEvent(page, {
      type: 'chat.permission_request',
      chatId: CHAT_ID,
      requestId: 'req-edit-2',
      request: {
        tool: 'Edit',
        args: { file_path: '/home/tom/projects/bus/main.ts' },
        description: 'Edit main.ts',
      },
      seq: 2,
    } as WireEvent);

    const stream = page.getByTestId('chat-stream');
    await expect(stream.getByTestId('permission')).toHaveCount(2);
    // …and NOW the sweep is worth offering, on both cards (spec/14).
    await expect(stream.getByTestId('permission-approve-all')).toHaveCount(2);
    await expect(
      stream.getByRole('button', { name: /^Approve all outstanding 2$/ }).first(),
    ).toBeVisible();
  });
});
