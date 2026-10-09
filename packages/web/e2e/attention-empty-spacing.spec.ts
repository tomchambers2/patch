import { test, expect } from '@playwright/test';

// Todoist: "'Nothing needs attention' has no spacing." — the empty-state
// message sat flush against the sidebar's left edge (2px in from `.empty-hint`
// alone), while every other control in the sidebar (rows, the "Needs
// attention" toggle itself) sits inset ~20px in from a shared left margin +
// padding. jsdom applies no stylesheet, so only a real browser can measure
// actual painted geometry.

const HARNESS = '/app/dev-harness.html?chat=chat_md';

test.describe('needs-attention empty state spacing', () => {
  test('"Nothing needs attention." aligns with the toggle above it, not the sidebar edge', async ({
    page,
  }) => {
    await page.goto(HARNESS);
    // Mark every seeded chat read AND settle it, so the needs-attention filter
    // has nothing left to show — the true empty state, not just an unpopulated
    // list. Read-marking alone is not enough: a failed chat needs attention
    // however many times it has been seen, so any errored fixture would
    // otherwise keep the list populated.
    await page.evaluate(() => {
      const w = window as unknown as {
        __store: {
          getState: () => {
            chats: Record<string, unknown>;
            markRead: (id: string) => void;
            setActiveChat: (id: string | null) => void;
          };
          setState: (fn: (s: { chats: Record<string, unknown> }) => unknown) => void;
        };
      };
      w.__store.setState((s) => ({
        chats: Object.fromEntries(
          Object.entries(s.chats).map(([id, row]) => [
            id,
            { ...(row as object), activity: 'idle', status: 'active', statusKind: null },
          ]),
        ),
      }));
      const ids = Object.keys(w.__store.getState().chats);
      for (const id of ids) w.__store.getState().markRead(id);
      // The harness's `?chat=chat_md` left chat_md active from page load, and
      // it started unread like every fixture (dev-harness.tsx — "every freshly
      // hydrated row defaults to lastReadSeq: -1"). Opening it is what just
      // marked it read, which is exactly what keeps a chat you're LOOKING AT
      // visible in the needs-attention view (Sidebar.tsx's hold) — so leaving
      // it active here would hold it and the list would never truly go empty.
      // Deactivate it, same as navigating away, so this test exercises the
      // genuine empty state rather than the hold.
      w.__store.getState().setActiveChat(null);
    });
    await page.getByTestId('attention-toggle').click();

    const empty = page.getByTestId('attention-empty');
    await expect(empty).toBeVisible();
    await expect(empty).toHaveText('Nothing needs attention.');

    const emptyBox = (await empty.boundingBox())!;
    const toggleBox = (await page.getByTestId('attention-toggle').boundingBox())!;

    // Left edge lines up with the toggle above it (both share the sidebar's
    // ~8px control inset), not the raw edge of the scroll region — the bug
    // was `.empty-hint`'s bare `padding: 8px 2px`, ~2px off the scroll
    // region's own x:0 edge.
    expect(emptyBox.x).toBeGreaterThan(4);
    expect(Math.abs(emptyBox.x - toggleBox.x)).toBeLessThanOrEqual(2);

    // Real vertical gap between the toggle and the empty message, not the two
    // butted flush against each other.
    const gap = emptyBox.y - (toggleBox.y + toggleBox.height);
    expect(gap).toBeGreaterThan(4);
  });
});
