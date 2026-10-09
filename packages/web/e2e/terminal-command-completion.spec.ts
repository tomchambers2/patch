import { test, expect, type Page } from '@playwright/test';

// spec/14 § Terminal — command completion.
//
// The bug: a pipe shell echoes nothing and prints no prompt, so a command that
// produced no output (`cd /tmp`) looked exactly like a session wedged by
// something reading stdin (`python3`). These two states have to be tellable
// apart on screen.
//
// `?ws=fake` is what makes a terminal reachable in the harness: a session only
// reaches `live` once `patch.terminal.open` is answered with a
// `patch.terminal.ready`, and nothing can be typed before that. Nothing in the
// harness actually runs a command, so `__terminalStore` stands in for the
// host reporting one finished.
const CHAT = 'chat_bgtask';
const URL = `/app/dev-harness.html?chat=${CHAT}&ws=fake`;

/** Open the chat's terminal tab (⌃`, spec/14 § Panes and tabs) and wait for
 *  its live prompt. */
async function openTerminal(page: Page): Promise<void> {
  await page.goto(URL);
  await page.getByTestId('composer').waitFor();
  await page.keyboard.press('Control+Backquote');
  await expect(page.getByTestId('terminal-input')).toBeVisible();
}

async function run(page: Page, command: string): Promise<void> {
  const input = page.getByTestId('terminal-input');
  await input.fill(command);
  await input.press('Enter');
}

/** Report a command finished, exactly as the host's sentinel filter would. */
async function finish(page: Page, code: number): Promise<void> {
  await page.evaluate(
    ({ chat, exitCode }) => {
      const store = (
        window as unknown as {
          __terminalStore: {
            getState: () => {
              sessions: Record<string, { sessionId: string }>;
              ingest: (e: unknown) => void;
            };
          };
        }
      ).__terminalStore;
      const session = store.getState().sessions[chat];
      if (!session) throw new Error(`no terminal session for ${chat}`);
      store.getState().ingest({
        type: 'patch.terminal.command-exit',
        sessionId: session.sessionId,
        code: exitCode,
      });
    },
    { chat: CHAT, exitCode: code },
  );
}

test.describe('terminal command completion', () => {
  test('a silent command reads as finished, not as a dead terminal', async ({ page }) => {
    await openTerminal(page);
    // Idle: nothing is running, so nothing claims to be.
    await expect(page.getByTestId('terminal-running')).toHaveCount(0);

    await run(page, 'cd /tmp');
    // In flight, with the way out named.
    await expect(page.getByTestId('terminal-running')).toBeVisible();
    await expect(page.getByTestId('terminal-running')).toContainText('⌃C interrupts');
    await expect(page.getByTestId('terminal-prompt-row')).toHaveAttribute('data-running', 'true');

    await finish(page, 0);
    await expect(page.getByTestId('terminal-running')).toHaveCount(0);
    await expect(page.getByTestId('terminal-prompt-row')).toHaveAttribute('data-running', 'false');
    // The echo is all there is: a clean run adds no noise of its own.
    await expect(page.getByTestId('terminal-scroll')).toContainText('❯ cd /tmp');
    await expect(page.getByTestId('terminal-scroll')).not.toContainText('exit');
  });

  test('a command that never returns keeps saying so', async ({ page }) => {
    await openTerminal(page);
    // `python3` on a pipe prints no banner and never returns — the original
    // report, where every later keystroke vanished with no explanation.
    await run(page, 'python3');
    await expect(page.getByTestId('terminal-running')).toBeVisible();
    // Give it long enough that a transient marker would have gone.
    await page.waitForTimeout(600);
    await expect(page.getByTestId('terminal-running')).toBeVisible();
    await expect(page.getByTestId('terminal-scroll')).toContainText('❯ python3');
  });

  test('a failure is spelled out in the scrollback', async ({ page }) => {
    await openTerminal(page);
    await run(page, 'git push');
    await finish(page, 128);
    await expect(page.getByTestId('terminal-scroll')).toContainText('exit 128');
    await expect(page.getByTestId('terminal-running')).toHaveCount(0);
  });

  test('the running marker is legible on the terminal surface', async ({ page }) => {
    await openTerminal(page);
    await run(page, 'pnpm install');
    const marker = page.getByTestId('terminal-running');
    await expect(marker).toBeVisible();
    // It sits on the prompt row, inside the terminal, not off in a corner.
    const row = await page.getByTestId('terminal-prompt-row').boundingBox();
    const box = await marker.boundingBox();
    expect(row).not.toBeNull();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.y).toBeGreaterThanOrEqual(row!.y - 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(row!.y + row!.height + 1);
  });
});
