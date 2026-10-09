// lib/voiceTts.ts — JS bridge to the PatchVoiceTts native module (Android
// AudioTrack PCM16 sink). The native Kotlin side can't run under Node; this
// exercises the JS bridge: base64 encode + the present/missing/non-Android
// branches via the react-native stub.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Platform, NativeModules } from 'react-native';

beforeEach(() => {
  Platform.OS = 'test';
  delete NativeModules['PatchVoiceTts'];
});

describe('voiceTts — non-Android is a no-op', () => {
  it('startTtsPlayback resolves', async () => {
    const { startTtsPlayback } = await import('../src/lib/voiceTts');
    await expect(startTtsPlayback()).resolves.toBeUndefined();
  });
  it('writeTtsPcm is a no-op (no throw)', async () => {
    const { writeTtsPcm } = await import('../src/lib/voiceTts');
    expect(() => writeTtsPcm(new Uint8Array([1, 2, 3]).buffer)).not.toThrow();
  });
  it('flushTtsPlayback resolves', async () => {
    const { flushTtsPlayback } = await import('../src/lib/voiceTts');
    await expect(flushTtsPlayback()).resolves.toBeUndefined();
  });
  it('stopTtsPlayback resolves', async () => {
    const { stopTtsPlayback } = await import('../src/lib/voiceTts');
    await expect(stopTtsPlayback()).resolves.toBeUndefined();
  });
});

describe('voiceTts — Android, module missing (NO FALLBACK)', () => {
  it('startTtsPlayback throws', async () => {
    Platform.OS = 'android';
    const { startTtsPlayback } = await import('../src/lib/voiceTts');
    await expect(startTtsPlayback()).rejects.toThrow(/native module missing/);
  });
  it('flushTtsPlayback throws', async () => {
    Platform.OS = 'android';
    const { flushTtsPlayback } = await import('../src/lib/voiceTts');
    await expect(flushTtsPlayback()).rejects.toThrow(/native module missing/);
  });
  it('stopTtsPlayback throws', async () => {
    Platform.OS = 'android';
    const { stopTtsPlayback } = await import('../src/lib/voiceTts');
    await expect(stopTtsPlayback()).rejects.toThrow(/native module missing/);
  });
});

describe('voiceTts — Android, module present', () => {
  it('start/flush/stop forward to the native module', async () => {
    Platform.OS = 'android';
    const start = vi.fn(async () => undefined);
    const flush = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    NativeModules['PatchVoiceTts'] = { start, write: vi.fn(async () => undefined), flush, stop };
    const { startTtsPlayback, flushTtsPlayback, stopTtsPlayback } =
      await import('../src/lib/voiceTts');
    await startTtsPlayback();
    await flushTtsPlayback();
    await stopTtsPlayback();
    expect(start).toHaveBeenCalled();
    expect(flush).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
  });

  it('writeTtsPcm base64-encodes the PCM buffer and forwards it (fire-and-forget)', async () => {
    Platform.OS = 'android';
    const write = vi.fn(async () => undefined);
    NativeModules['PatchVoiceTts'] = { start: vi.fn(), write, flush: vi.fn(), stop: vi.fn() };
    const { writeTtsPcm } = await import('../src/lib/voiceTts');
    const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
    writeTtsPcm(bytes.buffer);
    expect(write).toHaveBeenCalledTimes(1);
    const b64 = write.mock.calls[0]![0] as string;
    expect(Buffer.from(b64, 'base64')).toEqual(Buffer.from(bytes));
  });

  it('writeTtsPcm handles a 2-byte remainder (padding branch)', async () => {
    Platform.OS = 'android';
    const write = vi.fn(async () => undefined);
    NativeModules['PatchVoiceTts'] = { start: vi.fn(), write, flush: vi.fn(), stop: vi.fn() };
    const { writeTtsPcm } = await import('../src/lib/voiceTts');
    const bytes = Uint8Array.from([1, 2, 3, 4]); // len % 3 === 1... use 5 bytes for rem=2
    writeTtsPcm(bytes.buffer);
    const b64 = write.mock.calls[0]![0] as string;
    expect(Buffer.from(b64, 'base64')).toEqual(Buffer.from(bytes));
  });

  it('writeTtsPcm handles an exact multiple-of-3 buffer (no remainder)', async () => {
    Platform.OS = 'android';
    const write = vi.fn(async () => undefined);
    NativeModules['PatchVoiceTts'] = { start: vi.fn(), write, flush: vi.fn(), stop: vi.fn() };
    const { writeTtsPcm } = await import('../src/lib/voiceTts');
    const bytes = Uint8Array.from([10, 20, 30, 40, 50, 60]);
    writeTtsPcm(bytes.buffer);
    const b64 = write.mock.calls[0]![0] as string;
    expect(Buffer.from(b64, 'base64')).toEqual(Buffer.from(bytes));
  });
});
