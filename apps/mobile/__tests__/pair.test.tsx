// Render coverage for the QR pairing screen (app/pair.tsx — spec/05-surfaces.md
// § Canonical QR payload, spec/10-auth.md § Surface linking). Covers the three
// permission states (not-yet-decided / denied / granted) and the scan handler:
// success (parse → device keypair → pairComplete → saveCredential → navigate),
// re-entrancy guard (a second scan while one is in flight is ignored), and the
// NO-FALLBACK failure path (any pairComplete error surfaces via Alert.alert,
// never silently swallowed).
//
// parsePairingPayload and getOrCreateDeviceKeypair are exercised for REAL (both
// are pure/deterministic under the expo-crypto + MMKV stubs, already covered in
// their own unit tests) — only the network (api.pairComplete) and credential
// persistence are mocked, so this file pins pair.tsx's OWN wiring.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  renderRN,
  update,
  findHost,
  byTestId,
  byType,
  hasText,
  textOf,
  actSync,
  actAsync,
} from './testUtils/render';
import { routerMock, __resetRouterMock } from './stubs/expo-router';
import { __getLastAlert, __clearLastAlert } from './stubs/react-native';
import { __setCameraPermission } from './stubs/expo-camera';

const { pairCompleteMock } = vi.hoisted(() => ({ pairCompleteMock: vi.fn() }));
vi.mock('../src/api/rest', () => ({ api: { pairComplete: pairCompleteMock } }));

const { saveCredentialMock } = vi.hoisted(() => ({ saveCredentialMock: vi.fn() }));
vi.mock('../src/lib/credential', async () => {
  const actual =
    await vi.importActual<typeof import('../src/lib/credential')>('../src/lib/credential');
  return { ...actual, saveCredential: saveCredentialMock };
});

const { bootstrapMock, teardownMock } = vi.hoisted(() => ({
  bootstrapMock: vi.fn(async () => {}),
  teardownMock: vi.fn(),
}));
vi.mock('../src/lib/bootstrap', () => ({ bootstrap: bootstrapMock, teardown: teardownMock }));
import Pair from '../app/pair';

const NONCE_URL = 'patch-pair://patch.example.dev?nonce=abc123';

beforeEach(() => {
  __resetRouterMock();
  __clearLastAlert();
  __setCameraPermission(null);
  bootstrapMock.mockClear();
  teardownMock.mockClear();
  pairCompleteMock.mockReset();
  saveCredentialMock.mockReset();
});

describe('Pair — permission states', () => {
  it('shows a blank loading view while permission is not yet decided (perm === null)', () => {
    const r = renderRN(<Pair />);
    expect(findHost(r.root, byTestId('pair-permission-loading'))).toBeTruthy();
  });

  it('shows the "grant access" prompt when permission was denied', () => {
    __setCameraPermission({ granted: false });
    const r = renderRN(<Pair />);
    expect(hasText(r.root, 'Camera permission needed')).toBe(true);
    expect(hasText(r.root, 'Grant camera access')).toBe(true);
  });

  it('tapping "Grant camera access" requests permission and re-renders the camera once granted', () => {
    __setCameraPermission({ granted: false });
    const r = renderRN(<Pair />);
    const grantButton = findHost(
      r.root,
      (i) => byType('Pressable')(i) && textOf(i) === 'Grant camera access',
    );
    actAsync(() => {
      (grantButton.props as { onPress: () => void }).onPress();
    });
    update(r, <Pair />);
    expect(findHost(r.root, byType('CameraView'))).toBeTruthy();
  });

  it('renders the CameraView + instructions once permission is granted', () => {
    __setCameraPermission({ granted: true });
    const r = renderRN(<Pair />);
    expect(findHost(r.root, byType('CameraView'))).toBeTruthy();
    expect(hasText(r.root, 'Pair this device')).toBe(true);
  });
});

describe('Pair — scan handling', () => {
  beforeEach(() => {
    __setCameraPermission({ granted: true });
  });

  it('a successful scan pairs, saves the credential, and navigates to the chats tab', async () => {
    pairCompleteMock.mockResolvedValue({ credential: 'jwt.token.here' });
    const r = renderRN(<Pair />);
    const camera = findHost(r.root, byType('CameraView'));
    await actAsync(async () => {
      await (camera.props as { onBarcodeScanned: (r: { data: string }) => void }).onBarcodeScanned({
        data: NONCE_URL,
      });
    });
    expect(pairCompleteMock).toHaveBeenCalledWith(
      expect.objectContaining({ nonce: 'abc123', clientType: 'surface-mobile' }),
    );
    expect(saveCredentialMock).toHaveBeenCalledWith('jwt.token.here');
    expect(routerMock.replace).toHaveBeenCalledWith('/(tabs)/chats');
  });

  it('ignores a second scan while the first is still in flight (re-entrancy guard)', async () => {
    let resolvePair!: (v: { credential: string }) => void;
    pairCompleteMock.mockReturnValue(
      new Promise((resolve) => {
        resolvePair = resolve;
      }),
    );
    const r = renderRN(<Pair />);
    const camera = findHost(r.root, byType('CameraView'));
    // First scan: `setScanned(true)` runs synchronously before the first
    // await inside onScan, so a sync act() flushes it — `scanned` is true
    // by the time the second scan's guard check runs.
    actSync(() => {
      void (camera.props as { onBarcodeScanned: (r: { data: string }) => void }).onBarcodeScanned({
        data: NONCE_URL,
      });
    });
    actSync(() => {
      void (camera.props as { onBarcodeScanned: (r: { data: string }) => void }).onBarcodeScanned({
        data: NONCE_URL,
      });
    });
    await actAsync(async () => {
      resolvePair({ credential: 'jwt.token.here' });
    });
    expect(pairCompleteMock).toHaveBeenCalledTimes(1);
  });

  it('an invalid QR payload surfaces an Alert and re-arms scanning (no fallback)', async () => {
    const r = renderRN(<Pair />);
    const camera = findHost(r.root, byType('CameraView'));
    await actAsync(async () => {
      await (camera.props as { onBarcodeScanned: (r: { data: string }) => void }).onBarcodeScanned({
        data: 'not-a-pairing-qr',
      });
    });
    const alert = __getLastAlert();
    expect(alert?.title).toBe('Pairing failed');
    expect(alert?.message).toMatch(/patch-pair/);
    expect(saveCredentialMock).not.toHaveBeenCalled();
    expect(routerMock.replace).not.toHaveBeenCalled();

    // Re-armed: a subsequent scan is processed again (scanned reset to false).
    pairCompleteMock.mockResolvedValue({ credential: 'jwt.token.here' });
    await actAsync(async () => {
      await (camera.props as { onBarcodeScanned: (r: { data: string }) => void }).onBarcodeScanned({
        data: NONCE_URL,
      });
    });
    expect(saveCredentialMock).toHaveBeenCalledWith('jwt.token.here');
  });

  it('a pairComplete network failure surfaces via Alert.alert', async () => {
    pairCompleteMock.mockRejectedValue(new Error('nonce expired'));
    const r = renderRN(<Pair />);
    const camera = findHost(r.root, byType('CameraView'));
    await actAsync(async () => {
      await (camera.props as { onBarcodeScanned: (r: { data: string }) => void }).onBarcodeScanned({
        data: NONCE_URL,
      });
    });
    const alert = __getLastAlert();
    expect(alert?.title).toBe('Pairing failed');
    expect(alert?.message).toBe('nonce expired');
  });
});

describe('Pair — where the code says the server is', () => {
  beforeEach(async () => {
    (await import('./stubs/mmkv')).__clearAllMmkv();
    __setCameraPermission({ granted: true });
  });

  async function scan(r: ReturnType<typeof renderRN>, data: string): Promise<void> {
    const camera = findHost(r.root, byType('CameraView'));
    await actAsync(async () => {
      await (camera.props as { onBarcodeScanned: (r: { data: string }) => void }).onBarcodeScanned({
        data,
      });
    });
  }

  it('takes a direct server from the code and keeps it once pairing has worked', async () => {
    const { getRoute } = await import('../src/config');
    pairCompleteMock.mockResolvedValue({ credential: 'jwt.token.here' });
    await scan(renderRN(<Pair />), 'patch-pair://my-server.example.com?nonce=n1');
    expect(getRoute()).toEqual({ kind: 'direct', url: 'https://my-server.example.com' });
  });

  it('reads plain http from the code', async () => {
    const { getRoute } = await import('../src/config');
    pairCompleteMock.mockResolvedValue({ credential: 'jwt.token.here' });
    await scan(renderRN(<Pair />), 'patch-pair://192.168.1.20:3000?nonce=n1&s=http');
    expect(getRoute()).toEqual({ kind: 'direct', url: 'http://192.168.1.20:3000' });
  });

  it('takes a relay from the code when it names one', async () => {
    const { getRoute } = await import('../src/config');
    pairCompleteMock.mockResolvedValue({ credential: 'jwt.token.here' });
    await scan(
      renderRN(<Pair />),
      'patch-pair://?nonce=n1&relay=wss%3A%2F%2Frelay.example.com&ch=chan&pk=key',
    );
    expect(getRoute()).toEqual({
      kind: 'relay',
      relay: { url: 'wss://relay.example.com', channel: 'chan', serverKey: 'key' },
    });
  });

  it('aims the pairing call itself at the new server, then puts the old aim back if it fails', async () => {
    const { getRoute, getServerUrl } = await import('../src/config');
    let during = '';
    pairCompleteMock.mockImplementation(async () => {
      during = getServerUrl();
      throw new Error('expired');
    });
    await scan(renderRN(<Pair />), 'patch-pair://other.example.com?nonce=n1');
    expect(during).toBe('https://other.example.com');
    expect(getRoute()).toEqual({ kind: 'direct', url: 'https://patch.test' });
    expect(__getLastAlert()?.message).toBe('expired');
  });

  it('leaves the phone with no route at all if it never had one and the pairing failed', async () => {
    const { getRoute, clearRoute } = await import('../src/config');
    clearRoute();
    pairCompleteMock.mockRejectedValue(new Error('expired'));
    await scan(renderRN(<Pair />), 'patch-pair://other.example.com?nonce=n1');
    expect(getRoute()).toBeNull();
  });

  it('refuses a code that names neither a server nor a relay', async () => {
    pairCompleteMock.mockResolvedValue({ credential: 'x' });
    await scan(renderRN(<Pair />), 'patch-pair://?nonce=n1');
    expect(__getLastAlert()?.message).toMatch(/neither a server nor a relay/);
    expect(pairCompleteMock).not.toHaveBeenCalled();
  });
});

it('restarts app services after a replacement server is paired', async () => {
  __setCameraPermission({ granted: true });
  pairCompleteMock.mockResolvedValue({ credential: 'new.credential.sig' });
  const r = renderRN(<Pair />);
  await actAsync(async () => {
    findHost(r.root, byType('CameraView')).props.onBarcodeScanned({ data: NONCE_URL });
  });
  expect(teardownMock).toHaveBeenCalledOnce();
  expect(bootstrapMock).toHaveBeenCalledOnce();
  expect(routerMock.replace).toHaveBeenCalledWith('/(tabs)/chats');
});

describe('Pair — pasting a code when there is no server yet', () => {
  function paste(r: ReturnType<typeof renderRN>, text: string): void {
    actSync(() => {
      findHost(r.root, byTestId('pair-code-input')).props.onChangeText(text);
    });
  }

  it('offers the paste field while camera permission is denied', () => {
    __setCameraPermission({ granted: false });
    const r = renderRN(<Pair />);
    expect(findHost(r.root, byTestId('pair-code-input'))).toBeTruthy();
  });

  it('offers the paste field beside the camera', () => {
    __setCameraPermission({ granted: true });
    const r = renderRN(<Pair />);
    expect(findHost(r.root, byTestId('pair-code-input'))).toBeTruthy();
  });

  it('pairs from a pasted code exactly as a scan would', async () => {
    __setCameraPermission({ granted: false });
    pairCompleteMock.mockResolvedValue({ credential: 'jwt.token.here' });
    const r = renderRN(<Pair />);
    paste(r, `  ${NONCE_URL}\n`);
    await actAsync(async () => {
      findHost(r.root, byTestId('pair-code-submit')).props.onPress();
    });
    expect(pairCompleteMock).toHaveBeenCalledWith(expect.objectContaining({ nonce: 'abc123' }));
    expect(routerMock.replace).toHaveBeenCalledWith('/(tabs)/chats');
  });

  it('surfaces a pasted code that is not a pairing code', async () => {
    __setCameraPermission({ granted: false });
    const r = renderRN(<Pair />);
    paste(r, 'hello');
    await actAsync(async () => {
      findHost(r.root, byTestId('pair-code-submit')).props.onPress();
    });
    expect(__getLastAlert()?.title).toBe('Pairing failed');
    expect(pairCompleteMock).not.toHaveBeenCalled();
  });
});
