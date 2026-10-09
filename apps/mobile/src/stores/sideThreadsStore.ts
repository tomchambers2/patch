// sideThreadsStore — mobile's side-thread tab bookkeeping (spec/15 § Side
// threads screen). Mirrors web's `sideThreadsStore.ts`, minus the panel
// open/close state: on mobile the "panel" IS the pushed screen
// (`app/chats/[chatId]/threads.tsx`), so there is nothing to open/close here,
// only which tab is active and the trigger's not-yet-sent draft.

import { create } from 'zustand';

/** Sentinel "tab" for a side thread triggered but not sent yet — mirrors web. */
export const DRAFT_TAB_ID = '__side-thread-draft__';

export interface SideThreadDraft {
  seq: number;
  quotedMessage: string;
  fromBranchId?: string;
}

interface SideThreadsState {
  activeTabByChatId: Record<string, string>;
  pendingNewTab: Record<string, boolean>;
  draftByChatId: Record<string, SideThreadDraft>;
  expectNewTab(chatId: string): void;
  openThread(chatId: string, branchId: string): void;
  openDraft(chatId: string, draft: SideThreadDraft): void;
  closeDraft(chatId: string): void;
  setActiveTab(chatId: string, branchId: string): void;
}

export const useSideThreadsStore = create<SideThreadsState>((set) => ({
  activeTabByChatId: {},
  pendingNewTab: {},
  draftByChatId: {},
  expectNewTab(chatId) {
    set((s) => ({ pendingNewTab: { ...s.pendingNewTab, [chatId]: true } }));
  },
  openThread(chatId, branchId) {
    set((s) => {
      const { [chatId]: _dropped, ...restPending } = s.pendingNewTab;
      void _dropped;
      // A sent draft stays up until the host reports its branch, so the screen
      // never jumps elsewhere meanwhile; this is the swap to the real tab.
      const { [chatId]: _draft, ...restDrafts } = s.draftByChatId;
      void _draft;
      return {
        draftByChatId: s.pendingNewTab[chatId] ? restDrafts : s.draftByChatId,
        activeTabByChatId: { ...s.activeTabByChatId, [chatId]: branchId },
        pendingNewTab: restPending,
      };
    });
  },
  openDraft(chatId, draft) {
    set((s) => ({
      activeTabByChatId: { ...s.activeTabByChatId, [chatId]: DRAFT_TAB_ID },
      draftByChatId: { ...s.draftByChatId, [chatId]: draft },
    }));
  },
  closeDraft(chatId) {
    set((s) => {
      const { [chatId]: _dropped, ...rest } = s.draftByChatId;
      void _dropped;
      return { draftByChatId: rest };
    });
  },
  setActiveTab(chatId, branchId) {
    set((s) => ({ activeTabByChatId: { ...s.activeTabByChatId, [chatId]: branchId } }));
  },
}));
