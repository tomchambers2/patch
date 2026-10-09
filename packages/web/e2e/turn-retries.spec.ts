import { test, expect } from '@playwright/test';
import type { WireEvent } from '@patch/wire';

// spec/12 § A turn is owed until it settles.
//
// Tom's screenshot: ONE question drawn as three identical bubbles with a red
// "Connection to the host was lost" card between the first two, while the
// chat underneath was still thinking. "this is a mess. the error should be
// temporary, not there forever. subtle marker on hover below chat with the rest
// of the stuff like time to say 'Retried twice'. the human message shouldnt be
// repeated. < > to show the retries if there is failed content"
//
// So: one bubble, a hover-revealed meta strip that counts the retries, and the
// track switcher's `< >` paging the ATTEMPTS so the failed content of a
// superseded one is still reachable without sitting in the transcript.
const HARNESS = '/app/dev-harness.html?chat=chat_daemon_blip';
const CHAT_ID = 'chat_daemon_blip';
const TEXT = 'check rons latest messages with bug report';

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

function userMessage(seq: number, retryOfSeq?: number): WireEvent {
  return {
    type: 'chat.message',
    chatId: CHAT_ID,
    role: 'user',
    content: TEXT,
    seq,
    ...(retryOfSeq !== undefined ? { retryOfSeq } : {}),
  } as unknown as WireEvent;
}

/** The turn, the link dropping, the host coming back and re-sending it. */
async function oneRecovery(page: import('@playwright/test').Page) {
  await applyEvent(page, userMessage(2));
  await applyEvent(page, chatState('running'));
  await applyEvent(page, {
    type: 'chat.error',
    chatId: CHAT_ID,
    error: {
      code: 'daemon_unavailable',
      message: 'Connection to the host was lost. Message will resend.',
    },
    seq: -1,
  } as WireEvent);
  await applyEvent(page, chatState('errored'));
  await applyEvent(page, chatState('running'));
  await applyEvent(page, userMessage(7, 2));
}

test.describe('a turn that recovered reads as one turn', () => {
  test('the re-sent message folds into the bubble already on screen', async ({ page }) => {
    await page.goto(HARNESS);
    await oneRecovery(page);
    // ONE bubble, not two. This is the headline of the bug report.
    await expect(page.getByTestId('msg')).toHaveCount(1);
    // …and the error that stood between the two copies is gone with the
    // condition it described.
    await expect(page.getByTestId('turn-error')).toHaveCount(0);
  });

  test('the retry marker is on a meta strip, hidden until the message is hovered', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    await oneRecovery(page);
    await applyEvent(page, userMessage(12, 2));

    const meta = page.getByTestId('msg-meta');
    await expect(meta).toHaveCount(1);
    await expect(page.getByTestId('msg-meta-retries')).toHaveText('Retried twice');
    // Subtle: present in the layout, invisible at rest.
    await expect(meta).toHaveCSS('opacity', '0');
    await page.getByTestId('msg').locator('.content').hover();
    await expect(meta).toHaveCSS('opacity', '1');
  });

  test('a turn that never went round again has no strip at all', async ({ page }) => {
    await page.goto(HARNESS);
    await applyEvent(page, userMessage(2));
    await page.getByTestId('msg').locator('.content').hover();
    await expect(page.getByTestId('msg-meta')).toHaveCount(0);
  });
});

test.describe('the < > pager reaches the failed attempt', () => {
  test('pages the attempts and shows what the superseded one failed with', async ({ page }) => {
    await page.goto(HARNESS);
    await oneRecovery(page);

    const pager = page.getByTestId('attempt-switcher');
    await expect(pager).toHaveCount(1);
    // At rest it sits on the attempt that settled — the last — so the
    // transcript reads as the turn that worked.
    await expect(page.getByTestId('attempt-count')).toHaveText('2/2');
    await expect(page.getByTestId('attempt-error')).toHaveCount(0);
    await expect(page.getByTestId('attempt-next')).toBeDisabled();

    await page.getByTestId('attempt-prev').click();
    await expect(page.getByTestId('attempt-count')).toHaveText('1/2');
    await expect(page.getByTestId('attempt-error')).toContainText(
      'Connection to the host was lost',
    );
    await expect(page.getByTestId('attempt-prev')).toBeDisabled();

    // Arrows only, no explanatory copy (spec/14 § Copy).
    await expect(page.getByTestId('attempt-prev')).toHaveText('');
    await expect(page.getByTestId('attempt-next')).toHaveText('');
  });

  test('no pager when the retries left no failed content to walk back to', async ({ page }) => {
    // A control that pages onto empty pages is a control that does nothing.
    await page.goto(HARNESS);
    await applyEvent(page, userMessage(2));
    await applyEvent(page, userMessage(7, 2));
    await expect(page.getByTestId('msg')).toHaveCount(1);
    await expect(page.getByTestId('msg-meta-retries')).toHaveText('Retried once');
    await expect(page.getByTestId('attempt-switcher')).toHaveCount(0);
  });
});
