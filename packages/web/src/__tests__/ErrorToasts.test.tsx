import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { ErrorToasts } from '../components/ErrorToasts.js';
import { useUiStore } from '../stores/uiStore.js';

afterEach(() => {
  cleanup();
  useUiStore.getState().clearToasts();
});

describe('ErrorToasts', () => {
  it('renders nothing when there are no toasts', () => {
    const { container } = render(<ErrorToasts />);
    expect(container.firstChild).toBeNull();
  });

  it('renders an error toast with role=alert and a Dismiss button, no Retry when retry is absent', () => {
    useUiStore.getState().pushError('something broke');
    render(<ErrorToasts />);
    const toast = screen.getByRole('alert');
    expect(toast.textContent).toContain('something broke');
    expect(screen.queryByText('Retry')).toBeNull();
    expect(screen.getByText('Dismiss')).toBeTruthy();
  });

  it('renders an info toast with role=status', () => {
    useUiStore.getState().pushNotice('all good');
    render(<ErrorToasts />);
    expect(screen.getByRole('status').textContent).toContain('all good');
  });

  // A notice about something on ANOTHER view needs a way through to it — the
  // batch notification's "Review" is the case this exists for. It dismisses on
  // the way so the toast doesn't hang over the view it just opened.
  it('shows a named action button that runs the action and dismisses the toast', () => {
    const run = vi.fn();
    useUiStore.getState().pushNotice('Batch ready for review: 2 chats', { label: 'Review', run });
    render(<ErrorToasts />);
    const action = screen.getByTestId('error-toast-action');
    expect(action.textContent).toBe('Review');
    fireEvent.click(action);
    expect(run).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().errors).toHaveLength(0);
  });

  it('renders no action button on a notice that has no action', () => {
    useUiStore.getState().pushNotice('all good');
    render(<ErrorToasts />);
    expect(screen.queryByTestId('error-toast-action')).toBeNull();
  });

  it('shows a Retry button that invokes the callback when provided', () => {
    const retry = vi.fn();
    useUiStore.getState().pushError('failed', retry);
    render(<ErrorToasts />);
    fireEvent.click(screen.getByText('Retry'));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  // The toast reads as one plain sentence; the code/message that produced it is
  // kept behind a collapsed disclosure rather than shown in front of the user.
  it('keeps the raw detail in a collapsed disclosure under the sentence', () => {
    useUiStore
      .getState()
      .pushError('Pick a model before starting the chat.', undefined, 'no_model_catalogue: blah');
    render(<ErrorToasts />);
    expect(screen.getByRole('alert').querySelector('.msg')?.textContent).toBe(
      'Pick a model before starting the chat.',
    );
    const details = screen.getByTestId('error-toast-detail') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByTestId('error-toast-detail-text').textContent).toBe(
      'no_model_catalogue: blah',
    );
  });

  it('renders no disclosure when there is no detail to keep', () => {
    useUiStore.getState().pushError('something broke');
    render(<ErrorToasts />);
    expect(screen.queryByTestId('error-toast-detail')).toBeNull();
  });

  // A 6s auto-dismiss that yanks the details away mid-read makes the kept code
  // useless, so opening the disclosure holds the toast open.
  it('holds the toast against auto-dismiss once its detail is opened', () => {
    vi.useFakeTimers();
    try {
      useUiStore.getState().pushError('Couldn’t start the chat.', undefined, 'HTTP 500');
      render(<ErrorToasts />);
      const details = screen.getByTestId('error-toast-detail') as HTMLDetailsElement;
      details.open = true;
      fireEvent(details, new Event('toggle', { bubbles: false }));
      expect(useUiStore.getState().errors[0]?.held).toBe(true);
      vi.advanceTimersByTime(60_000);
      expect(useUiStore.getState().errors).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-dismisses a toast whose detail was never opened', () => {
    vi.useFakeTimers();
    try {
      useUiStore.getState().pushError('Couldn’t start the chat.', undefined, 'HTTP 500');
      render(<ErrorToasts />);
      vi.advanceTimersByTime(60_000);
      expect(useUiStore.getState().errors).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Two failures that humanise to the SAME sentence but carry different codes
  // are two failures — collapsing them would lose one of the two details.
  it('does not dedupe two toasts that differ only in their detail', () => {
    useUiStore.getState().pushError('Couldn’t start the chat.', undefined, 'HTTP 500');
    useUiStore.getState().pushError('Couldn’t start the chat.', undefined, 'HTTP 502');
    expect(useUiStore.getState().errors).toHaveLength(2);
  });

  it('Dismiss removes just that toast', () => {
    useUiStore.getState().pushError('a');
    useUiStore.getState().pushError('b');
    render(<ErrorToasts />);
    const dismissButtons = screen.getAllByText('Dismiss');
    fireEvent.click(dismissButtons[0]!);
    expect(useUiStore.getState().errors).toHaveLength(1);
  });
});
