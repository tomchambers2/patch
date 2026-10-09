// LinkDeviceQr — spec/14 `/settings` "Link a device" + spec/10 § Surface
// linking. Any already-linked surface can link another, so this is available
// from desktop. Mints a genuine, single-use, server-issued surface-pairing
// nonce (POST /api/auth/pair/start) and renders it as a scannable QR. The QR
// encodes a real pairing payload (`patch-pair://…`, spec/05 § Canonical QR
// payload), NOT a placeholder — the new surface (phone app) scans it to complete pairing
// (POST /api/auth/pair/complete). NO FALLBACK: a mint failure surfaces a red
// retry banner rather than a decorative image.

import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useQuery } from '@tanstack/react-query';
import { encodePairingUri } from '@patch/wire';
import { api } from '../api/rest.js';

/**
 * The pairing code the QR encodes: the one the server made, which knows how a
 * new device should reach it (its public address, else its relay); failing that,
 * the origin this surface is itself talking to.
 */
function buildPairingPayload(issued: { nonce: string; uri?: string }): string {
  return issued.uri ?? encodePairingUri({ nonce: issued.nonce, server: window.location.origin });
}

/**
 * The panel. Mounting it mints the nonce — don't mint pairing codes on every
 * Settings visit, so the Devices page mounts this only when "Link a device" is
 * pressed, and `onClose` unmounts it.
 */
export function LinkDeviceQr({ onClose }: { onClose: () => void }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  // Mint the nonce. Re-mint ~30s before the 5-min nonce TTL elapses so the QR
  // stays scannable while the panel is open.
  const { data, error, refetch, isFetching } = useQuery({
    queryKey: ['surface-pair-nonce'],
    queryFn: () => api.surfacePairStart(),
    refetchInterval: 4.5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const payload = data ? buildPairingPayload(data) : null;

  useEffect(() => {
    if (!payload || !canvasRef.current) return;
    let cancelled = false;
    QRCode.toCanvas(canvasRef.current, payload, { width: 220, margin: 1 }, (err) => {
      if (cancelled) return;
      setRenderError(err ? err.message : null);
    });
    return () => {
      cancelled = true;
    };
  }, [payload]);

  const close = (
    <div className="set-actions">
      <button
        type="button"
        className="set-btn ghost"
        data-testid="link-device-close"
        onClick={onClose}
      >
        Close
      </button>
    </div>
  );

  if (error) {
    return (
      <div className="set-pair" data-testid="link-device">
        <p className="set-error" data-testid="link-device-error">
          Could not issue a pairing code: {(error as Error).message}
          <button type="button" className="set-btn" onClick={() => refetch()}>
            Retry
          </button>
        </p>
        {close}
      </div>
    );
  }

  return (
    <div className="set-pair" data-testid="link-device">
      {!data ? (
        <p className="muted" data-testid="link-device-loading">
          {/* v8 ignore next -- defensive only: this branch only renders once `open` gates the query on, at which point react-query begins fetching synchronously with no cached data, so `isFetching` is always true here (and not errored). */}
          {isFetching ? 'Issuing a pairing code…' : 'Preparing…'}
        </p>
      ) : (
        <div className="set-qr">
          <canvas
            ref={canvasRef}
            data-testid="link-device-qr-canvas"
            data-pairing-nonce={data.nonce}
            aria-label="Link-a-device pairing QR code"
            role="img"
          />
          {renderError ? (
            <p className="set-error" data-testid="link-device-render-error">
              QR render failed: {renderError}
            </p>
          ) : (
            <code className="set-code" data-testid="link-device-nonce">
              {data.nonce}
            </code>
          )}
        </div>
      )}
      {close}
    </div>
  );
}
