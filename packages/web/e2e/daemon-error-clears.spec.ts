import { test, expect } from '@playwright/test';
import type { WireEvent } from '@patch/wire';

// spec/04 § Activity — when the host↔server link drops mid-turn the server
// raises a `daemon_unavailable` chat.error so the spinner unsticks, and the
// card promises "Message will resend." The host then keeps that promise: it
// re-sends the interrupted turn on hydrate and the chat returns to `running`.
// The red card was staying in the transcript regardless, so a two-second blip
// looked like a permanent failure (the reported bug). It must go with the
// condition it describes — and a REAL turn failure must not.
const HARNESS = '/app/dev-harness.html?chat=chat_daemon_blip';
const CHAT_ID = 'chat_daemon_blip';

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

function chatState(activity: string): WireEvent {
  return {
    type: 'chat.state',
    chatId: CHAT_ID,
    daemonId: 'd1',
    permissionMode: 'auto',
    activity,
    lastUpdated: Date.now(),
  } as unknown as WireEvent;
}

/** What ws-hub fans out on `daemon.offline` for an in-flight chat. */
async function deliverBlip(page: import('@playwright/test').Page) {
  await applyEvent(page, {
    type: 'chat.message',
    chatId: CHAT_ID,
    role: 'user',
    content: 'add a config file',
    seq: 0,
  } as WireEvent);
  await applyEvent(page, chatState('running'));
  await applyEvent(page, {
    type: 'chat.error',
    chatId: CHAT_ID,
    error: {
      code: 'daemon_unavailable',
      message: 'Connection to the host was lost. Message will resend.',
    },
    // OUT_OF_BAND_SEQ — server-generated, never part of the host's stream.
    seq: -1,
  } as WireEvent);
  await applyEvent(page, chatState('errored'));
}

test.describe('the daemon-link-lost card disappears once the link is back', () => {
  test('shown while the chat is errored, gone once the resumed turn reports running', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await deliverBlip(page);

    const card = page.getByTestId('turn-error');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Connection to the host was lost');
    await expect(card.locator('.turn-error-code')).toHaveText('daemon_unavailable');

    // The host comes back and re-sends the interrupted turn.
    await applyEvent(page, chatState('running'));

    await expect(page.getByTestId('turn-error')).toHaveCount(0);
    // The user's own message is still there — only the notice went.
    await expect(page.getByText('add a config file')).toBeVisible();
  });

  test('stays put while nothing resolves it — time alone is not a signal', async ({ page }) => {
    await page.goto(HARNESS);
    await deliverBlip(page);
    await expect(page.getByTestId('turn-error')).toHaveCount(1);
    // No recovery event. A host that never comes back leaves the error up.
    await page.waitForTimeout(1500);
    await expect(page.getByTestId('turn-error')).toHaveCount(1);
  });

  test('a real turn failure survives the chat going running again', async ({ page }) => {
    await page.goto(HARNESS);
    await applyEvent(page, {
      type: 'chat.error',
      chatId: CHAT_ID,
      error: { code: 'claude_oauth_missing', message: 'No Claude credential on this machine.' },
      seq: 1,
    } as WireEvent);
    await expect(page.getByTestId('turn-error')).toHaveCount(1);

    await applyEvent(page, chatState('running'));

    await expect(page.getByTestId('turn-error')).toHaveCount(1);
    await expect(page.getByTestId('turn-error').locator('.turn-error-code')).toHaveText(
      'claude_oauth_missing',
    );
  });
});
