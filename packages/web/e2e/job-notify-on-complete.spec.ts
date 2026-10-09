import { test, expect } from '@playwright/test';

// "Notify when job complete" in the job editor (spec/14 § Jobs view, spec/08
// § Action). It is the one boolean on this form that starts ON, and that is the
// half only a real browser proves: the state the page actually paints for a
// stored job that has no such key, and that leaving it ON posts NOTHING while
// turning it OFF posts `false`. It also has to follow § Controls' inline switch
// layout beside Hide chat from sidebar, which is computed geometry.

const FOLDER = '/home/tom/projects/portfolio';
const JOB_ID = 'j_01KZSAG4ZNEZCNVA5AA3T4QHCB';

// A keyed `continue` job in the shape one is really stored in — and, like every
// job already on disk, with no `notifyOnComplete` key at all.
const JOB = {
  id: JOB_ID,
  name: 'Patch Updates',
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

/** The switch's own label element — the `.toggle` <label> that wraps it. */
const CONTROL = '.job-editor label.toggle:has([data-testid="job-spawn-notify-on-complete"])';
const HIDE_CONTROL = '.job-editor label.toggle:has([data-testid="job-spawn-hidden"])';

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
  // registration order, so a list route added last would swallow
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
      saved.push(JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>);
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

test.describe('job editor — Notify when job complete', () => {
  test('a new job opens with it ON, unlike every other toggle here', async ({ page }) => {
    await stub(page, []);
    await page.goto(NEW_JOB);
    // The editor mounts a heavy stack behind this route; give the first
    // assertion room on a loaded box.
    await expect(page.getByTestId('job-name')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId('job-spawn-notify-on-complete')).toBeChecked();
    // The contrast that makes the default legible: its neighbour is off.
    await expect(page.getByTestId('job-spawn-hidden')).not.toBeChecked();
  });

  test('the switch and its label sit on one line, flush under Hide chat', async ({ page }) => {
    await stub(page, []);
    await page.goto(NEW_JOB);
    await expect(page.getByTestId('job-name')).toBeVisible({ timeout: 15_000 });

    const control = page.locator(CONTROL);
    await expect(control).toBeVisible();

    const track = await control.locator('.toggle-track').boundingBox();
    const label = await control.locator('.toggle-label').boundingBox();
    if (track === null || label === null) throw new Error('toggle track or label has no box');

    // Same line: their vertical centres agree, within optical-alignment slack.
    const trackMid = track.y + track.height / 2;
    const labelMid = label.y + label.height / 2;
    expect(Math.abs(trackMid - labelMid)).toBeLessThanOrEqual(2);
    // Side by side, switch first — not the words with a box floating over them,
    // which is what the job editor's stacked-label layout does to a bare one.
    expect(track.x + track.width).toBeLessThanOrEqual(label.x);

    const box = await control.boundingBox();
    if (box === null) throw new Error('control has no box');
    expect(box.height).toBeLessThanOrEqual(28);

    // Directly below Hide chat from sidebar, left edges flush, so the two read
    // as one pair of settings rather than two unrelated controls.
    const hide = await page.locator(HIDE_CONTROL).boundingBox();
    if (hide === null) throw new Error('hide-chat control has no box');
    expect(box.y).toBeGreaterThan(hide.y);
    expect(Math.abs(box.x - hide.x)).toBeLessThanOrEqual(1);
  });

  test('a stored job with no such key renders it ticked', async ({ page }) => {
    await stub(page, []);
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue(JOB.name, { timeout: 15_000 });

    const toggle = page.getByTestId('job-spawn-notify-on-complete');
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeChecked();
    await expect(toggle).toHaveAttribute('role', 'switch');
  });

  test('leaving it ON posts no notifyOnComplete key at all', async ({ page }) => {
    const saved: Saved = [];
    await stub(page, saved);
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue(JOB.name, { timeout: 15_000 });

    await page.getByTestId('job-save').click();
    await expect.poll(() => saved.length).toBe(1);
    const action = saved[0]?.action as Record<string, unknown>;
    // WIRE COMPATIBILITY: default-ON is encoded as ABSENT, so an untouched job
    // still serialises to exactly what a host predating the field accepts —
    // `notifyOnComplete: true` would be a new key on every job.
    expect('notifyOnComplete' in action).toBe(false);
    expect(Object.keys(action).sort()).toEqual(['daemonId', 'folder', 'key', 'skill', 'type']);
  });

  test('turning it OFF posts notifyOnComplete: false, keeping the continue key', async ({
    page,
  }) => {
    const saved: Saved = [];
    await stub(page, saved);
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue(JOB.name, { timeout: 15_000 });

    await page.locator(CONTROL).click();
    await expect(page.getByTestId('job-spawn-notify-on-complete')).not.toBeChecked();
    await page.getByTestId('job-save').click();

    await expect.poll(() => saved.length).toBe(1);
    const action = saved[0]?.action as Record<string, unknown>;
    expect(action.notifyOnComplete).toBe(false);
    // `key` has no field in the editor. Dropping it would silently collapse one
    // chat per task onto one shared chat.
    expect(action.key).toBe('{{payload.event_data.id}}');
  });

  test('turned OFF and back ON, the key is dropped rather than written true', async ({ page }) => {
    const saved: Saved = [];
    await stub(page, saved);
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue(JOB.name, { timeout: 15_000 });

    await page.locator(CONTROL).click();
    await page.locator(CONTROL).click();
    await expect(page.getByTestId('job-spawn-notify-on-complete')).toBeChecked();
    await page.getByTestId('job-save').click();

    await expect.poll(() => saved.length).toBe(1);
    const action = saved[0]?.action as Record<string, unknown>;
    expect('notifyOnComplete' in action).toBe(false);
  });

  test('it is withheld from a message action, which settles no chat of its own', async ({
    page,
  }) => {
    await stub(page, []);
    await page.goto(NEW_JOB);
    await expect(page.getByTestId('job-name')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('job-action-type').selectOption('continue');
    await expect(page.getByTestId('job-spawn-notify-on-complete')).toBeChecked();
    await page.getByTestId('job-action-type').selectOption('message');
    await expect(page.getByTestId('job-spawn-notify-on-complete')).toHaveCount(0);
  });
});
