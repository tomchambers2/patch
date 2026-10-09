// Image paste into the composer (spec/15 § Composer — "Paste"): the JS half of
// the PatchPaste native module (plugins/withImagePaste.js,
// plugins/native/PatchPasteModule.kt).
//
// RN 0.76's Android TextInput has no paste event, so the composer hands its
// input's React tag to the module, which installs an androidx
// OnReceiveContentListener for image types on that EditText. From then on a
// long-press → Paste of a clipboard image AND a keyboard's image insertion
// (Gboard GIFs, stickers) arrive here as a `PatchPasteReceived` event, already
// copied into the app's cache. Text paste never comes here — the listener
// hands it back to the input, which pastes it as plain text as it always has.
//
// NO FALLBACK: on Android the module is always present once this JS runs,
// because runtimeVersion was bumped to 0.1.3 with it (app.config.ts). A
// missing module or a failed attach is an error, not a quietly text-only
// input. Off Android (tests, dev web) there is nothing to attach to.

import { findNodeHandle, NativeEventEmitter, NativeModules, Platform } from 'react-native';

const MODULE_NAME = 'PatchPaste';
const EVENT = 'PatchPasteReceived';

export interface PastedImage {
  /** file:// copy in the app's cache. */
  uri: string;
  name: string;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface NativePastePayload {
  /** React tag of the input the image was pasted into. */
  tag: number;
  files: PastedImage[];
  /** One line per image that could not be copied, naming it. */
  errors: string[];
}

interface PatchPasteNativeModule {
  attach: (tag: number) => Promise<void>;
  addListener: (event: string) => void;
  removeListeners: (count: number) => void;
}

function getModule(): PatchPasteNativeModule | null {
  if (Platform.OS !== 'android') return null;
  const mod = (NativeModules as Record<string, unknown>)[MODULE_NAME];
  if (!mod) {
    throw new Error(
      'PatchPaste native module missing — is PatchPastePackage registered and the prebuild current?',
    );
  }
  return mod as PatchPasteNativeModule;
}

export interface ImagePasteHandlers {
  onImages: (files: PastedImage[]) => void;
  onError: (message: string) => void;
}

/**
 * Take image paste + keyboard image insertion on `input`. Returns the
 * unsubscribe. Every failure — no module, no native view, a failed attach, an
 * image that could not be copied — goes to `onError`.
 */
export function receiveImagePaste(input: unknown, handlers: ImagePasteHandlers): () => void {
  let mod: PatchPasteNativeModule | null;
  try {
    mod = getModule();
  } catch (e) {
    handlers.onError((e as Error).message);
    return () => {};
  }
  if (!mod) return () => {};
  const tag = findNodeHandle(input as Parameters<typeof findNodeHandle>[0]);
  if (tag == null) {
    handlers.onError('image paste: the message input has no native view');
    return () => {};
  }
  const emitter = new NativeEventEmitter(NativeModules[MODULE_NAME]);
  const sub = emitter.addListener(EVENT, (ev: unknown) => {
    const p = ev as NativePastePayload;
    if (p.tag !== tag) return;
    for (const e of p.errors) handlers.onError(`paste image failed: ${e}`);
    if (p.files.length > 0) handlers.onImages(p.files);
  });
  mod.attach(tag).catch((e: unknown) => {
    handlers.onError(`image paste unavailable: ${(e as Error).message}`);
  });
  return () => sub.remove();
}
