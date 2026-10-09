// lib/nativePaste.ts — JS bridge to the PatchPaste native module (image paste
// + keyboard image insertion into the composer input). The Kotlin listener
// can't run under Node; this exercises the bridge: attach by React tag, the
// event → handler wiring, per-input filtering, and every error path.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Platform, NativeModules, NativeEventEmitter } from 'react-native';
import { receiveImagePaste } from '../src/lib/nativePaste';

type Cb = (ev: unknown) => void;
let emit: Cb | undefined;
let removed = 0;
const realAddListener = NativeEventEmitter.prototype.addListener;

beforeEach(() => {
  Platform.OS = 'test';
  delete NativeModules['PatchPaste'];
  emit = undefined;
  removed = 0;
  NativeEventEmitter.prototype.addListener = function (event: string, cb: Cb) {
    expect(event).toBe('PatchPasteReceived');
    emit = cb;
    const sub = realAddListener.call(this, event, cb);
    return {
      remove: (): void => {
        removed++;
        sub.remove();
      },
    };
  };
});
afterEach(() => {
  NativeEventEmitter.prototype.addListener = realAddListener;
  Platform.OS = 'test';
});

function install(
  attach: (tag: number) => Promise<void> = async () => {},
): ReturnType<typeof vi.fn> {
  const fn = vi.fn(attach);
  NativeModules['PatchPaste'] = { attach: fn, addListener: vi.fn(), removeListeners: vi.fn() };
  return fn;
}
function handlers() {
  return { onImages: vi.fn(), onError: vi.fn() };
}
const input = {};

describe('nativePaste', () => {
  it('is a no-op off Android', () => {
    const h = handlers();
    const off = receiveImagePaste(input, h);
    off();
    expect(emit).toBeUndefined();
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('a missing module on Android is an error, not a text-only input (NO FALLBACK)', () => {
    Platform.OS = 'android';
    const h = handlers();
    receiveImagePaste(input, h);
    expect(h.onError).toHaveBeenCalledWith(
      expect.stringMatching(/PatchPaste native module missing/),
    );
  });

  it('an input with no native view is an error', () => {
    Platform.OS = 'android';
    const attach = install();
    const h = handlers();
    receiveImagePaste(null, h);
    expect(attach).not.toHaveBeenCalled();
    expect(h.onError).toHaveBeenCalledWith('image paste: the message input has no native view');
  });

  it('attaches by React tag and hands images for that input over', () => {
    Platform.OS = 'android';
    const attach = install();
    const h = handlers();
    const off = receiveImagePaste(input, h);
    expect(attach).toHaveBeenCalledTimes(1);
    const tag = attach.mock.calls[0]![0] as number;
    expect(typeof tag).toBe('number');
    const files = [
      {
        uri: 'file:///c/pasted-in/1-a.png',
        name: 'a.png',
        mimeType: 'image/png',
        width: 10,
        height: 20,
      },
    ];
    emit!({ tag, files, errors: [] });
    expect(h.onImages).toHaveBeenCalledWith(files);
    expect(h.onError).not.toHaveBeenCalled();
    off();
    expect(removed).toBe(1);
  });

  it('ignores images pasted into a different input', () => {
    Platform.OS = 'android';
    const attach = install();
    const h = handlers();
    receiveImagePaste(input, h);
    const tag = attach.mock.calls[0]![0] as number;
    emit!({ tag: tag + 1000, files: [{ uri: 'u', name: 'n', mimeType: 'image/gif' }], errors: [] });
    expect(h.onImages).not.toHaveBeenCalled();
  });

  it('an image that could not be copied is reported by name; the rest still land', () => {
    Platform.OS = 'android';
    const attach = install();
    const h = handlers();
    receiveImagePaste(input, h);
    const tag = attach.mock.calls[0]![0] as number;
    emit!({ tag, files: [], errors: ['sticker.webp: permission denied'] });
    expect(h.onError).toHaveBeenCalledWith('paste image failed: sticker.webp: permission denied');
    expect(h.onImages).not.toHaveBeenCalled();
  });

  it('a failed attach is an error', async () => {
    Platform.OS = 'android';
    install(async () => {
      throw new Error('view 7 is a ReactViewGroup, not an EditText');
    });
    const h = handlers();
    receiveImagePaste(input, h);
    await vi.waitFor(() =>
      expect(h.onError).toHaveBeenCalledWith(
        'image paste unavailable: view 7 is a ReactViewGroup, not an EditText',
      ),
    );
  });
});
