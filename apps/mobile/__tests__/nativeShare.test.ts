// lib/nativeShare.ts — JS bridge to the PatchShare native module (Android
// share sheet, ACTION_SEND text/plain). The native Kotlin side can't run
// under Node; this exercises the JS bridge: cold-start read, live event
// wiring, and the present/missing/non-Android branches — same convention as
// voiceMic.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Platform, NativeModules } from 'react-native';
import { useShareStore } from '../src/stores/shareStore';
import { useUiStore } from '../src/stores/uiStore';

beforeEach(() => {
  Platform.OS = 'test';
  delete NativeModules['PatchShare'];
  useShareStore.getState().clear();
  useUiStore.setState({ errors: [] });
});

describe('nativeShare — non-Android is a no-op', () => {
  it('initShareIntent does nothing (no NativeEventEmitter, no thrown error)', async () => {
    const { initShareIntent } = await import('../src/lib/nativeShare');
    expect(() => initShareIntent()).not.toThrow();
    expect(useShareStore.getState().pending).toBeNull();
  });
});

describe('nativeShare — Android, module missing (NO FALLBACK)', () => {
  it('initShareIntent throws', async () => {
    Platform.OS = 'android';
    const { initShareIntent } = await import('../src/lib/nativeShare');
    expect(() => initShareIntent()).toThrow(/native module missing/);
  });
});

describe('nativeShare — Android, module present', () => {
  function installModule(getInitialShare: () => Promise<Record<string, unknown> | null>): void {
    NativeModules['PatchShare'] = {
      getInitialShare: vi.fn(getInitialShare),
      addListener: vi.fn(),
      removeListeners: vi.fn(),
    };
  }

  it('a cold-start share lands in shareStore', async () => {
    Platform.OS = 'android';
    installModule(async () => ({ text: 'https://example.com' }));
    const { initShareIntent } = await import('../src/lib/nativeShare');
    initShareIntent();
    await vi.waitFor(() => {
      expect(useShareStore.getState().pending).toEqual({ text: 'https://example.com', files: [] });
    });
  });

  it('no cold-start share leaves shareStore untouched', async () => {
    Platform.OS = 'android';
    installModule(async () => null);
    const { initShareIntent } = await import('../src/lib/nativeShare');
    initShareIntent();
    // Let the promise settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(useShareStore.getState().pending).toBeNull();
  });

  it('a share arriving while already running reaches shareStore via the event', async () => {
    Platform.OS = 'android';
    installModule(async () => null);
    let emit: ((ev: unknown) => void) | undefined;
    const { NativeEventEmitter } = await import('react-native');
    const realAddListener = NativeEventEmitter.prototype.addListener;
    NativeEventEmitter.prototype.addListener = function (event: string, cb: (ev: unknown) => void) {
      emit = cb;
      return realAddListener.call(this, event, cb);
    };
    try {
      const { initShareIntent } = await import('../src/lib/nativeShare');
      initShareIntent();
      expect(emit).toBeDefined();
      emit!({ text: 'shared while open' });
      expect(useShareStore.getState().pending).toEqual({ text: 'shared while open', files: [] });
    } finally {
      NativeEventEmitter.prototype.addListener = realAddListener;
    }
  });

  it('a blank shared text via the event is ignored', async () => {
    Platform.OS = 'android';
    installModule(async () => null);
    let emit: ((ev: unknown) => void) | undefined;
    const { NativeEventEmitter } = await import('react-native');
    const realAddListener = NativeEventEmitter.prototype.addListener;
    NativeEventEmitter.prototype.addListener = function (event: string, cb: (ev: unknown) => void) {
      emit = cb;
      return realAddListener.call(this, event, cb);
    };
    try {
      const { initShareIntent } = await import('../src/lib/nativeShare');
      initShareIntent();
      emit!({ text: '   ' });
      expect(useShareStore.getState().pending).toBeNull();
    } finally {
      NativeEventEmitter.prototype.addListener = realAddListener;
    }
  });

  it('a cold-start share of files lands as attachments-to-be, and an uncopyable one is reported by name', async () => {
    Platform.OS = 'android';
    installModule(async () => ({
      files: [
        { uri: 'file:///cache/shared-in/1-a.jpg', name: 'a.jpg', mimeType: 'image/jpeg' },
        { uri: 'file:///cache/shared-in/2-b.pdf', name: 'b.pdf', mimeType: 'application/pdf' },
      ],
      errors: ['c.mov: permission denied'],
    }));
    const { initShareIntent } = await import('../src/lib/nativeShare');
    initShareIntent();
    await vi.waitFor(() => {
      expect(useShareStore.getState().pending).toEqual({
        text: null,
        files: [
          {
            uri: 'file:///cache/shared-in/1-a.jpg',
            name: 'a.jpg',
            mimeType: 'image/jpeg',
            kind: 'image',
          },
          {
            uri: 'file:///cache/shared-in/2-b.pdf',
            name: 'b.pdf',
            mimeType: 'application/pdf',
            kind: 'file',
          },
        ],
      });
    });
    expect(useUiStore.getState().errors.map((e) => e.message)).toContain(
      'share: c.mov: permission denied',
    );
  });

  it('a cold-start read the native side rejects is reported (NO FALLBACK)', async () => {
    Platform.OS = 'android';
    installModule(async () => {
      throw new Error('share_read_failed');
    });
    const { initShareIntent } = await import('../src/lib/nativeShare');
    initShareIntent();
    await vi.waitFor(() => {
      expect(useUiStore.getState().errors.map((e) => e.message)).toContain(
        'share: share_read_failed',
      );
    });
    expect(useShareStore.getState().pending).toBeNull();
  });
});
