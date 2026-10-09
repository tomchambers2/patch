// Unsent attachments, OWNED by the chat they were attached in (spec/14 §
// Composer), the same way `composerDraftStore` owns unsent text. <Composer> is
// remounted on every chat switch, so component state loses them; this store
// puts the right chat's files back. Keyed by chatId ("new" for a new chat).
// In-memory only: a File can't be persisted.

import { create } from 'zustand';

/** A file the user has attached but not yet sent. */
export interface PendingAttachment {
  /** Local key for React + removal (not the server id — that's minted on upload). */
  key: string;
  file: File;
  name: string;
  kind: 'image' | 'file';
  /** Object URL for the thumbnail preview (images only); revoked on removal. */
  previewUrl?: string;
}

interface ComposerAttachmentState {
  byChat: Record<string, PendingAttachment[]>;
  update(chatId: string, fn: (cur: PendingAttachment[]) => PendingAttachment[]): void;
  _reset(): void;
}

export const NO_ATTACHMENTS: PendingAttachment[] = [];

export const useComposerAttachmentStore = create<ComposerAttachmentState>((set) => ({
  byChat: {},
  update(chatId, fn) {
    set((s) => {
      const next = fn(s.byChat[chatId] ?? NO_ATTACHMENTS);
      const byChat = { ...s.byChat };
      if (next.length === 0) delete byChat[chatId];
      else byChat[chatId] = next;
      return { byChat };
    });
  },
  _reset() {
    set({ byChat: {} });
  },
}));
