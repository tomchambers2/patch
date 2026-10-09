import { test, expect } from '@playwright/test';

// Tom: "patch job page font size too small". The app-wide floor (--text-min,
// 13px) was met everywhere on the job pages, but 13px is still small for the
// pages he reads most, so they carry their own higher floor.
const JOB_PAGE_MIN_PX = 15;
const FOLDER = '/home/tom/projects/portfolio';
const JOB_ID = 'j_01KZSAG4ZNEZCNVA5AA3T4QHCA';
const JOB = {
  id: JOB_ID,
  name: 'Patch Updates',
  enabled: true,
  trigger: { type: 'todoist' },
  filter: null,
  action: { type: 'continue', daemonId: 'd1', folder: FOLDER, skill: 'app-update', key: 'k' },
  createdAt: 1,
  updatedAt: 1,
};

async function stub(page: import('@playwright/test').Page): Promise<void> {
  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  await page.route('**/api/folders**', (r) =>
    r.fulfill(json({ hosts: [{ daemonId: 'd1', roots: [FOLDER], recent: [] }] })),
  );
  await page.route('**/api/skills**', (r) =>
    r.fulfill(json({ skills: ['app-update'], paths: {} })),
  );
  await page.route('**/api/models**', (r) => r.fulfill(json({ models: [] })));
  await page.route('**/api/jobs**', (r) => r.fulfill(json({ jobs: [JOB] })));
  await page.route(`**/api/jobs/${JOB_ID}`, (r) => r.fulfill(json(JOB)));
  await page.route(`**/api/jobs/${JOB_ID}/runs**`, (r) => r.fulfill(json({ runs: [] })));
}

async function smallText(page: import('@playwright/test').Page, root: string, min: number) {
  return page.evaluate(
    ({ root, min }) => {
      const out: Array<{ cls: string; size: number; text: string }> = [];
      for (const el of Array.from(document.querySelectorAll(`${root} *`))) {
        const own = Array.from(el.childNodes).some(
          (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '',
        );
        if (!own) continue;
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        const size = parseFloat(s.fontSize);
        if (size < min)
          out.push({
            cls: el.className.toString(),
            size,
            text: (el.textContent ?? '').slice(0, 30),
          });
      }
      return out;
    },
    { root, min },
  );
}

test('job editor text is at least 15px', async ({ page }) => {
  await stub(page);
  await page.goto(`/app/dev-harness.html?route=/jobs/${JOB_ID}`);
  await expect(page.getByTestId('job-name')).toHaveValue(JOB.name, { timeout: 15_000 });
  expect(await smallText(page, '.job-editor', JOB_PAGE_MIN_PX)).toEqual([]);
});

test('jobs list text is at least 15px', async ({ page }) => {
  await stub(page);
  await page.goto('/app/dev-harness.html?route=/jobs');
  await expect(page.getByTestId('jobs-route')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.job-row').first()).toBeVisible();
  expect(await smallText(page, '.jobs-route', JOB_PAGE_MIN_PX)).toEqual([]);
});
