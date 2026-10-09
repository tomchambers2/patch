import { generateKeyPairSync, verify, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  authorityOf,
  directoryResponse,
  parseWebBotAuthKey,
  signRequestHeaders,
} from '../src/web-bot-auth.js';

const der = generateKeyPairSync('ed25519')
  .privateKey.export({ type: 'pkcs8', format: 'der' })
  .toString('base64');
const key = parseWebBotAuthKey(der);
const DIR = 'https://patch.example/.well-known/http-message-signatures-directory';

function check(base: string, sigHeader: string): boolean {
  const sig = Buffer.from(/:(.+):/.exec(sigHeader)![1]!, 'base64');
  const pub = createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: key.jwk.x },
    format: 'jwk',
  });
  return verify(null, Buffer.from(base), pub, sig);
}

describe('parseWebBotAuthKey', () => {
  it('derives an RFC 7638 thumbprint keyid', () => {
    expect(key.keyId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(key.jwk).toMatchObject({ kty: 'OKP', crv: 'Ed25519' });
  });
  it('rejects garbage and non-ed25519 keys loudly', () => {
    expect(() => parseWebBotAuthKey('')).toThrow(/empty/);
    expect(() => parseWebBotAuthKey('not a key')).toThrow(/PKCS#8/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'der' })
      .toString('base64');
    expect(() => parseWebBotAuthKey(rsa)).toThrow(/ed25519/);
  });
});

describe('authorityOf', () => {
  it('keeps non-default ports and drops default ones', () => {
    expect(authorityOf('https://Example.com:443/x')).toBe('example.com');
    expect(authorityOf('http://example.com:8080/x')).toBe('example.com:8080');
  });
  it('refuses non-http schemes', () => {
    expect(() => authorityOf('data:text/plain,hi')).toThrow(/cannot sign/);
  });
});

describe('signRequestHeaders', () => {
  const now = () => 1_700_000_000_000;
  const nonce = () => 'bm9uY2U=';
  it('emits a verifiable RFC 9421 signature tagged web-bot-auth', () => {
    const h = signRequestHeaders('https://crawltest.com/cdn-cgi/web-bot-auth', key, DIR, {
      now,
      nonce,
    });
    expect(h['Signature-Agent']).toBe(`"${DIR}"`);
    const expectedParams =
      `("@authority" "signature-agent");created=1700000000;expires=1700000060;` +
      `keyid="${key.keyId}";alg="ed25519";nonce="bm9uY2U=";tag="web-bot-auth"`;
    expect(h['Signature-Input']).toBe(`sig1=${expectedParams}`);
    const base =
      `"@authority": crawltest.com\n"signature-agent": "${DIR}"\n` +
      `"@signature-params": ${expectedParams}`;
    expect(check(base, h['Signature']!)).toBe(true);
  });
  it('signs a different @authority per request', () => {
    const a = signRequestHeaders('https://a.example/', key, DIR, { now, nonce });
    const b = signRequestHeaders('https://b.example/', key, DIR, { now, nonce });
    expect(a['Signature']).not.toBe(b['Signature']);
  });
  it('uses a fresh nonce by default', () => {
    const a = signRequestHeaders('https://a.example/', key, DIR);
    const b = signRequestHeaders('https://a.example/', key, DIR);
    expect(a['Signature-Input']).not.toBe(b['Signature-Input']);
  });
});

describe('directoryResponse', () => {
  it('serves the JWKS and signs it over the request authority', () => {
    const r = directoryResponse('patch.example', key, { now: () => 1_700_000_000_000 });
    expect(JSON.parse(r.body)).toEqual({ keys: [key.jwk] });
    expect(r.headers['Content-Type']).toBe('application/http-message-signatures-directory+json');
    const params =
      `("@authority";req);created=1700000000;expires=1700000300;` +
      `keyid="${key.keyId}";alg="ed25519";tag="http-message-signatures-directory"`;
    expect(r.headers['Signature-Input']).toBe(`sig1=${params}`);
    const base = `"@authority";req: patch.example\n"@signature-params": ${params}`;
    expect(check(base, r.headers['Signature']!)).toBe(true);
  });
});
