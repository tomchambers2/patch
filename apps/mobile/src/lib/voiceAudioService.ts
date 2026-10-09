// JS bridge to the Android VoiceAudioService foreground service.
//
// The service's notification is the control surface for a phone the user is not
// looking at (spec/15 § Voice tab), so this bridge is two-way: JS pushes the
// session's mode and mute state into the notification, and the notification's
// own buttons come back as `PatchVoiceAudioAction` events.
//
// NO FALLBACK: if the native module is missing on Android we throw —
// that means the prebuild didn't include PatchVoiceAudioServicePackage
// and a release build would silently lose the foreground notification.
// On non-Android (test, dev web) we no-op.

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type { AudioSessionMode } from '@patch/wire/audio';

/** What the notification's buttons ask JS to do. */
export type VoiceServiceAction = 'mute' | 'mode' | 'stop';

interface PatchVoiceAudioServiceModule {
  start: (chatName: string | null, mode: string, muted: boolean) => Promise<void>;
  update: (chatName: string | null, mode: string, muted: boolean) => Promise<void>;
  stop: () => Promise<void>;
}

function getModule(): PatchVoiceAudioServiceModule | null {
  if (Platform.OS !== 'android') return null;
  const mod = (NativeModules as Record<string, unknown>)['PatchVoiceAudioService'];
  if (!mod) {
    throw new Error(
      'PatchVoiceAudioService native module missing — is the package registered in MainApplication.kt?',
    );
  }
  return mod as PatchVoiceAudioServiceModule;
}

export async function startVoiceAudioService(
  chatName: string | null,
  mode: AudioSessionMode,
  muted = false,
): Promise<void> {
  const m = getModule();
  if (!m) return;
  await m.start(chatName, mode, muted);
}

/** Re-render the notification for a session that is already running. */
export async function updateVoiceAudioService(
  chatName: string | null,
  mode: AudioSessionMode,
  muted: boolean,
): Promise<void> {
  const m = getModule();
  if (!m) return;
  await m.update(chatName, mode, muted);
}

export async function stopVoiceAudioService(): Promise<void> {
  const m = getModule();
  if (!m) return;
  await m.stop();
}

/**
 * Subscribe to the notification's own button presses. Returns an unsubscribe.
 * A no-op off Android, where there is no notification to press.
 */
export function onVoiceServiceAction(handler: (action: VoiceServiceAction) => void): () => void {
  if (Platform.OS !== 'android') return () => {};
  const mod = (NativeModules as Record<string, unknown>)['PatchVoiceAudioService'];
  if (!mod) return () => {};
  const emitter = new NativeEventEmitter(mod as never);
  const sub = emitter.addListener('PatchVoiceAudioAction', (action: string) => {
    if (action === 'mute' || action === 'mode' || action === 'stop') handler(action);
  });
  return () => sub.remove();
}
