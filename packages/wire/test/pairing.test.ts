import { describe, expect, it } from 'vitest';
import { encodePairingUri, parsePairingUri } from '../src/pairing.js';

describe('pairing URI (spec/05 § Canonical QR payload)', () => {
  it('direct: the host, no scheme, defaults to https', () => {
    const uri = encodePairingUri({ nonce: 'abc_DEF-123', server: 'https://patch.example.com/' });
    expect(uri).toBe('patch-pair://patch.example.com?nonce=abc_DEF-123');
    expect(parsePairingUri(uri)).toEqual({
      nonce: 'abc_DEF-123',
      server: 'https://patch.example.com',
      relay: null,
    });
  });

  it('direct over plain http says so, and keeps the port', () => {
    const uri = encodePairingUri({ nonce: 'n', server: 'http://192.168.1.20:3000' });
    expect(uri).toBe('patch-pair://192.168.1.20:3000?nonce=n&s=http');
    expect(parsePairingUri(uri).server).toBe('http://192.168.1.20:3000');
  });

  it('relayed: no host, the relay, the channel and the server key travel instead', () => {
    const uri = encodePairingUri({
      nonce: 'n',
      relay: { url: 'wss://relay.example.com', channel: 'ch1', serverKey: 'KEY_abc-123' },
    });
    expect(uri.startsWith('patch-pair://?')).toBe(true);
    expect(parsePairingUri(uri)).toEqual({
      nonce: 'n',
      server: null,
      relay: { url: 'wss://relay.example.com', channel: 'ch1', serverKey: 'KEY_abc-123' },
    });
  });

  it('refuses to encode a payload that names neither a server nor a relay', () => {
    expect(() => encodePairingUri({ nonce: 'n' })).toThrow(/server nor a relay/);
  });

  it('refuses to encode one that names both — a scanner could not tell which to trust', () => {
    expect(() =>
      encodePairingUri({
        nonce: 'n',
        server: 'https://a.example',
        relay: { url: 'wss://r.example', channel: 'c', serverKey: 'k' },
      }),
    ).toThrow(/both/);
  });

  it.each([
    ['not a pairing code', /patch-pair/],
    ['{"nonce":"x"}', /patch-pair/],
    ['patch-pair://host.example', /nonce/],
    ['patch-pair://?nonce=n', /server nor a relay/],
    ['patch-pair://?nonce=n&relay=wss://r&ch=c', /server key/],
    ['patch-pair://?nonce=n&relay=https://r&ch=c&pk=k', /wss/],
    ['patch-pair://h.example?nonce=n&relay=wss://r&ch=c&pk=k', /both/],
  ])('rejects %s', (raw, why) => {
    expect(() => parsePairingUri(raw)).toThrow(why);
  });
});
