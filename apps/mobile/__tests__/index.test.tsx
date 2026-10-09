// Render coverage for the root auth gate (app/index.tsx). A credentialed
// device jumps straight to the tab navigator; an unpaired device is sent to
// /pair. loadCredential() is the sole branch condition, so it's mocked here
// rather than exercised through real MMKV (credential.test.ts already covers
// loadCredential's own persistence logic).

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderRN, findHost, byType } from './testUtils/render';
import { routerMock, __resetRouterMock } from './stubs/expo-router';

const { loadCredentialMock } = vi.hoisted(() => ({ loadCredentialMock: vi.fn() }));
vi.mock('../src/lib/credential', () => ({ loadCredential: loadCredentialMock }));

const getRouteMock = vi.hoisted(() => vi.fn());
vi.mock('../src/config', () => ({ getRoute: getRouteMock }));
import Index from '../app/index';

beforeEach(() => {
  __resetRouterMock();
  loadCredentialMock.mockReset();
  getRouteMock.mockReturnValue({ kind: 'direct', url: 'https://patch.test' });
});

describe('Index — auth gate', () => {
  it('redirects to /(tabs)/chats when a credential is already stored', () => {
    loadCredentialMock.mockReturnValue('a.b.c');
    const r = renderRN(<Index />);
    const redirect = findHost(r.root, byType('Redirect'));
    expect(redirect.props.href).toBe('/(tabs)/chats');
    expect(routerMock.push).toHaveBeenCalledWith('/(tabs)/chats');
  });

  it('redirects to /pair when there is no stored credential', () => {
    loadCredentialMock.mockReturnValue(null);
    const r = renderRN(<Index />);
    const redirect = findHost(r.root, byType('Redirect'));
    expect(redirect.props.href).toBe('/pair');
    expect(routerMock.push).toHaveBeenCalledWith('/pair');
  });
});

it('sends an upgraded phone with a credential but no saved server to pairing', () => {
  loadCredentialMock.mockReturnValue('a.b.c');
  getRouteMock.mockReturnValue(null);
  const r = renderRN(<Index />);
  expect(findHost(r.root, byType('Redirect')).props.href).toBe('/pair');
});
