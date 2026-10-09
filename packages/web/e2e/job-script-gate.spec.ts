import { test, expect } from '@playwright/test';

// A `script` job is a GATE (@patch/wire `ScriptAction`): it fires on a tight
// cron, decides whether there is work worth an agent turn, and mostly decides
// there is not. Two things were wrong with that in a real browser.
//
// Its HISTORY said nothing. Every held fire recorded `ok`, exit 0, so a gate
// that quietly broke three days ago looked identical to one correctly holding.
// The exit code and output tail were already in the run log; nothing rendered
// them. Tom: "i cant actually dig into when the job gets launched because its in
// code. and control hidden etc".
//
// And its COMMAND is a script — a whole gate, handed to `bash -lc` — which a
// four-row textarea cannot show you. These exercise both against real Monaco.

const FOLDER = '/home/claude-dev/projects/portfolio';
const JOB_ID = 'j_01M2587S0RCVM6ET399PTNB7Z8';

const GATE = [
  '#!/usr/bin/env bash',
  '# Foreman gate. Prints its verdict on every fire.',
  'set -euo pipefail',
  '',
  'QUIET_FROM=23',
  'AUDIT_HOUR=21',
  'echo "not due — holding"',
].join('\n');

const SCRIPT_JOB = {
  id: JOB_ID,
  name: 'Foreman: 15-min gate',
  enabled: true,
  trigger: { type: 'cron', expression: '*/15 * * * *', timezone: 'Europe/London' },
  filter: null,
  action: {
    type: 'script',
    daemonId: 'd1',
    folder: FOLDER,
    command: GATE,
    timeoutMs: 120_000,
  },
  concurrency: 1,
  createdAt: 1,
  updatedAt: 1,
};

/** The same watcher written the right way round: a gate decides, a spawn works. */
const GATED_JOB = {
  id: JOB_ID,
  name: 'Foreman',
  enabled: true,
  trigger: { type: 'cron', expression: '*/15 * * * *', timezone: 'Europe/London' },
  filter: null,
  gate: { daemonId: 'd1', folder: FOLDER, command: GATE, timeoutMs: 120_000 },
  action: { type: 'spawn', daemonId: 'd1', folder: FOLDER, skill: 'foreman' },
  concurrency: 1,
  createdAt: 1,
  updatedAt: 1,
};

/** A watcher's real day: mostly holds, the odd launch, and one broken gate. */
const GATE_RUNS = [
  {
    ts: Date.parse('2026-09-12T20:45:00Z'),
    jobId: JOB_ID,
    status: 'gate-error',
    trigger: 'cron',
    error: 'gate exited 1, which means hold, but printed no reason on stdout',
    action: { type: 'spawn', exitCode: 1, output: 'curl: (7) Failed to connect' },
  },
  {
    ts: Date.parse('2026-09-12T20:30:00Z'),
    jobId: JOB_ID,
    status: 'ok',
    trigger: 'cron',
    action: {
      type: 'spawn',
      chatId: '01M2COACH',
      output: 'due (desktop 40s ago) -> run\n',
    },
  },
  {
    ts: Date.parse('2026-09-12T20:15:00Z'),
    jobId: JOB_ID,
    status: 'gate-held',
    trigger: 'cron',
    action: { type: 'spawn', exitCode: 1, output: 'not due (next wake in 420s) — holding\n' },
  },
  {
    ts: Date.parse('2026-09-12T20:00:00Z'),
    jobId: JOB_ID,
    status: 'gate-held',
    trigger: 'cron',
    action: { type: 'spawn', exitCode: 1, output: 'quiet hours (23:40) — holding\n' },
  },
];

/** A held fire, a launch, and a fault — the three things a gate's day contains. */
const RUNS = [
  {
    ts: Date.parse('2026-09-12T20:45:00Z'),
    jobId: JOB_ID,
    status: 'dispatch-error',
    trigger: 'cron',
    error: 'command exited 1',
    action: {
      type: 'script',
      exitCode: 1,
      output: 'observer unreachable on http://127.0.0.1:3422 — cannot judge anything',
    },
  },
  {
    ts: Date.parse('2026-09-12T20:30:00Z'),
    jobId: JOB_ID,
    status: 'ok',
    trigger: 'cron',
    action: {
      type: 'script',
      exitCode: 0,
      chatId: '01M2COACH',
      output: 'patch:chat 01M2COACH\ndue (desktop 40s ago) -> spawned the coach on claude-opus-5',
    },
  },
  {
    ts: Date.parse('2026-09-12T20:15:00Z'),
    jobId: JOB_ID,
    status: 'ok',
    trigger: 'cron',
    action: {
      type: 'script',
      exitCode: 0,
      output: 'checked the observer\nnot due (coach asked for 1789243200, 420s away) — holding',
    },
  },
];

const EDIT_JOB = `/app/dev-harness.html?route=/jobs/${JOB_ID}`;

/** The gate switch's own label — the `.toggle` <label> wrapping its hidden input. */
const GATE_SWITCH = '.job-editor label.toggle:has([data-testid="job-gate-on"])';

async function stub(
  page: import('@playwright/test').Page,
  runs: unknown[],
  job: Record<string, unknown> = SCRIPT_JOB,
): Promise<void> {
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
      body: JSON.stringify({ skills: [], paths: {} }),
    }),
  );
  await page.route('**/api/models**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ models: [] }),
    }),
  );
  // Broadest FIRST: playwright checks handlers in reverse registration order,
  // so a list route added last would swallow the per-job routes below it.
  await page.route('**/api/jobs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: [job] }),
    }),
  );
  await page.route(`**/api/jobs/${JOB_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(job),
    }),
  );
  await page.route(`**/api/jobs/${JOB_ID}/runs**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs }),
    }),
  );
  await page.route(`**/api/jobs/${JOB_ID}/queue**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ concurrency: 1, inFlight: [], queued: [] }),
    }),
  );
}

test.describe('script job — the gate and its decisions', () => {
  test('the command is a real code editor that Edit grows to working height', async ({ page }) => {
    await stub(page, []);
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue(SCRIPT_JOB.name, { timeout: 15_000 });

    const editor = page.getByTestId('job-script-editor');
    await expect(editor).toBeVisible();
    // Monaco renders the stored script — the gate is READABLE from the app,
    // which is the whole point of keeping it in the job rather than in a file
    // on the host.
    const monaco = editor.locator('.monaco-editor');
    await expect(monaco).toBeVisible({ timeout: 20_000 });
    await expect(editor.getByText('QUIET_FROM=23')).toBeVisible();

    // Edit grows it; the button then offers the way back.
    const body = editor.locator('.job-script-editor-body');
    const collapsed = (await body.boundingBox())?.height ?? 0;
    expect(collapsed).toBeGreaterThan(0);
    await page.getByTestId('job-script-expand').click();
    await expect(page.getByTestId('job-script-expand')).toHaveText('Collapse');
    await expect
      .poll(async () => (await body.boundingBox())?.height ?? 0)
      .toBeGreaterThan(collapsed);
    // Collapsed or expanded, it is the same EDITABLE editor — the button changes
    // the room, never the writability. Proved by typing rather than by probing
    // an attribute: Monaco keeps a readonly `ime-text-area` of its own, so the
    // only honest check is whether a keystroke lands.
    await monaco.locator('.view-lines').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nTYPED_OK=1');
    // `toContainText`, not `getByText`: Monaco splits a line into one span per
    // token, so no single element holds a whole line of shell.
    await expect(editor).toContainText('TYPED_OK=1');
  });

  test('recent runs shows each fire’s verdict, its chat, and a fault', async ({ page }) => {
    await stub(page, RUNS);
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue(SCRIPT_JOB.name, { timeout: 15_000 });

    const panel = page.getByTestId('recent-runs');
    await expect(panel).toBeVisible();

    // Three fires, three different verdicts — which is the difference between
    // this panel and the wall of identical `ok` rows it replaces.
    const verdicts = panel.getByTestId('run-verdict');
    await expect(verdicts).toHaveCount(3);
    await expect(verdicts.nth(0)).toHaveText(/observer unreachable/);
    await expect(verdicts.nth(1)).toHaveText(/spawned the coach on claude-opus-5/);
    await expect(verdicts.nth(2)).toHaveText(/not due .* — holding/);

    // The fire that SPENT money links to what it bought; the ones that held
    // have nothing to link, so a launch is visible at a glance.
    const links = panel.locator('.run-chat-link');
    await expect(links).toHaveCount(1);
    await expect(links).toHaveAttribute('href', '/chats/01M2COACH');

    // A fault shows its exit code. A held fire exited 0 and says nothing about
    // it — holding on purpose SUCCEEDED, and `exit 0` on every row is the noise
    // this panel exists to cut.
    await expect(panel.getByTestId('run-exit')).toHaveCount(1);
    await expect(panel.getByTestId('run-exit')).toHaveText('exit 1');

    // The rest of the output is one click away, not lost.
    const held = panel.locator('li.run-row').nth(2);
    await expect(held.getByTestId('run-output')).toHaveCount(0);
    await held.getByTestId('run-output-toggle').click();
    await expect(held.getByTestId('run-output')).toContainText('checked the observer');
  });

  test('the jobs list names the gate by its first line of code, not its shebang', async ({
    page,
  }) => {
    await stub(page, []);
    await page.goto('/app/dev-harness.html?route=/jobs');
    const row = page.locator('.job-row', { hasText: SCRIPT_JOB.name });
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Clipping the command to 48 chars labelled every gate with the same
    // shebang-plus-comment prefix. The first real statement says more.
    await expect(row).toContainText('set -euo pipefail');
    await expect(row).toContainText('7 lines');
  });
});

// spec/08 § Gate. The shape Tom asked for: "script could be a gate that gets
// true/false, exit, error that kind of thing" — the command decides, the job's
// own action does the work, so the chat it makes is the job's chat with all the
// machinery attached.
test.describe('gated job — the decision and the work are separate', () => {
  test('the gate is its own section, editable, with its exit-code contract stated', async ({
    page,
  }) => {
    await stub(page, [], GATED_JOB);
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue('Foreman', { timeout: 15_000 });

    const gate = page.getByTestId('group-gate');
    await expect(gate).toBeVisible();
    // Loading a gated job arrives with the box ticked and the script in it.
    await expect(page.getByTestId('job-gate-on')).toBeChecked();
    await expect(page.getByTestId('job-gate-folder')).toHaveValue(FOLDER);
    await expect(page.getByTestId('job-gate-timeout')).toHaveValue('120000');
    const editor = page.getByTestId('job-gate-editor');
    await expect(editor.locator('.monaco-editor')).toBeVisible({ timeout: 20_000 });
    await expect(editor).toContainText('QUIET_FROM=23');
    // The rule that stops a broken gate reading as a quiet week is written where
    // the gate is written.
    await expect(gate).toContainText('exit 1');
    await expect(gate).toContainText('must print why');

    // And the ACTION is still the job's own action — the point of the rework.
    await expect(page.getByTestId('job-action-type')).toHaveValue('spawn');
  });

  test('unticking the gate posts gate: null, so it actually clears', async ({ page }) => {
    const posted: unknown[] = [];
    await stub(page, [], GATED_JOB);
    await page.route(`**/api/jobs/${JOB_ID}`, (route) => {
      const req = route.request();
      if (req.method() === 'PATCH') {
        posted.push(JSON.parse(req.postData() ?? '{}'));
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(GATED_JOB),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(GATED_JOB),
      });
    });
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue('Foreman', { timeout: 15_000 });
    await page.locator(GATE_SWITCH).click();
    await expect(page.getByTestId('job-gate-editor')).toHaveCount(0);
    await page.getByTestId('job-save').click();
    await expect.poll(() => posted.length).toBeGreaterThan(0);
    // Omitting the key would LEAVE the stored gate in place — an untick that
    // silently did nothing.
    expect((posted[0] as { gate: unknown }).gate).toBeNull();
  });

  test('recent runs: launches and faults show, holds hide behind a counted toggle', async ({
    page,
  }) => {
    await stub(page, GATE_RUNS, GATED_JOB);
    await page.goto(EDIT_JOB);
    await expect(page.getByTestId('job-name')).toHaveValue('Foreman', { timeout: 15_000 });

    const panel = page.getByTestId('recent-runs');
    // By default: the launch and the BROKEN gate. Two rows out of four, and the
    // two that matter — a watcher holds hundreds of times a day, and the run you
    // came to find must not be buried under them.
    await expect(panel.locator('li.run-row')).toHaveCount(2);
    await expect(panel.locator('.status-gate-error')).toHaveCount(1);
    await expect(panel.locator('.run-chat-link')).toHaveAttribute('href', '/chats/01M2COACH');
    // A fault's verdict line is whatever the gate managed to say (here, curl's
    // complaint), and the diagnosis of WHY it is a fault is the run's error.
    await expect(panel.getByTestId('run-verdict').first()).toContainText('Failed to connect');
    await expect(panel.locator('.run-error')).toContainText(
      'gate exited 1, which means hold, but printed no reason',
    );
    // A launch shows what its gate said to let it through — one fire, one row.
    await expect(panel.getByTestId('run-verdict').nth(1)).toContainText('due (desktop 40s ago)');

    // The count is the liveness signal: 2 held says the gate is deciding. And it
    // is called "held", not "rejected" — holding is what this job DOES.
    const toggle = panel.getByTestId('recent-runs-rejected-toggle');
    await expect(toggle).toHaveText('Show 2 held');
    await toggle.click();
    await expect(panel.locator('li.run-row')).toHaveCount(4);
    // Each hold carries the reason it gave, which is the whole reason to look.
    await expect(panel.getByText('not due (next wake in 420s) — holding')).toBeVisible();
    await expect(panel.getByText('quiet hours (23:40) — holding')).toBeVisible();
  });

  test('a new job can be given a gate from scratch', async ({ page }) => {
    const posted: unknown[] = [];
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
        body: JSON.stringify({ skills: ['foreman'], paths: {} }),
      }),
    );
    await page.route('**/api/models**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ models: [] }),
      }),
    );
    await page.route('**/api/jobs**', (route) => {
      const req = route.request();
      if (req.method() === 'POST') {
        posted.push(JSON.parse(req.postData() ?? '{}'));
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'j_new' }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jobs: [] }),
      });
    });
    await page.goto('/app/dev-harness.html?route=/jobs/new');
    await page.getByTestId('job-name').fill('new watcher');
    // Off by default — most jobs want no gate, and the section must not nag.
    await expect(page.getByTestId('job-gate-editor')).toHaveCount(0);
    await page.locator(GATE_SWITCH).click();
    const editor = page.getByTestId('job-gate-editor');
    await expect(editor.locator('.monaco-editor')).toBeVisible({ timeout: 20_000 });
    // Ticking it seeds host and folder FROM THE ACTION, which is where the work
    // happens and so nearly always where the question belongs. Read the action's
    // own folder rather than asserting a literal: a new job seeds that from the
    // most-recently-used pair, which is not this spec's to choose.
    const actionFolder = await page
      .getByTestId('job-spawn-folder')
      .inputValue()
      .catch(() => '');
    expect(actionFolder).not.toBe('');
    await expect(page.getByTestId('job-gate-folder')).toHaveValue(
      JSON.parse(actionFolder)[1] as string,
    );
    await editor.locator('.view-lines').click();
    await page.keyboard.type('test -s queue || exit 1');
    await page.getByTestId('job-spawn-skill').selectOption('foreman');
    await page.getByTestId('job-save').click();
    await expect.poll(() => posted.length).toBeGreaterThan(0);
    const body = posted[0] as {
      gate: { command: string; folder: string; daemonId: string };
      action: { folder: string; daemonId: string };
    };
    expect(body.gate.command).toContain('test -s queue || exit 1');
    // The gate is asked on the same machine, in the same folder, as the work.
    expect(body.gate.folder).toBe(body.action.folder);
    expect(body.gate.daemonId).toBe(body.action.daemonId);
  });
});
