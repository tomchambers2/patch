// PairingScreen — shown when no credential is stored. The web surface signs in
// by PASTING a credential token (a JWT from `patch auth bootstrap` on the very
// first sign-in, or `patch pair` on a linked machine). It is validated for
// shape (isWellFormedCredential) and persisted to localStorage.
//
// The QR flow (`patch-pair://<host>?nonce=…` + POST /api/auth/pair/complete,
// which returns the credential in the HTTP response) is how the MOBILE surface
// enrols by scanning — see apps/mobile/app/pair.tsx and
// packages/web/src/components/LinkDeviceQr.tsx (which any linked surface uses to
// GENERATE the QR). The web app is the QR generator, not a scanner; paste is its
// sign-in. (There is no `pairing.signed_credential` WS event.)

import type { JSX } from 'react';
import { useState } from 'react';
import { isWellFormedCredential, saveCredential } from '../lib/credential.js';
import { shortcutLabel } from '../lib/shortcuts.js';
import { isSubmitChord } from '../lib/submitChord.js';

export function PairingScreen({
  onPaired,
  rejectedReason,
}: {
  onPaired(): void;
  /**
   * Set when the server REJECTED the credential this surface was holding, as
   * opposed to there never having been one. Without this the screen appears
   * mid-session with no explanation, which reads as the app losing your work.
   */
  rejectedReason?: string;
}): JSX.Element {
  const [jwt, setJwt] = useState('');
  const [error, setError] = useState<string | null>(null);

  /** The one sign-in path — Continue's and `⌘↵`'s (spec/14 § Keyboard shortcuts). */
  function submit(): void {
    const v = jwt.trim();
    if (v.length === 0) return;
    if (!isWellFormedCredential(v)) {
      setError(
        'That doesn’t look like a credential token. A token is a long JWT starting with “eyJ”. If you pasted a short pairing code, that’s the wrong value.',
      );
      return;
    }
    saveCredential(v);
    onPaired();
  }
  return (
    <main className="pairing-screen" data-testid="pairing-screen">
      <div className="pairing-window-drag" data-testid="pairing-window-drag" aria-hidden="true" />
      <h1 className="display">patch</h1>
      {rejectedReason !== undefined ? (
        <p className="pairing-signed-out" data-testid="pairing-signed-out" role="status">
          This surface was signed out. The server no longer accepts its credential, so sign in again
          below.
        </p>
      ) : null}
      <p>
        Sign in by pasting a <strong>credential token</strong>. You get one from a machine that has
        the patch CLI:
      </p>
      <ol>
        <li>
          Run <code>patch auth bootstrap</code> (very first sign-in) or <code>patch pair</code> on a
          linked machine.
        </li>
        <li>
          It prints a long <strong>credential token</strong>, a JWT starting with <code>eyJ…</code>.
        </li>
        <li>
          Paste that token below. (Not the short <em>pairing code</em>, which authorises a daemon,
          not a sign-in.)
        </li>
      </ol>
      <textarea
        className="pairing-input"
        data-testid="pairing-input"
        placeholder="paste credential token (starts with eyJ…)"
        value={jwt}
        onChange={(e) => {
          setJwt(e.target.value);
          if (error !== null) setError(null);
        }}
        onKeyDown={(e) => {
          if (!isSubmitChord(e)) return;
          e.preventDefault();
          submit();
        }}
        rows={4}
      />
      {error !== null ? (
        <p className="pairing-error" data-testid="pairing-error" role="alert">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        data-testid="pairing-submit"
        disabled={jwt.trim().length === 0}
        title={shortcutLabel('⌘↵')}
        onClick={submit}
      >
        Continue
      </button>
    </main>
  );
}
