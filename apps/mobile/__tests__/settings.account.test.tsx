// Settings → Account (spec/14 § Account & connection, spec/15 § Settings →
// Account; design/settings-redesign): the account this phone is linked to, the
// server it talks to (host only, no scheme) and this device — painted
// instantly from the local credential, /me only a background refresh — then
// This device → Sign this device out (Deactivate: confirmed, self-revokes via
// POST /api/auth/revoke as web does, then clears the credential and returns to
// pairing). The server's build is no longer shown here: it is on Updates →
// Versions (settings.version.test.tsx).

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AccountPage,
  AccountSection,
  ThisSurfaceSection,
  serverHost,
} from '../src/components/settings/AccountSections';
import {
  renderRN,
  findHost,
  findAllHost,
  queryHost,
  byTestId,
  byLabel,
  hasText,
  textOf,
  actAsync,
  flush,
} from './testUtils/render';
import { api } from '../src/api/rest';
import { __getLastAlert, __clearLastAlert } from './stubs/react-native';
import { routerMock, __resetRouterMock } from './stubs/expo-router';
import { saveCredential, clearCredential, loadCredential } from '../src/lib/credential';
import { getServerUrl } from '../src/config';
import { usePresenceStore } from '../src/stores/presenceStore';

vi.mock('../src/api/rest', () => ({
  api: { me: vi.fn(), revoke: vi.fn() },
}));

const teardown = vi.fn();
vi.mock('../src/lib/bootstrap', () => ({ teardown: (): void => teardown() }));

function b64url(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
function jwt(payload: Record<string, unknown>): string {
  return `${b64url({ alg: 'EdDSA' })}.${b64url(payload)}.sig`;
}
const never = <T,>(): Promise<T> => new Promise<T>(() => {});

beforeEach(() => {
  vi.mocked(api.me).mockReset().mockReturnValue(never());
  vi.mocked(api.revoke).mockReset().mockResolvedValue({ ok: true });
  teardown.mockReset();
  __resetRouterMock();
  __clearLastAlert();
  clearCredential();
  usePresenceStore.setState({ surfaceId: null, accountId: null });
});

async function confirmDeactivate(root: Parameters<typeof findHost>[0]): Promise<void> {
  findHost(root, byTestId('deactivate-surface')).props.onPress();
  await actAsync(async () => {
    __getLastAlert()!.buttons!.find((b) => b.text === 'Deactivate')!.onPress!();
    await flush();
  });
}

describe('serverHost', () => {
  it('drops the scheme and a trailing slash', () => {
    expect(serverHost('https://patch.example.com')).toBe('patch.example.com');
    expect(serverHost('http://10.0.0.2:8080/')).toBe('10.0.0.2:8080');
    expect(serverHost('patch.example.com')).toBe('patch.example.com');
  });

  it('keeps a path other than a bare trailing slash', () => {
    expect(serverHost('https://h.test/base/')).toBe('h.test/base');
  });
});

describe('Settings — Account page', () => {
  it('is titled Account and composes the account group and This device', () => {
    const r = renderRN(<AccountPage />);
    expect(findHost(r.root, byTestId('settings-page-account'))).toBeTruthy();
    expect(textOf(findHost(r.root, byTestId('settings-page-title')))).toBe('Account');
    expect(findHost(r.root, byTestId('settings-account'))).toBeTruthy();
    expect(findHost(r.root, byTestId('settings-this-surface'))).toBeTruthy();
    // The old Connection group (server sha via healthz) is gone.
    expect(queryHost(r.root, byTestId('connection-sha'))).toBeNull();
  });

  it('Back pops the page', () => {
    const r = renderRN(<AccountPage />);
    findHost(r.root, byTestId('settings-back')).props.onPress();
    expect(routerMock.back).toHaveBeenCalled();
  });
});

describe('Settings — Account', () => {
  it('paints the account and this device instantly from the credential, before /me settles', () => {
    saveCredential(jwt({ sub: 'acct-1', surface_id: 'surf-1', surface_kind: 'mobile', label: '' }));
    const r = renderRN(<AccountSection />);
    expect(textOf(findHost(r.root, byTestId('account-id')))).toBe('acct-1');
    expect(textOf(findHost(r.root, byTestId('account-this-device')))).toBe('Phone');
    expect(findAllHost(r.root, byLabel('Loading'))).toHaveLength(0);
  });

  it('labels its rows Account, Server and This device', () => {
    saveCredential(jwt({ sub: 'acct-1', surface_id: 'surf-1', surface_kind: 'mobile', label: '' }));
    const r = renderRN(<AccountSection />);
    const text = textOf(r.root);
    expect(text.indexOf('Account')).toBeLessThan(text.indexOf('Server'));
    expect(text.indexOf('Server')).toBeLessThan(text.indexOf('This device'));
  });

  it('names the server this phone talks to, without its scheme', () => {
    const r = renderRN(<AccountSection />);
    const origin = textOf(findHost(r.root, byTestId('connection-origin')));
    expect(origin).toBe(serverHost(getServerUrl()));
    expect(origin).not.toMatch(/^https?:\/\//);
  });

  it('with no local credential shows a loading affordance until /me answers', async () => {
    let resolve!: (v: Awaited<ReturnType<typeof api.me>>) => void;
    vi.mocked(api.me).mockReturnValue(new Promise((res) => (resolve = res)));
    const r = renderRN(<AccountSection />);
    // Account and This device both wait; Server never does.
    expect(findAllHost(r.root, byLabel('Loading'))).toHaveLength(2);
    expect(findHost(r.root, byTestId('connection-origin'))).toBeTruthy();
    await actAsync(async () => {
      resolve({
        account: { accountId: 'a1', userPublicKey: 'a1', createdAt: 1 },
        surface: { surfaceId: 's1', surfaceKind: 'desktop', label: 'Studio', issuedAt: 2 },
      });
      await flush();
    });
    expect(findAllHost(r.root, byLabel('Loading'))).toHaveLength(0);
    expect(textOf(findHost(r.root, byTestId('account-id')))).toBe('a1');
    expect(textOf(findHost(r.root, byTestId('account-this-device')))).toBe('Studio');
  });

  it('/me refreshes a seeded identity', async () => {
    saveCredential(jwt({ sub: 'acct-1', surface_id: 'surf-1', surface_kind: 'mobile', label: '' }));
    vi.mocked(api.me).mockResolvedValue({
      account: { accountId: 'acct-2', userPublicKey: 'acct-2', createdAt: 1 },
      surface: { surfaceId: 'surf-1', surfaceKind: 'mobile', label: 'Pixel', issuedAt: 2 },
    });
    const r = renderRN(<AccountSection />);
    await flush();
    expect(textOf(findHost(r.root, byTestId('account-id')))).toBe('acct-2');
    expect(textOf(findHost(r.root, byTestId('account-this-device')))).toBe('Pixel');
  });

  it('a failed /me refresh keeps the seeded identity', async () => {
    saveCredential(jwt({ sub: 'acct-1', surface_id: 'surf-1', surface_kind: 'mobile', label: '' }));
    vi.mocked(api.me).mockRejectedValue(new Error('offline'));
    const r = renderRN(<AccountSection />);
    await flush();
    expect(textOf(findHost(r.root, byTestId('account-id')))).toBe('acct-1');
    expect(textOf(findHost(r.root, byTestId('account-this-device')))).toBe('Phone');
  });

  it('a failed /me refresh with nothing seeded says Unavailable, never a bare dash', async () => {
    vi.mocked(api.me).mockRejectedValue(new Error('offline'));
    const r = renderRN(<AccountSection />);
    await flush();
    expect(textOf(findHost(r.root, byTestId('account-id')))).toBe('Unavailable');
    expect(textOf(findHost(r.root, byTestId('account-this-device')))).toBe('Unavailable');
    expect(hasText(r.root, '—')).toBe(false);
  });

  it('a /me answer after unmount is ignored', async () => {
    let resolve!: (v: Awaited<ReturnType<typeof api.me>>) => void;
    vi.mocked(api.me).mockReturnValue(new Promise((res) => (resolve = res)));
    const r = renderRN(<AccountSection />);
    await actAsync(() => r.unmount());
    await actAsync(async () => {
      resolve({
        account: { accountId: 'a1', userPublicKey: 'a1', createdAt: 1 },
        surface: { surfaceId: 's1', surfaceKind: 'desktop', label: '', issuedAt: 2 },
      });
      await flush();
    });
    expect(r.toJSON()).toBeNull();
  });
});

describe('Settings — This device', () => {
  it('is one row, "Sign this device out", with a Deactivate button', () => {
    const r = renderRN(<ThisSurfaceSection />);
    const section = findHost(r.root, byTestId('settings-this-surface'));
    expect(hasText(section, 'This device')).toBe(true);
    expect(hasText(section, 'Sign this device out')).toBe(true);
    expect(textOf(findHost(r.root, byTestId('deactivate-surface')))).toBe('Deactivate');
    expect(hasText(r.root, 'Log out')).toBe(false);
  });

  it('Deactivate is confirmed first; Cancel does nothing at all', () => {
    saveCredential(jwt({ sub: 'a', surface_id: 's-me', surface_kind: 'mobile', label: '' }));
    const r = renderRN(<ThisSurfaceSection />);
    findHost(r.root, byTestId('deactivate-surface')).props.onPress();
    const alert = __getLastAlert()!;
    expect(alert.title).toBe('Sign this device out?');
    expect(alert.message).toBe(
      'It is removed from your account and has to be paired again to be used.',
    );
    expect(alert.buttons!.map((b) => b.text)).toEqual(['Cancel', 'Deactivate']);
    expect(alert.buttons![0]!.onPress).toBeUndefined();
    expect(api.revoke).not.toHaveBeenCalled();
    expect(loadCredential()).not.toBeNull();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it('confirming self-revokes on the server, clears the credential and returns to pairing', async () => {
    saveCredential(jwt({ sub: 'a', surface_id: 's-me', surface_kind: 'mobile', label: '' }));
    const r = renderRN(<ThisSurfaceSection />);
    await confirmDeactivate(r.root);
    expect(api.revoke).toHaveBeenCalledWith('s-me');
    expect(loadCredential()).toBeNull();
    expect(teardown).toHaveBeenCalled();
    expect(routerMock.replace).toHaveBeenCalledWith('/pair');
    expect(__getLastAlert()?.title).toBe('Sign this device out?');
  });

  it('with no credential it revokes the surface id presence knows', async () => {
    usePresenceStore.setState({ surfaceId: 's-presence' });
    const r = renderRN(<ThisSurfaceSection />);
    await confirmDeactivate(r.root);
    expect(api.revoke).toHaveBeenCalledWith('s-presence');
    expect(routerMock.replace).toHaveBeenCalledWith('/pair');
  });

  it('a failed revoke still clears locally, and says the revoke failed', async () => {
    saveCredential(jwt({ sub: 'a', surface_id: 's-me', surface_kind: 'mobile', label: '' }));
    vi.mocked(api.revoke).mockRejectedValue(new Error('HTTP 500'));
    const r = renderRN(<ThisSurfaceSection />);
    await confirmDeactivate(r.root);
    expect(loadCredential()).toBeNull();
    expect(teardown).toHaveBeenCalled();
    expect(routerMock.replace).toHaveBeenCalledWith('/pair');
    expect(__getLastAlert()).toEqual({
      title: 'Revoke failed',
      message: 'HTTP 500',
      buttons: undefined,
    });
  });

  it('with no known surface id it cannot revoke, and says so', async () => {
    const r = renderRN(<ThisSurfaceSection />);
    await confirmDeactivate(r.root);
    expect(api.revoke).not.toHaveBeenCalled();
    expect(__getLastAlert()).toEqual({
      title: 'Revoke failed',
      message: 'this phone does not know its own surface id, so it could not be revoked',
      buttons: undefined,
    });
    expect(teardown).toHaveBeenCalled();
    expect(routerMock.replace).toHaveBeenCalledWith('/pair');
  });
});

it('opens recovery without waiting for the account request', async () => {
  const { useUiStore } = await import('../src/stores/uiStore');
  useUiStore.setState({ diagnosticsOpen: false });
  const r = renderRN(<AccountPage />);
  findHost(r.root, byTestId('account-connection')).props.onPress();
  expect(useUiStore.getState().diagnosticsOpen).toBe(true);
});
