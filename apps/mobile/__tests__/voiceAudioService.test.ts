// lib/voiceAudioService.ts — JS bridge to the PatchVoiceAudioService native
// module. The Kotlin implementation under android/ cannot run under Node;
// this is the pure-JS bridge layer that decides WHETHER to call it, and it
// IS fully testable by faking Platform.OS + NativeModules the way the app's
// own `getModule()` reads them.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Platform, NativeModules } from 'react-native';

beforeEach(() => {
  Platform.OS = 'test';
  delete NativeModules['PatchVoiceAudioService'];
});

describe('voiceAudioService — non-Android is a no-op', () => {
  it('startVoiceAudioService no-ops off-Android', async () => {
    const { startVoiceAudioService } = await import('../src/lib/voiceAudioService');
    await expect(startVoiceAudioService('chat')).resolves.toBeUndefined();
  });

  it('stopVoiceAudioService no-ops off-Android', async () => {
    const { stopVoiceAudioService } = await import('../src/lib/voiceAudioService');
    await expect(stopVoiceAudioService()).resolves.toBeUndefined();
  });
});

describe('voiceAudioService — Android, module missing (NO FALLBACK)', () => {
  it('start throws when the native module is not registered', async () => {
    Platform.OS = 'android';
    const { startVoiceAudioService } = await import('../src/lib/voiceAudioService');
    await expect(startVoiceAudioService('chat')).rejects.toThrow(/native module missing/);
  });

  it('stop throws when the native module is not registered', async () => {
    Platform.OS = 'android';
    const { stopVoiceAudioService } = await import('../src/lib/voiceAudioService');
    await expect(stopVoiceAudioService()).rejects.toThrow(/native module missing/);
  });
});

describe('voiceAudioService — Android, module present', () => {
  it('start forwards the chat name to the native start()', async () => {
    Platform.OS = 'android';
    const start = vi.fn(async () => undefined);
    NativeModules['PatchVoiceAudioService'] = { start, stop: vi.fn(async () => undefined) };
    const { startVoiceAudioService } = await import('../src/lib/voiceAudioService');
    await startVoiceAudioService('Manager', 'hands-free');
    // The notification names the mode it is running in (spec/15 § Voice tab).
    expect(start).toHaveBeenCalledWith('Manager', 'hands-free', false);
  });

  it('start forwards a null chat name', async () => {
    Platform.OS = 'android';
    const start = vi.fn(async () => undefined);
    NativeModules['PatchVoiceAudioService'] = { start, stop: vi.fn(async () => undefined) };
    const { startVoiceAudioService } = await import('../src/lib/voiceAudioService');
    await startVoiceAudioService(null, 'call');
    expect(start).toHaveBeenCalledWith(null, 'call', false);
  });

  it('update re-renders the notification for a session already running', async () => {
    Platform.OS = 'android';
    const update = vi.fn(async () => undefined);
    NativeModules['PatchVoiceAudioService'] = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      update,
    };
    const { updateVoiceAudioService } = await import('../src/lib/voiceAudioService');
    await updateVoiceAudioService('Manager', 'call', true);
    expect(update).toHaveBeenCalledWith('Manager', 'call', true);
  });

  it('stop calls the native stop()', async () => {
    Platform.OS = 'android';
    const stop = vi.fn(async () => undefined);
    NativeModules['PatchVoiceAudioService'] = { start: vi.fn(async () => undefined), stop };
    const { stopVoiceAudioService } = await import('../src/lib/voiceAudioService');
    await stopVoiceAudioService();
    expect(stop).toHaveBeenCalled();
  });
});
