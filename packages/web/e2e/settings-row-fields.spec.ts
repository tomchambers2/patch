import { test, expect, type Page } from '@playwright/test';
import { settingsUrl, stubSettingsApi } from './settingsHarness.js';

// Real-browser e2e for the Settings rows that pair a LABEL with an editable
// FIELD (spec/14 § `/settings` details → Fields). These rows used to render as
// one run-together string — "Quiet hours23:00 to07:00", "Address wordpatch",
// "Chat name refresh (messages, 0=off)0" — because the rows had no CSS at all:
// the inputs inherited the app's borderless reset, carried no padding, and sat
// flush against their label with zero gap. The TTS voice `<select>` had the
// same problem and, as a shrinkable item next to a long label, could also clip
// its option text mid-word.
//
// These assertions are on computed style and geometry deliberately: the bug was
// invisible to any assertion on text or DOM structure, which is why it shipped.
// design/settings-redesign puts these fields on two pages: Manager (quiet
// hours, address word) and Voice (the host's Kokoro voice, chat-name interval).

/** The controls this spec is about: test id, page, and the narrowest it may be. */
const FIELDS = [
  { testid: 'manager-quiet-start', page: 'manager', minWidth: 90 },
  { testid: 'manager-quiet-end', page: 'manager', minWidth: 90 },
  { testid: 'manager-address-word', page: 'manager', minWidth: 90 },
  // A compact number box by design — wide enough for its numbers, no wider.
  { testid: 'chat-name-interval', page: 'voice', minWidth: 60 },
  { testid: 'kokoro-voice', page: 'voice', minWidth: 90 },
] as const;

async function openPage(page: Page, name: string): Promise<void> {
  await page.goto(settingsUrl(name));
  await expect(page.locator('.set-page')).toBeVisible();
}

test.describe('Settings rows — label and value are distinct, bordered fields', () => {
  // The shared settings (spec/01 § Settings) carry a Kokoro voice and a
  // chat-name interval, so both fields have a value to size to.
  test.beforeEach(async ({ page }) => {
    await stubSettingsApi(page, { preferences: { kokoroVoice: 'af_heart', chatNameInterval: 3 } });
  });

  for (const f of FIELDS) {
    test(`${f.testid} is drawn as a field — visible border, padding, minimum width`, async ({
      page,
    }) => {
      await openPage(page, f.page);
      const box = await page.getByTestId(f.testid).evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          borderTopWidth: parseFloat(cs.borderTopWidth),
          borderLeftWidth: parseFloat(cs.borderLeftWidth),
          borderStyle: cs.borderTopStyle,
          borderColor: cs.borderTopColor,
          paddingLeft: parseFloat(cs.paddingLeft),
          paddingTop: parseFloat(cs.paddingTop),
          width: el.getBoundingClientRect().width,
          height: el.getBoundingClientRect().height,
          overflows: el.scrollWidth > el.clientWidth,
        };
      });
      expect(box.borderTopWidth).toBeGreaterThanOrEqual(1);
      expect(box.borderLeftWidth).toBeGreaterThanOrEqual(1);
      expect(box.borderStyle).toBe('solid');
      expect(box.borderColor).not.toBe('rgba(0, 0, 0, 0)');
      expect(box.paddingLeft).toBeGreaterThanOrEqual(4);
      expect(box.paddingTop).toBeGreaterThanOrEqual(2);
      expect(box.width).toBeGreaterThanOrEqual(f.minWidth);
      // What it holds fits inside it.
      expect(box.overflows).toBe(false);
      // spec/14 § Legibility: no control is smaller than --tap-min (44px) on
      // either axis. Was ~36px (padding: 6px 10px, no min-height) — cramped
      // enough that Tom filed "input boxes are too small".
      expect(box.height).toBeGreaterThanOrEqual(44);
    });
  }

  for (const [name, labels] of [
    ['manager', ['Quiet hours', 'Address word']],
    ['voice', ['Voice', 'Say the chat name every']],
  ] as const) {
    test(`${name}: every label/value pair is separated by a real gap`, async ({ page }) => {
      await openPage(page, name);
      const gaps = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.settings-route .set-row'));
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

      const text = gaps.map((g) => g.text).join(' | ');
      for (const label of labels) expect(text).toContain(label);
      for (const row of gaps) {
        for (const gap of row.between) {
          expect(gap, `row "${row.text}" has a flush label/value pair`).toBeGreaterThanOrEqual(6);
        }
      }
    });
  }

  for (const width of [1280, 700]) {
    test(`the TTS voice select shows a whole option label at ${width}px, not a clipped one`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await openPage(page, 'voice');
      const fit = await page.getByTestId('kokoro-voice').evaluate((el) => {
        const select = el as HTMLSelectElement;
        const cs = getComputedStyle(select);
        const ctx = document.createElement('canvas').getContext('2d');
        if (!ctx) throw new Error('no 2d canvas context');
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const widest = Math.max(
          ...Array.from(select.options).map((o) => ctx.measureText(o.label).width),
        );
        const contentWidth =
          select.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        return { widest, contentWidth, selected: select.selectedOptions[0]?.label ?? '' };
      });
      expect(fit.selected).toBe('Heart (American F)');
      // Room for the widest label plus the dropdown arrow.
      expect(fit.contentWidth).toBeGreaterThanOrEqual(fit.widest + 16);
    });
  }
});
