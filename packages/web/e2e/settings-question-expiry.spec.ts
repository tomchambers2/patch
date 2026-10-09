import { test, expect } from '@playwright/test';
import { settingsUrl, stubSettingsApi, wsSent } from './settingsHarness.js';

// Real-browser e2e for Settings → Agent → Questions (spec/14 § `/settings`
// details, spec/02 § Questions are not approvals): whether an unanswered
// question on a host expires, and the window it gets.
//
// Tom, App Updates: "settings should have the configured time + whether feature
// is on to auto expire questions".
//
// Measured on computed style and geometry as well as on behaviour, deliberately.
// The rows these controls live in style their value as a bordered 120px-minimum
// FIELD, which is right for the seconds box and turns the tick box into a wide
// empty slab — and the repo has already shipped one settings control that
// rendered as an invisible zero-height nothing. Neither failure is visible to
// any assertion on text or DOM structure.
//
// Both are shared settings (spec/01 § Settings): a change is a write to the
// server, which sends it to every host, so the behaviour assertion is on the
// PATCHes the harness's fake server recorded.
const TOGGLE = 'question-expiry-toggle';
const SECONDS = 'question-expiry-seconds';

test.describe('Settings → Agent → Questions', () => {
  let server: Awaited<ReturnType<typeof stubSettingsApi>>;
  test.beforeEach(async ({ page }) => {
    server = await stubSettingsApi(page, { preferences: { questionExpirySeconds: 60 } });
    await page.goto(settingsUrl('agent'));
    await expect(page.getByTestId('question-expiry')).toBeVisible();
  });

  test('shows the shared settings: expiry on, at 60 seconds', async ({ page }) => {
    await expect(page.getByTestId(TOGGLE)).toBeChecked();
    await expect(page.getByTestId(SECONDS)).toHaveValue('60');
  });

  test('both controls are visible boxes with real size', async ({ page }) => {
    // The visible control is the switch's track; the real checkbox behind it
    // is visually hidden inside it.
    const box = await page.getByTestId(TOGGLE).evaluate((el) => {
      const track = el.closest('.toggle')?.querySelector('.toggle-track');
      if (!track) throw new Error('toggle track not rendered');
      const r = track.getBoundingClientRect();
      return { width: r.width, height: r.height };
    });
    // A switch, not a 120px-wide field and not a collapsed nothing.
    expect(box.width).toBeGreaterThanOrEqual(28);
    expect(box.width).toBeLessThanOrEqual(48);
    expect(box.height).toBeGreaterThanOrEqual(14);
    expect(box.height).toBeLessThanOrEqual(28);

    const field = await page.getByTestId(SECONDS).evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        borderTopWidth: parseFloat(cs.borderTopWidth),
        borderStyle: cs.borderTopStyle,
        borderColor: cs.borderTopColor,
        paddingLeft: parseFloat(cs.paddingLeft),
        width: el.getBoundingClientRect().width,
        height: el.getBoundingClientRect().height,
      };
    });
    // The seconds box keeps the shared Settings field look.
    expect(field.borderTopWidth).toBeGreaterThanOrEqual(1);
    expect(field.borderStyle).toBe('solid');
    expect(field.borderColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(field.paddingLeft).toBeGreaterThanOrEqual(4);
    // A compact number box — but wide enough for the longest window allowed.
    expect(field.width).toBeGreaterThanOrEqual(60);
    expect(field.height).toBeGreaterThan(0);
    await page.getByTestId(SECONDS).fill('3600');
    const fits = await page.getByTestId(SECONDS).evaluate((el) => el.scrollWidth <= el.clientWidth);
    expect(fits).toBe(true);
  });

  test('the label and its control never run together into one string', async ({ page }) => {
    const gaps = await page.evaluate(() => {
      const rows = Array.from(
        document.querySelectorAll('[data-testid="question-expiry"] .set-row'),
      );
      return rows.map((row) => {
        const kids = Array.from(row.children).map((c) => c.getBoundingClientRect());
        const between: number[] = [];
        for (let i = 1; i < kids.length; i++) {
          const prev = kids[i - 1] as DOMRect;
          const cur = kids[i] as DOMRect;
          if (cur.left >= prev.right) between.push(cur.left - prev.right);
        }
        return { text: (row.textContent ?? '').trim(), between };
      });
    });
    expect(gaps.map((g) => g.text).join(' | ')).toContain('Expire unanswered questions');
    expect(gaps.map((g) => g.text).join(' | ')).toContain('Expire after');
    for (const row of gaps) {
      for (const gap of row.between) {
        expect(gap, `row "${row.text}" has a flush label/value pair`).toBeGreaterThanOrEqual(6);
      }
    }
  });

  test('turning the feature off writes questionExpiry:false, and not the window', async ({
    page,
  }) => {
    await page.getByTestId(TOGGLE).click({ force: true });
    await expect.poll(() => server.patches).toEqual([{ questionExpiry: false }]);
    await expect(page.getByTestId(TOGGLE)).not.toBeChecked();
    expect(await wsSent(page)).toEqual([]);
  });

  test('a new window is written when the field is committed', async ({ page }) => {
    await page.getByTestId(SECONDS).fill('120');
    await page.getByTestId(SECONDS).press('Enter');
    await expect.poll(() => server.patches).toContainEqual({ questionExpirySeconds: 120 });
  });

  test('an out-of-bounds window is refused here rather than sent and rejected', async ({
    page,
  }) => {
    await page.getByTestId(SECONDS).fill('0');
    await page.getByTestId(SECONDS).press('Enter');
    await expect(page.getByText(/between 5 and 3600 seconds/)).toBeVisible();
    expect(server.patches).toEqual([]);
  });
});
