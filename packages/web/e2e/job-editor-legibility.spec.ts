import { test, expect } from '@playwright/test';

// Tom, on the Patch Updates job's editor: "i dont have the toggle to hide chats
// for pathc updates job. the fonts are too small on that page (enforce minimum
// siae font whole app). back button too small. not enough margin between back
// and title".
//
// Three of those four are computed geometry — a hit target's real size, the gap
// between two flex children under a LONG title, and the resolved font size of
// every string on a rendered page — so they belong in a real browser. The
// source-level font-size floor is gated separately and exhaustively in
// `src/__tests__/minFontSize.test.ts`; this file proves the rendered result on
// the page he was actually looking at.

const FOLDER = '/home/tom/projects/portfolio';
const JOB_ID = 'j_01KZSAG4ZNEZCNVA5AA3T4QHCA';

// The real job, in the shape it is stored in: a KEYED `ensure` — one durable
// chat per Todoist task — with the very long name that collides with the back
// button.
const JOB = {
  id: JOB_ID,
  name: 'Patch Updates (Todoist adds + moves/edits + comments → one thread per task)',
  enabled: true,
  trigger: { type: 'todoist' },
  filter: null,
  action: {
    type: 'continue',
    daemonId: 'd1',
    folder: FOLDER,
    skill: 'app-update',
    key: '{{payload.event_data.id}}',
  },
  createdAt: 1,
  updatedAt: 1,
};

const EDIT_JOB = `/app/dev-harness.html?route=/jobs/${JOB_ID}`;
const NEW_JOB = '/app/dev-harness.html?route=/jobs/new';

/** Every PATCH body the page sends, in order. */
type Saved = Array<Record<string, unknown>>;

async function stub(page: import('@playwright/test').Page, saved: Saved): Promise<void> {
  await page.route('**/api/folders**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hosts: [{ daemonId: 'd1', roots: [FOLDER], recent: [] }] }),
    }),
  );
  await page.route('**/api/skills**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ skills: ['app-update'], paths: {} }),
    }),
  );
  await page.route('**/api/models**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ models: [] }),
    }),
  );
  // Registered broadest-FIRST: playwright checks handlers in reverse
  // registration order, so the list route added last would swallow
  // `/api/jobs/:id` and the editor would render with no job at all.
  await page.route('**/api/jobs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: [JOB] }),
    }),
  );
  await page.route(`**/api/jobs/${JOB_ID}`, (route) => {
    if (route.request().method() === 'PATCH') {
      saved.push(JSON.parse(route.request().postData() ?? '{}'));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...JOB, updatedAt: 2 }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(JOB),
    });
  });
  await page.route(`**/api/jobs/${JOB_ID}/runs**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: [] }),
    }),
  );
}

test.describe('job editor — Hide chat on a continue job', () => {
  test('the toggle renders for an ensure action and shows its stored state', async ({ page }) => {
    await stub(page, []);
    await page.goto(EDIT_JOB);
    // The editor mounts a heavy stack behind this route; give the first
    // assertion room on a loaded box.
    await expect(page.getByTestId('job-name')).toHaveValue(JOB.name, { timeout: 15_000 });

    const toggle = page.getByTestId('job-spawn-hidden');
    await expect(toggle).toBeVisible();
    // Stored without the flag → unticked, and it is a switch like every other
    // boolean setting (spec/14 § Controls).
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toHaveAttribute('role', 'switch');
  });

  test('ticking it round-trips to action.startHidden, keeping the continue key', async ({
    page,
  }) => {
    const saved: Saved = [];
    await stub(page, saved);
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue(JOB.name, { timeout: 15_000 });

    await page.locator('.job-editor label.toggle:has([data-testid="job-spawn-hidden"])').click();
    await expect(page.getByTestId('job-spawn-hidden')).toBeChecked();
    await page.getByTestId('job-save').click();

    await expect.poll(() => saved.length).toBe(1);
    const action = saved[0].action as Record<string, unknown>;
    expect(action.type).toBe('continue');
    expect(action.startHidden).toBe(true);
    // `key` has no field in the editor. Dropping it would silently collapse one
    // chat per task onto one shared chat.
    expect(action.key).toBe('{{payload.event_data.id}}');
  });

  test('leaving it alone posts no `hidden` key at all', async ({ page }) => {
    const saved: Saved = [];
    await stub(page, saved);
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue(JOB.name, { timeout: 15_000 });

    await page.getByTestId('job-save').click();
    await expect.poll(() => saved.length).toBe(1);
    const action = saved[0].action as Record<string, unknown>;
    // WIRE COMPATIBILITY: `ContinueAction` is `.strict()` and Tom's host OTAs
    // separately from the server, so an untouched job must still serialise to
    // exactly what a host that predates this field accepts.
    expect('hidden' in action).toBe(false);
    expect(Object.keys(action).sort()).toEqual(['daemonId', 'folder', 'key', 'skill', 'type']);
  });
});

test.describe('job editor — back button and title', () => {
  test('the back button clears the minimum hit target on both axes', async ({ page }) => {
    await stub(page, []);
    await page.goto(EDIT_JOB);
    const back = page.getByTestId('job-editor-back');
    await expect(back).toBeVisible({ timeout: 15_000 });

    const box = await back.boundingBox();
    if (box === null) throw new Error('back button has no box');
    // It was `padding: 0` at 13px — roughly 50x16.
    const floor = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tap-min')),
    );
    expect(floor).toBe(44);
    expect(box.height).toBeGreaterThanOrEqual(floor);
    expect(box.width).toBeGreaterThanOrEqual(floor);
  });

  test('a long title cannot butt into the back button', async ({ page }) => {
    await stub(page, []);
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue(JOB.name, { timeout: 15_000 });

    const back = await page.getByTestId('job-editor-back').boundingBox();
    const title = await page.locator('.job-editor .route-head h1').boundingBox();
    if (back === null || title === null) throw new Error('head has no box');

    // Same row, and a real gap between them. `.route-head` is
    // `justify-content: space-between` with no `gap`, so this job's name — the
    // longest in the app — grew until it touched the button.
    expect(title.x - (back.x + back.width)).toBeGreaterThanOrEqual(12);
  });

  test('the back button still stays flush with the form below it', async ({ page }) => {
    await stub(page, []);
    await page.goto(NEW_JOB);
    const back = page.getByTestId('job-editor-back');
    await expect(back).toBeVisible({ timeout: 15_000 });

    // The bigger hit target is bought with padding plus a negative margin of the
    // same size, so the GLYPH must land where it did before — measure the text
    // itself, not the button's border box, which is deliberately 12px wider.
    const textX = await back.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().x;
    });
    const field = await page.getByTestId('job-name').boundingBox();
    if (field === null) throw new Error('no box');
    expect(Math.abs(textX - field.x)).toBeLessThanOrEqual(2);
  });
});

test.describe('legibility — no rendered UI string is below the floor', () => {
  // The source scan in `src/__tests__/minFontSize.test.ts` covers the whole
  // stylesheet; this proves the CASCADE agrees on a real page, catching an
  // inherited or relative size that resolves small only once rendered.
  test('every visible text node on the job editor renders at or above --text-min', async ({
    page,
  }) => {
    await stub(page, []);
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue(JOB.name, { timeout: 15_000 });

    const small = await page.evaluate(() => {
      const floor = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--text-min'),
      );
      const out: Array<{ tag: string; cls: string; size: number; text: string }> = [];
      for (const el of Array.from(document.querySelectorAll('.job-editor *'))) {
        // Only elements that actually own visible text.
        const own = Array.from(el.childNodes).some(
          (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '',
        );
        if (!own) continue;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          continue;
        }
        const size = parseFloat(style.fontSize);
        if (size >= floor) continue;
        out.push({
          tag: el.tagName,
          cls: el.className.toString(),
          size,
          text: (el.textContent ?? '').slice(0, 40),
        });
      }
      return out;
    });
    expect(small).toEqual([]);
  });
});
