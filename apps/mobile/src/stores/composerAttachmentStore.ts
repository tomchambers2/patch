// Attachments waiting in a composer, keyed by the composer's draft key (a
// chatId, or the new-chat key — see `NEW_CHAT_DRAFT_KEY` in lib/newChat.ts).
//
// The composer used to hold these in component state, which left nothing
// outside it able to put a file INTO a composer. The share sheet needs exactly
// that (spec/15 § Share into Patch): a shared image or file lands as an
// ordinary attachment chip in the chosen chat's composer, the same chip the
// composer's own pickers make, going through the same downscale + upload on
// send. Keeping them here — reactive, per key — means a composer that is
// already mounted picks the chips up the moment they are added.
//
// In-memory only, unlike the text draft (lib/composerDraft.ts): the uris are
// cache files and picker handles that don't outlive the process anyway.

import { create } from 'zustand';

/** A file attached to a composer but not yet sent. */
export interface PendingAttachment {
  key: string;
  uri: string;
  name: string;
  mimeType: string;
  kind: 'image' | 'file';
  /** Pixel dimensions when known (image picker) — lets the resize skip a probe. */
  width?: number;
  height?: number;
}

interface ComposerAttachmentState {
  byKey: Record<string, PendingAttachment[]>;
  add(key: string, items: PendingAttachment[]): void;
  remove(key: string, attachmentKey: string): void;
  clear(key: string): void;
  _reset(): void;
}

/** A stable empty list, so a selector for a key with nothing never re-renders. */
export const NO_ATTACHMENTS: PendingAttachment[] = [];

export const useComposerAttachmentStore = create<ComposerAttachmentState>((set) => ({
  byKey: {},
  add(key, items) {
    if (items.length === 0) return;
    set((s) => ({ byKey: { ...s.byKey, [key]: [...(s.byKey[key] ?? []), ...items] } }));
  },
  remove(key, attachmentKey) {
    set((s) => ({
      byKey: {
        ...s.byKey,
        [key]: (s.byKey[key] ?? []).filter((a) => a.key !== attachmentKey),
      },
    }));
  },
  clear(key) {
    set((s) => {
      const next = { ...s.byKey };
      delete next[key];
      return { byKey: next };
    });
  },
  _reset() {
    set({ byKey: {} });
  },
}));

let seq = 0;
/** A unique chip key. */
export function newAttachmentKey(): string {
  seq += 1;
  return `att-${Date.now()}-${seq}`;
}

/** Which chip a MIME type draws: a thumbnail for images, a file glyph otherwise. */
export function attachmentKindForMime(mime: string): 'image' | 'file' {
  return mime.toLowerCase().startsWith('image/') ? 'image' : 'file';
}
