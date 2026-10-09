import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { JSX } from 'react';
import { render as rtlRender, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { ChatHeader } from '../components/ChatHeader.js';
import { ConfirmModal } from '../components/ConfirmModal.js';
import type { ChatRow } from '../stores/types.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { useSideThreadsStore } from '../stores/sideThreadsStore.js';
import { api } from '../api/rest.js';
import * as newWindowLib from '../lib/newWindow.js';

vi.mock('../api/rest.js', () => ({
  api: {
    deleteChat: vi.fn(),
    pinChat: vi.fn(),
    renameChat: vi.fn(),
    archiveChat: vi.fn(),
    rotateChat: vi.fn(),
  },
}));

// The header's Back/Forward (navigateAfterArchive) needs a Router around it.
function render(ui: JSX.Element, path = '/chats/c1'): ReturnType<typeof rtlRender> {
  return rtlRender(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={ui} />
      </Routes>
    </MemoryRouter>,
  );
}

// Delete, Tools, Snooze, Move and (special threads) Disable/Clear context all
// live behind the ⋯ overflow menu now (spec/14 § Chat panel header).
function openMore(): void {
  fireEvent.click(screen.getByTestId('action-more'));
}

function row(overrides: Partial<ChatRow> = {}): ChatRow {
  return {
    pendingWake: null,
    todos: [],
    snoozedUntil: null,
    chatId: 'c1',
    daemonId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    name: 'fix layout',
    folder: '~/projects/foo',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: 0,
    lastUserActivity: 0,
    awaitingPermission: false,
    lastReadSeq: -1,
    preview: null,
    goal: null,
    goalProgress: null,
    lastGoal: null,
    reminder: null,
    statusSummary: null,
    statusKind: null,
    statusDeclared: null,
    pendingPermissions: [],
    lastSeq: 0,
    jobId: null,
    model: null,
    rateLimitResumingAt: null,
    resumeKind: null,
    ...overrides,
  };
}

describe('ChatHeader', () => {
  beforeEach(() => {
    // Kebab open-state lives in the shared chat store; reset between tests so a
    // prior test's open kebab doesn't toggle the next one closed.
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    // Clear any confirm left pending by a prior test (resolves its promise).
    useUiStore.getState().resolveConfirm(false);
    vi.mocked(api.deleteChat)
      .mockReset()
      .mockResolvedValue(undefined as never);
    vi.mocked(api.pinChat)
      .mockReset()
      .mockResolvedValue(undefined as never);
    vi.mocked(api.renameChat)
      .mockReset()
      .mockResolvedValue(undefined as never);
    vi.mocked(api.archiveChat)
      .mockReset()
      .mockResolvedValue(undefined as never);
    vi.mocked(api.rotateChat).mockReset().mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    cleanup();
  });

  it('the ⋯ menu offers Move to…, which opens the Move dialog (spec/04 § Moving a chat)', () => {
    render(<ChatHeader row={row()} />);
    openMore();
    fireEvent.click(screen.getByTestId('action-move'));
    expect(screen.getByTestId('move-chat-modal')).toBeTruthy();
    expect(screen.queryByTestId('head-menu')).toBeNull();
    fireEvent.click(screen.getByTestId('move-chat-cancel'));
    expect(screen.queryByTestId('move-chat-modal')).toBeNull();
  });

  it('shows folder · host only in the title hover, never as a line in the bar', () => {
    render(
      <ChatHeader row={row({ daemonId: 'ubuntu-4gb-hel1-1', folder: '~/projects/portfolio' })} />,
    );
    const title = screen.getByTestId('chat-title');
    expect(title.textContent).toBe('fix layout');
    expect(title).toHaveAttribute('title', 'portfolio · ubuntu-4gb-hel1-1');
    const head = screen.getByTestId('chat-head');
    expect(screen.queryByTestId('folder-path')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-host')).not.toBeInTheDocument();
    expect(head.querySelector('.chat-head-crumb')).toBeNull();
    expect(head.querySelector('.chat-head-subline')).toBeNull();
  });

  it('draws no usage bar in the header', () => {
    render(<ChatHeader row={row({ context: { tokens: 1000, percent: 10 } as never })} />);
    expect(screen.getByTestId('chat-head').querySelector('.chat-usage-crumb')).toBeNull();
  });

  // patch/todo.md — "show which model is in use on the top bar". Shown as a
  // third crumb segment next to the folder, not in the cramped action rail.
  // The model control lives in the composer's action row now (spec/14 §
  // Composer), beside the approval mode — the header crumb no longer carries it.
  it('carries no model in the header — it lives in the composer', () => {
    render(<ChatHeader row={row({ model: 'claude-sonnet-4-6' })} />);
    expect(screen.queryByTestId('chat-model')).not.toBeInTheDocument();
  });

  // G2-d6 / G2-d4: an unnamed chat must NOT show the raw ULID as the header
  // title. Nor the folder — that titled every chat in a project identically —
  // so until the AI name lands it reads "New chat".
  it('reads "New chat", never the raw ULID or the folder, when name is null', () => {
    const ulid = '01KVBD4HJF0N90DYVTDWEBH7FP';
    render(<ChatHeader row={row({ chatId: ulid, name: null, folder: '~/projects/foo' })} />);
    const title = screen.getByTestId('chat-title').textContent ?? '';
    expect(title).not.toBe(ulid);
    expect(title).not.toBe('foo');
    expect(title).toBe('New chat');
  });

  it('falls back to "New chat" when name, timeline, and folder are all empty', () => {
    const ulid = '01KVBD4HJF0N90DYVTDWEBH7FP';
    render(<ChatHeader row={row({ chatId: ulid, name: null, folder: '' })} />);
    const title = screen.getByTestId('chat-title').textContent ?? '';
    expect(title).not.toBe(ulid);
    expect(title).toBe('New chat');
  });

  // spec/04 § Name: the title is the AI-generated name; until it lands the row
  // reads "New chat" — NEVER the first user message. A chat with a timeline but
  // no name is still unnamed, not titled by its opening line.
  it('never uses the first user message as the header title', () => {
    const ulid = '01KVBD4HJF0N90DYVTDWEBH7FP';
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        [ulid]: [{ seq: 0, kind: 'message', role: 'user', content: 'plan the sea essay', at: 0 }],
      },
    }));
    render(<ChatHeader row={row({ chatId: ulid, name: null, folder: '~/projects/foo' })} />);
    const title = screen.getByTestId('chat-title').textContent ?? '';
    expect(title).toBe('New chat');
    expect(title).not.toBe('plan the sea essay');
  });

  // spec/14 § Chat panel header: the reversible actions are direct top-right
  // icons. Only the destructive one is behind the ⋯ menu.
  it('renders Editor, Archive and the ⋯ overflow as direct top-right icons', () => {
    render(<ChatHeader row={row()} />);
    const actions = screen.getByTestId('chat-head-actions');
    for (const id of ['action-editor', 'action-archive', 'action-more']) {
      const btn = screen.getByTestId(id);
      expect(actions.contains(btn)).toBe(true);
    }
  });

  // App Updates: "the button should be on the normal button rail top right" —
  // Tools used to be an ordinary rail icon. It is now inside the ⋯ overflow
  // (spec/14 § Chat panel header), alongside Snooze/Move/Delete, so the rail
  // itself stays down to Editor + Archive.
  describe('Tools action', () => {
    beforeEach(() => {
      useUiStore.setState({ toolsPanelChatId: null });
    });

    it('is not a direct rail icon — it lives inside the ⋯ overflow menu', () => {
      render(<ChatHeader row={row()} />);
      // Not visible as its own icon until the ⋯ menu is opened.
      expect(screen.queryByTestId('action-tools')).not.toBeInTheDocument();
      openMore();
      expect(screen.getByTestId('head-menu').contains(screen.getByTestId('action-tools'))).toBe(
        true,
      );
      expect(screen.queryByTestId('right-toolbar')).not.toBeInTheDocument();
    });

    it('opens the Tools sidebar for THIS chat', () => {
      render(<ChatHeader row={row({ chatId: 'c-tools' })} />);
      openMore();
      fireEvent.click(screen.getByTestId('action-tools'));
      expect(useUiStore.getState().toolsPanelChatId).toBe('c-tools');
      // Picking it closes the ⋯ menu, same as every other item in it.
      expect(screen.queryByTestId('head-menu')).not.toBeInTheDocument();
    });

    it('shows for special threads too', () => {
      render(<ChatHeader row={row({ chatId: 'thread_manager' })} />);
      openMore();
      expect(screen.getByTestId('action-tools')).toBeInTheDocument();
    });
  });

  // spec/14 § Side threads panel — "A Threads icon in the chat header opens
  // the panel with all this chat's side threads."
  describe('Threads action', () => {
    beforeEach(() => {
      useSideThreadsStore.setState({ panelChatId: null, activeTabByChatId: {} });
    });

    it('is absent when the chat has no side threads', () => {
      render(<ChatHeader row={row({ chatId: 'c-nothreads' })} />);
      expect(screen.queryByTestId('action-threads')).not.toBeInTheDocument();
    });

    it('opens the panel on the most recently created side thread', () => {
      useChatStore.getState().applyEvent({
        type: 'chat.branches',
        chatId: 'c-threads',
        activeBranchId: 'c-threads-b0',
        branches: [
          {
            branchId: 'c-threads-b0',
            parentBranchId: null,
            forkFromSeq: null,
            label: 'main',
            createdAt: 0,
          },
          {
            branchId: 'c-threads-b1',
            parentBranchId: 'c-threads-b0',
            forkFromSeq: 1,
            label: 'side 1',
            createdAt: 1,
            sideThread: true,
          },
        ],
      });
      render(<ChatHeader row={row({ chatId: 'c-threads' })} />);
      fireEvent.click(screen.getByTestId('action-threads'));
      expect(useSideThreadsStore.getState().panelChatId).toBe('c-threads');
      expect(useSideThreadsStore.getState().activeTabByChatId['c-threads']).toBe('c-threads-b1');
    });
  });

  // spec/14 § Chat panel header, § Panes and tabs — the Editor control opens
  // (or focuses) this chat's Files tab; a second click while it's already the
  // focused tab closes it instead (`layoutStore.toggleTab`).
  describe('quick links below the header (Files, Terminal)', () => {
    it('Files link opens the Files tab, Terminal link opens the terminal tab', () => {
      useLayoutStore.getState()._reset();
      render(<ChatHeader row={row()} />);
      const links = screen.getByTestId('chat-quicklinks');
      expect(links.previousElementSibling).toBe(screen.getByTestId('chat-head'));
      fireEvent.click(within(links).getByTestId('quicklink-files'));
      expect(
        useLayoutStore.getState().findTab({ kind: 'page', page: 'files', chatId: 'c1' }),
      ).not.toBeNull();
      fireEvent.click(within(links).getByTestId('quicklink-terminal'));
      expect(useLayoutStore.getState().findTab({ kind: 'terminal', chatId: 'c1' })).not.toBeNull();
    });
  });

  describe('Editor action (opens the Files tab)', () => {
    it('opens the Files tab when it is not open', () => {
      useLayoutStore.getState()._reset();
      render(<ChatHeader row={row()} />);
      fireEvent.click(screen.getByTestId('action-editor'));
      expect(
        useLayoutStore.getState().findTab({ kind: 'page', page: 'files', chatId: 'c1' }),
      ).not.toBeNull();
    });

    it('closes the Files tab on a second click when it is already the focused tab', () => {
      useLayoutStore.getState()._reset();
      useLayoutStore.getState().openTab({ kind: 'page', page: 'files', chatId: 'c1' });
      render(<ChatHeader row={row()} />);
      fireEvent.click(screen.getByTestId('action-editor'));
      expect(
        useLayoutStore.getState().findTab({ kind: 'page', page: 'files', chatId: 'c1' }),
      ).toBeNull();
    });

    it('shows for special threads too', () => {
      render(<ChatHeader row={row({ chatId: 'thread_manager' })} />);
      expect(screen.getByTestId('action-editor')).toBeInTheDocument();
    });
  });

  // spec/14 § Chat panel header — shown for every chat, including special
  // threads (unlike Archive/the ⋯ menu), since opening it in a new window is
  // reversible and applies just as well to Manager or Speakers. It
  // sits beside the title now, not in the action rail.
  describe('Open chat in new window action', () => {
    it('calls openChatInNewWindow with the chat id', () => {
      const spy = vi.spyOn(newWindowLib, 'openChatInNewWindow').mockImplementation(() => {});
      render(<ChatHeader row={row({ chatId: 'c-window' })} />);
      const btn = screen.getByTestId('action-open-window');
      expect(screen.getByTestId('chat-head-actions').contains(btn)).toBe(false);
      fireEvent.click(btn);
      expect(spy).toHaveBeenCalledWith('c-window', '');
    });

    // A chat opened from a sidebar search result carries `?seq=N` in the URL
    // (ChatRoute's jump-to) — the popout must land on the same message, so the
    // query string has to travel with it rather than being dropped.
    it('carries over the current URL’s query string (e.g. a search result’s ?seq=N)', () => {
      const spy = vi.spyOn(newWindowLib, 'openChatInNewWindow').mockImplementation(() => {});
      render(<ChatHeader row={row({ chatId: 'c-window' })} />, '/chats/c-window?seq=42');
      fireEvent.click(screen.getByTestId('action-open-window'));
      expect(spy).toHaveBeenCalledWith('c-window', '?seq=42');
    });

    it('shows for special threads too', () => {
      render(<ChatHeader row={row({ chatId: 'thread_manager' })} />);
      expect(screen.getByTestId('action-open-window')).toBeInTheDocument();
    });
  });

  // spec/14 § Chat panel header — Pin is removed from the header entirely; it
  // keeps its place in the sidebar row's right-click menu (§ Row context menu).
  it('renders no Pin control anywhere in the header', () => {
    render(<ChatHeader row={row({ pinned: false })} />);
    expect(screen.queryByTestId('action-pin')).not.toBeInTheDocument();
    openMore();
    expect(screen.queryByTestId('action-pin')).not.toBeInTheDocument();
  });

  it('shows the waiting-on-you pill when awaiting permission', () => {
    render(<ChatHeader row={row({ awaitingPermission: true, activity: 'awaiting-permission' })} />);
    expect(screen.getByTestId('waiting-on-you')).toBeInTheDocument();
  });

  // A `running` chat used to also draw an orange dot here, but that was a
  // third copy of the same signal the sidebar badge and the transcript's own
  // "Thinking…" dots already show — dropped (see ChatHeader.tsx).
  it('shows no thinking dot next to the title while the chat is running', () => {
    render(<ChatHeader row={row({ activity: 'running' })} />);
    expect(screen.queryByTestId('thinking-dot')).not.toBeInTheDocument();
  });

  it('shows Archive directly, with Tools/Snooze/Move/Delete only inside the ⋯ menu', () => {
    render(<ChatHeader row={row()} />);
    // Archive is the default, directly-clickable action.
    expect(screen.getByTestId('action-archive')).toBeInTheDocument();
    // None of these are in the rail — they are behind the ⋯ menu.
    for (const id of ['action-tools', 'action-move', 'action-delete']) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument();
    }
    expect(screen.queryByTestId('menu-snooze-row')).not.toBeInTheDocument();
    openMore();
    for (const id of ['action-tools', 'action-move', 'action-delete']) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    expect(screen.getByTestId('menu-snooze-row')).toBeInTheDocument();
  });

  // The delete confirmation must name the chat by its human-readable title (the
  // same title shown in the header), never the raw ULID. Shown in the custom
  // modal (not the OS-native confirm()).
  it('delete confirmation names the chat by its human title, not the ULID', async () => {
    const ulid = '01KVBV1ETA89AXS1F67TV5BVE2';
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        [ulid]: [
          {
            seq: 0,
            kind: 'message',
            role: 'user',
            content: 'Run this exact bash command now without asking',
            at: 0,
          },
        ],
      },
    }));
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(
      <>
        <ChatHeader row={row({ chatId: ulid, name: null })} />
        <ConfirmModal />
      </>,
    );
    const shownTitle = screen.getByTestId('chat-title').textContent ?? '';
    openMore();
    fireEvent.click(screen.getByTestId('action-delete'));
    // No native dialog — the message is carried by the custom modal instead.
    expect(confirmSpy).not.toHaveBeenCalled();
    const modal = await screen.findByTestId('confirm-modal');
    const message = modal.textContent ?? '';
    expect(message).toContain(shownTitle);
    expect(message).not.toContain(ulid);
    confirmSpy.mockRestore();
  });

  it.each(['thread_manager', 'thread_speakers'])(
    'hides Archive for the special thread %s, but keeps Editor/Open in new window/the ⋯ menu',
    (chatId) => {
      render(<ChatHeader row={row({ chatId })} />);
      expect(screen.getByTestId('action-editor')).toBeInTheDocument();
      expect(screen.getByTestId('action-open-window')).toBeInTheDocument();
      expect(screen.queryByTestId('action-pin')).not.toBeInTheDocument();
      // Special threads can't be archived or deleted, so neither the archive
      // icon nor Move/Delete is offered at all — but the ⋯ menu itself still
      // shows, since it's the only door to Tools/Disable/Clear context.
      expect(screen.queryByTestId('action-archive')).not.toBeInTheDocument();
      expect(screen.getByTestId('action-more')).toBeInTheDocument();
      openMore();
      expect(screen.getByTestId('action-tools')).toBeInTheDocument();
      expect(screen.queryByTestId('action-move')).not.toBeInTheDocument();
      expect(screen.queryByTestId('action-delete')).not.toBeInTheDocument();
      expect(screen.queryByTestId('menu-snooze-row')).not.toBeInTheDocument();
      // Session rotation only makes sense for a special thread's ever-growing
      // context, so Disable and Clear context are offered here...
      expect(screen.getByTestId('action-disable')).toBeInTheDocument();
      expect(screen.getByTestId('action-clear-context')).toBeInTheDocument();
    },
  );

  it('hides Disable + Clear context for an ordinary chat', () => {
    render(<ChatHeader row={row({ chatId: 'c1' })} />);
    openMore();
    // ...and absent for an ordinary chat, whose equivalent is a new chat.
    expect(screen.queryByTestId('action-disable')).not.toBeInTheDocument();
    expect(screen.queryByTestId('action-clear-context')).not.toBeInTheDocument();
  });

  it('Clear context calls rotateChat for the special thread', () => {
    render(<ChatHeader row={row({ chatId: 'thread_manager' })} />);
    openMore();
    fireEvent.click(screen.getByTestId('action-clear-context'));
    expect(api.rotateChat).toHaveBeenCalledWith('thread_manager');
  });

  it('Clear context surfaces a toast on API failure', async () => {
    vi.mocked(api.rotateChat).mockRejectedValueOnce(new Error('host offline'));
    render(<ChatHeader row={row({ chatId: 'thread_manager' })} />);
    openMore();
    fireEvent.click(screen.getByTestId('action-clear-context'));
    await vi.waitFor(() => {
      expect(useUiStore.getState().errors[0]?.message).toContain('Clear context failed');
    });
  });

  // Archive is the header's default "I'm done with this chat" action (spec/14
  // § Chat panel header) — one click, no confirmation, optimistic like pin.
  it('archives the chat optimistically and persists via the API', async () => {
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    render(<ChatHeader row={row()} />);
    fireEvent.click(screen.getByTestId('action-archive'));
    expect(useChatStore.getState().chats['c1']?.status).toBe('archived');
    expect(api.archiveChat).toHaveBeenCalledWith('c1', true);
  });

  it('archive reverts the optimistic flip + surfaces a toast on API failure', async () => {
    vi.mocked(api.archiveChat).mockRejectedValueOnce(new Error('network down'));
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    render(<ChatHeader row={row()} />);
    fireEvent.click(screen.getByTestId('action-archive'));
    expect(useChatStore.getState().chats['c1']?.status).toBe('archived'); // optimistic
    await vi.waitFor(() => {
      // NO FALLBACK — the failure is surfaced and the row goes back to active.
      expect(useChatStore.getState().chats['c1']?.status).toBe('active');
    });
    expect(useUiStore.getState().errors[0]?.message).toContain('Archive failed');
  });

  // Archive toggles, like pin: an archived chat's icon offers the way back.
  it('reads as Unarchive and unarchives when the chat is already archived', () => {
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    render(<ChatHeader row={row({ status: 'archived' })} />);
    const btn = screen.getByTestId('action-archive');
    expect(btn.getAttribute('aria-label')).toBe('Unarchive chat');
    fireEvent.click(btn);
    expect(api.archiveChat).toHaveBeenCalledWith('c1', false);
  });

  // The icon itself flips too — an open box for the way back, not the closed
  // Archive glyph used to put a chat away.
  it('renders an open-box icon (not the Archive glyph) when the chat is archived', () => {
    render(<ChatHeader row={row({ status: 'archived' })} />);
    const svg = screen.getByTestId('action-archive').querySelector('svg');
    expect(svg?.getAttribute('class')).toContain('lucide-package-open');
  });

  // spec/14 § Discoverability — a header tooltip carries the action's chord.
  it('carries the ⌘⌥A chord on the archive tooltip', () => {
    render(<ChatHeader row={row()} />);
    // Named for the keyboard reading it (spec/14 § Discoverability); jsdom's
    // navigator is not a Mac, so the chord is written in PC words.
    expect(screen.getByTestId('action-archive').getAttribute('title')).toBe('Archive (Ctrl+Alt+A)');
  });

  it('closes the ⋯ menu on Escape', async () => {
    render(<ChatHeader row={row()} />);
    openMore();
    expect(screen.getByTestId('action-delete')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    await vi.waitFor(() => {
      expect(screen.queryByTestId('action-delete')).not.toBeInTheDocument();
    });
  });

  it('closes the ⋯ menu on a click off it', async () => {
    render(<ChatHeader row={row()} />);
    openMore();
    expect(screen.getByTestId('action-delete')).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    await vi.waitFor(() => {
      expect(screen.queryByTestId('action-delete')).not.toBeInTheDocument();
    });
  });

  it('handleDelete does nothing when the user cancels the custom modal', async () => {
    render(
      <>
        <ChatHeader row={row()} />
        <ConfirmModal />
      </>,
    );
    openMore();
    fireEvent.click(screen.getByTestId('action-delete'));
    await screen.findByTestId('confirm-modal');
    fireEvent.click(screen.getByTestId('confirm-cancel'));
    await vi.waitFor(() => {
      expect(screen.queryByTestId('confirm-modal')).not.toBeInTheDocument();
    });
    expect(api.deleteChat).not.toHaveBeenCalled();
  });

  // E5: delete is a recoverable soft-delete — the chat flips to status
  // `deleted` (leaving the active list into the Deleted section), NOT hard-removed.
  it('handleDelete soft-deletes the chat on confirm + API success', async () => {
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    render(
      <>
        <ChatHeader row={row()} />
        <ConfirmModal />
      </>,
    );
    openMore();
    fireEvent.click(screen.getByTestId('action-delete'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await vi.waitFor(() => {
      expect(useChatStore.getState().chats['c1']?.status).toBe('deleted');
    });
    // Recoverable — the row still exists, just moved to the Deleted section.
    expect(useChatStore.getState().chats['c1']).toBeDefined();
    expect(api.deleteChat).toHaveBeenCalledWith('c1');
  });

  it('handleDelete reverts to active + surfaces a toast on API failure', async () => {
    vi.mocked(api.deleteChat).mockRejectedValueOnce(new Error('server error'));
    useChatStore
      .getState()
      .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
    render(
      <>
        <ChatHeader row={row()} />
        <ConfirmModal />
      </>,
    );
    openMore();
    fireEvent.click(screen.getByTestId('action-delete'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await vi.waitFor(() => {
      expect(useUiStore.getState().errors[0]?.message).toContain('Delete failed');
    });
    // Reverted to active (NO FALLBACK — the failure is surfaced, the row stays).
    expect(useChatStore.getState().chats['c1']?.status).toBe('active');
  });

  // App Updates: "top bar icons should go into a hamburger menu when not
  // enough space to display cleanly". Whether it's SHOWN at a given width is a
  // real-browser @container-query concern (packages/web/e2e/narrow-layout.spec.ts);
  // these unit tests cover that the hamburger dropdown itself lists every
  // action and drives the exact same handlers as the icon rail.
  describe('hamburger menu (spec/14 § Chat panel header, narrow widths)', () => {
    function openHamburger(): void {
      fireEvent.click(screen.getByTestId('action-hamburger'));
    }

    it('is closed by default and opens to list every action by name', () => {
      render(<ChatHeader row={row()} />);
      expect(screen.queryByTestId('head-hamburger-menu')).not.toBeInTheDocument();
      openHamburger();
      const menu = screen.getByTestId('head-hamburger-menu');
      expect(menu).toBeInTheDocument();
      expect(screen.getByTestId('hamburger-editor')).toHaveTextContent('Editor');
      expect(screen.getByTestId('hamburger-tools')).toHaveTextContent('Tools');
      expect(screen.getByTestId('hamburger-snooze-row')).toBeInTheDocument();
      expect(screen.getByTestId('hamburger-archive')).toHaveTextContent('Archive');
      expect(screen.getByTestId('hamburger-move')).toHaveTextContent('Move to…');
      expect(screen.getByTestId('hamburger-delete')).toHaveTextContent('Delete');
      // New chat, Call and Pin are gone from the header entirely; Open in new
      // window sits beside the title now, not in this mirrored list.
      expect(screen.queryByTestId('hamburger-new-chat')).not.toBeInTheDocument();
      expect(screen.queryByTestId('hamburger-call')).not.toBeInTheDocument();
      expect(screen.queryByTestId('hamburger-pin')).not.toBeInTheDocument();
      expect(screen.queryByTestId('hamburger-open-window')).not.toBeInTheDocument();
    });

    it('closes on Escape and on a click off it', async () => {
      render(<ChatHeader row={row()} />);
      openHamburger();
      expect(screen.getByTestId('head-hamburger-menu')).toBeInTheDocument();
      fireEvent.keyDown(window, { key: 'Escape' });
      await vi.waitFor(() => {
        expect(screen.queryByTestId('head-hamburger-menu')).not.toBeInTheDocument();
      });

      openHamburger();
      expect(screen.getByTestId('head-hamburger-menu')).toBeInTheDocument();
      fireEvent.pointerDown(document.body);
      await vi.waitFor(() => {
        expect(screen.queryByTestId('head-hamburger-menu')).not.toBeInTheDocument();
      });
    });

    it('Editor behaves exactly like the header icon: opens the Files tab', () => {
      useLayoutStore.getState()._reset();
      render(<ChatHeader row={row()} />);
      openHamburger();
      fireEvent.click(screen.getByTestId('hamburger-editor'));
      expect(
        useLayoutStore.getState().findTab({ kind: 'page', page: 'files', chatId: 'c1' }),
      ).not.toBeNull();
      // Selecting an item closes the dropdown.
      expect(screen.queryByTestId('head-hamburger-menu')).not.toBeInTheDocument();
    });

    it('Archive behaves exactly like the rail icon: flips status via the API', () => {
      useChatStore
        .getState()
        .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '~/p' });
      render(<ChatHeader row={row()} />);
      openHamburger();
      fireEvent.click(screen.getByTestId('hamburger-archive'));
      expect(useChatStore.getState().chats['c1']?.status).toBe('archived');
      expect(api.archiveChat).toHaveBeenCalledWith('c1', true);
    });

    it('Delete opens the same confirm modal as the rail/⋯ path', async () => {
      render(
        <>
          <ChatHeader row={row()} />
          <ConfirmModal />
        </>,
      );
      openHamburger();
      fireEvent.click(screen.getByTestId('hamburger-delete'));
      const modal = await screen.findByTestId('confirm-modal');
      expect(modal.textContent).toContain('Delete chat');
    });

    it('Tools behaves exactly like the rail icon: opens the Tools sidebar for this chat', () => {
      useUiStore.setState({ toolsPanelChatId: null });
      render(<ChatHeader row={row({ chatId: 'c-hamburger-tools' })} />);
      openHamburger();
      fireEvent.click(screen.getByTestId('hamburger-tools'));
      expect(useUiStore.getState().toolsPanelChatId).toBe('c-hamburger-tools');
      expect(screen.queryByTestId('head-hamburger-menu')).not.toBeInTheDocument();
    });

    it('special threads only offer Editor, Tools, Disable and Clear context', () => {
      render(<ChatHeader row={row({ chatId: 'thread_manager' })} />);
      openHamburger();
      expect(screen.getByTestId('hamburger-editor')).toBeInTheDocument();
      expect(screen.getByTestId('hamburger-tools')).toBeInTheDocument();
      expect(screen.getByTestId('hamburger-disable')).toBeInTheDocument();
      expect(screen.getByTestId('hamburger-clear-context')).toBeInTheDocument();
      expect(screen.queryByTestId('hamburger-snooze-row')).not.toBeInTheDocument();
      expect(screen.queryByTestId('hamburger-archive')).not.toBeInTheDocument();
      expect(screen.queryByTestId('hamburger-move')).not.toBeInTheDocument();
      expect(screen.queryByTestId('hamburger-delete')).not.toBeInTheDocument();
    });
  });

  // An optimistically-seeded row carries `daemonId: ''` and `folder: ''`
  // (chatStore's emptyRow). An unknown part is omitted from the tooltip with
  // its separator; with nothing known there is no tooltip at all.
  describe('title hover omits unknown parts', () => {
    const hover = (): string | null => screen.getByTestId('chat-title').getAttribute('title');

    it('a chat with no folder hovers as the host alone', () => {
      render(<ChatHeader row={row({ daemonId: 'dev-host', folder: '' })} />);
      expect(hover()).toBe('dev-host');
    });

    it('a bare "." folder is not a folder', () => {
      render(<ChatHeader row={row({ daemonId: 'dev-host', folder: '.' })} />);
      expect(hover()).toBe('dev-host');
    });

    it('a "./name" folder still resolves to its basename', () => {
      render(<ChatHeader row={row({ daemonId: 'dev-host', folder: './proj' })} />);
      expect(hover()).toBe('proj · dev-host');
    });

    it('an unnamed host hovers as the folder alone', () => {
      render(<ChatHeader row={row({ daemonId: '', folder: '~/projects/foo' })} />);
      expect(hover()).toBe('foo');
    });

    it('an optimistic row (no host, no folder) has no tooltip', () => {
      render(<ChatHeader row={row({ daemonId: '', folder: '' })} />);
      expect(hover()).toBeNull();
    });

    it('draws no tooltip from the model alone', () => {
      render(<ChatHeader row={row({ daemonId: '', folder: '', model: 'claude-opus-4' })} />);
      expect(hover()).toBeNull();
    });
  });

  // A4 (DESKTOP-REVIEW — "manager manager"): a special thread shows its name
  // exactly ONCE and carries no folder · host tooltip.
  it.each([
    ['thread_manager', 'Manager'],
    ['thread_speakers', 'Speakers'],
  ])('A4: special thread %s shows the name once ("%s") with no folder tooltip', (chatId, label) => {
    render(<ChatHeader row={row({ chatId, name: label, folder: '.patch/threads/x' })} />);
    expect(screen.getByTestId('chat-title').textContent).toBe(label);
    expect(screen.getByTestId('chat-title')).not.toHaveAttribute('title');
  });

  // spec/14 § Chat panel header — rename in place. Clicking the name turns it
  // into a text field; Enter commits, Esc cancels, blur commits, empty clears.
  describe('rename (spec/14 § Chat panel header)', () => {
    it('clicking the title opens an input seeded with the current name', () => {
      render(<ChatHeader row={row({ name: 'fix layout' })} />);
      fireEvent.click(screen.getByTestId('chat-title'));
      const input = screen.getByTestId('chat-title-input') as HTMLInputElement;
      expect(input).toBeInTheDocument();
      expect(input.value).toBe('fix layout');
    });

    // The rename field renders in the same font, size and position as the
    // static title (spec/14 § Chat panel header) — same base class, and no
    // tooltip on the field itself, so nothing shifts when it appears.
    it('the rename field shares the static title’s class and carries no tooltip', () => {
      render(<ChatHeader row={row({ name: 'fix layout' })} />);
      const title = screen.getByTestId('chat-title');
      fireEvent.click(title);
      const input = screen.getByTestId('chat-title-input');
      expect(input.className).toContain('chat-title');
      expect(input).not.toHaveAttribute('title');
    });

    it('an unnamed chat opens an EMPTY input, not the placeholder label', () => {
      // The placeholder is a display fallback, not the chat's name — seeding it
      // would silently promote "New chat" into a real stored name.
      render(<ChatHeader row={row({ name: null, folder: '~/projects/foo' })} />);
      expect(screen.getByTestId('chat-title').textContent).toBe('New chat');
      fireEvent.click(screen.getByTestId('chat-title'));
      expect((screen.getByTestId('chat-title-input') as HTMLInputElement).value).toBe('');
    });

    it('Enter commits the new name to the API and closes the input', async () => {
      render(<ChatHeader row={row({ name: 'fix layout' })} />);
      fireEvent.click(screen.getByTestId('chat-title'));
      const input = screen.getByTestId('chat-title-input');
      fireEvent.change(input, { target: { value: 'Bed Planner Rework' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(api.renameChat).toHaveBeenCalledWith('c1', 'Bed Planner Rework');
      await vi.waitFor(() =>
        expect(screen.queryByTestId('chat-title-input')).not.toBeInTheDocument(),
      );
    });

    it('Enter on an emptied field clears the name (sends null)', async () => {
      render(<ChatHeader row={row({ name: 'fix layout' })} />);
      fireEvent.click(screen.getByTestId('chat-title'));
      const input = screen.getByTestId('chat-title-input');
      fireEvent.change(input, { target: { value: '   ' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(api.renameChat).toHaveBeenCalledWith('c1', null);
    });

    it('Escape cancels without calling the API', () => {
      render(<ChatHeader row={row({ name: 'fix layout' })} />);
      fireEvent.click(screen.getByTestId('chat-title'));
      const input = screen.getByTestId('chat-title-input');
      fireEvent.change(input, { target: { value: 'Discarded' } });
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(api.renameChat).not.toHaveBeenCalled();
      expect(screen.queryByTestId('chat-title-input')).not.toBeInTheDocument();
      expect(screen.getByTestId('chat-title').textContent).toBe('fix layout');
    });

    it('blur commits the edit', () => {
      render(<ChatHeader row={row({ name: 'fix layout' })} />);
      fireEvent.click(screen.getByTestId('chat-title'));
      const input = screen.getByTestId('chat-title-input');
      fireEvent.change(input, { target: { value: 'Committed On Blur' } });
      fireEvent.blur(input);
      expect(api.renameChat).toHaveBeenCalledWith('c1', 'Committed On Blur');
    });

    it('an unchanged name commits nothing', () => {
      render(<ChatHeader row={row({ name: 'fix layout' })} />);
      fireEvent.click(screen.getByTestId('chat-title'));
      fireEvent.keyDown(screen.getByTestId('chat-title-input'), { key: 'Enter' });
      expect(api.renameChat).not.toHaveBeenCalled();
    });

    it('a failed rename reverts the optimistic name and raises an error', async () => {
      vi.mocked(api.renameChat).mockRejectedValue(new Error('host offline') as never);
      const r = row({ name: 'fix layout' });
      useChatStore.setState({ chats: { c1: r } });
      render(<ChatHeader row={r} />);
      fireEvent.click(screen.getByTestId('chat-title'));
      const input = screen.getByTestId('chat-title-input');
      fireEvent.change(input, { target: { value: 'Will Fail' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await vi.waitFor(() => {
        expect(useChatStore.getState().chats.c1?.name).toBe('fix layout');
      });
      expect(useUiStore.getState().errors.some((e) => /rename failed/i.test(e.message))).toBe(true);
    });

    it('a special thread title is not editable', () => {
      render(<ChatHeader row={row({ chatId: 'thread_manager', name: 'Manager' })} />);
      fireEvent.click(screen.getByTestId('chat-title'));
      expect(screen.queryByTestId('chat-title-input')).not.toBeInTheDocument();
    });
  });

  // spec/04 § Goals — "A finished goal stays viewable from the chat header".
  describe('finished goal indicator', () => {
    const lastGoal = {
      condition: 'Ship the release by Friday',
      startedAt: 0,
      endedAt: 9 * 60_000,
      turns: 3,
      tokens: 8200,
      outcome: 'met' as const,
      reason: 'All tests pass and the release is tagged',
    };

    it('shows nothing when no goal has ever finished', () => {
      render(<ChatHeader row={row()} />);
      expect(screen.queryByTestId('finished-goal-indicator')).not.toBeInTheDocument();
    });

    it('shows nothing while a goal is still active (the bar owns it instead)', () => {
      render(<ChatHeader row={row({ goal: 'still going', lastGoal })} />);
      expect(screen.queryByTestId('finished-goal-indicator')).not.toBeInTheDocument();
    });

    it('shows a collapsed "Goal met" once goal clears, expanding to condition/duration/turns/tokens/reason', () => {
      render(<ChatHeader row={row({ goal: null, lastGoal })} />);
      expect(screen.getByTestId('finished-goal-summary')).toHaveTextContent('Goal met');
      expect(screen.queryByTestId('finished-goal-detail')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('finished-goal-summary'));
      const detail = screen.getByTestId('finished-goal-detail');
      expect(detail).toHaveTextContent('Ship the release by Friday');
      expect(detail).toHaveTextContent('9m');
      expect(detail).toHaveTextContent('3 turns');
      expect(detail).toHaveTextContent('8.2k tokens');
      expect(detail).toHaveTextContent('All tests pass and the release is tagged');
    });

    it('labels an impossible outcome distinctly from met', () => {
      render(
        <ChatHeader row={row({ goal: null, lastGoal: { ...lastGoal, outcome: 'impossible' } })} />,
      );
      expect(screen.getByTestId('finished-goal-summary')).toHaveTextContent('Goal impossible');
    });
  });

  // Todoist: "buttons are broken here" — the ⋯ menu's Snooze row was a plain
  // div around a 32px icon-only button, so clicking the word "Snooze" (or any
  // of the row but the clock) did nothing, unlike every sibling item.
  describe('Snooze row in the menus is one whole-row menu item', () => {
    it('⋯ menu: clicking the Snooze label opens the preset pop-up', () => {
      render(<ChatHeader row={row()} />);
      openMore();
      fireEvent.click(screen.getByRole('menuitem', { name: /snooze/i }));
      expect(screen.getByTestId('snooze-menu')).toBeInTheDocument();
    });

    it('hamburger menu: clicking the Snooze label opens the preset pop-up', () => {
      render(<ChatHeader row={row()} />);
      fireEvent.click(screen.getByTestId('action-hamburger'));
      const hm = screen.getByTestId('head-hamburger-menu');
      fireEvent.click(within(hm).getByRole('menuitem', { name: /snooze/i }));
      expect(screen.getByTestId('snooze-menu')).toBeInTheDocument();
    });

    it('the row trigger is a head-menu-item, not the icon-only head-action', () => {
      render(<ChatHeader row={row()} />);
      openMore();
      const trigger = within(screen.getByTestId('menu-snooze-row')).getByTestId('action-snooze');
      expect(trigger).toHaveClass('head-menu-item');
      expect(trigger).not.toHaveClass('head-action');
    });
  });
});
