// Settings → Hosts → Pair a voice device (spec/16 § Pairing).
//
// The documented flow was: SSH to the machine, run `patch hosts pair-device`,
// then physically restart the device inside a five-minute window. That is a lot
// to ask, and it did not work anyway — the host's adoption window has no
// consumer (`DeviceAdoption.announce()` has no callers, and nothing ever calls
// `deviceRegistry.register()`), so no device could be adopted through it.
//
// A voice device is a surface. It pairs the same way a phone does, through the
// server's existing surface-pairing flow: mint a single-use nonce here, the
// device redeems it at /api/auth/pair/complete with `surface-voice-device` and
// its own public key, and comes back holding a real credential. No shell, no
// reboot, and one code path shared with every other surface.
//
// The code is rendered BOTH scannably and typeably: a device with no camera —
// which is most of them — is reached by typing, and a device with one is not
// made to wait for someone to read digits aloud.

import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import QRCode from 'qrcode';
import { api } from '../api/rest.js';

/** The same payload shape every other surface pairs with. */
function pairingPayload(nonce: string): string {
  const origin = window.location.origin.replace(/^https?:\/\//, '');
  return `patch-pair://${origin}?nonce=${encodeURIComponent(nonce)}&kind=voice-device`;
}

/** Seconds until the nonce expires, floored at zero. */
function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.floor((expiresAt - now) / 1000));
}

/**
 * The pairing code panel. Mounting it mints the code — visiting Settings must
 * not issue pairing codes nobody asked for, so the page mounts this only when
 * "Pair a device" is pressed, and `onClose` unmounts it.
 */
export function PairVoiceDevice({ onClose }: { onClose: () => void }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [qrError, setQrError] = useState<string | null>(null);

  const { data, error, refetch, isFetching } = useQuery({
    queryKey: ['voice-device-pair-nonce'],
    queryFn: () => api.surfacePairStart(),
    refetchOnWindowFocus: false,
    retry: false,
  });

  // Drive the countdown so an expired code is never left looking valid.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const payload = data ? pairingPayload(data.nonce) : null;

  useEffect(() => {
    if (!payload || !canvasRef.current) return;
    let cancelled = false;
    QRCode.toCanvas(canvasRef.current, payload, { width: 200, margin: 1 }, (err) => {
      if (!cancelled) setQrError(err ? err.message : null);
    });
    return () => {
      cancelled = true;
    };
  }, [payload]);

  const remaining = data ? secondsLeft(data.expiresAt, now) : 0;
  const expired = data !== undefined && remaining === 0;

  return (
    <div className="set-pair" data-testid="pair-voice-device-panel">
      {error ? (
        <p className="set-error" data-testid="pair-voice-device-error">
          {(error as Error).message}
          <button type="button" className="set-btn" onClick={() => void refetch()}>
            Retry
          </button>
        </p>
      ) : null}

      {isFetching && !data ? <p data-testid="pair-voice-device-loading">…</p> : null}

      {data && !expired ? (
        <div className="set-qr">
          <canvas ref={canvasRef} data-testid="pair-voice-device-qr" />
          <div>
            {qrError ? (
              <p className="set-error" data-testid="pair-voice-device-qr-error">
                {qrError}
              </p>
            ) : null}
            {/* The same code, typeable — most voice devices have no camera. */}
            <code className="set-code" data-testid="pair-voice-device-code">
              {data.nonce}
            </code>
            <span className="set-sub" data-testid="pair-voice-device-expiry">
              {remaining}s
            </span>
          </div>
        </div>
      ) : null}

      {expired ? (
        // An expired code must not sit there looking usable.
        <p className="set-sub" data-testid="pair-voice-device-expired">
          This code has expired{' '}
          <button type="button" className="set-btn" onClick={() => void refetch()}>
            New code
          </button>
        </p>
      ) : null}

      <div className="set-actions">
        <button
          type="button"
          className="set-btn ghost"
          data-testid="pair-voice-device-close"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>
  );
}
