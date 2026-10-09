// The single-use registration code a host installer redeems (spec/10
// § Host registration).
//
// Text, deliberately — NOT a QR. Adding a host ends at a terminal prompt on
// another machine ("Pairing code:"), and a camera cannot type into that. The QR
// here only implied a scanning step that does not exist, on a flow whose other
// half is a shell command you paste. QR belongs to linking a SURFACE, where a
// phone really does scan.
//
// NO FALLBACK: a mint failure is shown as itself. A stale or invented code would
// fail at the installer's prompt with nothing to explain why.

import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/rest.js';

export function PairingCode(): JSX.Element {
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ['daemon-pair-nonce'],
    queryFn: () => api.daemonPairStart(),
    // Codes are good for five minutes; re-mint just before that elapses so the
    // one on screen is always redeemable.
    refetchInterval: 4.5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  if (error) {
    return (
      <p className="muted" data-testid="pairing-code-error">
        Couldn’t issue a pairing code: {(error as Error).message}{' '}
        <button type="button" className="set-btn" onClick={() => void refetch()}>
          Retry
        </button>
      </p>
    );
  }

  if (!data) {
    return (
      <p className="muted" data-testid="pairing-code-loading">
        {isFetching ? 'Issuing a code…' : '…'}
      </p>
    );
  }

  return (
    <pre className="pairing-code" data-testid="pairing-code">
      {data.nonce}
    </pre>
  );
}
