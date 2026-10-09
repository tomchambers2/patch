// Redeeming the pairing code (spec/10 § Host registration).
//
// The code is minted by the SERVER when an already-linked surface asks for one
// (Settings → Hosts → Add host / `patch hosts add`), and rendered by that
// surface. The installer only ever REDEEMS it: it submits the code together
// with this machine's public key and takes back the `daemonKey` the server
// mints. It mints nothing itself.
//
// Every failure is named, because "pairing failed" is useless to somebody
// standing at a machine: an expired code, an already-used code, a code the
// server never issued and an unreachable server all need different next steps.

import type { DaemonIdentity } from '../identity.js';

export type PairFailure =
  | 'unreachable'
  | 'code_expired'
  | 'code_used'
  | 'code_unknown'
  | 'already_registered'
  | 'no_account'
  | 'server_error';

export interface PairSuccess {
  ok: true;
  daemonKey: string;
  daemonId: string;
  /** The server's voice-session secret, when it hands one over (spec/10). */
  internalToken?: string;
}

export interface PairError {
  ok: false;
  kind: PairFailure;
  message: string;
}

export type PairResult = PairSuccess | PairError;

export interface RedeemOptions {
  serverUrl: string;
  code: string;
  identity: DaemonIdentity;
  label: string;
  fetchImpl?: typeof fetch;
}

interface ServerError {
  error?: unknown;
  code?: unknown;
}

async function readError(res: Response): Promise<ServerError> {
  try {
    return (await res.json()) as ServerError;
  } catch {
    return {};
  }
}

/**
 * Submit the code + this machine's public key, then collect the minted
 * `daemonKey`. Returns a named failure rather than throwing, so the installer
 * can print the one sentence that tells the user what to do next.
 */
export async function redeemPairingCode(opts: RedeemOptions): Promise<PairResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.serverUrl.replace(/\/+$/, '');

  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/auth/daemon/register/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nonce: opts.code,
        daemonId: opts.identity.daemonId,
        label: opts.label,
        publicKey: opts.identity.publicKey,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      kind: 'unreachable',
      message: `could not reach the patch server at ${base}: ${(err as Error).message}`,
    };
  }

  if (!res.ok) {
    const body = await readError(res);
    const code = typeof body.code === 'string' ? body.code : undefined;
    const text = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
    if (code === 'nonce_expired') {
      return {
        ok: false,
        kind: 'code_expired',
        message:
          'that pairing code has expired (codes are good for five minutes). ' +
          'Ask the surface for a fresh one and run the installer again.',
      };
    }
    if (code === 'nonce_used') {
      return {
        ok: false,
        kind: 'code_used',
        message:
          'that pairing code has already been used. A code registers exactly one machine — ' +
          'ask the surface for a fresh one and run the installer again.',
      };
    }
    if (code === 'nonce_unknown') {
      return {
        ok: false,
        kind: 'code_unknown',
        message:
          'the server does not recognise that pairing code. Check it was typed correctly, ' +
          'or ask the surface for a fresh one.',
      };
    }
    if (res.status === 409) {
      return { ok: false, kind: 'already_registered', message: text };
    }
    if (res.status === 400 && text === 'no account bootstrapped') {
      return {
        ok: false,
        kind: 'no_account',
        message:
          'that server has no account yet, so it cannot register a machine. ' +
          'Link a surface first (`patch auth bootstrap`).',
      };
    }
    return { ok: false, kind: 'server_error', message: `the server refused the code: ${text}` };
  }

  // The server has minted the credential; collect it from the long-poll.
  let awaitRes: Response;
  try {
    awaitRes = await fetchImpl(
      `${base}/api/auth/daemon/register/await?nonce=${encodeURIComponent(opts.code)}`,
    );
  } catch (err) {
    return {
      ok: false,
      kind: 'unreachable',
      message: `the code was accepted but the credential could not be collected: ${(err as Error).message}`,
    };
  }
  if (!awaitRes.ok) {
    const body = await readError(awaitRes);
    return {
      ok: false,
      kind: 'server_error',
      message: `the code was accepted but the server did not return a credential: ${
        typeof body.error === 'string' ? body.error : `HTTP ${awaitRes.status}`
      }`,
    };
  }
  const payload = (await awaitRes.json()) as { daemonKey?: unknown; internalToken?: unknown };
  if (typeof payload.daemonKey !== 'string' || payload.daemonKey.length === 0) {
    return {
      ok: false,
      kind: 'server_error',
      message: 'the server returned a malformed credential (no daemonKey)',
    };
  }
  return {
    ok: true,
    daemonKey: payload.daemonKey,
    daemonId: opts.identity.daemonId,
    ...(typeof payload.internalToken === 'string' && payload.internalToken.length > 0
      ? { internalToken: payload.internalToken }
      : {}),
  };
}
