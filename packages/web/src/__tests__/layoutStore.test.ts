// layoutStore — the pane/tab tree behind the main area (spec/14 § Panes and
// tabs). Pure reducer logic: open/close/move/split/resize plus the
// dedupe-by-descriptor and persistence rules.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  useLayoutStore,
  loadLayout,
  type LeafPane,
  type SplitPane,
} from '../stores/layoutStore.js';

const store = (): ReturnType<typeof useLayoutStore.getState> => useLayoutStore.getState();

/** Every descriptor in this file is a chat tab — narrow past the union. */
function cid(d: { kind: string; chatId?: string }): string {
  if (d.kind !== 'chat' || typeof d.chatId !== 'string') throw new Error('not a chat descriptor');
  return d.chatId;
}

function rootLeaf(): LeafPane {
  const root = store().root;
  expect(root.type).toBe('leaf');
  return root as LeafPane;
}

beforeEach(() => {
  store()._reset();
});

describe('layoutStore — opening', () => {
  it('starts with a single empty pane, active', () => {
    const leaf = rootLeaf();
    expect(leaf.tabs).toEqual([]);
    expect(leaf.activeTabId).toBeNull();
    expect(store().activePaneId).toBe(leaf.id);
  });

  it('opens a chat into the active pane as its only tab', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' });
    const leaf = rootLeaf();
    expect(leaf.tabs.map((t) => t.descriptor)).toEqual([{ kind: 'chat', chatId: 'c1' }]);
    expect(leaf.activeTabId).toBe(leaf.tabs[0]!.id);
  });

  it('default placement REPLACES the active tab', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' });
    store().openTab({ kind: 'chat', chatId: 'c2' });
    const leaf = rootLeaf();
    expect(leaf.tabs).toHaveLength(1);
    expect(leaf.tabs[0]!.descriptor).toEqual({ kind: 'chat', chatId: 'c2' });
  });

  it("'tab' placement adds a new tab instead of replacing", () => {
    store().openTab({ kind: 'chat', chatId: 'c1' });
    store().openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'tab' });
    const leaf = rootLeaf();
    expect(leaf.tabs.map((t) => cid(t.descriptor))).toEqual(['c1', 'c2']);
    expect(leaf.activeTabId).toBe(leaf.tabs[1]!.id);
  });

  it('opening a descriptor already open focuses it instead of duplicating', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' }, { placement: 'tab' });
    store().openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'tab' });
    const leaf = rootLeaf();
    const firstTabId = leaf.tabs[0]!.id;
    store().setActiveTab(leaf.id, leaf.tabs[1]!.id);

    store().openTab({ kind: 'chat', chatId: 'c1' });

    const after = rootLeaf();
    expect(after.tabs).toHaveLength(2); // not duplicated
    expect(after.activeTabId).toBe(firstTabId);
  });

  it('a seq passed on an already-open tab is recorded (re-jump)', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' });
    store().openTab({ kind: 'chat', chatId: 'c1' }, { seq: 42 });
    const leaf = rootLeaf();
    expect(leaf.tabs[0]!.pendingSeq).toBe(42);
    store().clearPendingSeq(leaf.tabs[0]!.id);
    expect(rootLeaf().tabs[0]!.pendingSeq).toBeUndefined();
  });
});

describe('layoutStore — closing', () => {
  it('closing the last tab in the only pane leaves an empty pane, not no pane', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' });
    const leaf = rootLeaf();
    store().closeTab(leaf.id, leaf.tabs[0]!.id);
    const after = rootLeaf();
    expect(after.tabs).toEqual([]);
    expect(after.id).toBe(leaf.id);
  });

  it('closing a pane with siblings collapses the split (spec: "closes the pane")', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' });
    store().openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'split', edge: 'right' });
    const split = store().root as SplitPane;
    expect(split.type).toBe('split');
    const rightPane = split.children[1]!.pane as LeafPane;

    store().closeTab(rightPane.id, rightPane.tabs[0]!.id);

    const root = store().root;
    expect(root.type).toBe('leaf');
    expect((root as LeafPane).tabs.map((t) => cid(t.descriptor))).toEqual(['c1']);
  });

  it('closing the active tab activates the last remaining tab', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' }, { placement: 'tab' });
    store().openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'tab' });
    store().openTab({ kind: 'chat', chatId: 'c3' }, { placement: 'tab' });
    const leaf = rootLeaf();
    store().setActiveTab(leaf.id, leaf.tabs[1]!.id); // c2 active
    store().closeTab(leaf.id, leaf.tabs[1]!.id);
    const after = rootLeaf();
    expect(after.tabs.map((t) => cid(t.descriptor))).toEqual(['c1', 'c3']);
    expect(after.activeTabId).toBe(after.tabs[1]!.id); // c3, the last remaining
  });
});

describe('layoutStore — splitting', () => {
  it('splits the active pane right into a new pane, 50/50', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' });
    store().openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'split', edge: 'right' });
    const split = store().root as SplitPane;
    expect(split.type).toBe('split');
    expect(split.direction).toBe('row');
    expect(split.children).toHaveLength(2);
    expect(split.children[0]!.size).toBeCloseTo(0.5);
    expect(split.children[1]!.size).toBeCloseTo(0.5);
    expect(cid((split.children[0]!.pane as LeafPane).tabs[0]!.descriptor)).toBe('c1');
    expect(cid((split.children[1]!.pane as LeafPane).tabs[0]!.descriptor)).toBe('c2');
    expect(store().activePaneId).toBe(split.children[1]!.pane.id);
  });

  it('splitting left puts the new pane BEFORE the target', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' });
    store().openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'split', edge: 'left' });
    const split = store().root as SplitPane;
    expect(cid((split.children[0]!.pane as LeafPane).tabs[0]!.descriptor)).toBe('c2');
    expect(cid((split.children[1]!.pane as LeafPane).tabs[0]!.descriptor)).toBe('c1');
  });

  it('splitting top/bottom makes a column split', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' });
    store().openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'split', edge: 'bottom' });
    const split = store().root as SplitPane;
    expect(split.direction).toBe('column');
  });

  it('a third pane split on the SAME axis joins the existing split rather than nesting', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' });
    store().openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'split', edge: 'right' });
    const split1 = store().root as SplitPane;
    const rightPaneId = split1.children[1]!.pane.id;
    store().setActivePane(rightPaneId);
    store().openTab({ kind: 'chat', chatId: 'c3' }, { placement: 'split', edge: 'right' });

    const split2 = store().root as SplitPane;
    expect(split2.type).toBe('split');
    expect(split2.direction).toBe('row');
    expect(split2.children).toHaveLength(3);
    expect(split2.children.map((c) => cid((c.pane as LeafPane).tabs[0]!.descriptor))).toEqual([
      'c1',
      'c2',
      'c3',
    ]);
  });

  it('dragging a pane onto its own edge with only one tab is a no-op', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' });
    const leaf = rootLeaf();
    store().splitWithTab(leaf.id, leaf.tabs[0]!.id, leaf.id, 'right');
    expect(store().root).toEqual(leaf);
  });
});

describe('layoutStore — splitActivePane (⌘\\)', () => {
  it('splits a pane holding only ONE tab — unlike splitWithTab, this is not a no-op', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' });
    const leaf = rootLeaf();
    store().splitActivePane(leaf.id, 'right');
    const split = store().root as SplitPane;
    expect(split.type).toBe('split');
    expect(split.children).toHaveLength(2);
    expect(cid((split.children[1]!.pane as LeafPane).tabs[0]!.descriptor)).toBe('c1');
    expect(store().activePaneId).toBe(split.children[1]!.pane.id);
  });

  it('splits a pane with several tabs, moving only the ACTIVE one', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' }, { placement: 'tab' });
    store().openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'tab' });
    const leaf = rootLeaf(); // c2 active
    store().splitActivePane(leaf.id, 'right');
    const split = store().root as SplitPane;
    expect((split.children[0]!.pane as LeafPane).tabs.map((t) => cid(t.descriptor))).toEqual([
      'c1',
    ]);
    expect((split.children[1]!.pane as LeafPane).tabs.map((t) => cid(t.descriptor))).toEqual([
      'c2',
    ]);
  });

  it('an explicit tabId splits THAT tab even when a different one is active — a tab’s own "Open to the side" menu item', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' }, { placement: 'tab' });
    store().openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'tab' });
    const leaf = rootLeaf(); // c2 active
    store().splitActivePane(leaf.id, 'right', leaf.tabs[0]!.id); // split c1, not the active c2
    const split = store().root as SplitPane;
    expect((split.children[0]!.pane as LeafPane).tabs.map((t) => cid(t.descriptor))).toEqual([
      'c2',
    ]);
    expect((split.children[1]!.pane as LeafPane).tabs.map((t) => cid(t.descriptor))).toEqual([
      'c1',
    ]);
  });
});

describe('layoutStore — replacing the active tab', () => {
  it('a plain open puts the new tab where the replaced one was, not at the end', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' }, { placement: 'tab' });
    store().openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'tab' });
    store().openTab({ kind: 'chat', chatId: 'c3' }, { placement: 'tab' });
    const leaf = rootLeaf();
    store().setActiveTab(leaf.id, leaf.tabs[1]!.id); // c2
    store().openTab({ kind: 'chat', chatId: 'c4' });
    expect(rootLeaf().tabs.map((t) => cid(t.descriptor))).toEqual(['c1', 'c4', 'c3']);
  });

  it('closing the active tab activates its neighbour, not always the last tab', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' }, { placement: 'tab' });
    store().openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'tab' });
    store().openTab({ kind: 'chat', chatId: 'c3' }, { placement: 'tab' });
    const leaf = rootLeaf();
    store().setActiveTab(leaf.id, leaf.tabs[0]!.id); // c1
    store().closeTab(leaf.id, leaf.tabs[0]!.id);
    const after = rootLeaf();
    expect(cid(after.tabs.find((t) => t.id === after.activeTabId)!.descriptor)).toBe('c2');
  });
});

describe('layoutStore — moving and reordering', () => {
  it('reorders tabs within a pane', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' }, { placement: 'tab' });
    store().openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'tab' });
    store().openTab({ kind: 'chat', chatId: 'c3' }, { placement: 'tab' });
    const leaf = rootLeaf();
    store().reorderTab(leaf.id, leaf.tabs[0]!.id, 2);
    expect(rootLeaf().tabs.map((t) => cid(t.descriptor))).toEqual(['c2', 'c3', 'c1']);
  });

  it('moves a tab to a different pane and focuses it there', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' });
    store().openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'split', edge: 'right' });
    const split = store().root as SplitPane;
    const leftPane = split.children[0]!.pane as LeafPane;
    const rightPane = split.children[1]!.pane as LeafPane;

    store().moveTab(leftPane.id, leftPane.tabs[0]!.id, rightPane.id, 0);

    // Moving the left pane's only tab away closes the left pane, so the
    // split itself collapses back to a single leaf (spec: "closing a pane's
    // last tab closes the pane").
    const after = store().root;
    expect(after.type).toBe('leaf');
    expect((after as LeafPane).tabs.map((t) => cid(t.descriptor))).toEqual(['c1', 'c2']);
  });
});

describe('layoutStore — cycleActiveTab', () => {
  it('steps forward and backward through a pane’s tabs, wrapping at the ends', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' }, { placement: 'tab' });
    store().openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'tab' });
    store().openTab({ kind: 'chat', chatId: 'c3' }, { placement: 'tab' });
    const leaf = rootLeaf(); // c3 active (last opened)
    expect(leaf.activeTabId).toBe(leaf.tabs[2]!.id);

    store().cycleActiveTab(1); // wraps past the end back to c1
    expect(rootLeaf().activeTabId).toBe(leaf.tabs[0]!.id);

    store().cycleActiveTab(-1); // wraps back to c3
    expect(rootLeaf().activeTabId).toBe(leaf.tabs[2]!.id);
  });

  it('does nothing with fewer than two tabs', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' });
    const before = store().root;
    store().cycleActiveTab(1);
    expect(store().root).toEqual(before);
  });
});

describe('layoutStore — resizing', () => {
  it('resizes adjacent children, clamped to a minimum fraction', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' });
    store().openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'split', edge: 'right' });
    const split = store().root as SplitPane;
    store().resizeSplit(split.id, 0, 0.2);
    const after = store().root as SplitPane;
    expect(after.children[0]!.size).toBeCloseTo(0.7);
    expect(after.children[1]!.size).toBeCloseTo(0.3);

    store().resizeSplit(split.id, 0, 10); // way past the limit
    const clamped = store().root as SplitPane;
    expect(clamped.children[1]!.size).toBeGreaterThanOrEqual(0.12 - 1e-9);
  });
});

describe('layoutStore — persistence', () => {
  it('round-trips through localStorage', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' });
    store().openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'split', edge: 'right' });
    const loaded = loadLayout();
    expect(loaded.root).toEqual(store().root);
    expect(loaded.activePaneId).toBe(store().activePaneId);
  });

  it('a garbled layout falls back to a fresh single pane, not a crash', () => {
    localStorage.setItem('patch.layout.v1', '{not json');
    const loaded = loadLayout();
    expect(loaded.root.type).toBe('leaf');
    expect((loaded.root as LeafPane).tabs).toEqual([]);
  });
});

describe('layoutStore — closeMatching', () => {
  it('closes every tab matching the predicate across panes', () => {
    store().openTab({ kind: 'chat', chatId: 'c1' }, { placement: 'tab' });
    store().openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'split', edge: 'right' });
    store().closeMatching((d) => d.kind === 'chat' && d.chatId === 'c1');
    const root = store().root;
    expect(root.type).toBe('leaf');
    expect((root as LeafPane).tabs.map((t) => cid(t.descriptor))).toEqual(['c2']);
  });
});
