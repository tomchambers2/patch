// presenceStore.removeHost — a machine removed from the account (Settings →
// Hosts → Remove, or the server's `host.removed`) is forgotten whole: its
// presence, its self-description, its credentials and its Claude Code
// settings, with the account-wide "is any host up" flag recomputed from what
// is left.

import { describe, it, expect, beforeEach } from 'vitest';
import { usePresenceStore } from '../stores/presenceStore.js';
import {
  clearHosts,
  reportAccount,
  reportClaudeSettings,
  reportFolders,
  reportHost,
} from './presenceHelpers.js';

describe('presenceStore.removeHost', () => {
  beforeEach(() => {
    clearHosts();
  });

  it('drops the host and every report it made, leaving the others alone', () => {
    reportHost('host-a', { hostName: 'laptop' });
    reportAccount('host-a', true, 'tom@example.com');
    reportClaudeSettings('host-a');
    reportFolders('host-a', ['/srv/patch']);
    reportHost('host-b', { hostName: 'beta', isHomeHost: false });
    const before = usePresenceStore.getState().hosts['host-b'];

    usePresenceStore.getState().removeHost('host-a');

    const { hosts } = usePresenceStore.getState();
    expect(Object.keys(hosts)).toEqual(['host-b']);
    expect(hosts['host-a']).toBeUndefined();
    // The survivor is the same object: nothing about it changed.
    expect(hosts['host-b']).toBe(before);
  });

  it('a host re-appearing after removal starts blank, not with its old reports', () => {
    reportHost('host-a', { hostName: 'laptop' });
    reportClaudeSettings('host-a');
    usePresenceStore.getState().removeHost('host-a');
    usePresenceStore.getState().setHostOnline('host-a', true);
    const h = usePresenceStore.getState().hosts['host-a'];
    expect(h?.host).toBeNull();
    expect(h?.claudeSettings).toBeNull();
    expect(h?.accounts).toEqual({});
  });

  it('recomputes daemonOnline: false once the only online host is gone', () => {
    reportHost('host-a', { hostName: 'laptop' });
    reportHost('host-b', { hostName: 'beta', isHomeHost: false });
    usePresenceStore.getState().setHostOnline('host-a', true);
    expect(usePresenceStore.getState().daemonOnline).toBe(true);
    usePresenceStore.getState().removeHost('host-a');
    expect(usePresenceStore.getState().daemonOnline).toBe(false);
  });

  it('recomputes daemonOnline: still true while another host is online', () => {
    reportHost('host-a', { hostName: 'laptop' });
    reportHost('host-b', { hostName: 'beta', isHomeHost: false });
    usePresenceStore.getState().setHostOnline('host-a', true);
    usePresenceStore.getState().setHostOnline('host-b', true);
    usePresenceStore.getState().removeHost('host-a');
    expect(usePresenceStore.getState().daemonOnline).toBe(true);
  });

  it('an unknown id is a no-op that leaves the state untouched', () => {
    reportHost('host-a', { hostName: 'laptop' });
    usePresenceStore.getState().setHostOnline('host-a', true);
    const before = usePresenceStore.getState();
    usePresenceStore.getState().removeHost('host-nope');
    const after = usePresenceStore.getState();
    // The hosts map is the same object, so nothing reading it re-renders.
    expect(after.hosts).toBe(before.hosts);
    expect(after.daemonOnline).toBe(true);
    expect(Object.keys(after.hosts)).toEqual(['host-a']);
  });

  it('a host missing from a fresh auth.ok roster is dropped with its reports', () => {
    reportHost('host-a', { hostName: 'laptop' });
    reportClaudeSettings('host-a');
    reportHost('host-b', { hostName: 'beta', isHomeHost: false });

    // The server removed host-a while this surface was disconnected: the
    // reconnect greeting names only host-b.
    usePresenceStore
      .getState()
      .setHosts([{ daemonId: 'host-b', online: true, lastSeenAt: null, host: null, accounts: [] }]);

    const { hosts } = usePresenceStore.getState();
    expect(Object.keys(hosts)).toEqual(['host-b']);
    expect(hosts['host-a']).toBeUndefined();
  });
});
