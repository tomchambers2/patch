// selectionStore — sidebar multi-select (patch/todo.md "shift click should
// select multiple"; spec/14 § Sidebar → Selecting multiple rows (shift-click)).
//
// Shift on an in-app link is already swallowed so it can never reload the
// window (lib/shiftClickGuard.ts); this is what shift means INSTEAD: a range
// selection over the sidebar's chat rows, so a run of chats can be archived or
// deleted in one go.
//
// The store holds three things:
//   - `order`: the ids of the selectable rows, in the order they are DRAWN
//     (pinned first, then each folder group). The Sidebar publishes it on every
//     render of the list; range resolution is a slice of it, so a shift-click
//     can never select a row the user cannot see between the two endpoints.
//   - `anchor`: the last plainly-clicked row — the fixed end of the range.
//   - `selected`: the current selection.
//
// The range maths is the pure `resolveRange` so it can be exhaustively unit
// tested without a DOM. Per the portfolio "no fallbacks" rule, an id that is no
// longer in `order` is DROPPED (from the selection and the anchor) rather than
// silently carried as a phantom that bulk actions would then act on.

import { create } from 'zustand';

/**
 * The inclusive run of ids between `anchor` and `target` in drawn order.
 *
 * With no anchor — or an anchor/target that isn't in the list (a row that has
 * since been archived, deleted or filtered away) — the range is just the
 * clicked row: there is no visible span to select.
 */
export function resolveRange(order: string[], anchor: string | null, target: string): string[] {
  if (!order.includes(target)) return [];
  if (anchor === null) return [target];
  const from = order.indexOf(anchor);
  const to = order.indexOf(target);
  if (from === -1) return [target];
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return order.slice(lo, hi + 1);
}

export interface SelectionState {
  /** Selectable row ids, in the order they are drawn in the sidebar. */
  order: string[];
  /** The fixed end of a shift range — the last plainly-clicked row. */
  anchor: string | null;
  /** The currently selected row ids (a subset of `order`). */
  selected: string[];

  /**
   * Publish the drawn order. Anything no longer drawn is dropped from the
   * selection and the anchor — a selected chat that gets archived away must not
   * linger as a phantom id the bulk actions would still act on.
   */
  setOrder(ids: string[]): void;
  /** A plain click: this row becomes the anchor and the selection is cleared. */
  anchorAt(chatId: string): void;
  /** A shift-click: select the inclusive range from the anchor to this row. */
  extendTo(chatId: string): void;
  /** Drop the selection (Esc, a plain click, or a completed bulk action). */
  clear(): void;
}

export const useSelectionStore = create<SelectionState>((set) => ({
  order: [],
  anchor: null,
  selected: [],

  setOrder(ids) {
    set((s) => {
      const same = s.order.length === ids.length && s.order.every((id, i) => id === ids[i]);
      if (same) return s;
      const selected = s.selected.filter((id) => ids.includes(id));
      const anchor = s.anchor !== null && ids.includes(s.anchor) ? s.anchor : null;
      const selectionSame =
        selected.length === s.selected.length && selected.every((id, i) => id === s.selected[i]);
      return { order: ids, anchor, selected: selectionSame ? s.selected : selected };
    });
  },

  anchorAt(chatId) {
    set({ anchor: chatId, selected: [] });
  },

  extendTo(chatId) {
    set((s) => {
      const selected = resolveRange(s.order, s.anchor, chatId);
      if (selected.length === 0) return s;
      // A shift-click with no anchor adopts the clicked row as one, so the next
      // shift-click has a fixed end to range from.
      return { selected, anchor: s.anchor ?? chatId };
    });
  },

  clear() {
    set((s) => (s.selected.length === 0 ? s : { selected: [] }));
  },
}));
