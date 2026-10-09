// Disconnecting Claude used to produce a SILENT app: Settings said "Not connected"
// if you went looking, and everywhere else behaved normally — you could open a new
// chat, type, and send, and the turn simply never ran. The host emits
// `daemon.unauthenticated` for exactly this and the SPA dropped it.
//
// The credential is per host (spec/10 § Surface in Settings), so the banner is
// addressed to the machine the chat runs on: a logged-out machine elsewhere must
// not raise it over a healthy chat.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CLAUDE_BACKEND_ID } from '@patch/wire';
import { ClaudeDisconnectedBanner } from '../components/ClaudeDisconnectedBanner.js';
import { clearHosts, reportAccount } from './presenceHelpers.js';

const renderBanner = (daemonId: string | null = 'host-a'): void => {
  render(
    <MemoryRouter>
      <ClaudeDisconnectedBanner daemonId={daemonId} />
    </MemoryRouter>,
  );
};

afterEach(() => {
  cleanup();
  clearHosts();
});

describe('ClaudeDisconnectedBanner', () => {
  it('warns, and points at where to fix it, when this host has no credential', () => {
    reportAccount('host-a', false);
    renderBanner('host-a');
    const el = screen.getByTestId('claude-disconnected-banner');
    expect(el.textContent).toMatch(/can’t run/);
    // role=alert, not status: this blocks every turn until someone acts, unlike
    // daemon-offline which queues and self-heals.
    expect(el.getAttribute('role')).toBe('alert');
    expect(screen.getByRole('link').getAttribute('href')).toBe('/settings/usage');
  });

  it('stays silent when this host is connected', () => {
    reportAccount('host-a', true, 'a@b.c');
    renderBanner('host-a');
    expect(screen.queryByTestId('claude-disconnected-banner')).toBeNull();
  });

  it('stays silent before this host has reported', () => {
    // Nothing reported is "don't know yet". Guessing would flash a warning on
    // every load.
    clearHosts();
    renderBanner('host-a');
    expect(screen.queryByTestId('claude-disconnected-banner')).toBeNull();
  });

  it('ignores ANOTHER host being logged out (the account-wide-report bug)', () => {
    // Three hosts reporting different credential states at once is the live
    // case: host-b's "not connected" once landed in an account-wide slot and
    // raised this banner over a chat pinned to host-a.
    reportAccount('host-a', true, 'a@b.c');
    reportAccount('host-b', false);
    renderBanner('host-a');
    expect(screen.queryByTestId('claude-disconnected-banner')).toBeNull();
  });

  it('warns for the host that IS logged out', () => {
    reportAccount('host-a', true, 'a@b.c');
    reportAccount('host-b', false);
    renderBanner('host-b');
    expect(screen.getByTestId('claude-disconnected-banner')).toBeInTheDocument();
  });

  it('stays silent when no host is chosen yet', () => {
    reportAccount('host-a', false);
    renderBanner(null);
    expect(screen.queryByTestId('claude-disconnected-banner')).toBeNull();
  });

  // The host raises `daemon.unauthenticated` both at its pre-turn credential
  // check AND when Claude refuses a credential that check accepted (spec/10 §
  // Backend credentials). The banner is only as good as that frame reaching the
  // store, which nothing exercised end to end — so this drives a real frame
  // through the socket rather than seeding the store.
  it('raises on a daemon.unauthenticated frame arriving over the socket', async () => {
    const { PatchWs } = await import('../api/ws.js');
    const sockets: FakeWS[] = [];
    class FakeWS {
      static OPEN = 1;
      readyState = 1;
      listeners: Record<string, Array<(e: unknown) => void>> = {};
      constructor() {
        sockets.push(this);
      }
      send(): void {}
      close(): void {}
      addEventListener(n: string, cb: (e: unknown) => void): void {
        (this.listeners[n] ??= []).push(cb);
      }
      removeEventListener(): void {}
      emit(n: string, e: unknown): void {
        for (const cb of this.listeners[n] ?? []) cb(e);
      }
    }
    vi.stubGlobal('WebSocket', FakeWS);
    try {
      const ws = new PatchWs('ws://test/ws');
      ws.connect();
      const sock = sockets[sockets.length - 1]!;
      sock.emit('open', {});
      sock.emit('message', {
        data: JSON.stringify({
          type: 'daemon.unauthenticated',
          daemonId: 'host-a',
          backendId: CLAUDE_BACKEND_ID,
          reason: "Claude rejected this host's credential",
        }),
      });

      renderBanner('host-a');
      expect(screen.getByTestId('claude-disconnected-banner')).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
