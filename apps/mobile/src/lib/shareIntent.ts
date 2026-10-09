// Pure resolver for the Android share-sheet payload (ACTION_SEND /
// ACTION_SEND_MULTIPLE — text, images, any file) bridged in via the native
// PatchShare module (plugins/withShareIntent.js). Kept standalone + pure so it
// is unit-testable without a native module — same convention as deepLink.ts's
// resolveDeepLink.

import { attachmentKindForMime } from '../stores/composerAttachmentStore';

/** One shared file, already copied into the app's cache by the native side. */
export interface SharedFile {
  uri: string;
  name: string;
  mimeType: string;
  kind: 'image' | 'file';
}

export interface SharedPayload {
  /** Shared text, or null when the share carried none (a bare photo). */
  text: string | null;
  files: SharedFile[];
}

/** What the native module hands over (older APKs send `{ text }` only). */
export interface NativeSharePayload {
  text?: string;
  files?: Array<{ uri?: string; name?: string; mimeType?: string }>;
  errors?: string[];
}

export interface ResolvedShare {
  /** Null when there is nothing to offer a destination for. */
  payload: SharedPayload | null;
  /** Streams the native side could not copy — each must be reported. */
  errors: string[];
}

/**
 * Blank/whitespace-only text is not a real share (some senders share an empty
 * selection). A file entry missing its uri is a bridge fault and is reported
 * rather than dropped (NO FALLBACK).
 */
export function resolveShare(payload: NativeSharePayload | null | undefined): ResolvedShare {
  const errors = [...(payload?.errors ?? [])];
  const text = payload?.text?.trim() || null;
  const files: SharedFile[] = [];
  for (const f of payload?.files ?? []) {
    if (!f.uri) {
      errors.push(`${f.name ?? 'a shared file'}: no file was handed over`);
      continue;
    }
    const mimeType = f.mimeType || 'application/octet-stream';
    files.push({
      uri: f.uri,
      name: f.name || 'shared file',
      mimeType,
      kind: attachmentKindForMime(mimeType),
    });
  }
  if (text === null && files.length === 0) return { payload: null, errors };
  return { payload: { text, files }, errors };
}
