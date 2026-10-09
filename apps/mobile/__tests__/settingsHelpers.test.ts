// The pure helpers behind Settings: usage wording (the phone's copy of web's
// lib/usage.ts) and the host-scoped send guard every Settings edit goes through.

process.env.TZ = 'UTC';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  describeDisabledReason,
  EXTRA_USAGE_OFF_TEXT,
  formatReadAt,
  formatReset,
  formatUntil,
  formatUtilization,
} from '../src/lib/usage';
import { agoLabel, hostLabel, sendToHost } from '../src/components/settings/hostSend';
import { __getLastAlert, __clearLastAlert } from './stubs/react-native';
import { usePresenceStore } from '../src/stores/presenceStore';
import { reportHost, resetHosts } from './testUtils/settingsFixtures';

const send = vi.fn();
vi.mock('../src/api/ws', () => ({ getWs: () => ({ send }) }));

describe('usage wording', () => {
  const now = Date.UTC(2026, 8, 24, 10, 0); // Thu 24 Sep 2026 10:00 UTC

  it('formats a figure, or — when none was reported', () => {
    expect(formatUtilization({ status: 'allowed', utilization: 0.456 })).toBe('46%');
    expect(formatUtilization({ status: 'allowed' })).toBe('—');
    expect(formatUtilization(undefined)).toBe('—');
  });

  it('names a reset by time today and by weekday otherwise', () => {
    expect(formatReset(Date.UTC(2026, 8, 24, 13, 5), now)).toBe('13:05');
    expect(formatReset(Date.UTC(2026, 8, 26, 9, 0), now)).toBe('Sat 09:00');
  });

  it('says how long until, coarsely', () => {
    expect(formatUntil(now - 1, now)).toBe('now');
    expect(formatUntil(now + 28 * 60_000, now)).toBe('in 28 min');
    expect(formatUntil(now + 3 * 3_600_000, now)).toBe('in 3 h');
    expect(formatUntil(now + 5 * 86_400_000, now)).toBe('in 5 d');
  });

  it('says how old a reading is, and nothing when there is none', () => {
    expect(formatReadAt(undefined, now)).toBeNull();
    expect(formatReadAt(0, now)).toBeNull();
    expect(formatReadAt(now - 10_000, now)).toBe('read just now');
    expect(formatReadAt(now - 5 * 60_000, now)).toBe('read 5 min ago');
    expect(formatReadAt(now - 3 * 3_600_000, now)).toBe('read 3 h ago');
    expect(formatReadAt(now - 2 * 86_400_000, now)).toBe('read 2 d ago');
  });

  it('puts the never-bought add-on in the one sentence patch uses; other codes raw', () => {
    expect(describeDisabledReason('org_level_disabled_until')).toBe(EXTRA_USAGE_OFF_TEXT);
    expect(describeDisabledReason('something_else')).toBe('something_else');
  });
});

describe('sendToHost', () => {
  beforeEach(() => {
    send.mockReset();
    __clearLastAlert();
    resetHosts();
    reportHost('d1', { hostName: 'laptop' });
  });

  it('sends to a reachable host', () => {
    expect(sendToHost('d1', { type: 'host.update', daemonId: 'd1' }, 'Update')).toBe(true);
    expect(send).toHaveBeenCalledWith({ type: 'host.update', daemonId: 'd1' });
  });

  it('refuses when this phone has no server link, naming the link', () => {
    usePresenceStore.setState({ connection: 'offline' });
    expect(sendToHost('d1', { type: 'host.update', daemonId: 'd1' }, 'Update')).toBe(false);
    expect(__getLastAlert()?.message).toMatch(/no link to the server \(offline\)/);
  });

  it('refuses an unknown host and names it by id', () => {
    expect(sendToHost('ghost', { type: 'host.update', daemonId: 'ghost' }, 'Update')).toBe(false);
    expect(__getLastAlert()?.message).toBe(
      'ghost is offline (last seen never), so nothing was sent.',
    );
    expect(hostLabel('ghost')).toBe('ghost');
    expect(hostLabel('d1')).toBe('laptop');
  });

  it('labels a heartbeat age', () => {
    expect(agoLabel(null)).toBe('never');
    expect(agoLabel(1_000, 5_000)).toBe('4s ago');
    expect(agoLabel(0, 180_000)).toBe('3m ago');
    expect(agoLabel(0, 7_200_000)).toBe('2h ago');
    expect(agoLabel(0, 47 * 3_600_000)).toBe('47h ago');
    expect(agoLabel(0, 4 * 86_400_000)).toBe('4d ago');
  });
});
