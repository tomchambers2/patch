// Tests for DaemonOfflineBanner, OfflineBanner, and ColumnDivider.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { act } from 'react';
import { DaemonOfflineBanner } from '../components/DaemonOfflineBanner.js';
import { OfflineBanner } from '../components/OfflineBanner.js';
import { ColumnDivider } from '../components/ColumnDivider.js';
import { usePresenceStore } from '../stores/presenceStore.js';

afterEach(() => {
  cleanup();
  usePresenceStore.setState({
    connection: 'offline',
    daemonOnline: false,
    accountId: null,
    surfaceId: null,
    hosts: {},
    everConnected: false,
    hostsSeeded: false,
  });
});

describe('DaemonOfflineBanner', () => {
  it('renders nothing when not connected', () => {
    usePresenceStore.setState({ connection: 'reconnecting', daemonOnline: false });
    const { container } = render(<DaemonOfflineBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when connected and host online', () => {
    usePresenceStore.setState({ connection: 'connected', daemonOnline: true });
    const { container } = render(<DaemonOfflineBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('renders banner when connected but host offline', () => {
    usePresenceStore.setState({ connection: 'connected', daemonOnline: false, hostsSeeded: true });
    render(<DaemonOfflineBanner />);
    expect(screen.getByTestId('daemon-offline-banner')).toBeTruthy();
    expect(screen.getByText(/Agent offline/)).toBeTruthy();
  });
});

describe('OfflineBanner', () => {
  it('renders nothing when connected', () => {
    usePresenceStore.setState({ connection: 'connected' });
    const { container } = render(<OfflineBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('renders reconnecting banner when not connected', () => {
    usePresenceStore.setState({ connection: 'reconnecting', everConnected: true });
    render(<OfflineBanner />);
    expect(screen.getByTestId('offline-banner')).toBeTruthy();
    expect(screen.getByText('Reconnecting…')).toBeTruthy();
  });
});

describe('ColumnDivider', () => {
  function setPointerCaptureShim(el: HTMLElement): void {
    // jsdom doesn't implement pointer capture.
    (el as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = vi.fn();
    (el as unknown as { releasePointerCapture: (id: number) => void }).releasePointerCapture =
      vi.fn();
  }

  it('grows width on drag right for a left-side column', () => {
    const onResize = vi.fn();
    render(<ColumnDivider side="left" width={200} onResize={onResize} testId="div-left" />);
    const el = screen.getByTestId('div-left');
    setPointerCaptureShim(el);

    act(() => {
      el.dispatchEvent(
        new window.PointerEvent('pointerdown', { clientX: 100, pointerId: 1, bubbles: true }),
      );
    });
    act(() => {
      window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 150, pointerId: 1 }));
    });
    expect(onResize).toHaveBeenCalledWith(250);

    act(() => {
      window.dispatchEvent(new window.PointerEvent('pointerup', { clientX: 150, pointerId: 1 }));
    });
    // After pointerup, further moves should not call onResize again.
    onResize.mockClear();
    act(() => {
      window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 200, pointerId: 1 }));
    });
    expect(onResize).not.toHaveBeenCalled();
  });

  it('shrinks width on drag right for a right-side column', () => {
    const onResize = vi.fn();
    render(<ColumnDivider side="right" width={300} onResize={onResize} testId="div-right" />);
    const el = screen.getByTestId('div-right');
    setPointerCaptureShim(el);

    act(() => {
      el.dispatchEvent(
        new window.PointerEvent('pointerdown', { clientX: 100, pointerId: 2, bubbles: true }),
      );
    });
    act(() => {
      window.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 150, pointerId: 2 }));
    });
    expect(onResize).toHaveBeenCalledWith(250);

    act(() => {
      window.dispatchEvent(new window.PointerEvent('pointerup', { clientX: 150, pointerId: 2 }));
    });
  });

  it('has separator role and orientation', () => {
    render(<ColumnDivider side="left" width={100} onResize={() => {}} />);
    const el = screen.getByRole('separator');
    expect(el.getAttribute('aria-orientation')).toBe('vertical');
  });
});
