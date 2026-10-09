// The Chats tab's single view dropdown (spec/15 § Chats tab; mirrors
// packages/web/src/lib/sidebarView.ts exactly). Previously three controls —
// the Chats/Batch switch, and the Needs attention chip (there was never a
// state filter on mobile at all) — each owned a slice of what the tab shows;
// this is the one combined choice between them, now including Working/
// Waiting on you/Failed too.
//
// It is a pure VIEW over three independently-stored pieces: `batchStore`'s
// `mode`, and `uiStore`'s `attentionOnly` + `stateFilter`.

import type { ChatStateFilter } from './stateFilter';

export type SidebarView = 'all' | 'unread' | 'working' | 'waiting' | 'failed' | 'batch';

export const SIDEBAR_VIEW_OPTIONS: ReadonlyArray<{ value: SidebarView; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'working', label: 'Working' },
  { value: 'waiting', label: 'Waiting on you' },
  { value: 'failed', label: 'Failed' },
  { value: 'batch', label: 'Batch' },
];

const SIDEBAR_VIEW_LABELS: Record<SidebarView, string> = Object.fromEntries(
  SIDEBAR_VIEW_OPTIONS.map((o) => [o.value, o.label]),
) as Record<SidebarView, string>;

/** The trigger pill's own text — `All chats` for the default, else the option's label. */
export function sidebarViewTriggerLabel(view: SidebarView): string {
  return view === 'all' ? 'All chats' : SIDEBAR_VIEW_LABELS[view];
}

/**
 * Combine the three underlying pieces of state into the one dropdown
 * selection. Precedence: batch mode first — it replaces the whole tab body —
 * then Unread, then the state filter.
 */
export function sidebarViewFrom(
  batchMode: boolean,
  attentionOnly: boolean,
  stateFilter: ChatStateFilter,
): SidebarView {
  if (batchMode) return 'batch';
  if (attentionOnly) return 'unread';
  if (stateFilter === 'working' || stateFilter === 'waiting' || stateFilter === 'failed') {
    return stateFilter;
  }
  return 'all';
}

/** The setters `applySidebarView` drives — one call site, so picking an option
 *  can never leave two of the three pieces disagreeing with the third. */
export interface SidebarViewActions {
  setBatchMode(on: boolean): void;
  setAttentionOnly(v: boolean): void;
  setStateFilter(v: ChatStateFilter): void;
}

export function applySidebarView(view: SidebarView, actions: SidebarViewActions): void {
  actions.setBatchMode(view === 'batch');
  actions.setAttentionOnly(view === 'unread');
  actions.setStateFilter(
    view === 'working' || view === 'waiting' || view === 'failed' ? view : 'all',
  );
}
