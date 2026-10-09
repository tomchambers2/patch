import { describe, expect, it } from 'vitest';
import {
  channelFor,
  clientHandshake,
  generateServerIdentity,
  serverAccept,
  fromBase64Url,
  toBase64Url,
  RelayCryptoError,
} from '../src/crypto.js';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);

function pair() {
  const server = generateServerIdentity();
  const client = clientHandshake(server.publicKey);
  const accepted = serverAccept(server, client.hello);
  const clientSession = client.finish(accepted.reply);
  return { server, client, serverSession: accepted.session, clientSession };
}

describe('server identity', () => {
  it('names its channel by the hash of its public key, 22 base64url characters', () => {
    const id = generateServerIdentity();
    expect(channelFor(id.publicKey)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(channelFor(id.publicKey)).toBe(channelFor(id.publicKey));
    expect(channelFor(generateServerIdentity().publicKey)).not.toBe(channelFor(id.publicKey));
  });

  it('base64url round-trips without padding', () => {
    const b = new Uint8Array([0, 255, 254, 1, 2, 3, 4]);
    expect(toBase64Url(b)).not.toContain('=');
    expect(Array.from(fromBase64Url(toBase64Url(b)))).toEqual(Array.from(b));
  });
});

describe('handshake', () => {
  it('gives both ends a session that opens what the other seals, both ways', () => {
    const { serverSession, clientSession } = pair();
    expect(text(serverSession.open(clientSession.seal(utf8('hello server'))))).toBe('hello server');
    expect(text(clientSession.open(serverSession.seal(utf8('hello client'))))).toBe('hello client');
  });

  it('is fresh every time: two sessions to one server share no keys', () => {
    const server = generateServerIdentity();
    const a = clientHandshake(server.publicKey);
    const b = clientHandshake(server.publicKey);
    expect(toBase64Url(a.hello)).not.toBe(toBase64Url(b.hello));
    const sa = serverAccept(server, a.hello);
    const sb = serverAccept(server, b.hello);
    const frame = sa.session.seal(utf8('x'));
    expect(() => sb.session.open(frame)).toThrow(RelayCryptoError);
  });

  it('refuses a hello that is not for this server', () => {
    const real = generateServerIdentity();
    const other = generateServerIdentity();
    const client = clientHandshake(other.publicKey);
    expect(() => serverAccept(real, client.hello)).toThrow(/hello/);
  });

  it('refuses a hello that was altered on the way', () => {
    const server = generateServerIdentity();
    const client = clientHandshake(server.publicKey);
    const tampered = client.hello.slice();
    tampered[40] = tampered[40]! ^ 1;
    expect(() => serverAccept(server, tampered)).toThrow(/hello/);
  });

  it('lets the client tell an impostor: a reply made without the server key does not verify', () => {
    const server = generateServerIdentity();
    const impostor = generateServerIdentity();
    const client = clientHandshake(server.publicKey);
    // The impostor can only answer a hello meant for it, so it re-handshakes with its own key.
    const theirs = clientHandshake(impostor.publicKey);
    const forged = serverAccept(impostor, theirs.hello).reply;
    expect(() => client.finish(forged)).toThrow(/reply/);
  });

  it('rejects frames that are too short or of the wrong kind', () => {
    const server = generateServerIdentity();
    expect(() => serverAccept(server, new Uint8Array(5))).toThrow(/hello/);
    const client = clientHandshake(server.publicKey);
    expect(() => client.finish(new Uint8Array(3))).toThrow(/reply/);
  });
});

describe('transport', () => {
  it('does not put the plaintext on the wire', () => {
    const { clientSession } = pair();
    const secret = 'the-secret-api-key-0123456789';
    const frame = clientSession.seal(utf8(secret));
    expect(Buffer.from(frame).includes(Buffer.from(secret))).toBe(false);
    expect(frame.length).toBeGreaterThan(secret.length);
  });

  it('seals the same plaintext differently each time', () => {
    const { clientSession } = pair();
    const a = clientSession.seal(utf8('same'));
    const b = clientSession.seal(utf8('same'));
    expect(toBase64Url(a)).not.toBe(toBase64Url(b));
  });

  it('refuses a replayed frame', () => {
    const { serverSession, clientSession } = pair();
    const frame = clientSession.seal(utf8('pay £5'));
    serverSession.open(frame);
    expect(() => serverSession.open(frame)).toThrow(RelayCryptoError);
  });

  it('refuses a dropped frame — the order is part of the key stream', () => {
    const { serverSession, clientSession } = pair();
    clientSession.seal(utf8('first (dropped by the relay)'));
    const second = clientSession.seal(utf8('second'));
    expect(() => serverSession.open(second)).toThrow(RelayCryptoError);
  });

  it('refuses a frame altered on the way', () => {
    const { serverSession, clientSession } = pair();
    const frame = clientSession.seal(utf8('hello'));
    frame[frame.length - 1] = frame[frame.length - 1]! ^ 1;
    expect(() => serverSession.open(frame)).toThrow(RelayCryptoError);
  });

  it('refuses a frame reflected back at its sender', () => {
    const { clientSession } = pair();
    const frame = clientSession.seal(utf8('hello'));
    expect(() => clientSession.open(frame)).toThrow(RelayCryptoError);
  });

  it('carries an empty message and a large one', () => {
    const { serverSession, clientSession } = pair();
    expect(serverSession.open(clientSession.seal(new Uint8Array(0))).length).toBe(0);
    const big = new Uint8Array(60_000).fill(7);
    expect(serverSession.open(clientSession.seal(big)).length).toBe(60_000);
  });

  it('refuses to seal more than one frame can carry', () => {
    const { clientSession } = pair();
    expect(() => clientSession.seal(new Uint8Array(70_000))).toThrow(/too large/);
  });
});

describe('base64url', () => {
  it('agrees with the platform for every length, and refuses what is not base64url', () => {
    for (let n = 0; n < 40; n++) {
      const b = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
      expect(toBase64Url(b)).toBe(Buffer.from(b).toString('base64url'));
      expect(Array.from(fromBase64Url(Buffer.from(b).toString('base64url')))).toEqual(
        Array.from(b),
      );
    }
    expect(() => fromBase64Url('abc+')).toThrow(/base64url/);
  });
});
