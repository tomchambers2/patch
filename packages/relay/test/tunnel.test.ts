import { describe, expect, it } from 'vitest';
import { MAX_PLAINTEXT } from '../src/crypto.js';
import {
  carriedHeaders,
  chunks,
  decodeMessage,
  encodeMessage,
  MAX_CHUNK,
  Msg,
  json,
  parseJson,
} from '../src/tunnel.js';

describe('tunnel messages', () => {
  it('round-trip type, stream and payload', () => {
    const m = decodeMessage(encodeMessage(Msg.ResBody, 0xfffffffe, Uint8Array.of(1, 2, 3)));
    expect(m.type).toBe(Msg.ResBody);
    expect(m.stream).toBe(0xfffffffe);
    expect(Array.from(m.payload)).toEqual([1, 2, 3]);
  });

  it('read a header off a view that does not start at zero', () => {
    const backing = new Uint8Array(20);
    backing.set(encodeMessage(Msg.WsText, 7, Uint8Array.of(9)), 4);
    const m = decodeMessage(backing.subarray(4, 4 + 6));
    expect([m.type, m.stream, Array.from(m.payload)]).toEqual([Msg.WsText, 7, [9]]);
  });

  it('refuse a message with no header', () => {
    expect(() => decodeMessage(new Uint8Array(3))).toThrow(/header/);
  });

  it('carry JSON payloads', () => {
    expect(parseJson<{ a: string }>(json({ a: 'é✓' }))).toEqual({ a: 'é✓' });
  });
});

describe('chunking', () => {
  it('splits a body so every message fits one transport frame', () => {
    const body = new Uint8Array(MAX_CHUNK * 2 + 10);
    const parts = [...chunks(body)];
    expect(parts.map((p) => p.length)).toEqual([MAX_CHUNK, MAX_CHUNK, 10]);
    for (const p of parts)
      expect(encodeMessage(Msg.ReqBody, 1, p).length).toBeLessThanOrEqual(MAX_PLAINTEXT);
  });

  it('yields nothing for an empty body', () => {
    expect([...chunks(new Uint8Array(0))]).toEqual([]);
  });
});

describe('headers', () => {
  it('lower-cases names and drops what describes one hop', () => {
    expect(
      carriedHeaders([
        ['Authorization', 'Bearer x'],
        ['Content-Type', 'application/json'],
        ['Host', 'evil.example'],
        ['Connection', 'keep-alive'],
        ['Content-Length', '12'],
        ['Transfer-Encoding', 'chunked'],
        ['Upgrade', 'websocket'],
        ['Accept-Encoding', 'gzip'],
      ]),
    ).toEqual({ authorization: 'Bearer x', 'content-type': 'application/json' });
  });
});
