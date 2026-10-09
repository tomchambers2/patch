// LinkDeviceQr — spec/14 `/settings` "Link a device" (see component header
// comment). Direct tests: loading, QR success, QR render error, mint-error +
// retry, and Close. The panel mints on MOUNT: Settings → Devices mounts it only
// once "Link a device" is pressed (that gate is tested in SettingsRoute.test).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { LinkDeviceQr } from '../components/LinkDeviceQr.js';
import { api } from '../api/rest.js';

vi.mock('../api/rest.js', () => ({
  api: { surfacePairStart: vi.fn() },
}));

function renderWithClient(onClose: () => void = () => {}): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <LinkDeviceQr onClose={onClose} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('LinkDeviceQr', () => {
  it('mints a pairing code as soon as it mounts, with no open button of its own', async () => {
    vi.mocked(api.surfacePairStart).mockResolvedValue({
      nonce: 'n0',
      expiresAt: Date.now() + 60_000,
    });
    renderWithClient();
    expect(screen.queryByTestId('link-device-open')).toBeNull();
    await waitFor(() => expect(api.surfacePairStart).toHaveBeenCalledTimes(1));
  });

  it('Close calls onClose', async () => {
    vi.mocked(api.surfacePairStart).mockResolvedValue({
      nonce: 'n0',
      expiresAt: Date.now() + 60_000,
    });
    const onClose = vi.fn();
    renderWithClient(onClose);
    fireEvent.click(screen.getByTestId('link-device-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Close is offered on the mint-failure panel too', async () => {
    vi.mocked(api.surfacePairStart).mockRejectedValue(new Error('nope'));
    const onClose = vi.fn();
    renderWithClient(onClose);
    await waitFor(() => expect(screen.getByTestId('link-device-error')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('link-device-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('mounting shows a loading placeholder before the nonce resolves', async () => {
    let resolve!: (v: { nonce: string; expiresAt: number }) => void;
    vi.mocked(api.surfacePairStart).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    renderWithClient();
    expect(screen.getByTestId('link-device-loading')).toHaveTextContent('Issuing a pairing code');
    resolve({ nonce: 'n1', expiresAt: Date.now() + 60_000 });
    await waitFor(() => expect(screen.queryByTestId('link-device-loading')).toBeNull());
  });

  it('renders the QR canvas + pairing code once minted and the QR renders successfully', async () => {
    vi.mocked(api.surfacePairStart).mockResolvedValue({
      nonce: 'nonce-abc',
      expiresAt: Date.now() + 60_000,
    });
    vi.spyOn(QRCode, 'toCanvas').mockImplementation(
      (_canvas: unknown, _text: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: Error | null) => void)(null);
      },
    );
    renderWithClient();
    await waitFor(() => expect(screen.getByTestId('link-device-qr-canvas')).toBeInTheDocument());
    expect(screen.getByTestId('link-device-qr-canvas')).toHaveAttribute(
      'data-pairing-nonce',
      'nonce-abc',
    );
    expect(screen.getByTestId('link-device-nonce')).toHaveTextContent('nonce-abc');
    expect(screen.queryByTestId('link-device-render-error')).toBeNull();
  });

  // spec/05 § Canonical QR payload — the code is the server's to make: it knows
  // whether a new device reaches it by address or through a relay.
  it('draws the code the server issued, which may name a relay', async () => {
    const uri = 'patch-pair://?nonce=n9&relay=wss%3A%2F%2Frelay.example.com&ch=chan&pk=key';
    vi.mocked(api.surfacePairStart).mockResolvedValue({ nonce: 'n9', expiresAt: 1, uri });
    const toCanvas = vi
      .spyOn(QRCode, 'toCanvas')
      .mockImplementation((_c: unknown, _t: unknown, _o: unknown, cb: unknown) => {
        (cb as (err: Error | null) => void)(null);
      });
    renderWithClient();
    await waitFor(() => expect(toCanvas).toHaveBeenCalled());
    expect(toCanvas.mock.calls[0]?.[1]).toBe(uri);
  });

  it('otherwise draws the origin this surface is itself talking to', async () => {
    vi.mocked(api.surfacePairStart).mockResolvedValue({ nonce: 'n8', expiresAt: 1 });
    const toCanvas = vi
      .spyOn(QRCode, 'toCanvas')
      .mockImplementation((_c: unknown, _t: unknown, _o: unknown, cb: unknown) => {
        (cb as (err: Error | null) => void)(null);
      });
    renderWithClient();
    await waitFor(() => expect(toCanvas).toHaveBeenCalled());
    expect(toCanvas.mock.calls[0]?.[1]).toBe(
      `patch-pair://${window.location.host}?nonce=n8${window.location.protocol === 'http:' ? '&s=http' : ''}`,
    );
  });

  it('shows a render-error message when QRCode.toCanvas fails', async () => {
    vi.mocked(api.surfacePairStart).mockResolvedValue({
      nonce: 'nonce-fail',
      expiresAt: Date.now() + 60_000,
    });
    vi.spyOn(QRCode, 'toCanvas').mockImplementation(
      (_canvas: unknown, _text: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: Error | null) => void)(new Error('canvas unsupported'));
      },
    );
    renderWithClient();
    await waitFor(() =>
      expect(screen.getByTestId('link-device-render-error')).toHaveTextContent(
        'canvas unsupported',
      ),
    );
    expect(screen.queryByTestId('link-device-nonce')).toBeNull();
  });

  it('ignores a QRCode.toCanvas callback that fires after the effect was cleaned up', async () => {
    vi.mocked(api.surfacePairStart).mockResolvedValue({
      nonce: 'nonce-stale',
      expiresAt: Date.now() + 60_000,
    });
    let capturedCb: ((err: Error | null) => void) | undefined;
    vi.spyOn(QRCode, 'toCanvas').mockImplementation(
      (_canvas: unknown, _text: unknown, _opts: unknown, cb: unknown) => {
        capturedCb = cb as (err: Error | null) => void;
      },
    );
    const { unmount } = renderWithClient();
    await waitFor(() => expect(capturedCb).toBeTypeOf('function'));
    unmount();
    expect(() => capturedCb!(new Error('too late'))).not.toThrow();
  });

  it('shows a mint-failure banner with Retry when surfacePairStart rejects', async () => {
    vi.mocked(api.surfacePairStart).mockRejectedValue(new Error('server unreachable'));
    renderWithClient();
    await waitFor(() =>
      expect(screen.getByTestId('link-device-error')).toHaveTextContent('server unreachable'),
    );
    vi.mocked(api.surfacePairStart).mockResolvedValue({
      nonce: 'after-retry',
      expiresAt: Date.now() + 60_000,
    });
    vi.spyOn(QRCode, 'toCanvas').mockImplementation(
      (_canvas: unknown, _text: unknown, _opts: unknown, cb: unknown) => {
        (cb as (err: Error | null) => void)(null);
      },
    );
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(screen.getByTestId('link-device-qr-canvas')).toBeInTheDocument());
  });
});
