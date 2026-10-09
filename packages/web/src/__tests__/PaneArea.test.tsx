// PaneArea / TabBar — the pieces of the pane/tab layout that don't need a
// real browser to drive (click-to-activate, close, middle-click-close,
// click-to-focus-a-pane, and the hide-when-trivial rule). Drag-and-drop
// (reorder, move between panes, split by dragging to an edge) and divider
// resizing need real pointer/DataTransfer behaviour jsdom can't give them —
// those are e2e/panes-and-tabs.spec.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PaneArea } from '../components/PaneArea.js';
import { useChatStore } from '../stores/chatStore.js';
import { useLayoutStore, type LeafPane, type SplitPane } from '../stores/layoutStore.js';

/** Every descriptor in this file is a chat tab — narrow past the union. */
function cid(d: { kind: string; chatId?: string }): string {
  if (d.kind !== 'chat' || typeof d.chatId !== 'string') throw new Error('not a chat descriptor');
  return d.chatId;
}

vi.mock('../api/rest.js', () => ({
  api: {
    getFileContent: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    getFileContentAtHead: vi.fn(async () => ({ path: '', content: '', size: 0 })),
    markBatchOpened: vi.fn(async () => ({ batch: null, carryover: [] })),
  },
}));

function seedChats(ids: string[]): void {
  useChatStore.getState().hydrate(
    ids.map((chatId) => ({
      chatId,
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: chatId,
      folder: 'foo',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 0,
    })),
  );
}

function renderPanes(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <PaneArea ws={null} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useLayoutStore.getState()._reset();
  useChatStore.getState()._reset();
});

describe('PaneArea — single pane, single tab', () => {
  it('draws no tab bar at all (the plain, pre-existing chat view)', () => {
    seedChats(['c1']);
    useLayoutStore.getState().openTab({ kind: 'chat', chatId: 'c1' });
    renderPanes();
    expect(screen.queryByRole('tablist', { name: 'Tabs' })).toBeNull();
    expect(screen.getByTestId('chat-main')).toBeInTheDocument();
  });
});

describe('PaneArea — one pane, several tabs', () => {
  function seedTwoTabs(): LeafPane {
    seedChats(['c1', 'c2']);
    useLayoutStore.getState().openTab({ kind: 'chat', chatId: 'c1' }, { placement: 'tab' });
    useLayoutStore.getState().openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'tab' });
    return useLayoutStore.getState().root as LeafPane;
  }

  it('shows a tab bar once there is a second tab', () => {
    seedTwoTabs();
    renderPanes();
    expect(screen.getByRole('tablist', { name: 'Tabs' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('clicking an inactive tab activates it', () => {
    const pane = seedTwoTabs();
    renderPanes();
    const firstTabId = pane.tabs[0]!.id;
    fireEvent.click(screen.getByTestId(`tab-${firstTabId}`));
    expect(useLayoutStore.getState().root).toMatchObject({ activeTabId: firstTabId });
  });

  it('clicking the close control removes that tab', () => {
    const pane = seedTwoTabs();
    renderPanes();
    const firstTabId = pane.tabs[0]!.id;
    fireEvent.click(screen.getByTestId(`tab-close-${firstTabId}`));
    const root = useLayoutStore.getState().root as LeafPane;
    expect(root.tabs.map((t) => cid(t.descriptor))).toEqual(['c2']);
  });

  it('middle-click (auxclick) on a tab closes it, same as the close control', () => {
    const pane = seedTwoTabs();
    renderPanes();
    const secondTabId = pane.tabs[1]!.id;
    fireEvent(
      screen.getByTestId(`tab-${secondTabId}`),
      new MouseEvent('auxclick', { bubbles: true, button: 1 }),
    );
    const root = useLayoutStore.getState().root as LeafPane;
    expect(root.tabs.map((t) => cid(t.descriptor))).toEqual(['c1']);
  });

  it('right-click opens a menu offering to split, open in a new window, or close', () => {
    const pane = seedTwoTabs();
    renderPanes();
    const firstTabId = pane.tabs[0]!.id;
    fireEvent.contextMenu(screen.getByTestId(`tab-${firstTabId}`));
    expect(screen.getByText('Open to the side')).toBeInTheDocument();
    expect(screen.getByText('Open in new window')).toBeInTheDocument();
    expect(screen.getByText('Close tab')).toBeInTheDocument();
  });
});

describe('PaneArea — two panes', () => {
  it('each pane draws its own tab bar even with one tab each, and clicking one focuses it', () => {
    seedChats(['c1', 'c2']);
    const layout = useLayoutStore.getState();
    layout.openTab({ kind: 'chat', chatId: 'c1' });
    layout.openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'split', edge: 'right' });
    renderPanes();

    expect(screen.getAllByRole('tablist', { name: 'Tabs' })).toHaveLength(2);

    const split = useLayoutStore.getState().root as SplitPane;
    const leftPaneId = split.children[0]!.pane.id;
    expect(useLayoutStore.getState().activePaneId).not.toBe(leftPaneId);

    fireEvent.pointerDown(screen.getByTestId(`pane-${leftPaneId}`));
    expect(useLayoutStore.getState().activePaneId).toBe(leftPaneId);
  });
});

describe('PaneArea — regressions found using it', () => {
  it('splitting the only pane while it is on screen does not break the render', () => {
    seedChats(['c1', 'c2']);
    const layout = useLayoutStore.getState();
    layout.openTab({ kind: 'chat', chatId: 'c1' }, { placement: 'tab' });
    layout.openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'tab' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderPanes();
    act(() => {
      const l = useLayoutStore.getState();
      l.splitActivePane(l.activePaneId, 'right');
    });
    expect(screen.getAllByRole('tablist', { name: 'Tabs' })).toHaveLength(2);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a tab title follows its chat being renamed', () => {
    seedChats(['c1', 'c2']);
    const layout = useLayoutStore.getState();
    layout.openTab({ kind: 'chat', chatId: 'c1' }, { placement: 'tab' });
    layout.openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'tab' });
    renderPanes();
    expect(screen.getAllByRole('tab')[0]).toHaveTextContent('c1');
    act(() => {
      useChatStore.getState().setName('c1', 'Renamed');
    });
    expect(screen.getAllByRole('tab')[0]).toHaveTextContent('Renamed');
  });

  it('a tab is not a button wrapping another button', () => {
    seedChats(['c1', 'c2']);
    const layout = useLayoutStore.getState();
    layout.openTab({ kind: 'chat', chatId: 'c1' }, { placement: 'tab' });
    layout.openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'tab' });
    renderPanes();
    expect(document.querySelector('button button')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Close tab' })).toHaveLength(2);
  });

  it('dropping the first tab on the right half of the second lands it second, not last', () => {
    seedChats(['c1', 'c2', 'c3']);
    const layout = useLayoutStore.getState();
    for (const id of ['c1', 'c2', 'c3'])
      layout.openTab({ kind: 'chat', chatId: id }, { placement: 'tab' });
    renderPanes();
    const pane = useLayoutStore.getState().root as LeafPane;
    const payload = JSON.stringify({ paneId: pane.id, tabId: pane.tabs[0]!.id });
    fireEvent.drop(screen.getByTestId(`tab-${pane.tabs[1]!.id}`), {
      clientX: 10,
      dataTransfer: { getData: () => payload, types: ['application/x-patch-tab'] },
    });
    const after = useLayoutStore.getState().root as LeafPane;
    expect(after.tabs.map((t) => cid(t.descriptor))).toEqual(['c2', 'c1', 'c3']);
  });
});
