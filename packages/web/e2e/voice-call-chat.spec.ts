import { test, expect, type Page } from '@playwright/test';

// spec/07 § 2. Voice call, § Latency, § The fast voice and the chat's agent,
// § Call cost — a call is the chat it was started on, spoken. Real browser,
// real CSS, dev harness (no backend): the user's words appear as THEIR bubble
// in the chat while they speak, the call control shows the call is on, the
// bar says what the line is doing without repeating the words, and on the
// desktop shell it clears the window controls.

const CHAT = 'thread_manager';
const CALL = `/app/dev-harness.html?chat=${CHAT}&voice=call`;

type VoiceStoreHandle = {
  getState(): {
    setCallTranscript(t: string): void;
    setCallChat(id: string): void;
    setCallPhase(p: string): void;
  };
};

async function voice(page: Page, fn: string, arg: string): Promise<void> {
  await page.evaluate(
    ([f, a]) => {
      const store = (window as unknown as { __voiceStore: VoiceStoreHandle }).__voiceStore;
      (store.getState() as unknown as Record<string, (x: string) => void>)[f]!(a);
    },
    [fn, arg] as const,
  );
}

async function emit(page: Page, event: unknown): Promise<void> {
  await page.evaluate((ev) => {
    (window as unknown as { __store: { getState(): { applyEvent(e: unknown): void } } }).__store
      .getState()
      .applyEvent(ev);
  }, event);
}

test.describe('a call is the chat, spoken', () => {
  test('the call button is lit while on a call on this chat, and ends it', async ({ page }) => {
    await page.goto(`/app/dev-harness.html?chat=${CHAT}`);
    const btn = page.getByTestId('call-btn');
    await expect(btn).toBeVisible();
    await expect(btn).not.toHaveAttribute('data-live', 'true');
    const idleBg = await btn.evaluate((el) => getComputedStyle(el).backgroundColor);

    await page.goto(CALL);
    const live = page.getByTestId('call-btn');
    await expect(live).toHaveAttribute('data-live', 'true');
    await expect(live).toHaveAttribute('aria-pressed', 'true');
    const liveBg = await live.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(liveBg).not.toBe(idleBg);

    await live.click();
    await expect(page.getByTestId('voice-bar')).toHaveCount(0);
  });

  test("the words being spoken appear at once as the user's own bubble, in italics", async ({
    page,
  }) => {
    await page.goto(CALL);
    await voice(page, 'setCallTranscript', 'add milk to');
    const bubble = page.getByTestId('voice-live-bubble');
    await expect(bubble).toBeVisible();
    await expect(bubble).toHaveText('add milk to');
    // It is a user bubble — the same green box as a typed message.
    await expect(bubble).toHaveClass(/msg-user/);
    const style = await bubble.locator('.content').evaluate((el) => getComputedStyle(el).fontStyle);
    expect(style).toBe('italic');
    // Inside the chat, as its last entry.
    const inStream = await bubble.evaluate((el) => !!el.closest('[data-testid="chat-stream"]'));
    expect(inStream).toBe(true);
    // The words are in the chat, not repeated in the bar.
    await expect(page.getByTestId('voice-bar-line')).toHaveText('Hearing you');
    await expect(page.getByTestId('voice-bar-line')).not.toContainText('add milk');

    // Final: the live bubble goes, the transcript is no longer a preview.
    await voice(page, 'setCallTranscript', '');
    await expect(bubble).toHaveCount(0);
  });

  test("the live bubble belongs to the call's chat only", async ({ page }) => {
    await page.goto(CALL);
    await voice(page, 'setCallChat', 'some-other-chat');
    await voice(page, 'setCallTranscript', 'hello');
    await expect(page.getByTestId('voice-live-bubble')).toHaveCount(0);
  });

  test('the bar names an untitled chat "New chat", never its id', async ({ page }) => {
    await page.goto(CALL);
    await voice(page, 'setCallChat', '01M439R1F4K37F7XSVW5PKQMGZ');
    await expect(page.getByTestId('voice-bar-chat')).toHaveText('New chat');
  });

  test('a hand-off shows what the voice asked the agent; a finished call leaves its cost', async ({
    page,
  }) => {
    await page.goto(CALL);
    await emit(page, {
      type: 'chat.message',
      chatId: CHAT,
      role: 'user',
      content: '[voice hand-off • web] Add milk to the shopping list',
      seq: 9001,
      createdAt: Date.now(),
    });
    await emit(page, {
      type: 'chat.message',
      chatId: CHAT,
      role: 'system',
      content: '[call] Call 0:52 · Gemini Flash · $0.017',
      seq: 9002,
      createdAt: Date.now(),
    });
    const handoff = page.getByTestId('voice-handoff');
    await expect(handoff).toBeVisible();
    await expect(handoff).toContainText('Asked the agent');
    await expect(handoff).toContainText('Add milk to the shopping list');
    await expect(handoff).not.toHaveClass(/msg-user/);
    const summary = page.getByTestId('call-summary');
    await expect(summary).toHaveText('Call 0:52 · Gemini Flash · $0.017');
  });

  test('on the desktop shell the bar clears the window controls and stays readable', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as unknown as { patch: unknown }).patch = { overlayTitleBar: true };
    });
    await page.goto(CALL);
    const bar = page.getByTestId('voice-bar');
    await expect(bar).toBeVisible();
    // Three 12px lights from x=18 on a 20px pitch end at x=70, bottom at y=43.
    const head = await page.getByTestId('voice-bar-head').boundingBox();
    expect(head!.x).toBeGreaterThanOrEqual(70);
    const box = await bar.boundingBox();
    expect(box!.y + box!.height).toBeGreaterThanOrEqual(43);
    const region = await bar.evaluate((el) =>
      getComputedStyle(el).getPropertyValue('-webkit-app-region').trim(),
    );
    expect(region).toBe('drag');
    const endRegion = await page
      .getByTestId('voice-bar-end')
      .evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-app-region').trim());
    expect(endRegion).toBe('no-drag');

    // WCAG AA contrast for every piece of text on the bar.
    const ratios = await bar.evaluate((el) => {
      const lum = (c: string): number => {
        const [r, g, b] = (c.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number) as [
          number,
          number,
          number,
        ];
        const ch = (v: number): number => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
      };
      const bg = lum(getComputedStyle(el).backgroundColor);
      return [...el.querySelectorAll('[data-testid^="voice-bar-"]')]
        .filter((n) => (n.textContent ?? '').trim().length > 0)
        .map((n) => {
          const fg = lum(getComputedStyle(n).color);
          const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg];
          return (hi + 0.05) / (lo + 0.05);
        });
    });
    expect(ratios.length).toBeGreaterThan(0);
    for (const r of ratios) expect(r).toBeGreaterThanOrEqual(4.5);
  });
});
