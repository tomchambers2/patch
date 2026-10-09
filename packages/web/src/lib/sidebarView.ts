// The sidebar's single view dropdown (spec/14 § Sidebar §1b). Previously three
// controls — the Chats/Batch tabs, the state-filter select and the Needs
// attention toggle — each owned a slice of what the sidebar shows; this is the
// one combined choice between them, so picking one option always clears the
// others rather than leaving two filters silently stacked.
//
// It is a pure VIEW over three independently-stored pieces (spec/14 §1b):
// `batchStore`'s `mode`, and `uiStore`'s `attentionOnly` + `stateFilter`. Kept
// separate rather than merged into one persisted enum because `batchStore.mode`
// is already driven from elsewhere — a clicked batch check-in notification
// (`lib/batchNotifier.ts`'s `showBatch`) switches straight to Batch without
// going through this dropdown, and that has to keep working.

import type { ChatStateFilter } from './chatGroups.js';

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

/** The trigger's own text — `All chats` for the default, else the option's label. */
export function sidebarViewTriggerLabel(view: SidebarView): string {
  return view === 'all' ? 'All chats' : SIDEBAR_VIEW_LABELS[view];
}

/**
 * Combine the three underlying pieces of state into the one dropdown
 * selection. Precedence: batch mode first — it replaces the whole sidebar
 * body, so it wins over a state filter or Unread left selected from before —
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

/** Apply a chosen dropdown option to the three underlying stores, keeping them
 *  mutually exclusive. */
export function applySidebarView(view: SidebarView, actions: SidebarViewActions): void {
  actions.setBatchMode(view === 'batch');
  actions.setAttentionOnly(view === 'unread');
  actions.setStateFilter(
    view === 'working' || view === 'waiting' || view === 'failed' ? view : 'all',
  );
}
