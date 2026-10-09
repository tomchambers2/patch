// lib/voiceMic.ts — JS bridge to the PatchVoiceMic native module (Android
// AudioRecord PCM16 tap). The native Kotlin side can't run under Node; this
// exercises the JS bridge: base64 decode, event wiring, and the
// present/missing/non-Android branches via the react-native stub.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Platform, NativeModules } from 'react-native';

beforeEach(() => {
  Platform.OS = 'test';
  delete NativeModules['PatchVoiceMic'];
});

describe('voiceMic — non-Android is a no-op', () => {
  it('startMicCapture resolves without touching NativeEventEmitter', async () => {
    const { startMicCapture } = await import('../src/lib/voiceMic');
    const onFrame = vi.fn();
    const onError = vi.fn();
    await startMicCapture(onFrame, onError);
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('stopMicCapture resolves (idempotent, no subscription to drop)', async () => {
    const { stopMicCapture } = await import('../src/lib/voiceMic');
    await expect(stopMicCapture()).resolves.toBeUndefined();
  });
});

describe('voiceMic — Android, module missing (NO FALLBACK)', () => {
  it('startMicCapture throws', async () => {
    Platform.OS = 'android';
    const { startMicCapture } = await import('../src/lib/voiceMic');
    await expect(startMicCapture(vi.fn(), vi.fn())).rejects.toThrow(/native module missing/);
  });

  it('stopMicCapture throws (still calls stop() on the missing module)', async () => {
    Platform.OS = 'android';
    const { stopMicCapture } = await import('../src/lib/voiceMic');
    await expect(stopMicCapture()).rejects.toThrow(/native module missing/);
  });
});

describe('voiceMic — Android, module present', () => {
  it('decodes a base64 PCM16 frame and hands it to onFrame as an Int16Array', async () => {
    Platform.OS = 'android';
    let emit: ((ev: unknown) => void) | undefined;
    NativeModules['PatchVoiceMic'] = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      addListener: vi.fn(),
      removeListeners: vi.fn(),
    };
    // The module bridges via `new NativeEventEmitter(m)`; our stub's
    // NativeEventEmitter is a real (if fake) event bus, so capture the
    // registered callback by wrapping addListener on the RN stub itself is
    // unnecessary — instead we drive it through the real NativeEventEmitter
    // class the app imports, by importing it directly here.
    const { NativeEventEmitter } = await import('react-native');
    const realAddListener = NativeEventEmitter.prototype.addListener;
    NativeEventEmitter.prototype.addListener = function (event: string, cb: (ev: unknown) => void) {
      emit = cb;
      return realAddListener.call(this, event, cb);
    };
    try {
      const { startMicCapture } = await import('../src/lib/voiceMic');
      const onFrame = vi.fn();
      const onError = vi.fn();
      await startMicCapture(onFrame, onError);
      expect(emit).toBeDefined();
      // Two PCM16 samples (4 bytes): 0x0102 and 0x0304 little-endian-ish via
      // our base64 table decode — just assert SOME Int16Array of length 2
      // reaches onFrame, decoded from a real base64 payload.
      const bytes = Uint8Array.from([1, 2, 3, 4]);
      const b64 = Buffer.from(bytes).toString('base64');
      emit!({ base64: b64, samples: 2 });
      expect(onFrame).toHaveBeenCalledTimes(1);
      const pcm = onFrame.mock.calls[0]![0] as Int16Array;
      expect(pcm).toBeInstanceOf(Int16Array);
      expect(pcm.length).toBe(2);
      expect(onError).not.toHaveBeenCalled();
    } finally {
      NativeEventEmitter.prototype.addListener = realAddListener;
    }
  });

  it('surfaces a native mid-stream error via onError, not onFrame', async () => {
    Platform.OS = 'android';
    let emit: ((ev: unknown) => void) | undefined;
    NativeModules['PatchVoiceMic'] = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      addListener: vi.fn(),
      removeListeners: vi.fn(),
    };
    const { NativeEventEmitter } = await import('react-native');
    const realAddListener = NativeEventEmitter.prototype.addListener;
    NativeEventEmitter.prototype.addListener = function (event: string, cb: (ev: unknown) => void) {
      emit = cb;
      return realAddListener.call(this, event, cb);
    };
    try {
      const { startMicCapture } = await import('../src/lib/voiceMic');
      const onFrame = vi.fn();
      const onError = vi.fn();
      await startMicCapture(onFrame, onError);
      emit!({ error: 'AudioRecord read failed' });
      expect(onError).toHaveBeenCalledWith('AudioRecord read failed');
      expect(onFrame).not.toHaveBeenCalled();
    } finally {
      NativeEventEmitter.prototype.addListener = realAddListener;
    }
  });

  it('ignores a frame event with neither error nor base64', async () => {
    Platform.OS = 'android';
    let emit: ((ev: unknown) => void) | undefined;
    NativeModules['PatchVoiceMic'] = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      addListener: vi.fn(),
      removeListeners: vi.fn(),
    };
    const { NativeEventEmitter } = await import('react-native');
    const realAddListener = NativeEventEmitter.prototype.addListener;
    NativeEventEmitter.prototype.addListener = function (event: string, cb: (ev: unknown) => void) {
      emit = cb;
      return realAddListener.call(this, event, cb);
    };
    try {
      const { startMicCapture } = await import('../src/lib/voiceMic');
      const onFrame = vi.fn();
      const onError = vi.fn();
      await startMicCapture(onFrame, onError);
      emit!({});
      expect(onFrame).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      NativeEventEmitter.prototype.addListener = realAddListener;
    }
  });

  it('stopMicCapture drops the subscription and calls native stop()', async () => {
    Platform.OS = 'android';
    const stop = vi.fn(async () => undefined);
    NativeModules['PatchVoiceMic'] = {
      start: vi.fn(async () => undefined),
      stop,
      addListener: vi.fn(),
      removeListeners: vi.fn(),
    };
    const { startMicCapture, stopMicCapture } = await import('../src/lib/voiceMic');
    await startMicCapture(vi.fn(), vi.fn());
    await stopMicCapture();
    expect(stop).toHaveBeenCalled();
    // Idempotent — a second stop with no subscription left must not throw.
    await expect(stopMicCapture()).resolves.toBeUndefined();
  });
});
