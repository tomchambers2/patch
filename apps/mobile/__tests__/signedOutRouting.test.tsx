// Getting refused mid-session has to take you somewhere.
//
// The app only decided between "chats" and "pair" at launch (app/index.tsx), so
// a credential refused while the app was open left you sitting in a chat list
// that could never load anything, behind a banner claiming it was reconnecting.
// The refusal is terminal, so the app leaves for pairing the moment it happens.

import React from 'react';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { renderRN, actSync } from './testUtils/render';
import { usePresenceStore } from '../src/stores/presenceStore';
import { routerMock } from './stubs/expo-router';
import { SignedOutRedirect } from '../src/components/SignedOutRedirect';

// Each test mounts a live subscriber; leaving them mounted would make the next
// test's store change fire every previous instance's effect too.
let mounted: { unmount: () => void } | null = null;
const mount = (el: React.ReactElement): void => {
  const r = renderRN(el);
  mounted = { unmount: () => actSync(() => r.unmount()) };
};

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

beforeEach(() => {
  routerMock.replace.mockClear();
  usePresenceStore.getState().setAuthRejected(null);
  usePresenceStore.getState().setConnection('connecting');
});

describe('a refusal while the app is open', () => {
  it('leaves for the pairing screen', () => {
    mount(<SignedOutRedirect />);
    expect(routerMock.replace).not.toHaveBeenCalled();

    actSync(() => usePresenceStore.getState().setConnection('unauthenticated'));
    expect(routerMock.replace).toHaveBeenCalledWith('/pair');
  });

  it('stays put while the link is merely down', () => {
    // Reconnecting IS recoverable — navigating away from a chat mid-turn
    // because the wifi blinked would be its own bug.
    mount(<SignedOutRedirect />);
    actSync(() => usePresenceStore.getState().setConnection('reconnecting'));
    actSync(() => usePresenceStore.getState().setConnection('offline'));
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it('does not bounce the user back again once they are already pairing', () => {
    mount(<SignedOutRedirect />);
    actSync(() => usePresenceStore.getState().setConnection('unauthenticated'));
    expect(routerMock.replace).toHaveBeenCalledTimes(1);
    actSync(() => usePresenceStore.getState().setAuthRejected('again'));
    expect(routerMock.replace).toHaveBeenCalledTimes(1);
  });
});
