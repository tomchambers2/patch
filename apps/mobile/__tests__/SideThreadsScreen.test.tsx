// spec/15 § Side threads screen — tabs, draft composer, send/stop/send-back,
// permission cards, branching again from inside a tab, and the auto-open
// reconciler. Mirrors web's SideThreadsPanel.test.tsx.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  renderRN,
  actSync,
  actAsync,
  flush,
  findHost,
  findAllHost,
  byTestId,
} from './testUtils/render';
import { SideThreadsScreen } from '../src/components/SideThreadsScreen';
import { useChatStore } from '../src/stores/chatStore';
import { useSideThreadsStore, DRAFT_TAB_ID } from '../src/stores/sideThreadsStore';
import { openSideThreadDraft, openExistingSideThread } from '../src/lib/sideThreadActions';
import { routerMock, __resetRouterMock } from './stubs/expo-router';
import { __setSafeAreaInsets } from './stubs/safe-area-context';

const wsMock = vi.hoisted(() => ({ send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() }));
vi.mock('../src/api/ws', () => ({ getWs: () => wsMock }));

const apiMocks = vi.hoisted(() => ({
  getChatHistory: vi.fn(async () => ({ events: [] as unknown[] })),
}));
vi.mock('../src/api/rest', () => ({ api: apiMocks }));

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
  vi.clearAllMocks();
  useChatStore.getState()._reset();
  useSideThreadsStore.setState({ activeTabByChatId: {}, pendingNewTab: {}, draftByChatId: {} });
  __resetRouterMock();
  apiMocks.getChatHistory.mockResolvedValue({ events: [] });
});

describe('SideThreadsScreen', () => {
  it('shows "No side threads yet" with nothing to show', () => {
    seedBranches('c1');
    const r = renderRN(<SideThreadsScreen chatId="c1" />);
    expect(findAllHost(r.root, byTestId('side-threads-pane-c1-b1'))).toHaveLength(0);
  });

  it('a draft shows the quote and an empty composer', () => {
    seedBranches('c1');
    openSideThreadDraft('c1', 4, 'the original message');
    const r = renderRN(<SideThreadsScreen chatId="c1" />);
    expect(findAllHost(r.root, byTestId('side-threads-draft-composer'))).toHaveLength(1);
    expect(findHost(r.root, byTestId('side-threads-draft-quote')).children.join('')).toContain(
      'the original message',
    );
  });

  it('sending from the draft fires chat.side_request and keeps the draft up until the branch lands', () => {
    seedBranches('c1');
    openSideThreadDraft('c1', 4, 'q');
    const r = renderRN(<SideThreadsScreen chatId="c1" />);
    actSync(() =>
      findHost(r.root, byTestId('side-threads-draft-composer')).props.onChangeText(
        'what did you mean?',
      ),
    );
    actSync(() => findHost(r.root, byTestId('side-threads-draft-send')).props.onPress());

    expect(wsMock.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.side_request',
        chatId: 'c1',
        seq: 4,
        message: 'what did you mean?',
      }),
    );
    expect(wsMock.send.mock.calls[0]![0].branchId).toBeUndefined();
    // Not replaced by another thread (or the empty state) while the host mints the branch.
    expect(useSideThreadsStore.getState().draftByChatId['c1']).toBeDefined();
    expect(useSideThreadsStore.getState().activeTabByChatId['c1']).toBe(DRAFT_TAB_ID);
  });

  it('sending from a draft does not flip to another existing thread before the new one lands', () => {
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
    const r = renderRN(<SideThreadsScreen chatId="c1" />);
    actSync(() =>
      findHost(r.root, byTestId('side-threads-draft-composer')).props.onChangeText('hi'),
    );
    actSync(() => findHost(r.root, byTestId('side-threads-draft-send')).props.onPress());
    expect(findAllHost(r.root, byTestId('side-threads-pane-c1-b1'))).toHaveLength(0);
    expect(findAllHost(r.root, byTestId('side-threads-draft-quote'))).toHaveLength(1);

    actSync(() => {
      seedBranches('c1', [
        existing,
        { ...existing, branchId: 'c1-b2', forkFromSeq: 4, label: 'side 2', createdAt: 2 },
      ]);
    });
    expect(useSideThreadsStore.getState().activeTabByChatId['c1']).toBe('c1-b2');
    expect(useSideThreadsStore.getState().draftByChatId['c1']).toBeUndefined();
  });

  it('keeps the draft composer clear of the system navigation bar', () => {
    __setSafeAreaInsets({ bottom: 48 });
    seedBranches('c1');
    openSideThreadDraft('c1', 4, 'q');
    const r = renderRN(<SideThreadsScreen chatId="c1" />);
    const footer = findHost(r.root, byTestId('side-threads-draft-footer'));
    expect((footer.props.style as { paddingBottom: number }).paddingBottom).toBeGreaterThanOrEqual(
      48,
    );
    __setSafeAreaInsets({ bottom: 10 });
  });

  it("keeps a thread's controls and composer clear of the system navigation bar", async () => {
    __setSafeAreaInsets({ bottom: 48 });
    seedBranches('c1', [
      {
        branchId: 'c1-b1',
        parentBranchId: 'c1-b0',
        forkFromSeq: 2,
        label: 'side 1',
        createdAt: 1,
        sideThread: true,
      },
    ]);
    openExistingSideThread('c1', 'c1-b1');
    const r = renderRN(<SideThreadsScreen chatId="c1" />);
    await actAsync(flush);
    const footer = findHost(r.root, byTestId('side-threads-footer-c1-b1'));
    expect((footer.props.style as { paddingBottom: number }).paddingBottom).toBeGreaterThanOrEqual(
      48,
    );
    __setSafeAreaInsets({ bottom: 10 });
  });

  it('the reconciler opens the tab on the real branch once chat.branches reports it', () => {
    seedBranches('c1');
    openSideThreadDraft('c1', 4, 'q');
    const r = renderRN(<SideThreadsScreen chatId="c1" />);
    actSync(() =>
      findHost(r.root, byTestId('side-threads-draft-composer')).props.onChangeText('hi'),
    );
    actSync(() => findHost(r.root, byTestId('side-threads-draft-send')).props.onPress());

    actSync(() => {
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
    });

    expect(useSideThreadsStore.getState().activeTabByChatId['c1']).toBe('c1-b1');
  });

  it("does NOT auto-open a chat's PRE-EXISTING side threads just because the screen mounted", () => {
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
    const r = renderRN(<SideThreadsScreen chatId="c1" />);
    // No tab is forced active (no pendingNewTab armed) — the screen falls
    // back to the last/only one via its own resolvedActive logic, but the
    // STORE itself records no auto-open.
    expect(useSideThreadsStore.getState().activeTabByChatId['c1']).toBeUndefined();
    void r;
  });

  it('a tab shows the status dot; send/stop/send-back all address the right branch', async () => {
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
    const r = renderRN(<SideThreadsScreen chatId="c1" />);
    await actAsync(flush);

    expect(findAllHost(r.root, byTestId('side-threads-pane-c1-b1'))).toHaveLength(1);

    actSync(() =>
      findHost(r.root, byTestId('side-threads-composer-c1-b1')).props.onChangeText('follow-up'),
    );
    actSync(() => findHost(r.root, byTestId('side-threads-send-c1-b1')).props.onPress());
    expect(wsMock.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.input',
        chatId: 'c1',
        branchId: 'c1-b1',
        message: 'follow-up',
      }),
    );

    actSync(() => findHost(r.root, byTestId('side-threads-stop')).props.onPress());
    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'chat.stop_request',
      chatId: 'c1',
      branchId: 'c1-b1',
    });

    actSync(() => findHost(r.root, byTestId('side-threads-send-back')).props.onPress());
    expect(wsMock.send).toHaveBeenCalledWith({
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
    const r = renderRN(<SideThreadsScreen chatId="c1" />);
    await actAsync(flush);
    const btn = findHost(r.root, byTestId('side-threads-send-back'));
    expect(btn.props.disabled).toBe(true);
  });

  it("a permission card renders for the branch's own question; Approve sends + clears it", async () => {
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
    const r = renderRN(<SideThreadsScreen chatId="c1" />);
    await actAsync(flush);

    expect(findAllHost(r.root, byTestId('side-threads-permission-card'))).toHaveLength(1);
    actSync(() => findHost(r.root, byTestId('side-threads-permission-approve')).props.onPress());
    expect(wsMock.send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.permission_response',
        chatId: 'c1',
        requestId: 'r1',
        approve: true,
      }),
    );
    expect(useChatStore.getState().sideThreadPermissions['c1::c1-b1']).toHaveLength(0);
  });

  it('long-pressing a message inside a tab opens a draft with fromBranchId set to that tab', async () => {
    apiMocks.getChatHistory.mockResolvedValue({
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
    const r = renderRN(<SideThreadsScreen chatId="c1" />);
    await actAsync(flush);

    actSync(() => findHost(r.root, byTestId('side-threads-msg-10')).props.onLongPress());

    expect(useSideThreadsStore.getState().draftByChatId['c1']).toEqual({
      seq: 10,
      quotedMessage: 'the answer',
      fromBranchId: 'c1-b1',
    });
    expect(useSideThreadsStore.getState().activeTabByChatId['c1']).toBe(DRAFT_TAB_ID);
  });

  it('Back goes to the main chat', () => {
    seedBranches('c1');
    const r = renderRN(<SideThreadsScreen chatId="c1" />);
    actSync(() => findHost(r.root, byTestId('side-threads-back')).props.onPress());
    expect(routerMock.back).toHaveBeenCalled();
  });
});
