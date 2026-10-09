// The end-to-end encryption between a Patch server and a device that reaches it
// through a relay (spec/10 § Relay). Everything the relay forwards is one of
// these frames, so it learns who is talking (a channel) and how much, and
// nothing of what is said.
//
// A Noise-NK shaped handshake: the device knows the server's static public key
// (it came in the pairing code), sends a fresh ephemeral key, and the server
// answers with its own. Both ends then hold two fresh keys, one per direction,
// from a hash over the two Diffie-Hellman results. Only the holder of the
// server's secret key can read the hello or make a reply the device accepts, so
// the device knows it is talking to its server and not to the relay; the server
// learns who the device is from the layer above (the pairing nonce, then the
// credential), not from this one.
//
// The transport is XChaCha20-Poly1305 with an implicit counter as the nonce: a
// frame the relay drops, repeats or reorders fails to open, and the session ends.

import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import {
  ed25519,
  edwardsToMontgomeryPriv,
  edwardsToMontgomeryPub,
  x25519,
} from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';
import { utf8Encode } from './utf8.js';

export class RelayCryptoError extends Error {}

const LABEL = utf8Encode('patch-relay-v1');
const KIND_HELLO = 1;
const KIND_REPLY = 2;
/** The most plaintext one transport frame carries; larger messages are split above this layer. */
export const MAX_PLAINTEXT = 65_536;
const TAG = 16;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// By hand, like utf8.ts: `btoa` and `atob` are not on every JavaScript engine this runs on.
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] as string;
    out += B64[(n >> 12) & 63] as string;
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63] as string;
    if (i + 2 < bytes.length) out += B64[n & 63] as string;
  }
  return out;
}

export function fromBase64Url(s: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of s) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new RelayCryptoError('not base64url');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** The server's long-term identity: an Ed25519 key, which also yields its X25519 key. */
export interface ServerIdentity {
  /** Ed25519 public key, 32 bytes — what a pairing code carries. */
  publicKey: Uint8Array;
  /** Ed25519 seed, 32 bytes. Never leaves the server. */
  secretKey: Uint8Array;
}

export function generateServerIdentity(): ServerIdentity {
  const secretKey = ed25519.utils.randomPrivateKey();
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

/** The identity a stored secret key stands for. */
export function identityFromSecret(secretKey: Uint8Array): ServerIdentity {
  if (secretKey.length !== 32)
    throw new RelayCryptoError(`a relay key is 32 bytes, got ${secretKey.length}`);
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

/** The relay channel a server listens on: derived from its key, so only it can hold it. */
export function channelFor(publicKey: Uint8Array): string {
  return toBase64Url(sha256(publicKey)).slice(0, 22);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function key(ikm: Uint8Array, salt: Uint8Array, info: string): Uint8Array {
  return hkdf(sha256, ikm, salt, utf8Encode(info), 32);
}

/** 24-byte XChaCha nonce from a counter: 16 zero bytes then the counter, little-endian. */
function nonceFor(counter: number): Uint8Array {
  const n = new Uint8Array(24);
  new DataView(n.buffer).setBigUint64(16, BigInt(counter), true);
  return n;
}

/** One direction pair of an established session. */
export class RelaySession {
  private sent = 0;
  private received = 0;

  constructor(
    private readonly sendKey: Uint8Array,
    private readonly receiveKey: Uint8Array,
  ) {}

  /** Seal one message into a transport frame. */
  seal(plaintext: Uint8Array): Uint8Array {
    if (plaintext.length > MAX_PLAINTEXT) {
      throw new RelayCryptoError(`message too large for one frame (${plaintext.length} bytes)`);
    }
    const box = xchacha20poly1305(this.sendKey, nonceFor(this.sent)).encrypt(plaintext);
    this.sent += 1;
    return box;
  }

  /** Open a transport frame. Throws if it was altered, repeated, dropped-before or reflected. */
  open(frame: Uint8Array): Uint8Array {
    if (frame.length < TAG || frame.length > MAX_PLAINTEXT + TAG) {
      throw new RelayCryptoError('frame has an impossible size');
    }
    let plain: Uint8Array;
    try {
      plain = xchacha20poly1305(this.receiveKey, nonceFor(this.received)).decrypt(frame);
    } catch {
      throw new RelayCryptoError(
        'frame did not open (altered, repeated, out of order or not ours)',
      );
    }
    this.received += 1;
    return plain;
  }
}

export interface ClientHandshake {
  /** Send to the server first. */
  hello: Uint8Array;
  /** Give it the server's reply; returns the session, or throws if the reply is not the server's. */
  finish(reply: Uint8Array): RelaySession;
}

/** The device's side. `serverKey` is the Ed25519 public key from the pairing code. */
export function clientHandshake(serverKey: Uint8Array): ClientHandshake {
  const ephemeral = x25519.utils.randomPrivateKey();
  const ephemeralPub = x25519.getPublicKey(ephemeral);
  const staticPub = edwardsToMontgomeryPub(serverKey);
  const dh1 = x25519.getSharedSecret(ephemeral, staticPub);
  const helloKey = key(dh1, new Uint8Array(0), 'hello');
  const aad = concat(Uint8Array.of(KIND_HELLO), ephemeralPub);
  const box = xchacha20poly1305(helloKey, nonceFor(0), aad).encrypt(concat(LABEL, randomBytes(16)));
  return {
    hello: concat(aad, box),
    finish(reply: Uint8Array): RelaySession {
      if (reply.length < 1 + 32 + TAG || reply[0] !== KIND_REPLY) {
        throw new RelayCryptoError('reply is not a server reply');
      }
      const serverEphemeral = reply.slice(1, 33);
      const dh2 = x25519.getSharedSecret(ephemeral, serverEphemeral);
      const ikm = concat(dh1, dh2);
      const replyKey = key(ikm, new Uint8Array(0), 'reply');
      try {
        xchacha20poly1305(replyKey, nonceFor(0), concat(reply.slice(0, 33), ephemeralPub)).decrypt(
          reply.slice(33),
        );
      } catch {
        throw new RelayCryptoError('reply did not verify: this is not the server the code named');
      }
      const salt = sha256(concat(ephemeralPub, serverEphemeral));
      return new RelaySession(key(ikm, salt, 'c2s'), key(ikm, salt, 's2c'));
    },
  };
}

/** The server's side: answer a hello. Throws if it is not for this server or was altered. */
export function serverAccept(
  identity: ServerIdentity,
  hello: Uint8Array,
): { reply: Uint8Array; session: RelaySession } {
  if (hello.length < 1 + 32 + TAG || hello[0] !== KIND_HELLO) {
    throw new RelayCryptoError('not a client hello');
  }
  const clientEphemeral = hello.slice(1, 33);
  const staticPriv = edwardsToMontgomeryPriv(identity.secretKey);
  const dh1 = x25519.getSharedSecret(staticPriv, clientEphemeral);
  try {
    const plain = xchacha20poly1305(
      key(dh1, new Uint8Array(0), 'hello'),
      nonceFor(0),
      hello.slice(0, 33),
    ).decrypt(hello.slice(33));
    if (plain.length < LABEL.length || !LABEL.every((b, i) => plain[i] === b))
      throw new Error('label');
  } catch {
    throw new RelayCryptoError('client hello is not for this server or was altered');
  }
  const ephemeral = x25519.utils.randomPrivateKey();
  const ephemeralPub = x25519.getPublicKey(ephemeral);
  const dh2 = x25519.getSharedSecret(ephemeral, clientEphemeral);
  const ikm = concat(dh1, dh2);
  const aad = concat(Uint8Array.of(KIND_REPLY), ephemeralPub);
  const box = xchacha20poly1305(
    key(ikm, new Uint8Array(0), 'reply'),
    nonceFor(0),
    concat(aad, clientEphemeral),
  ).encrypt(LABEL);
  const salt = sha256(concat(clientEphemeral, ephemeralPub));
  return {
    reply: concat(aad, box),
    session: new RelaySession(key(ikm, salt, 's2c'), key(ikm, salt, 'c2s')),
  };
}
