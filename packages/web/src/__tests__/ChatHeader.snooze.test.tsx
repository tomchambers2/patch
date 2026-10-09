// Snooze from the chat header (spec/14 § Chat panel header → Snooze, spec/04
// § Snooze) — patch/todo.md: "ability to snooze a chat for 2, 5, 30, 1 hour,
// 1 day, next week or custom amount of time, like in gmail".
//
// The header's clock icon opens an anchored menu of wake times. Choosing one
// resolves `now + delta` to an ABSOLUTE timestamp, optimistically stamps the
// row and POSTs it; failure reverts and toasts (NO FALLBACK). While snoozed the
// menu leads with Unsnooze.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { JSX } from 'react';
import { render as rtlRender, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatHeader } from '../components/ChatHeader.js';
import type { ChatRow } from '../stores/types.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';

vi.mock('../api/rest.js', () => ({
  api: { deleteChat: vi.fn(), pinChat: vi.fn(), snoozeChat: vi.fn(async () => undefined) },
}));

vi.mock('../lib/voiceController.js', () => ({
  startVoiceCall: vi.fn(async () => {}),
}));

const NOW = 1_700_000_000_000;

function render(ui: JSX.Element): ReturnType<typeof rtlRender> {
  return rtlRender(
    <MemoryRouter initialEntries={['/chats/c1']}>
      <Routes>
        <Route path="*" element={ui} />
      </Routes>
    </MemoryRouter>,
  );
}

function row(overrides: Partial<ChatRow> = {}): ChatRow {
  return {
    chatId: 'c1',
    daemonId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    name: 'fix layout',
    folder: '~/projects/foo',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
    lastUserActivity: 0,
    awaitingPermission: false,
    lastReadSeq: -1,
    preview: null,
    goal: null,
    goalProgress: null,
    lastGoal: null,
    reminder: null,
    pendingWake: null,
    todos: [],
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    pendingPermissions: [],
    lastSeq: 0,
    jobId: null,
    model: null,
    rateLimitResumingAt: null,
    resumeKind: null,
    snoozedUntil: null,
    ...overrides,
  };
}

function seed(r: ChatRow): void {
  useChatStore.setState({ chats: { [r.chatId]: r } });
}

describe('ChatHeader — snooze', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    vi.mocked(api.snoozeChat)
      .mockReset()
      .mockResolvedValue(undefined as never);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('offers every Gmail-style preset plus Custom', () => {
    const r = row();
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-snooze'));
    const menu = screen.getByTestId('snooze-menu');
    for (const label of [
      '2 minutes',
      '5 minutes',
      '30 minutes',
      '1 hour',
      '5pm',
      'Tomorrow 8am',
      '1 day',
      'Next week',
      'Custom…',
    ]) {
      expect(menu).toHaveTextContent(label);
    }
  });

  it('choosing "1 hour" posts an absolute now+1h and stamps the row optimistically', async () => {
    const r = row();
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-snooze'));
    fireEvent.click(screen.getByTestId('snooze-preset-1-hour'));
    await waitFor(() => expect(api.snoozeChat).toHaveBeenCalledWith('c1', NOW + 3_600_000));
    expect(useChatStore.getState().chats['c1']?.snoozedUntil).toBe(NOW + 3_600_000);
    // The menu closes once a choice is made.
    expect(screen.queryByTestId('snooze-menu')).toBeNull();
  });

  it('each preset resolves to its own delta', async () => {
    const cases: Array<[string, number]> = [
      ['snooze-preset-2-minutes', 2 * 60_000],
      ['snooze-preset-5-minutes', 5 * 60_000],
      ['snooze-preset-30-minutes', 30 * 60_000],
      ['snooze-preset-1-day', 24 * 3_600_000],
      ['snooze-preset-next-week', 7 * 24 * 3_600_000],
    ];
    for (const [testId, delta] of cases) {
      const r = row();
      seed(r);
      render(<ChatHeader row={r} />);
      fireEvent.click(screen.getByTestId('action-more'));
      fireEvent.click(screen.getByTestId('action-snooze'));
      fireEvent.click(screen.getByTestId(testId));
      await waitFor(() => expect(api.snoozeChat).toHaveBeenCalledWith('c1', NOW + delta));
      vi.mocked(api.snoozeChat).mockClear();
      cleanup();
    }
  });

  // These three mock Date.now (like beforeEach does for NOW) rather than
  // vi.useFakeTimers — fake timers also stub setTimeout, which stalls RTL's
  // waitFor polling since nothing here advances the fake clock.
  it('"5pm" preset snoozes to today 17:00 when it is currently before 5pm', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 7, 25, 9, 0, 0).getTime());
    const r = row();
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-snooze'));
    fireEvent.click(screen.getByTestId('snooze-preset-5pm'));
    await waitFor(() =>
      expect(api.snoozeChat).toHaveBeenCalledWith(
        'c1',
        new Date(2026, 7, 25, 17, 0, 0, 0).getTime(),
      ),
    );
  });

  it('"5pm" preset snoozes to tomorrow 17:00 when it is currently after 5pm', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 7, 25, 18, 30, 0).getTime());
    const r = row();
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-snooze'));
    fireEvent.click(screen.getByTestId('snooze-preset-5pm'));
    await waitFor(() =>
      expect(api.snoozeChat).toHaveBeenCalledWith(
        'c1',
        new Date(2026, 7, 26, 17, 0, 0, 0).getTime(),
      ),
    );
  });

  it('"Tomorrow 8am" preset always snoozes to tomorrow 08:00, regardless of current time', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 7, 25, 23, 59, 0).getTime());
    const r = row();
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-snooze'));
    fireEvent.click(screen.getByTestId('snooze-preset-tomorrow-8am'));
    await waitFor(() =>
      expect(api.snoozeChat).toHaveBeenCalledWith(
        'c1',
        new Date(2026, 7, 26, 8, 0, 0, 0).getTime(),
      ),
    );
  });

  it('Custom… snoozes to the picked date/time', async () => {
    const r = row();
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-snooze'));
    fireEvent.click(screen.getByTestId('snooze-preset-custom'));
    const input = screen.getByTestId('snooze-custom-input') as HTMLInputElement;
    // A local datetime string, as `datetime-local` produces.
    const target = new Date(NOW + 3 * 3_600_000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    const local = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}T${pad(target.getHours())}:${pad(target.getMinutes())}`;
    fireEvent.change(input, { target: { value: local } });
    fireEvent.click(screen.getByTestId('snooze-custom-submit'));
    await waitFor(() => expect(api.snoozeChat).toHaveBeenCalledTimes(1));
    const [, until] = vi.mocked(api.snoozeChat).mock.calls[0]!;
    // Minute precision — the datetime-local field has no seconds.
    expect(Math.abs((until as number) - (NOW + 3 * 3_600_000))).toBeLessThan(60_000);
  });

  it('a custom time in the past is refused without posting', async () => {
    const r = row();
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-snooze'));
    fireEvent.click(screen.getByTestId('snooze-preset-custom'));
    const past = new Date(NOW - 3 * 3_600_000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    const local = `${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())}T${pad(past.getHours())}:${pad(past.getMinutes())}`;
    fireEvent.change(screen.getByTestId('snooze-custom-input'), { target: { value: local } });
    fireEvent.click(screen.getByTestId('snooze-custom-submit'));
    expect(api.snoozeChat).not.toHaveBeenCalled();
    await waitFor(() => expect(useUiStore.getState().errors.length).toBe(1));
  });

  it('a snoozed chat leads with Unsnooze, which clears the snooze', async () => {
    const r = row({ snoozedUntil: NOW + 60_000 });
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-snooze'));
    fireEvent.click(screen.getByTestId('snooze-unsnooze'));
    await waitFor(() => expect(api.snoozeChat).toHaveBeenCalledWith('c1', null));
    expect(useChatStore.getState().chats['c1']?.snoozedUntil).toBe(null);
  });

  it('a failed snooze reverts the row and toasts', async () => {
    vi.mocked(api.snoozeChat).mockRejectedValue(new Error('boom') as never);
    const r = row();
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-snooze'));
    fireEvent.click(screen.getByTestId('snooze-preset-1-hour'));
    await waitFor(() => expect(useUiStore.getState().errors.length).toBe(1));
    expect(useChatStore.getState().chats['c1']?.snoozedUntil).toBe(null);
  });

  it('Esc closes the menu without snoozing', () => {
    const r = row();
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    fireEvent.click(screen.getByTestId('action-snooze'));
    expect(screen.getByTestId('snooze-menu')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('snooze-menu')).toBeNull();
    expect(api.snoozeChat).not.toHaveBeenCalled();
  });

  it('special threads cannot be snoozed', () => {
    const r = row({ chatId: 'thread_manager' });
    seed(r);
    render(<ChatHeader row={r} />);
    fireEvent.click(screen.getByTestId('action-more'));
    expect(screen.queryByTestId('action-snooze')).toBeNull();
  });
});
