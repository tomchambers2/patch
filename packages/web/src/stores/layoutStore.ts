// layoutStore — the pane/tab layout of the main area (spec/14 § Panes and
// tabs): a tree of panes, each holding an ordered list of tabs, nested as deep
// as split/split-again goes. Persisted per-user across reloads and restarts,
// the same `localStorage` convention as the rest of `## Layout`.
//
// A tab's identity is its descriptor's key (`tabKey` below): opening a
// descriptor that is already open anywhere in the tree focuses that tab
// instead of duplicating it (spec/14 § Panes and tabs — "focused rather than
// opened twice").

import { create } from 'zustand';

/** A page tab's own kind — spec/14 § Panes and tabs: "pages (Jobs, a job's
 *  editor, Settings)". The built-in web panel and artifacts stay a native,
 *  OS-level second window (`lib/artifactPanel.ts`) — they are not DOM content
 *  this app renders, so there is nothing for a pane to host; they keep their
 *  existing opening mechanism unchanged. */
export type PageKind = 'jobs' | 'job' | 'settings' | 'files' | 'pads' | 'pad' | 'new-pad';

export type TabDescriptor =
  | { kind: 'chat'; chatId: string }
  | { kind: 'terminal'; chatId: string }
  | { kind: 'file'; chatId: string; path: string }
  | { kind: 'page'; page: 'jobs' }
  | { kind: 'page'; page: 'job'; jobId: string }
  | { kind: 'page'; page: 'settings' }
  | { kind: 'page'; page: 'files'; chatId: string }
  | { kind: 'page'; page: 'pads' }
  | { kind: 'page'; page: 'pad'; padId: string }
  | { kind: 'page'; page: 'new-pad'; chatId?: string };

export interface Tab {
  /** Stable identity — `tabKey(descriptor)`. Also the React key. */
  id: string;
  descriptor: TabDescriptor;
  /**
   * A one-shot jump target for a chat tab opened from a search result
   * (`?seq=` — spec/14 § Main chat panel). Consumed and cleared by the tab's
   * own content the moment it reads it; re-opening the same chat at a new
   * `seq` overwrites it even if the tab was already open.
   */
  pendingSeq?: number;
}

export interface LeafPane {
  type: 'leaf';
  id: string;
  tabs: Tab[];
  /** Null only when `tabs` is empty. */
  activeTabId: string | null;
}

export interface SplitPane {
  type: 'split';
  id: string;
  direction: 'row' | 'column';
  /** `size` is this child's fraction of the split (all children sum to 1). */
  children: { pane: PaneNode; size: number }[];
}

export type PaneNode = LeafPane | SplitPane;

/** Which edge of a pane a tab was dropped on (spec/14 § Panes and tabs). */
export type SplitEdge = 'left' | 'right' | 'top' | 'bottom';

export interface OpenTabOptions {
  /** Target pane — defaults to the active pane. Must name a leaf pane. */
  paneId?: string;
  /**
   * `'active'` (default) replaces the target pane's active tab — unless it is
   * dirty, in which case it falls back to `'tab'` (spec/14 § Opening things).
   * `'tab'` always adds a new tab. `'split'` opens a new pane at `edge`.
   */
  placement?: 'active' | 'tab' | 'split';
  edge?: SplitEdge;
  seq?: number;
}

const LAYOUT_KEY = 'patch.layout.v1';
/** A split child never shrinks below this fraction of its split (spec/14 §
 *  Panes and tabs — "Dividers are drag-resizable"): a divider that could drag
 *  a pane to zero width could drag it out of existence without the explicit
 *  close gesture the spec describes. */
export const MIN_PANE_FRACTION = 0.12;

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function tabKey(descriptor: TabDescriptor): string {
  switch (descriptor.kind) {
    case 'chat':
      return `chat:${descriptor.chatId}`;
    case 'terminal':
      return `terminal:${descriptor.chatId}`;
    case 'file':
      return `file:${descriptor.chatId}:${descriptor.path}`;
    case 'page':
      return descriptor.page === 'job'
        ? `page:job:${descriptor.jobId}`
        : descriptor.page === 'files'
          ? `page:files:${descriptor.chatId}`
          : descriptor.page === 'pad'
            ? `page:pad:${descriptor.padId}`
            : `page:${descriptor.page}`;
  }
}

/**
 * A tab reports its own dirtiness here — a file tab's unsaved draft lives in
 * the `FileEditorTab` component itself (in-memory only, same convention as
 * the old rail's draft), not in this store, so it calls
 * `setTabDirty` on every keystroke/save rather than this store deriving it.
 * Every other kind is never dirty.
 */
const dirtyTabIds = new Set<string>();

export function isTabDirty(tab: Tab): boolean {
  return dirtyTabIds.has(tab.id);
}

export function setTabDirty(tabId: string, dirty: boolean): void {
  if (dirty) dirtyTabIds.add(tabId);
  else dirtyTabIds.delete(tabId);
}

function makeLeaf(tabs: Tab[] = [], activeTabId: string | null = null): LeafPane {
  return { type: 'leaf', id: genId('pane'), tabs, activeTabId };
}

function defaultRoot(): LeafPane {
  return makeLeaf();
}

interface Found {
  pane: LeafPane;
  tab: Tab;
  index: number;
}

/** Depth-first search for a tab by key, anywhere under `node`. */
function findTabByKey(node: PaneNode, key: string): Found | null {
  if (node.type === 'leaf') {
    const index = node.tabs.findIndex((t) => t.id === key);
    return index === -1 ? null : { pane: node, tab: node.tabs[index] as Tab, index };
  }
  for (const child of node.children) {
    const found = findTabByKey(child.pane, key);
    if (found) return found;
  }
  return null;
}

export function findPane(node: PaneNode, paneId: string): PaneNode | null {
  if (node.id === paneId) return node;
  if (node.type === 'leaf') return null;
  for (const child of node.children) {
    const found = findPane(child.pane, paneId);
    if (found) return found;
  }
  return null;
}

/** First leaf pane in document order — the fallback when a named pane can't
 *  be resolved (e.g. it just closed). */
export function firstLeaf(node: PaneNode): LeafPane {
  return node.type === 'leaf' ? node : firstLeaf(node.children[0]!.pane);
}

/** Resolve a pane id to the leaf that actually holds tabs — `paneId` may name
 *  a split (stale after a tree change), in which case its first leaf stands
 *  in for it. Used to find "the active pane" for opening/focus purposes. */
export function resolvePane(root: PaneNode, paneId: string): LeafPane {
  const node = findPane(root, paneId);
  return node ? (node.type === 'leaf' ? node : firstLeaf(node)) : firstLeaf(root);
}

/** The chat currently showing in a pane's active tab, or null (no tabs, or
 *  its active tab isn't a chat). */
export function activeChatOf(pane: LeafPane): string | null {
  const tab = pane.tabs.find((t) => t.id === pane.activeTabId);
  return tab && tab.descriptor.kind === 'chat' ? tab.descriptor.chatId : null;
}

/** How many leaf panes the tree currently has — a single pane holding a
 *  single tab draws no tab bar at all (spec/14 § Panes and tabs), so a
 *  pane needs to know whether it's the only one. */
export function countPanes(node: PaneNode): number {
  return node.type === 'leaf' ? 1 : node.children.reduce((n, c) => n + countPanes(c.pane), 0);
}

/** Rebuild `node`, replacing the pane named `paneId` with whatever `replace`
 *  returns (`null` removes it, collapsing a split that drops to one child).
 *  Returns `null` only when `node` itself was removed. */
function rebuild(
  node: PaneNode,
  paneId: string,
  replace: (pane: PaneNode) => PaneNode | null,
): PaneNode | null {
  if (node.id === paneId) return replace(node);
  if (node.type === 'leaf') return node;
  const nextChildren: { pane: PaneNode; size: number }[] = [];
  for (const child of node.children) {
    const nextPane = rebuild(child.pane, paneId, replace);
    if (nextPane === null) continue;
    nextChildren.push({ pane: nextPane, size: child.size });
  }
  if (nextChildren.length === node.children.length) {
    return { ...node, children: nextChildren };
  }
  if (nextChildren.length === 0) return null;
  if (nextChildren.length === 1) {
    // A split reduced to one child is no split at all — replace it with the
    // surviving child directly (spec/14 § "Closing a pane's last tab closes
    // the pane").
    return nextChildren[0]!.pane;
  }
  // Redistribute the removed child's share evenly so the rest still sum to 1.
  const total = nextChildren.reduce((n, c) => n + c.size, 0);
  return {
    ...node,
    children: total > 0 ? nextChildren.map((c) => ({ ...c, size: c.size / total })) : nextChildren,
  };
}

interface LayoutState {
  root: PaneNode;
  activePaneId: string;
  /** Open (or focus) a tab per `opts` (spec/14 § Opening things). */
  openTab(descriptor: TabDescriptor, opts?: OpenTabOptions): void;
  closeTab(paneId: string, tabId: string): void;
  setActiveTab(paneId: string, tabId: string): void;
  setActivePane(paneId: string): void;
  /** Reorder a tab within its own pane. */
  reorderTab(paneId: string, tabId: string, toIndex: number): void;
  /** Move a tab (drag) into a different pane at `toIndex`. */
  moveTab(fromPaneId: string, tabId: string, toPaneId: string, toIndex: number): void;
  /** Drag a tab onto a pane's edge: pull it out of its pane and split there. */
  splitWithTab(fromPaneId: string, tabId: string, targetPaneId: string, edge: SplitEdge): void;
  /** ⌘\, and a tab's own "Open to the side" menu item — split a pane,
   *  moving one of its tabs (its active one, or `tabId` for a specific tab
   *  that need not be the active one) into the new one. Unlike `splitWithTab`,
   *  this always splits even when the pane holds only one tab: dragging a tab
   *  onto its own pane's edge is usually an accidental gesture, but an
   *  explicit split request asking for exactly that outcome is not. */
  splitActivePane(paneId: string, edge: SplitEdge, tabId?: string): void;
  /** Drag a split divider — `childIndex` and the next child trade the delta. */
  resizeSplit(splitId: string, childIndex: number, delta: number): void;
  /** The pane + index of an already-open tab, or null. */
  findTab(descriptor: TabDescriptor): Found | null;
  /**
   * Open (or focus) a tab, UNLESS it is already the focused tab of the
   * focused pane, in which case close it instead — a toggle, for a keyboard
   * chord that used to open/close a docked rail (⌥E, ⌃\`).
   */
  toggleTab(descriptor: TabDescriptor): void;
  clearPendingSeq(tabId: string): void;
  /** Close every tab in every pane whose descriptor matches `pred` — used
   *  when the thing a tab points at is gone (spec/04 § Delete). */
  closeMatching(pred: (descriptor: TabDescriptor) => boolean): void;
  /** ⌘⌥←/→ — step the active pane's active tab, wrapping at the ends. */
  cycleActiveTab(delta: number): void;
  /** Test-only: back to a single empty pane, localStorage cleared. */
  _reset(): void;
}

/**
 * A tab detached into its own window (`routes/TabWindowRoute.tsx`) is a
 * throwaway single-tab view, not a second copy of the whole layout — and
 * `window.open` to the same origin shares `localStorage` with the opener, so
 * a detached window that persisted like any other would read the opener's
 * FULL tree on open and overwrite it on every change. `?tabWindow=1` (set
 * only by `lib/newWindow.ts`'s `openTabInNewWindow`) opts that one window out
 * of both sides of persistence entirely.
 */
function isTabWindow(): boolean {
  /* v8 ignore next -- jsdom's default location has no search string; exercised via explicit URLSearchParams construction in tests instead of navigating jsdom's location. */
  if (typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).get('tabWindow') === '1';
}

function persist(root: PaneNode, activePaneId: string): void {
  /* v8 ignore next -- jsdom always defines localStorage; this SSR guard can't be hit under vitest+jsdom. */
  if (typeof localStorage === 'undefined') return;
  if (isTabWindow()) return;
  localStorage.setItem(LAYOUT_KEY, JSON.stringify({ root, activePaneId }));
}

export function isTabDescriptor(v: unknown): v is TabDescriptor {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  switch (d['kind']) {
    case 'chat':
    case 'terminal':
      return typeof d['chatId'] === 'string';
    case 'file':
      return typeof d['chatId'] === 'string' && typeof d['path'] === 'string';
    case 'page':
      switch (d['page']) {
        case 'jobs':
        case 'settings':
        case 'pads':
          return true;
        case 'job':
          return typeof d['jobId'] === 'string';
        case 'pad':
          return typeof d['padId'] === 'string';
        case 'new-pad':
          return d['chatId'] === undefined || typeof d['chatId'] === 'string';
        case 'files':
          return typeof d['chatId'] === 'string';
        default:
          return false;
      }
    default:
      return false;
  }
}

function parseNode(v: unknown): PaneNode | null {
  if (typeof v !== 'object' || v === null) return null;
  const n = v as Record<string, unknown>;
  if (n['type'] === 'leaf') {
    if (typeof n['id'] !== 'string' || !Array.isArray(n['tabs'])) return null;
    const tabs: Tab[] = [];
    for (const rawTab of n['tabs']) {
      if (typeof rawTab !== 'object' || rawTab === null) continue;
      const t = rawTab as Record<string, unknown>;
      if (typeof t['id'] !== 'string' || !isTabDescriptor(t['descriptor'])) continue;
      tabs.push({ id: t['id'], descriptor: t['descriptor'] });
    }
    const activeTabId = typeof n['activeTabId'] === 'string' ? n['activeTabId'] : null;
    return {
      type: 'leaf',
      id: n['id'],
      tabs,
      activeTabId:
        activeTabId !== null && tabs.some((t) => t.id === activeTabId)
          ? activeTabId
          : (tabs[0]?.id ?? null),
    };
  }
  if (n['type'] === 'split') {
    if (
      typeof n['id'] !== 'string' ||
      (n['direction'] !== 'row' && n['direction'] !== 'column') ||
      !Array.isArray(n['children'])
    ) {
      return null;
    }
    const children: { pane: PaneNode; size: number }[] = [];
    for (const rawChild of n['children']) {
      if (typeof rawChild !== 'object' || rawChild === null) continue;
      const c = rawChild as Record<string, unknown>;
      const pane = parseNode(c['pane']);
      if (pane === null || typeof c['size'] !== 'number') continue;
      children.push({ pane, size: c['size'] });
    }
    if (children.length < 2) return children[0]?.pane ?? null;
    return { type: 'split', id: n['id'], direction: n['direction'], children };
  }
  return null;
}

/** Read the persisted layout back. Exported so parsing is unit-testable on
 *  its own, matching `uiStore.loadBrowseState`'s convention. A garbled value
 *  is a first run, not a swallowed error (NO FALLBACK that hides real state —
 *  this one has no real state to lose, only a layout that starts empty). */
export function loadLayout(): { root: PaneNode; activePaneId: string } {
  /* v8 ignore next -- jsdom always defines localStorage; this SSR guard can't be hit under vitest+jsdom. */
  if (typeof localStorage === 'undefined') return { root: defaultRoot(), activePaneId: '' };
  if (isTabWindow()) {
    const root = defaultRoot();
    return { root, activePaneId: root.id };
  }
  const raw = localStorage.getItem(LAYOUT_KEY);
  if (raw === null) {
    const root = defaultRoot();
    return { root, activePaneId: root.id };
  }
  try {
    const parsed = JSON.parse(raw) as { root?: unknown; activePaneId?: unknown };
    const root = parseNode(parsed.root);
    if (root === null) throw new Error('malformed layout');
    const activePaneId =
      typeof parsed.activePaneId === 'string' && findPane(root, parsed.activePaneId)
        ? parsed.activePaneId
        : firstLeaf(root).id;
    return { root, activePaneId };
  } catch {
    const root = defaultRoot();
    return { root, activePaneId: root.id };
  }
}

export const useLayoutStore = create<LayoutState>((set, get) => {
  const initial = loadLayout();
  return {
    root: initial.root,
    activePaneId: initial.activePaneId,

    findTab(descriptor) {
      return findTabByKey(get().root, tabKey(descriptor));
    },

    toggleTab(descriptor) {
      const state = get();
      const found = findTabByKey(state.root, tabKey(descriptor));
      if (
        found &&
        found.pane.activeTabId === found.tab.id &&
        state.activePaneId === found.pane.id
      ) {
        get().closeTab(found.pane.id, found.tab.id);
      } else {
        get().openTab(descriptor);
      }
    },

    openTab(descriptor, opts = {}) {
      const key = tabKey(descriptor);
      const state = get();
      const existing = findTabByKey(state.root, key);
      if (existing) {
        const withSeq: PaneNode | null = rebuild(state.root, existing.pane.id, (pane) => {
          if (pane.type !== 'leaf') return pane;
          return {
            ...pane,
            activeTabId: existing.tab.id,
            tabs: pane.tabs.map((t) =>
              t.id === existing.tab.id
                ? { ...t, ...(opts.seq !== undefined ? { pendingSeq: opts.seq } : {}) }
                : t,
            ),
          };
        });
        const root = withSeq ?? state.root;
        set({ root, activePaneId: existing.pane.id });
        persist(root, existing.pane.id);
        return;
      }

      const target = resolvePane(state.root, opts.paneId ?? state.activePaneId);
      const tab: Tab = {
        id: key,
        descriptor,
        ...(opts.seq !== undefined ? { pendingSeq: opts.seq } : {}),
      };

      if (opts.placement === 'split') {
        const edge = opts.edge ?? 'right';
        const newLeaf = makeLeaf([tab], tab.id);
        const root = splitTree(state.root, target.id, newLeaf, edge);
        set({ root, activePaneId: newLeaf.id });
        persist(root, newLeaf.id);
        return;
      }

      const activeTab = target.tabs.find((t) => t.id === target.activeTabId);
      const replace =
        opts.placement !== 'tab' && (activeTab === undefined || !isTabDirty(activeTab));

      const root = rebuild(state.root, target.id, (pane) => {
        if (pane.type !== 'leaf') return pane;
        const tabs = pane.tabs.slice();
        // A replacing open takes the replaced tab's place in the bar rather
        // than jumping to the end of it.
        const at = replace ? tabs.findIndex((t) => t.id === pane.activeTabId) : -1;
        if (at === -1) tabs.push(tab);
        else tabs[at] = tab;
        return { ...pane, tabs, activeTabId: tab.id };
      });
      const finalRoot = root ?? state.root;
      set({ root: finalRoot, activePaneId: target.id });
      persist(finalRoot, target.id);
    },

    closeTab(paneId, tabId) {
      const state = get();
      const pane = findPane(state.root, paneId);
      if (!pane || pane.type !== 'leaf') return;
      const tabs = pane.tabs.filter((t) => t.id !== tabId);
      let root: PaneNode | null;
      if (tabs.length === 0) {
        // Closing the last tab closes the pane (spec/14 § Panes and tabs) —
        // unless it's the only pane left, which has nowhere to collapse into.
        root =
          pane.id === state.root.id
            ? { ...pane, tabs: [], activeTabId: null }
            : rebuild(state.root, paneId, () => null);
      } else {
        const closedAt = pane.tabs.findIndex((t) => t.id === tabId);
        // The neighbour that slides into the closed tab's place, else the one before it.
        const activeTabId =
          pane.activeTabId === tabId
            ? (tabs[Math.min(closedAt, tabs.length - 1)]?.id ?? null)
            : pane.activeTabId;
        root = rebuild(state.root, paneId, (p) =>
          p.type === 'leaf' ? { ...p, tabs, activeTabId } : p,
        );
      }
      const finalRoot = root ?? defaultRoot();
      const activePaneId = findPane(finalRoot, state.activePaneId)
        ? state.activePaneId
        : firstLeaf(finalRoot).id;
      set({ root: finalRoot, activePaneId });
      persist(finalRoot, activePaneId);
    },

    setActiveTab(paneId, tabId) {
      const state = get();
      const root = rebuild(state.root, paneId, (pane) =>
        pane.type === 'leaf' && pane.tabs.some((t) => t.id === tabId)
          ? { ...pane, activeTabId: tabId }
          : pane,
      );
      const finalRoot = root ?? state.root;
      set({ root: finalRoot, activePaneId: paneId });
      persist(finalRoot, paneId);
    },

    setActivePane(paneId) {
      if (!findPane(get().root, paneId)) return;
      set({ activePaneId: paneId });
      persist(get().root, paneId);
    },

    reorderTab(paneId, tabId, toIndex) {
      const state = get();
      const root = rebuild(state.root, paneId, (pane) => {
        if (pane.type !== 'leaf') return pane;
        const tabs = pane.tabs.slice();
        const from = tabs.findIndex((t) => t.id === tabId);
        if (from === -1) return pane;
        const [moved] = tabs.splice(from, 1);
        tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, moved as Tab);
        return { ...pane, tabs };
      });
      const finalRoot = root ?? state.root;
      set({ root: finalRoot });
      persist(finalRoot, state.activePaneId);
    },

    moveTab(fromPaneId, tabId, toPaneId, toIndex) {
      const state = get();
      if (fromPaneId === toPaneId) {
        get().reorderTab(fromPaneId, tabId, toIndex);
        return;
      }
      const fromPane = findPane(state.root, fromPaneId);
      if (!fromPane || fromPane.type !== 'leaf') return;
      const tab = fromPane.tabs.find((t) => t.id === tabId);
      if (!tab) return;

      let root: PaneNode | null = state.root;
      const remaining = fromPane.tabs.filter((t) => t.id !== tabId);
      if (remaining.length === 0) {
        root =
          fromPane.id === root.id
            ? { ...fromPane, tabs: [], activeTabId: null }
            : rebuild(root, fromPaneId, () => null);
      } else {
        const activeTabId =
          fromPane.activeTabId === tabId
            ? (remaining[remaining.length - 1]?.id ?? null)
            : fromPane.activeTabId;
        root = rebuild(root, fromPaneId, (p) =>
          p.type === 'leaf' ? { ...p, tabs: remaining, activeTabId } : p,
        );
      }
      root = root ?? defaultRoot();

      root = rebuild(root, toPaneId, (pane) => {
        if (pane.type !== 'leaf') return pane;
        const tabs = pane.tabs.slice();
        tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, tab);
        return { ...pane, tabs, activeTabId: tab.id };
      });
      const finalRoot = root ?? defaultRoot();
      set({ root: finalRoot, activePaneId: toPaneId });
      persist(finalRoot, toPaneId);
    },

    splitWithTab(fromPaneId, tabId, targetPaneId, edge) {
      const state = get();
      const fromPane = findPane(state.root, fromPaneId);
      if (!fromPane || fromPane.type !== 'leaf') return;
      const tab = fromPane.tabs.find((t) => t.id === tabId);
      if (!tab) return;

      // Dragging a pane's only tab onto its OWN edge would close it and
      // immediately reopen the identical pane — a no-op dressed as a split.
      if (fromPaneId === targetPaneId && fromPane.tabs.length === 1) return;

      const { root, newLeafId } = movePaneTabToSplit(state.root, fromPane, tab, targetPaneId, edge);
      set({ root, activePaneId: newLeafId });
      persist(root, newLeafId);
    },

    splitActivePane(paneId, edge, tabId) {
      const state = get();
      const pane = findPane(state.root, paneId);
      if (!pane || pane.type !== 'leaf') return;
      const tab = pane.tabs.find((t) => t.id === (tabId ?? pane.activeTabId));
      if (!tab) return;

      const { root, newLeafId } = movePaneTabToSplit(state.root, pane, tab, paneId, edge);
      set({ root, activePaneId: newLeafId });
      persist(root, newLeafId);
    },

    resizeSplit(splitId, childIndex, delta) {
      const state = get();
      const root = rebuild(state.root, splitId, (pane) => {
        if (pane.type !== 'split') return pane;
        const next = pane.children.map((c) => ({ ...c }));
        const a = next[childIndex];
        const b = next[childIndex + 1];
        if (!a || !b) return pane;
        const clampedDelta = Math.max(
          MIN_PANE_FRACTION - a.size,
          Math.min(delta, b.size - MIN_PANE_FRACTION),
        );
        a.size += clampedDelta;
        b.size -= clampedDelta;
        return { ...pane, children: next };
      });
      const finalRoot = root ?? state.root;
      set({ root: finalRoot });
      persist(finalRoot, state.activePaneId);
    },

    clearPendingSeq(tabId) {
      const state = get();
      const found = findTabByKey(state.root, tabId);
      if (!found) return;
      const root = rebuild(state.root, found.pane.id, (pane) =>
        pane.type === 'leaf'
          ? {
              ...pane,
              tabs: pane.tabs.map((t) => {
                if (t.id !== tabId) return t;
                const next = { ...t };
                delete next.pendingSeq;
                return next;
              }),
            }
          : pane,
      );
      const finalRoot = root ?? state.root;
      set({ root: finalRoot });
      persist(finalRoot, state.activePaneId);
    },

    closeMatching(pred) {
      let state = get();
      // Repeatedly close the first match — the tree shape (and pane ids)
      // changes on every close, so collecting matches up front would act on
      // stale panes.
      for (;;) {
        const match = findFirstMatch(state.root, pred);
        if (!match) return;
        get().closeTab(match.pane.id, match.tab.id);
        state = get();
      }
    },

    cycleActiveTab(delta) {
      const state = get();
      const pane = resolvePane(state.root, state.activePaneId);
      if (pane.tabs.length < 2) return;
      const idx = pane.tabs.findIndex((t) => t.id === pane.activeTabId);
      const next = pane.tabs[(idx + delta + pane.tabs.length) % pane.tabs.length];
      if (next) get().setActiveTab(pane.id, next.id);
    },

    _reset() {
      /* v8 ignore next -- jsdom always defines localStorage; this SSR guard can't be hit under vitest+jsdom. */
      if (typeof localStorage !== 'undefined') localStorage.removeItem(LAYOUT_KEY);
      const root = defaultRoot();
      set({ root, activePaneId: root.id });
    },
  };
});

function findFirstMatch(node: PaneNode, pred: (d: TabDescriptor) => boolean): Found | null {
  if (node.type === 'leaf') {
    const index = node.tabs.findIndex((t) => pred(t.descriptor));
    return index === -1 ? null : { pane: node, tab: node.tabs[index] as Tab, index };
  }
  for (const child of node.children) {
    const found = findFirstMatch(child.pane, pred);
    if (found) return found;
  }
  return null;
}

/** Pull `tab` out of `fromPane` and split it into a new leaf at `edge` of
 *  `targetPaneId`. Shared core of `splitWithTab` and `splitActivePane` — the
 *  two differ only in whether a same-pane, single-tab split is allowed. */
function movePaneTabToSplit(
  treeRoot: PaneNode,
  fromPane: LeafPane,
  tab: Tab,
  targetPaneId: string,
  edge: SplitEdge,
): { root: PaneNode; newLeafId: string } {
  let root: PaneNode | null = treeRoot;
  const remaining = fromPane.tabs.filter((t) => t.id !== tab.id);
  if (remaining.length === 0) {
    root =
      fromPane.id === root.id
        ? { ...fromPane, tabs: [], activeTabId: null }
        : rebuild(root, fromPane.id, () => null);
  } else {
    const activeTabId =
      fromPane.activeTabId === tab.id
        ? (remaining[remaining.length - 1]?.id ?? null)
        : fromPane.activeTabId;
    root = rebuild(root, fromPane.id, (p) =>
      p.type === 'leaf' ? { ...p, tabs: remaining, activeTabId } : p,
    );
  }
  root = root ?? defaultRoot();

  const newLeaf = makeLeaf([tab], tab.id);
  // The target pane may have been the one just emptied-and-removed above
  // (splitting a pane with its own tab); fall back to wherever it still
  // resolves, or the tree root.
  const resolvedTargetId = findPane(root, targetPaneId) ? targetPaneId : root.id;
  return { root: splitTree(root, resolvedTargetId, newLeaf, edge), newLeafId: newLeaf.id };
}

/** Split `targetPaneId` in the tree rooted at `node`, adding `newLeaf` on
 *  `edge` of it, 50/50. `direction` is `row` for left/right, `column` for
 *  top/bottom; a target whose PARENT already splits the same direction just
 *  gains a sibling there instead of nesting a redundant single-axis split. */
function splitTree(
  node: PaneNode,
  targetPaneId: string,
  newLeaf: LeafPane,
  edge: SplitEdge,
): PaneNode {
  const direction: 'row' | 'column' = edge === 'left' || edge === 'right' ? 'row' : 'column';
  const before = edge === 'left' || edge === 'top';

  if (node.id === targetPaneId) {
    const children = before
      ? [
          { pane: newLeaf, size: 0.5 },
          { pane: node, size: 0.5 },
        ]
      : [
          { pane: node, size: 0.5 },
          { pane: newLeaf, size: 0.5 },
        ];
    return { type: 'split', id: genId('split'), direction, children };
  }
  if (node.type === 'leaf') return node;

  // The target is a direct child of THIS split, and this split already runs
  // the same axis: grow it by one child instead of nesting a 1-axis split
  // inside another of the same axis (spec/14 § Panes and tabs — panes "nested
  // as deep as you like", not deeper than the drag asked for).
  const directIndex = node.children.findIndex((c) => c.pane.id === targetPaneId);
  if (directIndex !== -1 && node.direction === direction) {
    const share = (node.children[directIndex] as { pane: PaneNode; size: number }).size / 2;
    const children = node.children.map((c, i) => (i === directIndex ? { ...c, size: share } : c));
    const insertAt = before ? directIndex : directIndex + 1;
    children.splice(insertAt, 0, { pane: newLeaf, size: share });
    return { ...node, children };
  }

  return {
    ...node,
    children: node.children.map((c) => ({
      ...c,
      pane: splitTree(c.pane, targetPaneId, newLeaf, edge),
    })),
  };
}
