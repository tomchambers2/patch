// sideThreadsStore — the Threads panel's per-chat tab bookkeeping (spec/14 §
// Side threads panel). Which tabs a chat's panel shows, which one is active,
// and the order the user dragged them into. Session-only (not persisted
// across reloads), the same convention `toolsPanelChatId` uses for the
// panel's own open/closed state — the panel is a working surface for the
// conversation on screen right now, not standing layout.
//
// The actual LIST of tabs is derived, not stored here: it is every
// `sideThread` branch in `chatStore`'s `branchGraphs[chatId]`, in creation
// order, minus whatever this store has closed. Closing a tab only hides it
// (spec: "the thread stays") — it stays a real branch, re-openable from its
// marker or the hover/context-menu trigger.

import { create } from 'zustand';

/**
 * Sentinel "tab" for a side thread that has been triggered but not sent yet
 * (spec/14 § Side threads panel TRIGGER — "opens the panel with the cursor in
 * its composer"): the host mints branch ids, so there is nothing real to
 * open until the first message actually sends. Never a real branchId.
 */
export const DRAFT_TAB_ID = '__side-thread-draft__';

/** A side thread trigger's quote-and-fork-point, before it has a branch. */
export interface SideThreadDraft {
  seq: number;
  /** The message text it hangs off, shown as "Off <quotedMessage>". */
  quotedMessage: string;
  /** Set when triggered from inside another side thread's own tab. */
  fromBranchId?: string;
}

interface SideThreadsState {
  /** Which chat's panel is open, or null when the panel is closed. */
  panelChatId: string | null;
  /** The active tab (a branchId) per chat. */
  activeTabByChatId: Record<string, string>;
  /** Tabs closed by the user per chat — hidden from the bar, branch still exists. */
  closedTabsByChatId: Record<string, string[]>;
  /** Drag-reordered tab sequence per chat. Branches not listed sort after, in creation order. */
  tabOrderByChatId: Record<string, string[]>;
  /**
   * Set right when the trigger (hover button / context menu / branch-again)
   * fires `chat.side_request`, before the host has minted the new branchId:
   * "the next NEW side-thread branch this chat's graph grows is the one to
   * open the panel on". The host mints ids, so there is nothing to open yet
   * at send time — `SideThreadsPanel`'s own reconciler consumes this the
   * moment `chat.branches` reports the new branch and opens it then.
   */
  pendingNewTab: Record<string, boolean>;
  expectNewTab(chatId: string): void;
  /** Open the panel on this chat with `branchId`'s tab active (re-opening it if closed). */
  openThread(chatId: string, branchId: string): void;
  /** Open the panel on an UN-SENT draft — the trigger, before the branch exists. */
  draftByChatId: Record<string, SideThreadDraft>;
  openDraft(chatId: string, draft: SideThreadDraft): void;
  closeDraft(chatId: string): void;
  closePanel(): void;
  setActiveTab(chatId: string, branchId: string): void;
  /** Hide a tab. The thread (branch) itself is untouched. */
  closeTab(chatId: string, branchId: string): void;
  reorderTabs(chatId: string, order: string[]): void;
}

export const useSideThreadsStore = create<SideThreadsState>((set) => ({
  panelChatId: null,
  activeTabByChatId: {},
  closedTabsByChatId: {},
  tabOrderByChatId: {},
  pendingNewTab: {},
  expectNewTab(chatId) {
    set((s) => ({ pendingNewTab: { ...s.pendingNewTab, [chatId]: true } }));
  },
  draftByChatId: {},
  openDraft(chatId, draft) {
    set((s) => ({
      panelChatId: chatId,
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
  openThread(chatId, branchId) {
    set((s) => {
      const { [chatId]: _dropped, ...restPending } = s.pendingNewTab;
      void _dropped;
      // A sent draft stays up until the host reports its branch, so the panel
      // never jumps elsewhere meanwhile; this is the swap to the real tab.
      const { [chatId]: _draft, ...restDrafts } = s.draftByChatId;
      void _draft;
      return {
        panelChatId: chatId,
        draftByChatId: s.pendingNewTab[chatId] ? restDrafts : s.draftByChatId,
        activeTabByChatId: { ...s.activeTabByChatId, [chatId]: branchId },
        closedTabsByChatId: {
          ...s.closedTabsByChatId,
          [chatId]: (s.closedTabsByChatId[chatId] ?? []).filter((id) => id !== branchId),
        },
        pendingNewTab: restPending,
      };
    });
  },
  closePanel() {
    set({ panelChatId: null });
  },
  setActiveTab(chatId, branchId) {
    set((s) => ({ activeTabByChatId: { ...s.activeTabByChatId, [chatId]: branchId } }));
  },
  closeTab(chatId, branchId) {
    set((s) => {
      const closed = s.closedTabsByChatId[chatId] ?? [];
      if (closed.includes(branchId)) return s;
      return { closedTabsByChatId: { ...s.closedTabsByChatId, [chatId]: [...closed, branchId] } };
    });
  },
  reorderTabs(chatId, order) {
    set((s) => ({ tabOrderByChatId: { ...s.tabOrderByChatId, [chatId]: order } }));
  },
}));

/** Order `branchIds` (sideThread branches, creation order) per the drag-reorder
 * override, unlisted ones appended in their given order. */
export function orderTabs(branchIds: string[], order: string[] | undefined): string[] {
  if (!order || order.length === 0) return branchIds;
  const known = new Set(branchIds);
  const ordered = order.filter((id) => known.has(id));
  const rest = branchIds.filter((id) => !ordered.includes(id));
  return [...ordered, ...rest];
}
