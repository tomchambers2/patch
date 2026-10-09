// Being signed out has to LOOK like being signed out.
//
// When the server refuses this surface's credential the app goes back to
// pairing — but a sign-in screen appearing with no explanation is its own kind
// of confusing. It says what happened, so "link this device again" reads as an
// instruction rather than something the user has to infer from a QR scanner
// they didn't ask for.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderRN, hasText } from './testUtils/render';
import { usePresenceStore } from '../src/stores/presenceStore';

vi.mock('expo-camera', () => ({
  CameraView: () => null,
  useCameraPermissions: () => [{ granted: true }, vi.fn()],
}));

beforeEach(() => {
  usePresenceStore.getState().setAuthRejected(null);
  usePresenceStore.getState().setConnection('connecting');
});

describe('the pairing screen after a refusal', () => {
  it('says the device was signed out, and why', async () => {
    usePresenceStore.getState().setAuthRejected('invalid credential');
    const Pair = (await import('../app/pair')).default;
    const tree = renderRN(<Pair />);
    expect(hasText(tree.root, 'signed out')).toBe(true);
    expect(hasText(tree.root, 'invalid credential')).toBe(true);
  });

  it('says nothing of the sort on an ordinary first-time pairing', async () => {
    const Pair = (await import('../app/pair')).default;
    const tree = renderRN(<Pair />);
    expect(hasText(tree.root, 'signed out')).toBe(false);
  });
});
