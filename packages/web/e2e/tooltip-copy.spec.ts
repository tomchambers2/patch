import { test, expect } from '@playwright/test';

// spec/14 § Copy — no helper text, verified against what the browser actually
// paints rather than against the source. The unit sweep
// (src/__tests__/tooltipCopy.test.ts) can only see STATIC `title="…"`
// attributes; half the app's tooltips are computed at render time from state,
// and those are exactly the ones that had drifted into sentences ("Off — hidden
// from the agent", "Working — stays open and quiet until it has something to
// say", "Enabled — click to disable").
//
// So: render the harness, read every rendered `title`, and split them into the
// two sanctioned kinds. A tooltip is EITHER
//   - a name of a few words in sentence case, or
//   - the full value of text the app has clipped, reproduced verbatim
//     (the required tooltip on any ellipsised name or path)
// and never an explanation of what the control does.

const HARNESS = '/app/dev-harness.html';
const MANAGER = '/app/dev-harness.html?chat=thread_manager';

/** Every rendered tooltip, with enough context to name the offender. */
async function tooltips(page: import('@playwright/test').Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[title]')].map((el) => ({
      title: el.getAttribute('title') ?? '',
      // The element's own visible text, so a full-value tooltip can be told
      // apart from an explanation: a full-value tooltip reproduces text that
      // is on screen (possibly clipped), an explanation invents new prose.
      text: (el as HTMLElement).innerText.trim(),
      testid: el.getAttribute('data-testid') ?? el.className,
    })),
  );
}

/** Is this tooltip the full value of the (possibly clipped) text it sits on? */
function isFullValue(t: { title: string; text: string }): boolean {
  if (t.text === '') return false;
  const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/…/g, '').trim();
  return clean(t.title).includes(clean(t.text)) || clean(t.text).includes(clean(t.title));
}

for (const [name, url] of [
  ['the chat view', HARNESS],
  ['the Manager view', MANAGER],
] as const) {
  test.describe(`tooltips in ${name}`, () => {
    test('no tooltip explains its control with an em-dash clause', async ({ page }) => {
      await page.goto(url);
      await expect(page.getByTestId('chat-stream')).toBeVisible();
      const dashed = (await tooltips(page)).filter((t) => t.title.includes('—'));
      expect(dashed).toEqual([]);
    });

    test('every tooltip is either a short name or the full value of clipped text', async ({
      page,
    }) => {
      await page.goto(url);
      await expect(page.getByTestId('chat-stream')).toBeVisible();
      const all = await tooltips(page);
      expect(all.length).toBeGreaterThan(10);
      const wordy = all.filter((t) => {
        // Ignore a trailing shortcut hint: "Files (⌘⇧')" is still a name.
        const words = t.title.replace(/\s*\([^)]*\)\s*$/, '').split(/\s+/).length;
        return words > 5 && !isFullValue(t);
      });
      expect(wordy).toEqual([]);
    });
  });
}

test.describe('the Tools panel', () => {
  // The panel is closed by default, so its tooltips never appear in the sweeps
  // above. Its per-tool switch carried the state AND an explanation of the
  // consequence ("Off — hidden from the agent"). Note the per-tool SENTENCE
  // beneath each name stays: that is content, the one thing spec/14 § Copy
  // exempts, and it is not a tooltip.
  test('titles each tool switch with its state alone', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_md');
    await page.getByTestId('action-more').click();
    await page.getByTestId('action-tools').click();
    await expect(page.getByTestId('tools-panel')).toBeVisible();

    const inPanel = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="tools-panel"] [title]')].map(
        (el) => el.getAttribute('title') ?? '',
      ),
    );
    expect(inPanel.length).toBeGreaterThan(1);
    expect(inPanel.filter((t) => t.includes('—'))).toEqual([]);
    // Every switch is named by its state and nothing more.
    const states = inPanel.filter((t) => /^(On|Off)\b/.test(t));
    expect(states.length).toBeGreaterThan(0);
    expect(states.every((t) => t === 'On' || t === 'Off')).toBe(true);
  });
});

test.describe('the Manager row', () => {
  // It carried a two-sentence explainer ("Manager — the meta-operator chat with
  // a view across all your other chats. Ask it system-wide things like…").
  test('is named by its tooltip, not explained by it', async ({ page }) => {
    await page.goto(HARNESS);
    const row = page.getByTestId('chat-row-thread_manager');
    await expect(row).toBeVisible();
    const title = await row.getAttribute('title');
    expect(title).toBe(await row.locator('.name').innerText());
    expect(title).not.toContain('meta-operator');
  });
});

test.describe('visible copy', () => {
  // The em dash reads as a licence to keep going after the sentence is done, so
  // it is where the banned helper prose hides in plain sight. The rendered
  // sidebar + chat are checked as a whole rather than string by string.
  test('the sidebar and chat paint no em-dash-joined prose', async ({ page }) => {
    await page.goto(HARNESS);
    await expect(page.getByTestId('chat-stream')).toBeVisible();
    const offenders = await page.evaluate(() => {
      const out: string[] = [];
      for (const root of ['.sb', '[data-testid="chat-stream"]']) {
        const el = document.querySelector(root);
        if (!el) continue;
        for (const line of (el as HTMLElement).innerText.split('\n')) {
          // A separator between two values ("kitchen — speaker") is fine; a
          // clause after the dash is not. Prose gives itself away by running on.
          const after = line.split('—')[1];
          if (after !== undefined && after.trim().split(/\s+/).length > 3) out.push(line);
        }
      }
      return out;
    });
    expect(offenders).toEqual([]);
  });
});
