// ErrorToasts — the app's ONLY surface for queued errors. Before it existed
// every `pushError` went nowhere, so a failed attachment upload just blinked
// the send button and did nothing. These pin: errors render, tap dismisses,
// they auto-expire, and an empty queue renders nothing.

import React from 'react';
import type { ReactTestRenderer } from 'react-test-renderer';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderRN, actSync, hasText, findHost, byTestId, queryHost } from './testUtils/render';
import { ErrorToasts, TOAST_TTL_MS } from '../src/components/ErrorToasts';
import { useUiStore } from '../src/stores/uiStore';

// Every mounted toast list stays subscribed to the store, so a renderer left
// alive by one test would schedule its own auto-dismiss timer during the next.
// Track and unmount them.
const mounted: ReactTestRenderer[] = [];
function render(): ReactTestRenderer {
  const r = renderRN(<ErrorToasts />);
  mounted.push(r);
  return r;
}

afterEach(() => {
  actSync(() => {
    for (const r of mounted.splice(0)) r.unmount();
  });
  useUiStore.setState({ errors: [] });
  vi.useRealTimers();
});

describe('ErrorToasts', () => {
  it('renders nothing with an empty queue', () => {
    const r = render();
    expect(r.toJSON()).toBeNull();
  });

  it('renders every queued error message', () => {
    const r = render();
    actSync(() => {
      useUiStore.getState().pushError('attachment upload failed: internal: EACCES');
      useUiStore.getState().pushError('skills unavailable: HTTP 500');
    });
    expect(hasText(r.root, 'attachment upload failed: internal: EACCES')).toBe(true);
    expect(hasText(r.root, 'skills unavailable: HTTP 500')).toBe(true);
    expect(findHost(r.root, byTestId('error-toasts'))).toBeTruthy();
  });

  it('dismisses a toast on tap', () => {
    const r = render();
    actSync(() => {
      useUiStore.getState().pushError('boom');
    });
    const id = useUiStore.getState().errors[0]!.id;
    const toast = findHost(r.root, byTestId(`error-toast-${id}`));
    actSync(() => {
      (toast.props['onPress'] as () => void)();
    });
    expect(useUiStore.getState().errors).toHaveLength(0);
    expect(queryHost(r.root, byTestId('error-toasts'))).toBeNull();
  });

  it('auto-dismisses after the TTL so a stale error never sits over the UI', () => {
    vi.useFakeTimers();
    render();
    actSync(() => {
      useUiStore.getState().pushError('transient');
    });
    expect(useUiStore.getState().errors).toHaveLength(1);
    actSync(() => {
      vi.advanceTimersByTime(TOAST_TTL_MS);
    });
    expect(useUiStore.getState().errors).toHaveLength(0);
  });

  it('clears its timers on unmount', () => {
    vi.useFakeTimers();
    const r = render();
    actSync(() => {
      useUiStore.getState().pushError('unmount me');
    });
    actSync(() => {
      r.unmount();
    });
    actSync(() => {
      vi.advanceTimersByTime(TOAST_TTL_MS * 2);
    });
    // The store is untouched — the unmounted component's timer did not fire.
    expect(useUiStore.getState().errors).toHaveLength(1);
  });
});
