import { test, expect } from '@playwright/test';

// Todo item: "gap is too big between last message and ..., review all the
// spacing and make it consistent within chat". Two independent bugs combined
// to make the space between the last transcript entry and the composer both
// too large and inconsistent:
//
// 1. `.chat-stream-content` is `flex: 1 0 auto` inside the scrolling
//    `.chat-stream`, so it always stretches to fill the panel. The default
//    `justify-content: flex-start` then packed messages against the TOP and
//    left the leftover space at the BOTTOM — the fewer messages a chat has,
//    the bigger the gap above the composer got. Fixed with
//    `justify-content: flex-end` so slack space sits above the oldest
//    message instead (spec/14 § "opening a chat lands on the latest message,
//    scrolled to the bottom").
// 2. Flex siblings don't collapse margins the way block siblings do, so
//    whatever entry ended the chat contributed its OWN trailing margin
//    (`.msg`'s 28px turn separation, `.tool-call.compaction`'s 4px, etc.) on
//    top of `.chat-stream`'s 40px bottom padding — a message-ending chat got
//    a bigger, inconsistent gap versus a tool-row-ending one. Fixed by
//    zeroing `.chat-stream-content > *:last-child`'s margin-bottom.
test.describe('the gap above the composer', () => {
  test('is small and consistent for a chat ending in a message vs. one ending in a tool row', async ({
    page,
  }) => {
    await page.goto('/app/dev-harness.html?chat=chat_tools'); // short chat, ends in `.msg`
    const composer = page.locator('[data-testid="composer"]');
    await expect(composer).toBeVisible();
    const lastEntryMsg = page.locator('.chat-stream-content > *').last();
    await expect(lastEntryMsg).toHaveClass(/^msg /);
    const [msgBox, composerBoxA] = await Promise.all([
      lastEntryMsg.boundingBox(),
      composer.boundingBox(),
    ]);
    const gapAfterMessage = composerBoxA!.y - (msgBox!.y + msgBox!.height);

    await page.goto('/app/dev-harness.html?chat=chat_md'); // short chat, ends in `.tool-call.compaction`
    const lastEntryTool = page.locator('.chat-stream-content > *').last();
    await expect(lastEntryTool).toHaveClass(/compaction/);
    const composer2 = page.locator('[data-testid="composer"]');
    const [toolBox, composerBoxB] = await Promise.all([
      lastEntryTool.boundingBox(),
      composer2.boundingBox(),
    ]);
    const gapAfterToolResult = composerBoxB!.y - (toolBox!.y + toolBox!.height);

    // Same edge gutter regardless of what kind of row ends the transcript —
    // no longer inflated by that entry's own trailing margin.
    expect(Math.abs(gapAfterMessage - gapAfterToolResult)).toBeLessThanOrEqual(2);

    // Just the 40px `.chat-stream` edge gutter (spec/14 § Breathing room) plus
    // the composer's own unrelated 14px internal top padding — not the 68px+
    // the double-margin bug produced, and not the hundreds-of-px gap the
    // top-packed flex layout produced on a short chat.
    expect(gapAfterMessage).toBeGreaterThanOrEqual(40);
    expect(gapAfterMessage).toBeLessThan(60);
  });

  test('stays small on a two-message chat instead of growing to fill the empty panel', async ({
    page,
  }) => {
    // chat_forked has only 4 short entries — comfortably shorter than the
    // panel, so this is exactly the case where `flex-start` used to leave a
    // large empty gap between the last message and the composer.
    await page.goto('/app/dev-harness.html?chat=chat_forked');
    const composer = page.locator('[data-testid="composer"]');
    await expect(composer).toBeVisible();
    const lastMsg = page.locator('.msg').last();
    await expect(lastMsg).toBeVisible();
    const [msgBox, composerBox] = await Promise.all([
      lastMsg.boundingBox(),
      composer.boundingBox(),
    ]);
    const gap = composerBox!.y - (msgBox!.y + msgBox!.height);
    expect(gap).toBeLessThan(60);
  });

  test('slack space on a short chat sits above the oldest message, not below the newest', async ({
    page,
  }) => {
    await page.goto('/app/dev-harness.html?chat=chat_forked');
    const stream = page.locator('.chat-stream');
    const firstMsg = page.locator('.msg').first();
    const [streamBox, firstBox] = await Promise.all([stream.boundingBox(), firstMsg.boundingBox()]);
    // The first message sits well below the stream's own top edge (32px
    // gutter) — the rest of the leftover vertical space, not just the gutter.
    expect(firstBox!.y - streamBox!.y).toBeGreaterThan(40);
  });
});

test.describe('grouped tool-call rows', () => {
  test('a run of grouped tool calls gets the same distinct-row treatment as an ungrouped one', async ({
    page,
  }) => {
    // chat_tools groups its Grep/Read/Glob run into one `.tool-group` row
    // (spec/14 § Main chat panel — "Tool runs collapse to one row"). It must
    // read as the same kind of "chip" as an individual `.tool-call`/
    // `.tool-result` row — it was previously missing this box entirely and
    // sat flush against its neighbours with no margin.
    await page.goto('/app/dev-harness.html?chat=chat_tools');
    const group = page.locator('[data-testid="tool-group"]').first();
    await expect(group).toBeVisible();
    const bg = await group.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    expect(bg).not.toBe('transparent');
    const marginBottom = await group.evaluate((el) =>
      parseFloat(getComputedStyle(el).marginBottom),
    );
    expect(marginBottom).toBeGreaterThanOrEqual(9);
  });
});
