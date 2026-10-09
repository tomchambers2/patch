// Regression: Kokoro real-backend PCM16 frame decode must be byte-offset-safe.
//
// The ws library with permessage-deflate delivers inflated binary frames as
// Buffers that are slices of Node's shared internal buffer pool. Such a Buffer
// can land at an ODD `byteOffset`. The original handler did
// `new Int16Array(data.buffer, data.byteOffset, ...)`, which throws an
// uncaught `RangeError: start offset of Int16Array should be a multiple of 2`
// for odd offsets — crashing the host non-deterministically mid-TTS.
//
// These tests pin both:
//   1. The exact decode is offset-safe (deterministic, no pool luck needed).
//   2. A full real-backend round-trip over a permessage-deflate WS streaming
//      many small PCM frames decodes every frame without throwing.

import { describe, test, expect } from 'vitest';
import pino from 'pino';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { createKokoro } from '../src/audio/kokoro.js';

const logger = pino({ level: 'silent' });

// Mirrors the decode in kokoro.ts onBinary. Kept here so a regression in the
// product code can't quietly weaken this guarantee.
function decodePcmFrame(data: Buffer): Int16Array {
  const pcm = new Int16Array(data.byteLength >>> 1);
  const bytes = new Uint8Array(pcm.buffer);
  bytes.set(data);
  return pcm;
}

describe('PCM16 frame decode is byte-offset-safe', () => {
  test('decodes a Buffer at an ODD byteOffset without throwing', () => {
    // Build a backing ArrayBuffer and take a sub-Buffer starting at offset 1
    // (odd), exactly as permessage-deflate can hand to onBinary.
    const samples = [1, -2, 3, -4, 1000, -1000];
    const backing = new ArrayBuffer(1 + samples.length * 2);
    const dv = new DataView(backing);
    samples.forEach((s, i) => dv.setInt16(1 + i * 2, s, true /* little-endian */));
    const odd = Buffer.from(backing, 1, samples.length * 2);
    expect(odd.byteOffset % 2).toBe(1); // precondition: odd offset

    let pcm!: Int16Array;
    expect(() => {
      pcm = decodePcmFrame(odd);
    }).not.toThrow();
    expect(Array.from(pcm)).toEqual(samples);
  });

  test('decodes a Buffer at an EVEN byteOffset identically', () => {
    const samples = [7, -7, 32767, -32768];
    const backing = new ArrayBuffer(samples.length * 2);
    const dv = new DataView(backing);
    samples.forEach((s, i) => dv.setInt16(i * 2, s, true));
    const even = Buffer.from(backing, 0, samples.length * 2);
    const pcm = decodePcmFrame(even);
    expect(Array.from(pcm)).toEqual(samples);
  });
});

describe('RealKokoroBackend over permessage-deflate WS', () => {
  test('streams many PCM frames back without crashing on odd offsets', async () => {
    // A fake sidecar that compresses (permessage-deflate) and streams many
    // small binary PCM frames followed by {end:true}. Sending many frames
    // forces the receiving ws layer to allocate inflated payloads at varied
    // (including odd) byteOffsets in Node's shared buffer pool.
    const wss = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      perMessageDeflate: true,
    });
    const port = await new Promise<number>((resolve) => {
      wss.on('listening', () => resolve((wss.address() as AddressInfo).port));
    });

    const FRAME_COUNT = 500;
    const SAMPLES_PER_FRAME = 240; // 10ms @ 24kHz
    wss.on('connection', (sock: WebSocket) => {
      sock.on('message', (raw: Buffer | string, isBinary: boolean) => {
        if (isBinary) return;
        const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')) as {
          requestId?: string;
          text?: string;
        };
        if (typeof msg.text !== 'string') return;
        for (let f = 0; f < FRAME_COUNT; f++) {
          const buf = Buffer.alloc(SAMPLES_PER_FRAME * 2);
          for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
            buf.writeInt16LE(((f + i) % 1000) - 500, i * 2);
          }
          sock.send(buf, { binary: true, compress: true });
        }
        sock.send(JSON.stringify({ requestId: msg.requestId, end: true }));
      });
    });

    const k = createKokoro({
      backend: 'real',
      logger,
      sidecarUrl: `ws://127.0.0.1:${port}`,
    });
    try {
      const synth = await k.synthesize('hello world');
      let count = 0;
      let totalSamples = 0;
      for await (const c of synth.iterator) {
        expect(c.pcm).toBeInstanceOf(Int16Array);
        expect(c.pcm.length).toBe(SAMPLES_PER_FRAME);
        if (count === 0) expect(c.first).toBe(true);
        else expect(c.first).toBe(false);
        count++;
        totalSamples += c.pcm.length;
      }
      expect(count).toBe(FRAME_COUNT);
      expect(totalSamples).toBe(FRAME_COUNT * SAMPLES_PER_FRAME);
    } finally {
      await k.close();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  }, 20000);
});
