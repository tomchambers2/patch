import { test, expect } from '@playwright/test';

// spec/09 § `### desktop` — clicking a desktop notification opens the chat it
// came from. Only the Electron main process sees the native toast's click, so
// it raises the window and hands the destination to the renderer over the
// preload bridge (`patch.onNavigate`). The renderer has to route on it; while
// nothing subscribed, main's send went nowhere and a clicked notification left
// you on whatever chat you were already reading.
//
// The Electron shell can't be driven from Linux, so what's pinned here is the
// renderer's half against the REAL router and the REAL chat panel, with the one
// thing the preload hands over (`window.patch`) stubbed — same trick as
// version-auto-install.spec.ts.

type NavigateCb = (e: { path: string }) => void;

/** Boot the harness as if it were an Electron window, with the shell's
 *  navigate IPC exposed to the test as `window.__fireNavigate`. */
async function asDesktopShell(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      patch: unknown;
      __fireNavigate?: NavigateCb;
      __navUnsubscribed: boolean;
    };
    w.__navUnsubscribed = false;
    w.patch = {
      onNavigate: (cb: NavigateCb) => {
        w.__fireNavigate = cb;
        return () => {
          w.__navUnsubscribed = true;
        };
      },
    };
  });
}

async function fireNavigate(page: import('@playwright/test').Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    const fire = (window as unknown as { __fireNavigate?: NavigateCb }).__fireNavigate;
    if (!fire) throw new Error('the app never subscribed to the desktop shell navigate bridge');
    fire({ path: p });
  }, path);
}

test.describe('desktop notification click → the chat it came from', () => {
  test('routes the open window to the notification chat', async ({ page }) => {
    await asDesktopShell(page);
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await expect(page.getByTestId('chat-title')).toHaveText('bus-watch');

    await fireNavigate(page, '/chats/chat_md');

    await expect(page.getByTestId('chat-title')).toHaveText('July Seasonal Food');
  });

  test('a path that is not an in-app route raises an error toast and stays put', async ({
    page,
  }) => {
    // NO FALLBACK: an unroutable destination is reported, never dropped.
    await asDesktopShell(page);
    await page.goto('/app/dev-harness.html?chat=chat_bus');
    await expect(page.getByTestId('chat-title')).toHaveText('bus-watch');

    await fireNavigate(page, 'chats/chat_md');

    await expect(page.getByTestId('error-toasts')).toContainText('page that does not exist');
    await expect(page.getByTestId('chat-title')).toHaveText('bus-watch');
  });
});
