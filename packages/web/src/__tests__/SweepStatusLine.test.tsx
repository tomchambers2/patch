// The Manager view's slim sweep-status line (spec/06 § Sweep — "Visible").

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SweepStatusLine } from '../components/SweepStatusLine.js';
import { useUiStore } from '../stores/uiStore.js';
import * as rest from '../api/rest.js';

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  useUiStore.getState().clearToasts();
});

function renderLine(): void {
  render(
    <MemoryRouter>
      <SweepStatusLine />
    </MemoryRouter>,
  );
}

describe('SweepStatusLine', () => {
  it('shows "No sweeps yet" when the account has never swept', async () => {
    vi.spyOn(rest.api, 'getSweepRuns').mockResolvedValue({ runs: [] });
    renderLine();
    await waitFor(() =>
      expect(screen.getByTestId('sweep-status-summary')).toHaveTextContent('No sweeps yet'),
    );
  });

  it('summarizes the last run — nudged/woke/flagged counts', async () => {
    vi.spyOn(rest.api, 'getSweepRuns').mockResolvedValue({
      runs: [
        {
          at: new Date('2026-10-02T14:30:00').getTime(),
          runId: 'r1',
          candidateCount: 3,
          actions: [
            { chatId: 'c1', action: 'nudge' },
            { chatId: 'c2', action: 'nudge' },
            { chatId: 'c3', action: 'flag' },
          ],
          tokensUsed: 900,
        },
      ],
    });
    renderLine();
    await waitFor(() =>
      expect(screen.getByTestId('sweep-status-summary')).toHaveTextContent(
        'Last sweep 14:30 · nudged 2 · flagged 1',
      ),
    );
  });

  it('expands to show each action, naming the chat', async () => {
    vi.spyOn(rest.api, 'getSweepRuns').mockResolvedValue({
      runs: [
        {
          at: 0,
          runId: 'r1',
          candidateCount: 1,
          actions: [{ chatId: 'chat-abc', action: 'wake' }],
          tokensUsed: 10,
        },
      ],
    });
    renderLine();
    const summary = await screen.findByTestId('sweep-status-summary');
    expect(screen.queryByTestId('sweep-status-detail')).toBeNull();
    fireEvent.click(summary);
    expect(screen.getByTestId('sweep-status-row-chat-abc')).toHaveTextContent('wake · chat-abc');
  });

  it('"Check now" calls the API and refreshes the summary', async () => {
    const getSweepRuns = vi
      .spyOn(rest.api, 'getSweepRuns')
      .mockResolvedValueOnce({ runs: [] })
      .mockResolvedValueOnce({
        runs: [{ at: 0, runId: 'r2', candidateCount: 0, actions: [], tokensUsed: 0 }],
      });
    const checkSweepNow = vi.spyOn(rest.api, 'checkSweepNow').mockResolvedValue({ fired: false });
    renderLine();
    await waitFor(() => expect(getSweepRuns).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('sweep-check-now'));
    await waitFor(() => expect(checkSweepNow).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId('sweep-status-summary')).toHaveTextContent('nothing to do'),
    );
  });

  it('reports a failed load through pushError rather than hanging on "Sweep —"', async () => {
    vi.spyOn(rest.api, 'getSweepRuns').mockRejectedValue(new Error('offline'));
    renderLine();
    await waitFor(() =>
      expect(useUiStore.getState().errors.some((e) => (e.detail ?? '').includes('offline'))).toBe(
        true,
      ),
    );
  });
});
