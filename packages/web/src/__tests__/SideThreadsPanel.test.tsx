// spec/14 § Side threads panel — the panel itself: tabs, draft composer,
// sending to a branch, stop, send back, permission cards, branching again
// from inside a tab, and the auto-open reconciler.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useLayoutStore } from '../stores/layoutStore.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SideThreadsPanel } from '../components/SideThreadsPanel.js';
import { useChatStore } from '../stores/chatStore.js';
import { useSideThreadsStore, DRAFT_TAB_ID } from '../stores/sideThreadsStore.js';
import { openSideThreadDraft, openExistingSideThread } from '../lib/sideThreadActions.js';
import { setActiveWs } from '../api/ws.js';
import type { PatchWs } from '../api/ws.js';

vi.mock('../api/rest.js', () => ({
  api: { getChatHistory: vi.fn().mockResolvedValue({ events: [] }) },
}));

import { api } from '../api/rest.js';

function fakeWs(): { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn() };
}

function renderPanel(chatId: string) {
  // The panel follows the chat in the focused pane, not the address bar.
  useLayoutStore.getState().openTab({ kind: 'chat', chatId });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/jobs']}>
        <SideThreadsPanel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function seedBranches(chatId: string, extra: Array<Record<string, unknown>> = []): void {
  useChatStore.getState().applyEvent({
    type: 'chat.branches',
    chatId,
    activeBranchId: `${chatId}-b0`,
    branches: [
      {
        branchId: `${chatId}-b0`,
        parentBranchId: null,
        forkFromSeq: null,
        label: 'main',
        createdAt: 0,
      },
      ...extra,
    ],
  } as never);
}

beforeEach(() => {
  useLayoutStore.getState()._reset();
  useChatStore.getState()._reset();
  useSideThreadsStore.setState({
    panelChatId: null,
    activeTabByChatId: {},
    closedTabsByChatId: {},
    tabOrderByChatId: {},
    pendingNewTab: {},
    draftByChatId: {},
  });
  setActiveWs(null);
  vi.mocked(api.getChatHistory).mockResolvedValue({ events: [] });
});
afterEach(() => cleanup());

describe('SideThreadsPanel', () => {
  it('renders nothing when the panel is closed', () => {
    seedBranches('c1');
    const { container } = renderPanel('c1');
    expect(container.querySelector('.side-threads-panel')).toBeNull();
  });

  it('a draft (triggered, not yet sent) shows "Off <quote>" and an empty composer', () => {
    seedBranches('c1');
    openSideThreadDraft('c1', 4, 'the original message');
    renderPanel('c1');

    expect(screen.getByTestId('side-threads-panel')).toBeTruthy();
    expect(screen.getByTestId('stp-draft').textContent).toContain('the original message');
    expect(screen.getByTestId('stp-draft-composer')).toBeTruthy();
  });

  it('sending from the draft fires chat.side_request with the typed message and no branchId', () => {
    const ws = fakeWs();
    setActiveWs(ws as unknown as PatchWs);
    seedBranches('c1');
    openSideThreadDraft('c1', 4, 'the original message');
    renderPanel('c1');

    fireEvent.change(screen.getByTestId('stp-draft-composer'), {
      target: { value: 'what did you mean?' },
    });
    fireEvent.click(screen.getByTestId('stp-draft-send'));

    expect(ws.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.side_request',
        chatId: 'c1',
        seq: 4,
        message: 'what did you mean?',
      }),
    );
    const sent = ws.send.mock.calls[0]![0];
    expect(sent.branchId).toBeUndefined();
    // The draft stays up — the panel doesn't jump elsewhere — until the real branch lands.
    expect(useSideThreadsStore.getState().draftByChatId['c1']).toBeDefined();
    expect(screen.getByTestId('stp-draft')).toBeTruthy();
  });

  it('sending from a draft does not flip to another existing thread before the new one lands', () => {
    setActiveWs(fakeWs() as unknown as PatchWs);
    const existing = {
      branchId: 'c1-b1',
      parentBranchId: 'c1-b0',
      forkFromSeq: 2,
      label: 'side 1',
      createdAt: 1,
      sideThread: true,
    };
    seedBranches('c1', [existing]);
    openSideThreadDraft('c1', 4, 'q');
    renderPanel('c1');
    fireEvent.change(screen.getByTestId('stp-draft-composer'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByTestId('stp-draft-send'));
    expect(screen.queryByTestId('stp-body-c1-b1')).toBeNull();
    expect(screen.getByTestId('stp-draft')).toBeTruthy();

    act(() => {
      seedBranches('c1', [
        existing,
        { ...existing, branchId: 'c1-b2', forkFromSeq: 4, label: 'side 2', createdAt: 2 },
      ]);
    });
    expect(useSideThreadsStore.getState().activeTabByChatId['c1']).toBe('c1-b2');
    expect(useSideThreadsStore.getState().draftByChatId['c1']).toBeUndefined();
  });

  it('the reconciler opens the panel on the real branch once chat.branches reports it', async () => {
    setActiveWs(fakeWs() as unknown as PatchWs);
    seedBranches('c1');
    openSideThreadDraft('c1', 4, 'q');
    renderPanel('c1');
    fireEvent.change(screen.getByTestId('stp-draft-composer'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByTestId('stp-draft-send'));

    // The host mints the branch and reports it on chat.branches.
    seedBranches('c1', [
      {
        branchId: 'c1-b1',
        parentBranchId: 'c1-b0',
        forkFromSeq: 4,
        label: 'side 1',
        createdAt: 1,
        sideThread: true,
      },
    ]);

    await waitFor(() => {
      expect(useSideThreadsStore.getState().activeTabByChatId['c1']).toBe('c1-b1');
    });
    expect(await screen.findByTestId('stp-tab-c1-b1')).toBeTruthy();
  });

  it("does NOT auto-open a chat's PRE-EXISTING side threads just because the panel mounted", () => {
    seedBranches('c1', [
      {
        branchId: 'c1-b1',
        parentBranchId: 'c1-b0',
        forkFromSeq: 4,
        label: 'side 1',
        createdAt: 1,
        sideThread: true,
      },
    ]);
    const { container } = renderPanel('c1');
    // No pendingNewTab was ever armed, so the panel stays closed even though
    // a side thread already exists.
    expect(container.querySelector('.side-threads-panel')).toBeNull();
  });

  it('tabs show a status dot, switch on click, and support send/stop/send-back', async () => {
    const ws = fakeWs();
    setActiveWs(ws as unknown as PatchWs);
    seedBranches('c1', [
      {
        branchId: 'c1-b1',
        parentBranchId: 'c1-b0',
        forkFromSeq: 4,
        label: 'side 1',
        createdAt: 1,
        sideThread: true,
        running: true,
      },
    ]);
    openExistingSideThread('c1', 'c1-b1');
    renderPanel('c1');

    expect(await screen.findByTestId('stp-body-c1-b1')).toBeTruthy();
    expect(screen.getByTestId('stp-status-dot').className).toContain('running');

    fireEvent.change(screen.getByTestId('stp-composer-c1-b1'), {
      target: { value: 'follow-up' },
    });
    fireEvent.click(screen.getByTestId('stp-send-c1-b1'));
    expect(ws.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.input',
        chatId: 'c1',
        branchId: 'c1-b1',
        message: 'follow-up',
      }),
    );

    fireEvent.click(screen.getByTestId('stp-stop'));
    expect(ws.send).toHaveBeenCalledWith({
      type: 'chat.stop_request',
      chatId: 'c1',
      branchId: 'c1-b1',
    });

    fireEvent.click(screen.getByTestId('stp-send-back'));
    expect(ws.send).toHaveBeenCalledWith({
      type: 'chat.send_back_request',
      chatId: 'c1',
      branchId: 'c1-b1',
    });
  });

  it('"Send back to chat" is disabled once sentBack is true', async () => {
    seedBranches('c1', [
      {
        branchId: 'c1-b1',
        parentBranchId: 'c1-b0',
        forkFromSeq: 4,
        label: 'side 1',
        createdAt: 1,
        sideThread: true,
        sentBack: true,
      },
    ]);
    openExistingSideThread('c1', 'c1-b1');
    renderPanel('c1');
    const btn = await screen.findByTestId('stp-send-back');
    expect(btn).toBeDisabled();
    expect(btn.textContent).toBe('Sent back');
  });

  it('closing a tab hides it; the thread (branch) itself is untouched', async () => {
    seedBranches('c1', [
      {
        branchId: 'c1-b1',
        parentBranchId: 'c1-b0',
        forkFromSeq: 4,
        label: 'side 1',
        createdAt: 1,
        sideThread: true,
      },
    ]);
    openExistingSideThread('c1', 'c1-b1');
    renderPanel('c1');
    expect(await screen.findByTestId('stp-tab-c1-b1')).toBeTruthy();

    fireEvent.click(screen.getByTestId('stp-tab-close-c1-b1'));
    expect(screen.queryByTestId('stp-tab-c1-b1')).toBeNull();
    // The branch is still in the graph — only the UI tab is gone.
    expect(
      useChatStore.getState().branchGraphs['c1']?.branches.some((b) => b.branchId === 'c1-b1'),
    ).toBe(true);
  });

  it("a permission card renders for the branch's own question, and Approve sends + clears it", async () => {
    const ws = fakeWs();
    setActiveWs(ws as unknown as PatchWs);
    seedBranches('c1', [
      {
        branchId: 'c1-b1',
        parentBranchId: 'c1-b0',
        forkFromSeq: 4,
        label: 'side 1',
        createdAt: 1,
        sideThread: true,
      },
    ]);
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'c1',
      requestId: 'r1',
      request: { tool: 'Bash', args: { cmd: 'ls' }, description: 'list files' },
      seq: 1,
      branchId: 'c1-b1',
    });
    openExistingSideThread('c1', 'c1-b1');
    renderPanel('c1');

    expect(await screen.findByTestId('stp-permission-card')).toBeTruthy();
    fireEvent.click(screen.getByTestId('stp-permission-approve'));
    expect(ws.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.permission_response',
        chatId: expect.any(String),
        requestId: 'r1',
        approve: true,
      }),
    );
    expect(useChatStore.getState().sideThreadPermissions['c1::c1-b1']).toHaveLength(0);
  });

  it('branching again from a message inside a tab opens a draft with fromBranchId set to that tab', async () => {
    vi.mocked(api.getChatHistory).mockResolvedValue({
      events: [{ seq: 10, role: 'assistant', content: 'the answer' }],
    });
    seedBranches('c1', [
      {
        branchId: 'c1-b1',
        parentBranchId: 'c1-b0',
        forkFromSeq: 4,
        label: 'side 1',
        createdAt: 1,
        sideThread: true,
      },
    ]);
    openExistingSideThread('c1', 'c1-b1');
    renderPanel('c1');

    const branchAgainBtn = await screen.findByTestId('stp-branch-again-10');
    fireEvent.click(branchAgainBtn);

    expect(useSideThreadsStore.getState().draftByChatId['c1']).toEqual({
      seq: 10,
      quotedMessage: 'the answer',
      fromBranchId: 'c1-b1',
    });
    expect(useSideThreadsStore.getState().activeTabByChatId['c1']).toBe(DRAFT_TAB_ID);
  });
});

describe('SideThreadsPanel — alongside tabs', () => {
  it('hides while another chat has focus and comes back, state intact, when its tab does', () => {
    seedBranches('c1');
    seedBranches('c2');
    openSideThreadDraft('c1', 4, 'the original message');
    renderPanel('c1');
    expect(screen.getByTestId('side-threads-panel')).toBeTruthy();

    act(() => {
      useLayoutStore.getState().openTab({ kind: 'chat', chatId: 'c2' }, { placement: 'tab' });
    });
    expect(screen.queryByTestId('side-threads-panel')).toBeNull();

    act(() => {
      const l = useLayoutStore.getState();
      const pane = l.root as import('../stores/layoutStore.js').LeafPane;
      l.setActiveTab(pane.id, pane.tabs.find((t) => t.id.includes('c1'))!.id);
    });
    expect(screen.getByTestId('stp-draft').textContent).toContain('the original message');
  });

  it('a draft tab can be closed like any other tab', () => {
    seedBranches('c1');
    openSideThreadDraft('c1', 4, 'the original message');
    const { container } = renderPanel('c1');
    fireEvent.click(screen.getByTestId('stp-tab-close-draft'));
    expect(container.querySelector('.side-threads-panel')).toBeNull();
  });
});
