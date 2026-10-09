import { test, expect } from '@playwright/test';

// spec/14 § Tool calls — a row the user has opened stays open. The in-progress
// call is a lone row; when the next call arrives the run becomes a group, which
// used to remount the row and drop what the user had just tapped open.
const CHAT = '/app/dev-harness.html?chat=chat_tool_paired';

type Store = {
  getState: () => unknown;
  setState: (fn: (s: { timelines: Record<string, unknown[]> }) => unknown) => void;
};

test.use({ viewport: { width: 390, height: 800 }, hasTouch: true });

test('a tool call opened while in progress stays open when the run grows into a group', async ({
  page,
}) => {
  await page.goto(CHAT);
  const call = (seq: number, callId: string, file: string) => ({
    seq,
    kind: 'tool_call',
    tool: 'Read',
    toolArgs: { file_path: file },
    callId,
    at: seq,
  });
  const setTimeline = (entries: unknown[]) =>
    page.evaluate((e) => {
      const store = (window as unknown as { __store: Store }).__store;
      store.setState((s) => ({ timelines: { ...s.timelines, chat_tool_paired: e } }));
    }, entries);

  await setTimeline([call(0, 'c1', 'src/one.ts')]);
  await page.getByTestId('tool-call-summary').tap();
  await expect(page.getByTestId('tool-call-detail')).toContainText('src/one.ts');

  await setTimeline([call(0, 'c1', 'src/one.ts'), call(1, 'c2', 'src/two.ts')]);
  await expect(page.getByTestId('tool-group')).toHaveCount(1);
  await expect(page.getByTestId('tool-group')).toHaveAttribute('data-open', 'true');
  await expect(page.getByTestId('tool-call-detail')).toContainText('src/one.ts');
});
