import { test, expect } from '@playwright/test';
import type { WireEvent } from '@patch/wire';

// spec/12 § "No message deduplication beyond seq" — a `chat.replay` can
// legitimately be re-delivered (opening a chat requests it, and the socket's
// own connect handler asks again for every held chat a moment later, both
// from `fromSeq: -1`). `chat.message` folds a re-delivered turn onto its
// canonical seq instead of re-rendering it; `chat.tool_call` / `chat.tool_result`
// must do the same, or the re-delivered call is appended a second time at the
// TAIL of the timeline — landing after a later message that WAS correctly
// folded back into place, which is a tool call rendering out of message order.
const HARNESS = '/app/dev-harness.html?chat=chat_replay_dupe';

function applyEvent(page: import('@playwright/test').Page, event: WireEvent) {
  return page.evaluate(
    (e) => {
      const store = (
        window as unknown as {
          __store: { getState: () => { applyEvent: (ev: Record<string, unknown>) => void } };
        }
      ).__store;
      store.getState().applyEvent(e);
    },
    event as unknown as WireEvent,
  );
}

async function deliverTurn(page: import('@playwright/test').Page) {
  await applyEvent(page, {
    type: 'chat.message',
    chatId: 'chat_replay_dupe',
    role: 'user',
    content: 'ls the repo',
    seq: 0,
  } as WireEvent);
  await applyEvent(page, {
    type: 'chat.tool_call',
    chatId: 'chat_replay_dupe',
    seq: 1,
    tool: 'Bash',
    args: { command: 'ls' },
    callId: 'call-1',
  } as WireEvent);
  await applyEvent(page, {
    type: 'chat.tool_result',
    chatId: 'chat_replay_dupe',
    seq: 2,
    tool: 'Bash',
    result: { stdout: 'ok' },
    callId: 'call-1',
  } as WireEvent);
  await applyEvent(page, {
    type: 'chat.message',
    chatId: 'chat_replay_dupe',
    role: 'assistant',
    content: 'done.',
    seq: 3,
  } as WireEvent);
}

test.describe('tool calls survive a re-delivered chat.replay in order', () => {
  test('a duplicate full replay does not duplicate or reorder the tool call', async ({ page }) => {
    await page.goto(HARNESS);

    // Two replays of the same full history race in, exactly as ws.ts documents
    // for the open + connect-time request racing at the same `fromSeq: -1`.
    await deliverTurn(page);
    await deliverTurn(page);

    const stream = page.getByTestId('chat-stream');
    const entries = stream.locator(
      '[data-testid="msg"], [data-testid="tool-call"], [data-testid="tool-result"]',
    );
    // Three rows, not four: the call and its result are ONE row (spec/14), so
    // the turn reads user → Bash → assistant. A dedup failure still shows up
    // here, as a second `tool-call` row appended after the final message.
    await expect(entries).toHaveCount(3);
    await expect(page.getByTestId('tool-call')).toHaveCount(1);
    await expect(page.getByTestId('tool-result')).toHaveCount(0);
    // The folded row still carries its result — `→` marks that it returned, so
    // a re-delivered replay that dropped the result would not pass silently.
    await expect(page.getByTestId('tool-call')).toContainText('→');

    const kinds = await entries.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-testid')),
    );
    expect(kinds).toEqual(['msg', 'tool-call', 'msg']);

    // The tool call still reads BEFORE the assistant's final reply, not after
    // it — the visible symptom of "tool calls not shown in message order".
    const toolCallBox = await page.getByTestId('tool-call').boundingBox();
    const lastMsg = page.getByTestId('msg').last();
    const lastMsgBox = await lastMsg.boundingBox();
    if (!toolCallBox || !lastMsgBox) throw new Error('missing layout boxes');
    expect(toolCallBox.y).toBeLessThan(lastMsgBox.y);
  });
});
