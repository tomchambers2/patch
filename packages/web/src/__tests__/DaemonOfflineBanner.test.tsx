// DaemonOfflineBanner — per-chat banner shown when the server WS is up but
// the host is offline.

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DaemonOfflineBanner } from '../components/DaemonOfflineBanner.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useUiStore } from '../stores/uiStore.js';

describe('DaemonOfflineBanner', () => {
  beforeEach(() => {
    usePresenceStore.setState({ connection: 'offline', daemonOnline: false, hostsSeeded: true });
  });

  it('renders nothing when the WS connection is not connected, even if the host is offline', () => {
    usePresenceStore.setState({ connection: 'reconnecting', daemonOnline: false });
    const { container } = render(<DaemonOfflineBanner />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('daemon-offline-banner')).toBeNull();
  });

  it('renders nothing before the auth.ok greeting has said whether any agent is online', () => {
    usePresenceStore.setState({ connection: 'connected', daemonOnline: false, hostsSeeded: false });
    const { container } = render(<DaemonOfflineBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when connected and the host is online', () => {
    usePresenceStore.setState({ connection: 'connected', daemonOnline: true });
    const { container } = render(<DaemonOfflineBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the banner when connected but the host is offline', () => {
    usePresenceStore.setState({ connection: 'connected', daemonOnline: false });
    render(<DaemonOfflineBanner />);
    expect(screen.getByTestId('daemon-offline-banner')).toHaveTextContent(
      'Agent offline. Messages are queued and sent when it reconnects.',
    );
  });

  // spec/12 § Connection diagnostics screen: the banner offers Diagnose, and
  // the app behind it stays navigable — the screen is an overlay, not a block.
  it('Diagnose opens the connection diagnostics screen', () => {
    useUiStore.setState({ diagnosticsOpen: false });
    usePresenceStore.setState({ connection: 'connected', daemonOnline: false });
    render(<DaemonOfflineBanner />);
    fireEvent.click(screen.getByTestId('daemon-offline-diagnose'));
    expect(useUiStore.getState().diagnosticsOpen).toBe(true);
    useUiStore.setState({ diagnosticsOpen: false });
  });
});
