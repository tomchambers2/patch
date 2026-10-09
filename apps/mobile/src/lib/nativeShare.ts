// Bridges the native PatchShare module (Android share sheet, ACTION_SEND /
// ACTION_SEND_MULTIPLE: text, images, files — see plugins/withShareIntent.js)
// into shareStore. Call
// `initShareIntent()` once at bootstrap, alongside the patch:// deep-link
// listener in app/_layout.tsx.
//
// NO FALLBACK: on Android the module is always present once this JS is
// running, because runtimeVersion was bumped in lockstep with the native
// change (app.config.ts) — this JS cannot reach a phone still on the APK
// built before PatchShareModule existed. On non-Android (tests, dev web)
// there is no share sheet to receive, so we no-op rather than throw.

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { resolveShare, type NativeSharePayload } from './shareIntent';
import { useShareStore } from '../stores/shareStore';
import { useUiStore } from '../stores/uiStore';

const MODULE_NAME = 'PatchShare';
const EVENT = 'PatchShareReceived';

interface PatchShareNativeModule {
  getInitialShare: () => Promise<NativeSharePayload | null>;
  addListener: (event: string) => void;
  removeListeners: (count: number) => void;
}

function getModule(): PatchShareNativeModule | null {
  if (Platform.OS !== 'android') return null;
  const mod = (NativeModules as Record<string, unknown>)[MODULE_NAME];
  if (!mod) {
    throw new Error(
      'PatchShare native module missing — is PatchSharePackage registered and the prebuild current?',
    );
  }
  return mod as PatchShareNativeModule;
}

function handlePayload(payload: NativeSharePayload | null | undefined): void {
  const { payload: shared, errors } = resolveShare(payload);
  // A file that could not be read is said out loud, by name — the rest of the
  // share still goes through (NO FALLBACK: never a silently shorter share).
  for (const e of errors) useUiStore.getState().pushError(`share: ${e}`);
  if (shared) useShareStore.getState().setPending(shared);
}

/**
 * Picks up a share that launched the app (cold start) and subscribes to
 * shares that arrive while it is already running. Both land in `shareStore`;
 * app/_layout.tsx watches it and routes to app/share.tsx.
 */
export function initShareIntent(): void {
  const mod = getModule();
  if (!mod) return;
  void mod.getInitialShare().then(handlePayload, (e: unknown) => {
    useUiStore.getState().pushError(`share: ${(e as Error).message}`);
  });
  const emitter = new NativeEventEmitter(NativeModules[MODULE_NAME]);
  emitter.addListener(EVENT, handlePayload);
}
