// The pairing-QR payload (spec/05 § Canonical QR payload): the one string every
// generator encodes and every scanner reads.
//
//   patch-pair://<host>?nonce=<nonce>[&s=http]         a server reached directly
//   patch-pair://?nonce=<nonce>&relay=<wss url>&ch=<channel>&pk=<server key>
//                                                      a server reached through a relay
//
// The nonce is the only secret the code carries; the relay's address, the
// channel and the server's PUBLIC key are what a scanner needs to dial in and to
// know it is talking to that server and nobody in between (spec/10 § Relay).
//
// NO FALLBACK: anything that is not exactly this throws, and the scanner shows
// the error rather than guessing.

const SCHEME = 'patch-pair://';

export interface PairingRelay {
  /** The relay's `wss://` address. */
  url: string;
  /** Which of the relay's channels the server is on. */
  channel: string;
  /** The server's X25519 public key, base64url — pins who the scanner is talking to. */
  serverKey: string;
}

export interface PairingPayload {
  nonce: string;
  /** Origin of a server reached directly (`https://host[:port]`), else null. */
  server: string | null;
  /** The relay to reach the server through, else null. */
  relay: PairingRelay | null;
}

export function encodePairingUri(p: {
  nonce: string;
  server?: string;
  relay?: PairingRelay;
}): string {
  if (p.server !== undefined && p.relay !== undefined) {
    throw new Error('A pairing code names both a server and a relay; it must name one');
  }
  const q = new URLSearchParams({ nonce: p.nonce });
  if (p.server !== undefined) {
    const url = new URL(p.server);
    if (url.protocol === 'http:') q.set('s', 'http');
    return `${SCHEME}${url.host}?${q.toString()}`;
  }
  if (p.relay !== undefined) {
    q.set('relay', p.relay.url);
    q.set('ch', p.relay.channel);
    q.set('pk', p.relay.serverKey);
    return `${SCHEME}?${q.toString()}`;
  }
  throw new Error('A pairing code names neither a server nor a relay');
}

export function parsePairingUri(raw: string): PairingPayload {
  const trimmed = raw.trim();
  if (!trimmed.startsWith(SCHEME)) {
    throw new Error('Not a patch pairing QR (expected a patch-pair:// code)');
  }
  const rest = trimmed.slice(SCHEME.length);
  const qIdx = rest.indexOf('?');
  const host = qIdx === -1 ? '' : rest.slice(0, qIdx);
  const q = new URLSearchParams(qIdx === -1 ? '' : rest.slice(qIdx + 1));
  const nonce = q.get('nonce');
  if (!nonce) throw new Error('Pairing QR missing nonce');

  const relayUrl = q.get('relay');
  if (host.length > 0 && relayUrl !== null) {
    throw new Error('Pairing QR names both a server and a relay');
  }
  if (relayUrl !== null) {
    if (!relayUrl.startsWith('wss://') && !relayUrl.startsWith('ws://')) {
      throw new Error('Pairing QR relay must be a wss:// address');
    }
    const channel = q.get('ch');
    if (!channel) throw new Error('Pairing QR missing relay channel');
    const serverKey = q.get('pk');
    if (!serverKey) throw new Error('Pairing QR missing server key');
    return { nonce, server: null, relay: { url: relayUrl, channel, serverKey } };
  }
  if (host.length === 0) throw new Error('Pairing QR names neither a server nor a relay');
  const scheme = q.get('s') === 'http' ? 'http' : 'https';
  return { nonce, server: `${scheme}://${host}`, relay: null };
}
