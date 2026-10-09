import { test, expect } from '@playwright/test';

// Recent-folder selection rule (spec/04 § Folders) on the job editor's real
// folder select. The harness seeds both special threads on their thread
// working dirs alongside real projects, so an unfiltered picker offers patch's
// own bookkeeping directories as machines-and-folders to aim a job at.
//
// A real browser rather than jsdom because a `<select>`'s `<optgroup>` options
// are what the user actually opens, and the list is assembled from two sources
// at once — the host registry over the network and the live chat store.

const NEW_JOB = '/app/dev-harness.html?route=/jobs/new';

const THREAD_FOLDERS = ['/home/tom/.patch/threads/manager', '/home/tom/.patch/threads/speakers'];

/**
 * The host registry. `recent` deliberately carries a thread dir under a
 * RELOCATED patch home (`/daemon-home/...`, as the integration rig runs it):
 * no dot segment, so only the path rule can see it.
 */
const HOSTS = {
  hosts: [
    {
      daemonId: 'd1',
      roots: ['/home/tom/projects/alpha'],
      recent: ['/daemon-home/threads/manager', '/home/tom/projects/beta'],
    },
  ],
};

function value(daemonId: string, folder: string): string {
  return JSON.stringify([daemonId, folder]);
}

async function stub(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/api/folders', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(HOSTS) }),
  );
  await page.route('**/api/models**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ models: [] }),
    }),
  );
  await page.route('**/api/skills**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ skills: [] }),
    }),
  );
  await page.route('**/api/jobs**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jobs: [] }) }),
  );
}

test.describe('job editor folder select excludes patch’s own thread folders', () => {
  test('lists real projects and no thread working dir', async ({ page }) => {
    await stub(page);
    await page.goto(NEW_JOB);

    const select = page.getByTestId('job-spawn-folder');
    await expect(select).toBeVisible();

    // The registry's root and its non-junk recent are both offered...
    await expect(
      select.locator(`option[value='${value('d1', '/home/tom/projects/alpha')}']`),
    ).toHaveCount(1);
    await expect(
      select.locator(`option[value='${value('d1', '/home/tom/projects/beta')}']`),
    ).toHaveCount(1);
    // ...as is a folder known only from chat history.
    await expect(
      select.locator(`option[value='${value('d1', '/home/tom/projects/bus')}']`),
    ).toHaveCount(1);

    // The thread dirs the harness's special threads sit in are not.
    for (const folder of THREAD_FOLDERS) {
      await expect(select.locator(`option[value='${value('d1', folder)}']`)).toHaveCount(0);
    }
    // Nor the one the host published in `recent` under a relocated patch home.
    await expect(
      select.locator(`option[value='${value('d1', '/daemon-home/threads/manager')}']`),
    ).toHaveCount(0);

    // The host's group survives regardless — Custom path… is how a job reaches
    // a machine patch has no project history on.
    await expect(select.locator(`option[value='${value('d1', '__custom__')}']`)).toHaveCount(1);
  });

  test('seeds the new job to a real project', async ({ page }) => {
    await stub(page);
    await page.goto(NEW_JOB);

    // The harness's most-recently-updated chat is in projects/bus.
    await expect(page.getByTestId('job-spawn-folder')).toHaveValue(
      value('d1', '/home/tom/projects/bus'),
    );
    // No free-text box, i.e. the seed is a listed option rather than an ad-hoc
    // path the picker fell back to.
    await expect(page.getByTestId('job-spawn-folder-custom')).toHaveCount(0);
  });
});

// That the seed SKIPS a special thread is covered in JobEditorRoute.test.tsx:
// it only misfires when a thread is the most recently updated chat of all, and
// the harness's seeds — shared with every other spec — put two real projects
// above the thread dirs. An e2e here would pass with or without the filter.
