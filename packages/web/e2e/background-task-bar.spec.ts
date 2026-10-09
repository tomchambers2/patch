import { test, expect, type Page } from '@playwright/test';

// spec/14 § Main chat panel — Background task bar.
//
// jsdom (ChatRoute.backgroundTaskBar.test.tsx) proves the wiring; this proves
// the readout is really on screen with the real CSS: one full-width bar PER
// running task above the transcript, each named, each spinning, folding to
// one counted summary line — plus the kill/elapsed/command-preview additions.
//
// `chat_bgtask`'s hydrate seed (dev-harness.tsx) already reports
// `backgroundTasks: 2` on `chat.state`, which is what the bar's very existence
// is gated on now (chatRunner.ts emits it the instant a watch starts or is
// killed). The per-task ROWS come from `GET /api/chats/:id/watch`, stubbed
// here with the same task names the old Bash/Task `run_in_background`
// transcript fixture used, so this file proves the same ground the old one
// did — just fed by the real mechanism instead of the denied one.
const BG = '/app/dev-harness.html?chat=chat_bgtask';

const NOW = Date.now();
const RUNNING = [
  {
    taskId: 'diag-25045',
    description: 'Diagnose 25045 test failures',
    command: 'pnpm --filter @patch/web test -- --grep 25045',
    outputFile: '/data/chats/chat_bgtask/watch/diag-25045.output',
    status: 'running' as const,
    startedAt: NOW - 5_000,
  },
  {
    taskId: 'baiw888mq',
    description: 'Build web package to compile CSS',
    command: 'pnpm --filter @patch/web build',
    outputFile: '/data/chats/chat_bgtask/watch/baiw888mq.output',
    status: 'running' as const,
    startedAt: NOW - 65_000,
  },
];
const ENDED = [
  {
    taskId: 'typecheck1',
    description: 'Typecheck the monorepo',
    command: 'pnpm typecheck',
    outputFile: '/data/chats/chat_bgtask/watch/typecheck1.output',
    status: 'failed' as const,
    startedAt: NOW - 40_000,
    endedAt: NOW - 30_000,
    exitCode: 1,
  },
  {
    taskId: 'bkill01xy',
    description: 'Ship the web bundle',
    command: 'pnpm run deploy',
    outputFile: '/data/chats/chat_bgtask/watch/bkill01xy.output',
    status: 'stopped' as const,
    startedAt: NOW - 50_000,
    endedAt: NOW - 45_000,
  },
  {
    taskId: 'serversuite',
    description: 'Run the server suite',
    command: 'pnpm --filter @patch/server test',
    outputFile: '/data/chats/chat_bgtask/watch/serversuite.output',
    status: 'exited' as const,
    startedAt: NOW - 90_000,
    endedAt: NOW - 80_000,
    exitCode: 0,
  },
];

/** Serve `GET /api/chats/chat_bgtask/watch` with the fixture list above. */
async function stubWatchList(page: Page, tasks: unknown[] = [...RUNNING, ...ENDED]): Promise<void> {
  await page.route('**/api/chats/chat_bgtask/watch', (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ tasks }),
    });
  });
}

test.describe('background task bar', () => {
  test('sits above the transcript as one bar per running task, newest first', async ({ page }) => {
    await stubWatchList(page);
    await page.goto(BG);
    const bar = page.getByTestId('background-task-bar');
    await expect(bar).toBeVisible();
    await expect(bar).toHaveAttribute('data-collapsed', 'false');
    const rows = page.getByTestId('background-task-bar-task');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Diagnose 25045 test failures');
    await expect(rows.nth(1)).toContainText('Build web package to compile CSS');
    await expect(bar).not.toContainText('Run the server suite');
    await expect(page.getByTestId('background-task-bar-count')).toHaveText('2 background tasks');

    const head = await page.getByTestId('chat-main').boundingBox();
    const box = await bar.boundingBox();
    const stream = await page.getByTestId('chat-stream').boundingBox();
    if (!head || !box || !stream) throw new Error('missing layout boxes');
    expect(box.y).toBeGreaterThan(head.y);
    expect(box.y + box.height).toBeLessThanOrEqual(stream.y + 1);
    expect(box.width).toBeGreaterThan(300);

    const first = await rows.nth(0).boundingBox();
    const second = await rows.nth(1).boundingBox();
    if (!first || !second) throw new Error('missing row boxes');
    expect(first.height).toBeLessThan(28);
    expect(second.height).toBeLessThan(28);
    expect(second.y).toBeGreaterThan(first.y + first.height - 1);
    expect(second.x).toBeCloseTo(first.x, 1);
  });

  test('every running row spins', async ({ page }) => {
    await stubWatchList(page);
    await page.goto(BG);
    const spinners = page.locator('.background-task-bar-spinner');
    await expect(spinners).toHaveCount(2);
    for (const i of [0, 1]) {
      const anim = await spinners.nth(i).evaluate((el) => {
        const s = getComputedStyle(el);
        return {
          name: s.animationName,
          dur: s.animationDuration,
          count: s.animationIterationCount,
          timing: s.animationTimingFunction,
        };
      });
      expect(anim.name).toBe('background-task-spin');
      expect(anim.dur).toBe('1.8s');
      expect(anim.count).toBe('infinite');
      expect(anim.timing).toBe('linear');
    }
    const at = async (): Promise<string> =>
      spinners.nth(0).evaluate((el) => getComputedStyle(el).transform);
    const before = await at();
    await page.waitForTimeout(200);
    expect(await at()).not.toBe(before);
  });

  test('the spinners sit still under a reduced-motion preference', async ({ page }) => {
    await stubWatchList(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(BG);
    const spinner = page.locator('.background-task-bar-spinner').first();
    await expect(spinner).toBeVisible();
    expect(await spinner.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  });

  test('collapses to one counted line and expands again', async ({ page }) => {
    await stubWatchList(page);
    await page.goto(BG);
    const bar = page.getByTestId('background-task-bar');
    const toggle = page.getByTestId('background-task-bar-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const expandedHeight = (await bar.boundingBox())!.height;

    await toggle.click();
    await expect(bar).toHaveAttribute('data-collapsed', 'true');
    await expect(page.getByTestId('background-task-bar-task')).toHaveCount(0);
    await expect(page.getByTestId('background-task-bar-count')).toHaveText('2 background tasks');
    await expect(page.getByTestId('background-task-bar-toggle')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect((await bar.boundingBox())!.height).toBeLessThan(expandedHeight);

    await page.getByTestId('background-task-bar-toggle').click();
    await expect(page.getByTestId('background-task-bar-task')).toHaveCount(2);
    await expect(page.getByTestId('background-task-bar-count')).toHaveText('2 background tasks');
  });

  test('the fold survives a reload', async ({ page }) => {
    await stubWatchList(page);
    await page.goto(BG);
    await page.getByTestId('background-task-bar-toggle').click();
    await expect(page.getByTestId('background-task-bar-count')).toBeVisible();

    await page.reload();
    await expect(page.getByTestId('background-task-bar')).toHaveAttribute('data-collapsed', 'true');
    await expect(page.getByTestId('background-task-bar-count')).toHaveText('2 background tasks');
    await expect(page.getByTestId('background-task-bar-task')).toHaveCount(0);
  });

  test('the title stays above the bars when the stack is expanded', async ({ page }) => {
    await stubWatchList(page);
    await page.goto(BG);
    const title = page.getByTestId('background-task-bar-count');
    await expect(title).toHaveText('2 background tasks');
    const titleBox = await title.boundingBox();
    const firstRow = await page.getByTestId('background-task-bar-task').nth(0).boundingBox();
    if (!titleBox || !firstRow) throw new Error('missing boxes');
    expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(firstRow.y + 1);
    await expect(page.locator('.background-task-bar-spinner')).toHaveCount(2);
    await page.getByTestId('background-task-bar-toggle').click();
    await expect(page.locator('.background-task-bar-spinner')).toHaveCount(1);
  });

  test('the rows are set at body size on a readable line', async ({ page }) => {
    await stubWatchList(page);
    await page.goto(BG);
    const row = page.getByTestId('background-task-bar-task').nth(0);
    const size = await row.evaluate((el) => {
      const s = getComputedStyle(el);
      return { font: parseFloat(s.fontSize), line: parseFloat(s.lineHeight) };
    });
    expect(size.font).toBeGreaterThanOrEqual(14);
    expect(size.line).toBeGreaterThanOrEqual(22);
    const box = await row.boundingBox();
    if (!box) throw new Error('missing row box');
    expect(box.height).toBeGreaterThanOrEqual(20);
    expect(box.height).toBeLessThan(32);
  });

  // Elapsed time (background-task reliability overhaul, part 3).
  test.describe('elapsed time', () => {
    test('a running row shows elapsed time next to the spinner, and it ticks upward', async ({
      page,
    }) => {
      await stubWatchList(page, [{ ...RUNNING[0], startedAt: Date.now() }]);
      await page.goto(BG);
      const row = page.getByTestId('background-task-bar-task').first();
      const elapsed = row.getByTestId('background-task-bar-elapsed');
      await expect(elapsed).toBeVisible();
      const first = await elapsed.textContent();
      await page.waitForTimeout(2_200);
      await expect(elapsed).not.toHaveText(first ?? '');
    });

    test('an ended row shows no elapsed clock', async ({ page }) => {
      await stubWatchList(page);
      await page.goto(BG);
      await page.getByTestId('background-task-bar-show-all').check();
      const rows = page.getByTestId('background-task-bar-task');
      const ended = rows.filter({ hasText: 'Typecheck the monorepo' });
      await expect(ended.getByTestId('background-task-bar-elapsed')).toHaveCount(0);
    });
  });

  // Command preview + click-to-expand (background-task reliability overhaul, part 3).
  test.describe('command preview', () => {
    test('a long command is truncated, and clicking it reveals the whole thing without opening the terminal', async ({
      page,
    }) => {
      await stubWatchList(page, [
        {
          ...RUNNING[0],
          command:
            'pnpm --filter @patch/web test -- --grep "a much longer flag than the preview length allows"',
        },
      ]);
      await page.goto(BG);
      const preview = page.getByTestId('background-task-bar-command');
      const full =
        'pnpm --filter @patch/web test -- --grep "a much longer flag than the preview length allows"';
      await expect(preview).not.toHaveText(full);
      await preview.click();
      await expect(preview).toHaveText(full);
      await expect(page.getByTestId('terminal-pane')).toHaveCount(0);
    });
  });

  // Kill button (background-task reliability overhaul, part 3 — reverses
  // spec/14-design-web.md's original "the agent owns the task" decision).
  test.describe('kill', () => {
    test('a running row carries a kill control that stops it without opening the terminal', async ({
      page,
    }) => {
      await stubWatchList(page);
      let stopped: string | null = null;
      await page.route('**/api/chats/chat_bgtask/watch/*/stop', (route) => {
        stopped = route.request().url();
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ stopped: true }),
        });
      });
      await page.goto(BG);
      const row = page.getByTestId('background-task-bar-task').filter({ hasText: 'Build web' });
      await row.getByTestId('background-task-bar-kill').click();
      await expect.poll(() => stopped).toContain('baiw888mq');
      await expect(page.getByTestId('terminal-pane')).toHaveCount(0);
    });

    test('an ended row carries no kill control', async ({ page }) => {
      await stubWatchList(page);
      await page.goto(BG);
      await page.getByTestId('background-task-bar-show-all').check();
      const ended = page
        .getByTestId('background-task-bar-task')
        .filter({ hasText: 'Typecheck the monorepo' });
      await expect(ended.getByTestId('background-task-bar-kill')).toHaveCount(0);
    });
  });

  test('is absent on a chat that launched nothing in the background', async ({ page }) => {
    await page.goto('/app/dev-harness.html?chat=chat_md');
    await expect(page.getByTestId('chat-stream')).toBeVisible();
    await expect(page.getByTestId('background-task-bar')).toHaveCount(0);
  });

  test('is absent on a chat whose only background task already reported back', async ({ page }) => {
    // chat_task_notification carries no live `backgroundTasks` count at all —
    // its `<task-notification>` transcript block is for the notice-lifting
    // e2e (background-task-notification.spec.ts), a separate concern from
    // this bar.
    await page.goto('/app/dev-harness.html?chat=chat_task_notification');
    await expect(page.getByTestId('bg-task-notice')).toBeVisible();
    await expect(page.getByTestId('background-task-bar')).toHaveCount(0);
  });

  // Show all (spec/14 § Main chat panel — Background task bar).
  test.describe('show all', () => {
    test('the ended tasks are not in the bar and are not counted', async ({ page }) => {
      await stubWatchList(page);
      await page.goto(BG);
      const bar = page.getByTestId('background-task-bar');
      await expect(page.getByTestId('background-task-bar-task')).toHaveCount(2);
      await expect(page.getByTestId('background-task-bar-count')).toHaveText('2 background tasks');
      await expect(bar).not.toContainText('Ship the web bundle');
      await expect(bar).not.toContainText('Typecheck the monorepo');
      await expect(page.getByTestId('background-task-bar-show-all')).not.toBeChecked();
    });

    test('checking it lists the ended tasks under the running ones, struck through', async ({
      page,
    }) => {
      await stubWatchList(page);
      await page.goto(BG);
      await page.getByTestId('background-task-bar-show-all').check();
      const rows = page.getByTestId('background-task-bar-task');
      await expect(rows).toHaveCount(5);
      await expect(rows.nth(0)).toContainText('Diagnose 25045 test failures');
      await expect(rows.nth(1)).toContainText('Build web package to compile CSS');
      await expect(rows.nth(2)).toContainText('Typecheck the monorepo');
      await expect(rows.nth(3)).toContainText('Ship the web bundle');
      await expect(rows.nth(4)).toContainText('Run the server suite');
      await expect(rows.nth(1)).toHaveAttribute('data-ended', 'false');
      await expect(rows.nth(2)).toHaveAttribute('data-ended', 'true');
      await expect(rows.nth(4)).toHaveAttribute('data-ended', 'true');

      const line = async (i: number): Promise<string> =>
        rows
          .nth(i)
          .getByTestId('background-task-bar-description')
          .evaluate((el) => getComputedStyle(el).textDecorationLine);
      expect(await line(2)).toContain('line-through');
      expect(await line(3)).toContain('line-through');
      expect(await line(0)).not.toContain('line-through');
      expect(await line(1)).not.toContain('line-through');

      await expect(page.getByTestId('background-task-bar-count')).toHaveText('2 background tasks');
      const box = await rows.nth(2).boundingBox();
      if (!box) throw new Error('missing row box');
      expect(box.height).toBeLessThan(32);
    });

    test('an ended row does not turn', async ({ page }) => {
      await stubWatchList(page);
      await page.goto(BG);
      await page.getByTestId('background-task-bar-show-all').check();
      const rows = page.getByTestId('background-task-bar-task');
      await expect(rows).toHaveCount(5);
      await expect(page.locator('.background-task-bar-spinner')).toHaveCount(2);
      for (const i of [2, 3, 4]) {
        await expect(rows.nth(i).locator('.background-task-bar-spinner')).toHaveCount(0);
      }
      const x = async (i: number): Promise<number> => {
        const b = await rows.nth(i).getByTestId('background-task-bar-description').boundingBox();
        if (!b) throw new Error('missing description box');
        return b.x;
      };
      expect(await x(2)).toBeCloseTo(await x(0), 1);
    });

    test('the checkbox survives a reload, and folds away with the stack', async ({ page }) => {
      await stubWatchList(page);
      await page.goto(BG);
      await page.getByTestId('background-task-bar-show-all').check();
      await expect(page.getByTestId('background-task-bar-task')).toHaveCount(5);

      await page.reload();
      await expect(page.getByTestId('background-task-bar-show-all')).toBeChecked();
      await expect(page.getByTestId('background-task-bar-task')).toHaveCount(5);

      await page.getByTestId('background-task-bar-toggle').click();
      await expect(page.getByTestId('background-task-bar-task')).toHaveCount(0);
      await expect(page.getByTestId('background-task-bar-show-all')).toHaveCount(0);
      await expect(page.getByTestId('background-task-bar-count')).toHaveText('2 background tasks');
    });

    test('an ended task still opens the terminal on the output it left behind', async ({
      page,
    }) => {
      await stubWatchList(page);
      await page.goto(BG);
      await page.getByTestId('background-task-bar-show-all').check();
      await page
        .getByTestId('background-task-bar-task')
        .filter({ hasText: 'Ship the web bundle' })
        .click();
      await expect(page.getByTestId('terminal-pane')).toBeVisible();
    });

    test('unchecking it takes the ended tasks away again', async ({ page }) => {
      await stubWatchList(page);
      await page.goto(BG);
      const box = page.getByTestId('background-task-bar-show-all');
      await box.check();
      await expect(page.getByTestId('background-task-bar-task')).toHaveCount(5);
      await box.uncheck();
      await expect(page.getByTestId('background-task-bar-task')).toHaveCount(2);
      await expect(page.getByTestId('background-task-bar')).not.toContainText(
        'Typecheck the monorepo',
      );
    });
  });

  test('does not resurrect the removed other-chats bar', async ({ page }) => {
    await stubWatchList(page);
    await page.goto(BG);
    await expect(page.getByTestId('background-task-bar')).toBeVisible();
    await expect(page.getByTestId('bg-runs-bar')).toHaveCount(0);
    await expect(page.getByText(/others? running/i)).toHaveCount(0);
  });
});
