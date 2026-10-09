// OfflineBanner — amber 'Reconnecting…' banner shown whenever the WS
// connection is anything other than 'connected'.

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OfflineBanner } from '../components/OfflineBanner.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';

describe('OfflineBanner', () => {
  beforeEach(() => {
    usePresenceStore.setState({ connection: 'offline', everConnected: true });
  });

  it('renders nothing when connected', () => {
    usePresenceStore.getState().setConnection('connected');
    const { container } = render(<OfflineBanner />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });

  it('renders the banner when connecting after a connection was lost', () => {
    usePresenceStore.getState().setConnection('connecting');
    render(<OfflineBanner />);
    expect(screen.getByTestId('offline-banner')).toHaveTextContent('Reconnecting…');
  });

  it.each(['connecting', 'reconnecting', 'offline'] as const)(
    'renders nothing while the first connection is still being made (%s)',
    (state) => {
      usePresenceStore.setState({ everConnected: false });
      usePresenceStore.getState().setConnection(state);
      const { container } = render(<OfflineBanner />);
      expect(container).toBeEmptyDOMElement();
    },
  );

  it('renders the banner when reconnecting', () => {
    usePresenceStore.getState().setConnection('reconnecting');
    render(<OfflineBanner />);
    expect(screen.getByTestId('offline-banner')).toBeInTheDocument();
  });

  it('renders the banner when offline', () => {
    usePresenceStore.getState().setConnection('offline');
    render(<OfflineBanner />);
    expect(screen.getByTestId('offline-banner')).toBeInTheDocument();
  });

  // spec/12 § Connection diagnostics screen: 'Reconnecting…' on its own is a
  // dead end — the banner must open the diagnostics screen.
  it('Diagnose opens the connection diagnostics screen', () => {
    useUiStore.setState({ diagnosticsOpen: false });
    usePresenceStore.getState().setConnection('reconnecting');
    render(<OfflineBanner />);
    fireEvent.click(screen.getByTestId('offline-diagnose'));
    expect(useUiStore.getState().diagnosticsOpen).toBe(true);
    useUiStore.setState({ diagnosticsOpen: false });
  });
});
