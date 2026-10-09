import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

// The sidebar's global chat search (spec/03 § Chat search) in a real browser,
// against the dev harness with `/api/chats/search` stubbed: the field shares the
// Needs attention row, results replace the chat list with highlighted matches,
// an unsearched host is named, a failure is shown, and a result opens its chat
// scrolled to — and ringing — the matched message.

const HARNESS = '/app/dev-harness.html?chat=chat_md';
const HOUR = 3_600_000;

function searchBody(query: string): unknown {
  return {
    query,
    hits: [
      {
        chatId: 'chat_scroll',
        daemonId: 'd1',
        name: 'scroll-fixture',
        preview: null,
        folder: '/home/tom/projects/bus',
        status: 'active',
        section: 'folders',
        pinned: false,
        snoozedUntil: null,
        lastUpdated: Date.now() - HOUR,
        jobId: null,
        nameMatch: false,
        nameHighlights: [],
        messageMatches: 2,
        snippet: {
          text: 'history line 5 — lorem ipsum dolor sit amet',
          highlights: [[17, 22]],
          role: 'assistant',
          seq: 5,
          createdAt: Date.now() - 2 * HOUR,
        },
      },
      {
        chatId: 'chat_md',
        daemonId: 'd1',
        name: 'lorem notes',
        preview: null,
        folder: '/home/tom/projects/portfolio',
        status: 'archived',
        section: 'archived',
        pinned: false,
        snoozedUntil: null,
        lastUpdated: Date.now() - 5 * HOUR,
        jobId: 'job_x',
        nameMatch: true,
        nameHighlights: [[0, 5]],
        messageMatches: 0,
        snippet: null,
      },
    ],
    total: 2,
    nextOffset: null,
    hosts: [
      { daemonId: 'd1', hostName: 'hetzner', state: 'searched', searchedChats: 12 },
      { daemonId: 'mac1', hostName: 'Mac', state: 'offline' },
    ],
  };
}

async function stubSearch(
  page: Page,
  handler: (route: Route, q: string) => unknown,
): Promise<void> {
  await page.route('**/api/chats/search**', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    return handler(route, q) as Promise<void>;
  });
}

test.describe('sidebar chat search', () => {
  test('shares the Needs attention row and costs the chat list no height', async ({ page }) => {
    await page.goto(HARNESS);
    await page.locator('.sb-row').first().waitFor();
    const chip = (await page.getByTestId('attention-toggle').boundingBox())!;
    const field = (await page.getByTestId('chat-search').boundingBox())!;
    const row = (await page.locator('.sb-scroll .sb-row').first().boundingBox())!;
    // Same row, same height as the chip.
    expect(Math.abs(field.y - chip.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(field.height - chip.height)).toBeLessThanOrEqual(1);
    // Chip on the left, field filling to the rows' shared right edge.
    expect(field.x).toBeGreaterThan(chip.x + chip.width);
    expect(Math.abs(field.x + field.width - (row.x + row.width))).toBeLessThanOrEqual(1);
    // Wide enough to show its placeholder in full.
    const fits = await page.getByTestId('chat-search').evaluate((el) => {
      const input = el as HTMLInputElement;
      const cs = getComputedStyle(input);
      const probe = document.createElement('span');
      probe.style.font = cs.font;
      probe.style.position = 'absolute';
      probe.style.whiteSpace = 'nowrap';
      probe.textContent = input.placeholder;
      document.body.appendChild(probe);
      const need = probe.getBoundingClientRect().width;
      probe.remove();
      const have = input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      return need <= have;
    });
    expect(fits).toBe(true);
  });

  test('results replace the list, with highlights, meta and the offline host named', async ({
    page,
  }) => {
    await stubSearch(page, (route, q) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(searchBody(q)),
      }),
    );
    await page.goto(HARNESS);
    await page.locator('.sb-row').first().waitFor();

    await page.getByTestId('chat-search').fill('lorem');
    const hits = page.getByTestId('chat-search-hit');
    await expect(hits).toHaveCount(2);
    // The chat list is gone from the band while searching; lifecycle stays.
    await expect(page.getByTestId('chat-row-chat_bus')).toHaveCount(0);
    await expect(page.getByTestId('sb-lifecycle')).toBeVisible();

    // Hosts are named as the rest of the app names them — the harness's d1
    // reports itself as `dev-host`, which wins over the server's `hetzner`.
    const first = hits.nth(0);
    await expect(first.locator('.search-snippet mark')).toHaveText('lorem');
    await expect(first.locator('.search-meta')).toHaveText('dev-host · bus · 2h ago · +1 more');
    const second = hits.nth(1);
    await expect(second.locator('.name mark')).toHaveText('lorem');
    await expect(second.locator('.search-meta')).toHaveText(
      'dev-host · Archived · Automation · 5h ago',
    );
    // The mark is a visible tint, not the browser's yellow.
    const bg = await first.locator('mark').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgb(255, 255, 0)');
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');

    await expect(page.getByTestId('chat-search-host-mac1')).toHaveText(
      'Mac offline — not searched',
    );
    await expect(page.getByTestId('chat-search-host-d1')).toHaveCount(0);

    // Clearing the field brings the list back.
    await page.getByTestId('chat-search').fill('');
    await expect(page.getByTestId('chat-row-chat_bus')).toBeVisible();
  });

  test('a result opens its chat at the matched message and rings it', async ({ page }) => {
    await stubSearch(page, (route, q) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(searchBody(q)),
      }),
    );
    await page.goto(HARNESS);
    await page.locator('.sb-row').first().waitFor();
    await page.getByTestId('chat-search').fill('lorem');
    const hit = page.locator('[data-testid="chat-search-hit"][data-chat-id="chat_scroll"]');
    await expect(hit).toHaveAttribute('href', /\/chats\/chat_scroll\?seq=5$/);
    await hit.click();

    const target = page.locator('.chat-stream [data-testid="msg"][data-seq="5"]');
    await expect(target).toHaveClass(/msg-jump-target/);
    // Pressing a result clears the search — the field and the results band
    // are both gone, so the sidebar is back to its ordinary chat list.
    await expect(page.getByTestId('chat-search')).toHaveValue('');
    await expect(page.getByTestId('chat-search-results')).toHaveCount(0);

    // Positioned in the middle of the stream, not left at the latest message.
    const geo = await page.evaluate(() => {
      const stream = document.querySelector('.chat-stream') as HTMLElement;
      const el = stream.querySelector('[data-seq="5"]') as HTMLElement;
      const s = stream.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      return {
        top: r.top - s.top,
        bottom: s.bottom - r.bottom,
        height: s.height,
        atBottom: stream.scrollTop + stream.clientHeight >= stream.scrollHeight - 50,
      };
    });
    expect(geo.atBottom).toBe(false);
    expect(geo.top).toBeGreaterThan(0);
    expect(geo.bottom).toBeGreaterThan(0);
    // Roughly centred.
    expect(Math.abs(geo.top - geo.bottom)).toBeLessThan(geo.height * 0.25);

    // It stays put (follow is off) and the ring fades.
    await expect(target).not.toHaveClass(/msg-jump-target/, { timeout: 5000 });
    const still = await page.evaluate(() => {
      const stream = document.querySelector('.chat-stream') as HTMLElement;
      return stream.scrollTop + stream.clientHeight >= stream.scrollHeight - 50;
    });
    expect(still).toBe(false);
  });

  test('a failed search shows its error row', async ({ page }) => {
    await stubSearch(page, (route) =>
      route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'bad gateway' }),
      }),
    );
    await page.goto(HARNESS);
    await page.locator('.sb-row').first().waitFor();
    await page.getByTestId('chat-search').fill('lorem');
    await expect(page.getByTestId('chat-search-error')).toContainText('bad gateway');
    await expect(page.getByTestId('chat-search-hit')).toHaveCount(0);
  });

  test('only the latest query renders when an older answer arrives last', async ({ page }) => {
    // The first query is held until the second has answered, then released.
    let releaseFirst: (() => void) | null = null;
    await stubSearch(page, async (route, q) => {
      if (q === 'lor') {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      const body = searchBody(q) as { hits: Array<{ chatId: string }> };
      if (q === 'lor') body.hits = [body.hits[0]!];
      else body.hits = [body.hits[1]!];
      // The app aborts the superseded request, so fulfilling it may be refused.
      await route
        .fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(body),
        })
        .catch(() => undefined);
    });
    await page.goto(HARNESS);
    await page.locator('.sb-row').first().waitFor();
    const field = page.getByTestId('chat-search');
    await field.fill('lor');
    await expect.poll(() => releaseFirst !== null).toBe(true);
    await field.fill('lorem');
    await expect(page.getByTestId('chat-search-hit')).toHaveCount(1);
    await expect(page.getByTestId('chat-search-hit')).toHaveAttribute('data-chat-id', 'chat_md');
    (releaseFirst as unknown as () => void)();
    // Give the stale answer every chance to land; it must not replace the list.
    await page.waitForTimeout(500);
    await expect(page.getByTestId('chat-search-hit')).toHaveCount(1);
    await expect(page.getByTestId('chat-search-hit')).toHaveAttribute('data-chat-id', 'chat_md');
  });

  test('a Full text box, unticked by default, asks for message text when ticked', async ({
    page,
  }) => {
    const scopes: (string | null)[] = [];
    await stubSearch(page, (route, q) => {
      scopes.push(new URL(route.request().url()).searchParams.get('fullText'));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(searchBody(q)),
      });
    });
    await page.goto(HARNESS);
    await page.locator('.sb-row').first().waitFor();

    await page.getByTestId('chat-search').fill('"lorem ipsum"');
    await expect(page.getByTestId('chat-search-hit')).toHaveCount(2);
    const box = page.getByTestId('chat-search-fulltext');
    await expect(box).not.toBeChecked();
    expect(scopes).toEqual(['false']);

    await box.check();
    await expect(page.getByTestId('chat-search-hit')).toHaveCount(2);
    expect(scopes).toEqual(['false', 'true']);
  });
});
