import { test, expect, type Page } from '@playwright/test';
import { settingsUrl, stubSettingsApi } from './settingsHarness.js';

/** The pill currently chosen in a Pills group. */
async function chosen(page: Page, testid: string): Promise<string> {
  return page.getByTestId(testid).locator('button[aria-pressed="true"]').innerText();
}

// Real-browser e2e for the per-surface voice config (spec/07 § Voice is a
// config matrix). Four surfaces (dictation / device / hands-free / call), each
// ONE choice of engine — the backend and layer it maps to are not shown — with
// an honest status for a cell the host would refuse at connect time.
test.describe('Settings — Voice engines', () => {
  test.beforeEach(async ({ page }) => {
    await stubSettingsApi(page);
    await page.goto(settingsUrl('voice'));
    await expect(page.getByTestId('settings-voice-config')).toBeVisible();
  });

  test('each surface is one engine choice, named for people, with no layer axis', async ({
    page,
  }) => {
    for (const surface of ['dictation', 'device', 'handsFree', 'call']) {
      await expect(page.getByTestId(`voice-${surface}-engine`)).toBeVisible();
      await expect(page.getByTestId(`voice-${surface}-layer`)).toHaveCount(0);
    }
    await expect(page.getByTestId('voice-call-engine').locator('button')).toHaveText([
      'Local',
      'Gemini Flash',
      'Gemini Thinking',
      'OpenAI mini',
      'OpenAI',
    ]);
    await expect(page.getByTestId('voice-dictation-engine').locator('button')).toHaveText([
      'Local',
      'Gemini',
      'OpenAI',
    ]);
    await expect(page.getByText(/\b(direct|light|heavy)\b/)).toHaveCount(0);
  });

  test('defaults to Local everywhere, no status hint shown', async ({ page }) => {
    for (const surface of ['dictation', 'device', 'handsFree', 'call']) {
      expect(await chosen(page, `voice-${surface}-engine`)).toBe('Local');
    }
    await expect(
      page.locator('[data-testid="settings-voice-config"] [data-testid$="-status"]'),
    ).toHaveCount(0);
  });

  test('picking an engine writes the backend and layer it stands for', async ({ page }) => {
    await page.getByTestId('voice-call-engine-gemini-thinking').click();
    expect(await chosen(page, 'voice-call-engine')).toBe('Gemini Thinking');
    await page.getByTestId('voice-call-engine-openai-mini').click();
    expect(await chosen(page, 'voice-call-engine')).toBe('OpenAI mini');
    await expect(page.getByTestId('voice-call-status')).toHaveCount(0);
  });

  test('picking an unimplemented cell shows the honest status, not a silent success', async ({
    page,
  }) => {
    await page.getByTestId('voice-device-engine-gemini-flash').click();
    await expect(page.getByTestId('voice-device-status')).toContainText('Not implemented yet');
  });

  test('Gemini on hands-free says the address word is not enforced', async ({ page }) => {
    await page.getByTestId('voice-handsFree-engine-gemini-flash').click();
    await expect(page.getByTestId('voice-handsFree-status')).toContainText(
      'address word is not enforced',
    );
  });

  test('shows what voice calls have cost on each host, this month and in all', async ({ page }) => {
    await page.evaluate(() => {
      const store = (
        window as unknown as {
          __presenceStore: {
            getState(): {
              hosts: Record<string, { host: Record<string, unknown> | null }>;
              setHostReport(r: Record<string, unknown>): void;
            };
          };
        }
      ).__presenceStore;
      const host = store.getState().hosts['d1']!.host!;
      store.getState().setHostReport({
        ...host,
        type: 'daemon.host',
        voiceUsage: { monthUsd: 0.0412, monthCalls: 3, allUsd: 1.5, allCalls: 40 },
      });
    });
    await expect(page.getByTestId('voice-usage-d1')).toHaveText(
      'dev-host: this month $0.041 across 3 calls · in all $1.50 across 40 calls',
    );
  });

  test('a hosted cell whose key the host lacks says so, naming the host and the key', async ({
    page,
  }) => {
    // The host reports which provider keys it holds (`daemon.host.voiceKeys`).
    await page.evaluate(() => {
      const store = (
        window as unknown as {
          __presenceStore: {
            getState(): {
              hosts: Record<string, { host: Record<string, unknown> | null }>;
              setHostReport(r: Record<string, unknown>): void;
            };
          };
        }
      ).__presenceStore;
      const host = store.getState().hosts['d1']!.host!;
      store.getState().setHostReport({
        ...host,
        type: 'daemon.host',
        voiceKeys: { gemini: false, openai: true },
      });
    });
    await expect(page.getByTestId('voice-dictation-keys')).toHaveCount(0);
    await page.getByTestId('voice-dictation-engine-gemini').click();
    const line = page.getByTestId('voice-dictation-keys');
    await expect(line).toHaveText(
      'Not configured on dev-host: GEMINI_API_KEY is missing. Sessions there are refused.',
    );
    await expect(line).toBeVisible();
    // It reads as an error, not as a muted hint.
    const color = await line.evaluate((el) => getComputedStyle(el).color);
    const hint = await line.evaluate(
      (el) => getComputedStyle(el.closest('.set-sub') as HTMLElement).color,
    );
    expect(color).not.toBe(hint);
    // The key the host holds says nothing.
    await page.getByTestId('voice-call-engine-openai').click();
    await expect(page.getByTestId('voice-call-keys')).toHaveCount(0);
  });
});
