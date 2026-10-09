import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor, cleanup, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar.js';
import { ConfirmModal } from '../components/ConfirmModal.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api, ApiError } from '../api/rest.js';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import type { ChatRow } from '../stores/types.js';
import * as newWindow from '../lib/newWindow.js';
import { __setAudioOpenerForTests } from '../lib/voiceController.js';
import type { AudioSession, OpenAudioSessionOpts } from '../lib/audioSession.js';

// Stub for the streaming audio-session opener (Call / Hands-free), matching
// the one `voiceController.test.ts` uses — no real audio/network is touched.
function stubOpener(opts: OpenAudioSessionOpts): Promise<AudioSession> {
  return Promise.resolve({
    sessionId: 'sess-1',
    chatId: opts.chatId,
    setMuted: () => {},
    isMuted: () => false,
    setSessionMode: () => {},
    speak: () => {},
    sendPcm: () => {},
    end: () => {},
  });
}

type RowFixture = Omit<
  ChatRow,
  | 'awaitingPermission'
  | 'lastReadSeq'
  | 'preview'
  | 'goal'
  | 'goalProgress'
  | 'lastGoal'
  | 'reminder'
  | 'statusSummary'
  | 'statusKind'
  | 'statusDeclared'
  | 'pendingPermissions'
  | 'lastSeq'
>;

function rowFixture(overrides: Partial<ChatRow> = {}): RowFixture {
  const merged: RowFixture = {
    pendingWake: null,
    todos: [],
    snoozedUntil: null,
    chatId: 'c1',
    daemonId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    name: 'a chat',
    folder: '~/proj',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: Date.now(),
    lastUserActivity: Date.now(),
    jobId: null,
    model: null,
    rateLimitResumingAt: null,
    resumeKind: null,
    ...overrides,
  };
  // Most of this suite's fixtures only ever set `lastUpdated` — mirroring it
  // onto `lastUserActivity` by default keeps every recency-ordered fixture
  // sorting the way it always did; a test about the two diverging sets
  // `lastUserActivity` explicitly, which wins over the mirror.
  if (overrides.lastUpdated !== undefined && overrides.lastUserActivity === undefined) {
    merged.lastUserActivity = overrides.lastUpdated;
  }
  return merged;
}

/**
 * Seed the sidebar's section counts (spec/04 § Section counts). They come from
 * the server, not from the store's rows — the lifecycle lists load on expand,
 * so before a section is opened the store holds none of its rows. Any test
 * asserting on a count badge has to put one here; without it the counts are
 * `null` and no badge renders at all.
 */
function seedCounts(overrides: Partial<Record<string, number>> = {}): void {
  useChatStore.getState().setSectionCounts({
    hidden: 0,
    archived: 0,
    snoozed: 0,
    deleted: 0,
    automations: 0,
    ...overrides,
  });
}

function renderInRouter(opts: { standalone?: boolean; path?: string } = {}): void {
  render(
    <MemoryRouter initialEntries={[opts.path ?? '/']}>
      <Sidebar standalone={opts.standalone} />
      <ConfirmModal />
    </MemoryRouter>,
  );
}

// Turns on the Unread option in the sidebar's view dropdown (spec/14 §
// Sidebar §1b) — the old standalone Needs attention toggle's replacement.
function selectUnreadView(): void {
  fireEvent.click(screen.getByTestId('sidebar-view-trigger'));
  fireEvent.click(screen.getByTestId('sidebar-view-option-unread'));
}

describe('Sidebar', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.setState({ daemonOnline: true });
    useVoiceStore.setState({ activeDevices: {} });
    useUiStore.getState().setChannelsOpen(false);
    useUiStore.getState().setArchivedOpen(false);
    useUiStore.getState().setDeletedOpen(false);
    useUiStore.getState().setAttentionOnly(false);
    useUiStore.setState({ forgottenFolders: [] });
    useUiStore.setState({ toolsPanelChatId: null });
    useUiStore.getState().setSearchQuery('');
    useUiStore.setState({ errors: [] });
    // Clear any confirm left pending by a prior test (resolves its promise).
    useUiStore.getState().resolveConfirm(false);
    // The Archived/Deleted sections lazily fetch on expand; default them to an
    // empty merge so tests that seed the store directly aren't disturbed.
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({ chats: [], nextOffset: null });
    vi.spyOn(api, 'listChatsDeleted').mockResolvedValue({ chats: [], nextOffset: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('renders the brand row + connection dot', () => {
    renderInRouter();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(screen.getByText('patch')).toBeInTheDocument();
    expect(screen.getByTestId('conn-dot')).toBeInTheDocument();
  });

  it('clicking the collapse chevron collapses the sidebar', () => {
    useUiStore.setState({ sidebarCollapsed: false });
    renderInRouter();
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    fireEvent.click(screen.getByTestId('sidebar-collapse'));
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  });

  // spec/14 § Discoverability — a control with a shortcut names it, and names it
  // for the keyboard reading it (jsdom's navigator is not a Mac).
  it('the sidebar controls with chords name them in their tooltips', () => {
    useUiStore.setState({ sidebarCollapsed: false });
    renderInRouter();
    expect(screen.getByTestId('sidebar-collapse').getAttribute('title')).toBe(
      'Collapse sidebar (Ctrl+/)',
    );
    expect(screen.getByTestId('new-chat-fab').getAttribute('title')).toBe('Ctrl+N');
    expect(screen.getByTestId('channels-toggle').getAttribute('title')).toBe('Ctrl+2');
    expect(screen.getByTestId('archived-toggle').getAttribute('title')).toBe(
      'Archived (Ctrl+Shift+A)',
    );
  });

  it('New chat names its chord in the tooltip only, with no tag on the button', () => {
    renderInRouter();
    expect(screen.queryByTestId('new-chat-fab-chord')).toBeNull();
  });

  it('the connection dot shows offline styling + "Reconnecting…" tooltip when not connected', () => {
    usePresenceStore.getState().setConnection('reconnecting');
    renderInRouter();
    const dot = screen.getByTestId('conn-dot');
    expect(dot.className).toContain('offline');
    expect(dot.getAttribute('title')).toBe('Reconnecting…');
  });

  // Patch Updates: "Dot should show status" — the WS link to the server can be
  // 'connected' while every host is unreachable (spec/12 § Surface
  // connection state model). The dot must not read as healthy in that case.
  it('the connection dot shows offline styling + "Agent offline" tooltip when the WS is connected but the host is not', () => {
    usePresenceStore.setState({ connection: 'connected', daemonOnline: false });
    renderInRouter();
    const dot = screen.getByTestId('conn-dot');
    expect(dot.className).toContain('offline');
    expect(dot.getAttribute('title')).toBe('Agent offline');
  });

  it('the connection dot shows connected styling + "Connected" tooltip when the WS is connected and the host is online', () => {
    usePresenceStore.setState({ connection: 'connected', daemonOnline: true });
    renderInRouter();
    const dot = screen.getByTestId('conn-dot');
    expect(dot.className).not.toContain('offline');
    expect(dot.getAttribute('title')).toBe('Connected');
  });

  it('shows the empty manager slot when none exists', () => {
    renderInRouter();
    expect(screen.getByTestId('manager-row-empty')).toBeInTheDocument();
  });

  it('renders the Manager chat row exactly once when present (matched by chatId)', () => {
    // The host emits the special thread with a lowercase folder-NAME as
    // `name` and a full filesystem path as `folder`; detection must key off
    // the stable chatId, never name/folder (spec/06).
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_manager',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'manager',
        folder: '/home/tom/.patch/threads/manager',
        activity: 'idle',
        status: 'active',
        pinned: true,
        pinnedAt: 50,
        disabled: false,
        lastUpdated: 1,
      },
    ]);
    renderInRouter();
    // Rendered in the dedicated top slot...
    expect(screen.getByTestId('chat-row-thread_manager')).toBeInTheDocument();
    // ...and NOT duplicated into the pinned section.
    expect(screen.queryByTestId('manager-row-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pinned-section')).not.toBeInTheDocument();
  });

  // spec/04 § Goals, spec/14 § Sidebar — a chat working toward a goal carries
  // a small marker beside its badge, purely informational (no effect on sort).
  it('shows the goal marker on a chat with an active goal, and not on one without', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'c-goal',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'ship it',
        folder: '/work',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 1,
        goal: 'Ship the release by Friday',
      },
      {
        chatId: 'c-no-goal',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'ordinary chat',
        folder: '/work',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 1,
      },
    ]);
    renderInRouter();
    expect(screen.getByTestId('goal-marker-c-goal')).toBeInTheDocument();
    expect(screen.queryByTestId('goal-marker-c-no-goal')).not.toBeInTheDocument();
  });

  // The Manager row's mic sits in the three-up Voice note / Call / Hands-free
  // trio (spec/14 § Manager) and renders bigger + accent-tinted via the shared
  // `mic-btn--manager-ctl` variant; ordinary rows keep the plain small hover mic.
  it('the Manager row mic uses the manager-ctl variant; ordinary rows do not', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_manager',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'manager',
        folder: '/home/tom/.patch/threads/manager',
        activity: 'idle',
        status: 'active',
        pinned: true,
        pinnedAt: 50,
        disabled: false,
        lastUpdated: 1,
      },
      rowFixture({
        chatId: 'c-plain',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'plain',
        folder: '/proj/x',
      }),
    ]);
    renderInRouter();
    const managerMic = screen.getByTestId('row-mic-thread_manager');
    expect(managerMic.className).toContain('mic-btn--manager-ctl');
    expect(managerMic.getAttribute('title')).toBe('Voice note');
    const plainMic = screen.getByTestId('row-mic-c-plain');
    expect(plainMic.className).toContain('mic-btn');
    expect(plainMic.className).not.toContain('mic-btn--manager-ctl');
  });

  // spec/14 § Manager — three icon buttons with tooltips, no extra text, same
  // icons/behaviour as those controls elsewhere (ChatHeader's Call, the row
  // mic, mobile's Hands-free). Covers the redesign from the old lone wide
  // labelled ("Talk") mic to the side-by-side trio.
  it('the Manager row shows Voice note, Call and Hands-free as icon-only buttons with tooltips, side by side', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_manager',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'manager',
        folder: '/home/tom/.patch/threads/manager',
        activity: 'idle',
        status: 'active',
        pinned: true,
        pinnedAt: 50,
        disabled: false,
        lastUpdated: 1,
      },
    ]);
    renderInRouter();
    const mic = screen.getByTestId('row-mic-thread_manager');
    const call = screen.getByTestId('row-call');
    const handsfree = screen.getByTestId('row-handsfree');
    expect(mic.getAttribute('title')).toBe('Voice note');
    expect(call.getAttribute('title')).toBe('Call');
    expect(handsfree.getAttribute('title')).toBe('Hands-free');
    // No visible text labels — the tooltip is the only name any of the three gets.
    expect(mic.textContent?.trim()).toBe('');
    expect(call.textContent?.trim()).toBe('');
    expect(handsfree.textContent?.trim()).toBe('');
    // All three live in the same row-tools container, side by side.
    const tools = mic.closest('.row-tools');
    expect(tools).toContainElement(call);
    expect(tools).toContainElement(handsfree);
  });

  // Plain chat rows get no Call control — calls on an ordinary chat happen by
  // opening it (ChatHeader's own Call action), not from the sidebar row.
  it('ordinary rows have no row-call control', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'c-plain' })]);
    renderInRouter();
    expect(screen.queryByTestId('row-call')).toBeNull();
  });

  // The fix (Patch Updates: "Talk sends a voice note to the current chat, not
  // the Manager"): every voice control in the Manager block targets the
  // Manager thread regardless of which chat is open.
  it('every Manager voice control targets Manager, whatever chat is open', async () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_manager',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'manager',
        folder: '/home/tom/.patch/threads/manager',
        activity: 'idle',
        status: 'active',
        pinned: true,
        pinnedAt: 50,
        disabled: false,
        lastUpdated: 1,
      },
      rowFixture({ chatId: 'other-chat', folder: '/home/tom/projects/foo' }),
    ]);
    useChatStore.getState().setActiveChat('other-chat');
    renderInRouter({ path: '/chats/other-chat' });

    // Voice note.
    fireEvent.mouseDown(screen.getByTestId('row-mic-thread_manager'));
    expect(useVoiceStore.getState().note?.chatId).toBe('thread_manager');
    fireEvent.mouseUp(screen.getByTestId('row-mic-thread_manager'));
    useVoiceStore.getState().endNote();

    // Call.
    __setAudioOpenerForTests(stubOpener);
    fireEvent.click(screen.getByTestId('row-call'));
    await waitFor(() => expect(useVoiceStore.getState().call?.chatId).toBe('thread_manager'));
    useVoiceStore.getState().endCall();

    // Hands-free.
    fireEvent.click(screen.getByTestId('row-handsfree'));
    await waitFor(() => expect(useVoiceStore.getState().call?.chatId).toBe('thread_manager'));
    expect(useVoiceStore.getState().call?.mode).toBe('hands-free');
    useVoiceStore.getState().endCall();
    __setAudioOpenerForTests(null);
  });

  // The Manager thread needs a self-explanatory, distinct design so a new user
  // can tell it apart from ordinary chats (todo: "Manager needs a more distinct
  // design to show its special status"). It carries a dedicated identity glyph
  // (not the generic status dot) that ordinary rows never render.
  it('the Manager row shows a distinct identity glyph that ordinary rows lack', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_manager',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'manager',
        folder: '/home/tom/.patch/threads/manager',
        activity: 'idle',
        status: 'active',
        pinned: true,
        pinnedAt: 50,
        disabled: false,
        lastUpdated: 1,
      },
      rowFixture({
        chatId: 'c-plain',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'plain',
        folder: '/proj/x',
      }),
    ]);
    renderInRouter();
    const managerRow = screen.getByTestId('chat-row-thread_manager');
    expect(managerRow.querySelector('[data-testid="manager-glyph"]')).toBeTruthy();
    // The distinctive glyph is Manager-only — ordinary rows never render it.
    const plainRow = screen.getByTestId('chat-row-c-plain');
    expect(plainRow.querySelector('[data-testid="manager-glyph"]')).toBeNull();
  });

  // The host emits the special thread with a lowercase folder-NAME ("manager").
  // The row must present a clean, capitalized "Manager" label — matching the
  // empty-slot placeholder — so the special row reads consistently, never as a
  // lowercase "manager" that looks like an ordinary chat title.
  it('the Manager row always shows a capitalized "Manager" label regardless of the host name', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_manager',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'manager',
        folder: '/home/tom/.patch/threads/manager',
        activity: 'idle',
        status: 'active',
        pinned: true,
        pinnedAt: 50,
        disabled: false,
        lastUpdated: 1,
      },
    ]);
    renderInRouter();
    const name = screen.getByTestId('chat-row-thread_manager').querySelector('.name')?.textContent;
    expect(name).toBe('Manager');
  });

  // The empty Manager slot (before the host registers the thread) carries the
  // same identity glyph so the special status is legible from first paint.
  it('the empty Manager slot also carries the identity glyph', () => {
    renderInRouter();
    const empty = screen.getByTestId('manager-row-empty');
    expect(empty.querySelector('[data-testid="manager-glyph"]')).toBeTruthy();
  });

  // spec/14 § Copy: text clipped to fit carries its full value on hover. A row
  // name ellipsises at rest and clips harder still while hovered (the action
  // icons take the slot), so without this the one gesture that asks to read a
  // row is the one that makes it least readable.
  it('every chat row carries its full title as a hover tooltip', () => {
    window.localStorage.clear();
    const longName = 'Refactor the sidebar grouping so pinned rows stop starving the chat list';
    useChatStore.getState().hydrate([rowFixture({ chatId: 'c-long', name: longName })]);
    renderInRouter();
    const row = screen.getByTestId('chat-row-c-long');
    expect(row.getAttribute('title')).toBe(longName);
    // The tooltip is the same text the row displays, not a different string.
    expect(row.querySelector('.name')?.textContent).toBe(longName);
  });

  // The tooltip carries the PRESENTED title, so a markdown-laden name reads as
  // the flat text the row shows rather than raw syntax.
  it("a row's tooltip is markdown-stripped, matching the visible name", () => {
    window.localStorage.clear();
    useChatStore
      .getState()
      .hydrate([rowFixture({ chatId: 'c-md', name: '**Bold** plan for `deploy.md`' })]);
    renderInRouter();
    const row = screen.getByTestId('chat-row-c-md');
    expect(row.getAttribute('title')).toBe(row.querySelector('.name')?.textContent);
    expect(row.getAttribute('title')).not.toContain('**');
  });

  // spec/14 § Copy — no helper text: no row carries an explainer tooltip, the
  // Manager row included. Its only tooltip is its own full title, the value the
  // ellipsis would otherwise lose.
  it('the Manager row carries its title as its tooltip, not an explainer', () => {
    window.localStorage.clear();
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_manager',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'manager',
        folder: '/home/tom/.patch/threads/manager',
        activity: 'idle',
        status: 'active',
        pinned: true,
        pinnedAt: 50,
        disabled: false,
        lastUpdated: 1,
      },
    ]);
    renderInRouter();
    const row = screen.getByTestId('chat-row-thread_manager');
    expect(row.getAttribute('title')).toBe(row.querySelector('.name')?.textContent);
    expect(row.getAttribute('title')).not.toContain('—');
  });

  it('puts Speakers in a Channels section collapsed by default, not in folders', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_speakers',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'speakers',
        folder: '/home/tom/.patch/threads/speakers',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 1,
      },
    ]);
    renderInRouter();
    // Collapsed by default — channel rows not rendered yet.
    expect(screen.queryByTestId('channels-list')).not.toBeInTheDocument();
    // Speakers must NOT appear as a regular folder chat row.
    expect(screen.queryByTestId('chat-row-thread_speakers')).not.toBeInTheDocument();
    // Expand → the channel row appears inside the Channels section.
    fireEvent.click(screen.getByTestId('channels-toggle'));
    expect(screen.getByTestId('channels-list')).toBeInTheDocument();
    expect(screen.getByTestId('channel-row-thread_speakers')).toBeInTheDocument();
  });

  it('shows a "🎙 <name>" device pill on the Speakers row when a device is mid-session', async () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_speakers',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'speakers',
        folder: '/home/tom/.patch/threads/speakers',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 1,
      },
    ]);
    // No active device yet → no pill.
    renderInRouter();
    fireEvent.click(screen.getByTestId('channels-toggle'));
    expect(screen.queryByTestId('channel-device-pill-thread_speakers')).not.toBeInTheDocument();

    // A device.session active event populates the store → pill appears.
    act(() => {
      useVoiceStore.getState().setDeviceSession('dev-kitchen', 'kitchen', true);
    });
    const pill = await screen.findByTestId('channel-device-pill-thread_speakers');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent('🎙 kitchen');

    // Session end clears it.
    act(() => {
      useVoiceStore.getState().setDeviceSession('dev-kitchen', 'kitchen', false);
    });
    expect(screen.queryByTestId('channel-device-pill-thread_speakers')).not.toBeInTheDocument();
  });

  it('renders the device pill even before the Speakers thread is registered', () => {
    // The pill must show whenever a device is mid-session, regardless of whether
    // the host has registered the Speakers special thread yet (spec/16 §v1).
    useVoiceStore.getState().setDeviceSession('dev-bedroom', 'bedroom', true);
    renderInRouter();
    fireEvent.click(screen.getByTestId('channels-toggle'));
    const pill = screen.getByTestId('channel-device-pill-thread_speakers');
    expect(pill).toHaveTextContent('🎙 bedroom');
  });

  it('groups pinned chats above folders', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'p1',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'pinned',
        folder: '~/proj',
        activity: 'idle',
        status: 'active',
        pinned: true,
        pinnedAt: 100,
        disabled: false,
        lastUpdated: 1,
      },
      {
        chatId: 'r1',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'regular',
        folder: '~/proj',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 1,
      },
    ]);
    renderInRouter();
    expect(screen.getByTestId('pinned-section')).toBeInTheDocument();
    expect(screen.getByTestId('chat-row-p1')).toBeInTheDocument();
    expect(screen.getByTestId('chat-row-r1')).toBeInTheDocument();
  });

  it('hides archived chats by default and reveals them when expanded', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'a1',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'old',
        folder: '~/proj',
        activity: 'idle',
        status: 'archived',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 1,
      },
    ]);
    renderInRouter();
    expect(screen.queryByTestId('chat-row-a1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('archived-toggle'));
    expect(screen.getByTestId('chat-row-a1')).toBeInTheDocument();
  });

  it('an ARCHIVED row still shows its status — that is where overnight jobs live', () => {
    // The status line used to be suppressed on archived rows, and archived is
    // exactly where job-spawned chats sit ("an automation chat is usually
    // archived"). So the one line saying what an overnight run actually did was
    // hidden on every row most likely to have one, and twenty of them read
    // identically.
    useChatStore.getState().hydrate([
      {
        chatId: 'arch-r',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'nightly backup',
        folder: '~/proj',
        activity: 'idle',
        status: 'archived',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 1,
        statusSummary: 'the backup has been failing silently since Tuesday',
        statusKind: 'report',
      },
    ]);
    renderInRouter();
    fireEvent.click(screen.getByTestId('archived-toggle'));
    const el = screen.getByTestId('status-summary-arch-r');
    expect(el).toHaveTextContent('the backup has been failing silently since Tuesday');
    expect(el.getAttribute('data-kind')).toBe('report');
  });

  // G2-d4: two unnamed archived chats in the SAME folder must still be
  // individually identifiable — the daemon-captured first-message preview
  // becomes each row's title so they don't both collapse to the folder basename.
  // spec/04 § Name: an unnamed row's TITLE is the folder basename (the first
  // user message is never the title). The host's `preview` snippet still
  // renders as a distinct SECONDARY line so rows sharing a folder are
  // distinguishable until the AI title lands.
  it('titles unnamed archived rows "New chat", with the preview as a secondary line', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'a-tmp-1',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: null,
        preview: 'fix the sidebar ordering bug',
        folder: '/private/tmp',
        activity: 'idle',
        status: 'archived',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 2,
      },
      {
        chatId: 'a-tmp-2',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: null,
        preview: 'add a dark mode toggle',
        folder: '/private/tmp',
        activity: 'idle',
        status: 'archived',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 1,
      },
    ]);
    renderInRouter();
    fireEvent.click(screen.getByTestId('archived-toggle'));
    const r1 = screen.getByTestId('chat-row-a-tmp-1');
    const r2 = screen.getByTestId('chat-row-a-tmp-2');
    // Neither is titled by the folder (that made every chat in a project look
    // identically named) and neither is titled by the first message.
    expect(r1.querySelector('.name')?.textContent).toBe('New chat');
    expect(r2.querySelector('.name')?.textContent).toBe('New chat');
    // The preview snippet renders as the distinct secondary line.
    const p1 = r1.querySelector('.preview')?.textContent;
    const p2 = r2.querySelector('.preview')?.textContent;
    expect(p1).toBe('fix the sidebar ordering bug');
    expect(p2).toBe('add a dark mode toggle');
    expect(p1).not.toBe(p2);
  });

  // Updates/todo: "Remove the preview text of each chat (the last message)."
  // Ordinary rows in the main chat list show the AI title only — the message
  // snippet is dropped. (It's still kept for archived rows and search results,
  // which have no title and need it to be individually identifiable.)
  it('does NOT show the message-snippet preview line for ordinary main-list rows', () => {
    useChatStore.getState().hydrate([
      rowFixture({
        chatId: 'plain-1',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'My chat',
        preview: 'the first user message',
      }),
    ]);
    renderInRouter();
    const row = screen.getByTestId('chat-row-plain-1');
    expect(row.querySelector('.name')?.textContent).toBe('My chat');
    // No secondary preview line.
    expect(screen.queryByTestId('row-preview-plain-1')).toBeNull();
    expect(row.querySelector('.preview')).toBeNull();
  });

  // The pinned section is still part of the main list — no preview there either.
  it('does NOT show the preview line for pinned main-list rows', () => {
    useChatStore.getState().hydrate([
      rowFixture({
        chatId: 'pin-1',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'Pinned chat',
        preview: 'a snippet',
        pinned: true,
      }),
    ]);
    renderInRouter();
    const row = screen.getByTestId('chat-row-pin-1');
    expect(screen.queryByTestId('row-preview-pin-1')).toBeNull();
    expect(row.querySelector('.preview')).toBeNull();
  });

  it('archived rows still show their own preview as the secondary line', () => {
    useChatStore.getState().hydrate([
      rowFixture({
        chatId: 'a-prev',
        name: null,
        preview: 'Help me write an essay about the sea',
        folder: '~/proj',
        status: 'archived',
      }),
    ]);
    renderInRouter();
    fireEvent.click(screen.getByTestId('archived-toggle'));
    expect(screen.getByTestId('row-preview-a-prev')).toHaveTextContent(
      'Help me write an essay about the sea',
    );
  });

  it('renders folder groups with the project basename as the header and full path on hover', () => {
    useChatStore
      .getState()
      .hydrate([rowFixture({ chatId: 'f1', folder: '/private/tmp/a/b/c/deep-project' })]);
    renderInRouter();
    const head = document.querySelector('.folder-head');
    expect(head?.querySelector('.folder-head-label')?.textContent).toBe('deep-project');
    expect(head?.getAttribute('title')).toBe('/private/tmp/a/b/c/deep-project');
    expect(screen.getByTestId('chat-row-f1')).toBeInTheDocument();
  });

  it('renders the folder header as the basename', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'f2', folder: '~/proj' })]);
    renderInRouter();
    expect(document.querySelector('.folder-head-label')?.textContent).toBe('proj');
  });

  // A row whose folder is not known yet (chatStore's optimistic seed, and any
  // row built from an event that carries no folder) groups under `''`, which
  // has no project name — it drew a headless, nameless folder heading over the
  // rows, with archive buttons for "project ''". The rows stay; the heading goes.
  it('draws no folder header for a group whose folder is empty, but still lists its rows', () => {
    useChatStore
      .getState()
      .hydrate([
        rowFixture({ chatId: 'no-folder', name: null, folder: '', daemonId: '' }),
        rowFixture({ chatId: 'in-proj', folder: '~/proj' }),
      ]);
    renderInRouter();
    const labels = Array.from(document.querySelectorAll('.folder-head-label')).map(
      (el) => el.textContent,
    );
    expect(labels).toEqual(['proj']);
    expect(labels).not.toContain('');
    // No archive-project button addressed to the empty folder either.
    expect(document.querySelector('[data-testid="folder-archive-"]')).toBeNull();
    expect(document.querySelector('[data-testid="folder-archive-all-"]')).toBeNull();
    // The chat itself is still reachable — hiding a real row would be worse.
    expect(screen.getByTestId('chat-row-no-folder')).toBeInTheDocument();
    expect(screen.getByTestId('folder-section-unfiled')).toBeInTheDocument();
  });

  it('sorts folders by most recent activity, and within a folder ranks permission > working > rest', () => {
    useChatStore
      .getState()
      .hydrate([
        rowFixture({ chatId: 'old-folder-1', folder: '~/old', lastUpdated: 1 }),
        rowFixture({ chatId: 'new-folder-1', folder: '~/new', lastUpdated: 100 }),
      ]);
    renderInRouter();
    const folderHeads = Array.from(document.querySelectorAll('.folder-head-label')).map(
      (el) => el.textContent,
    );
    expect(folderHeads.indexOf('new')).toBeLessThan(folderHeads.indexOf('old'));
  });

  it('within a folder, a merely-working chat does NOT rank above an idle one — the badge shows it, position does not move', () => {
    useChatStore
      .getState()
      .hydrate([
        rowFixture({ chatId: 'idle2', folder: '~/wk', lastUpdated: 300, activity: 'idle' }),
        rowFixture({ chatId: 'work2', folder: '~/wk', lastUpdated: 1, activity: 'running' }),
      ]);
    renderInRouter();
    const rows = Array.from(document.querySelectorAll('[data-testid^="chat-row-"]')).map((el) =>
      el.getAttribute('data-testid'),
    );
    // spec/14 § Sidebar ordering: `activity` never moved the user's own last
    // send, so work2's older `lastUserActivity` (mirrored from `lastUpdated`
    // by the fixture) keeps it below idle2, agent activity notwithstanding.
    expect(rows.indexOf('chat-row-idle2')).toBeLessThan(rows.indexOf('chat-row-work2'));
  });

  it('within a folder, a permission request does NOT rank the chat above an older idle one — the badge shows it, position does not move', () => {
    useChatStore
      .getState()
      .hydrate([
        rowFixture({ chatId: 'idle1', folder: '~/proj', lastUpdated: 300, activity: 'idle' }),
        rowFixture({ chatId: 'work1', folder: '~/proj', lastUpdated: 1, activity: 'running' }),
      ]);
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'work1',
      requestId: 'r1',
      seq: 1,
      request: { tool: 'Bash', args: {}, description: 'x' },
    });
    renderInRouter();
    const rows = Array.from(document.querySelectorAll('[data-testid^="chat-row-"]')).map((el) =>
      el.getAttribute('data-testid'),
    );
    // spec/14 § Sidebar ordering: work1 going `awaiting-permission` is an
    // agent-side state change, not a user send, so it stays below idle1 —
    // the `permission` badge is what tells the user it needs them, not a
    // jump to the top of the folder.
    expect(rows.indexOf('chat-row-idle1')).toBeLessThan(rows.indexOf('chat-row-work1'));
  });

  it('within a folder, chats that tie on recency render in a consistent order regardless of input order', () => {
    // Two chats in the same folder, identical lastUpdated and idle badge. With
    // no deterministic tiebreaker the rendered order follows Object.values()
    // insertion order, so it flips when the store re-emits rows in a different
    // order (todo Bugs: "Order not consistent in conversation list").
    const rowIds = (): (string | null)[] =>
      Array.from(document.querySelectorAll('[data-testid^="chat-row-"]')).map((el) =>
        el.getAttribute('data-testid'),
      );

    useChatStore
      .getState()
      .hydrate([
        rowFixture({ chatId: 'zeta', folder: '~/tie', lastUpdated: 5 }),
        rowFixture({ chatId: 'alpha', folder: '~/tie', lastUpdated: 5 }),
      ]);
    renderInRouter();
    const orderA = rowIds();
    cleanup();

    useChatStore.getState()._reset();
    useChatStore
      .getState()
      .hydrate([
        rowFixture({ chatId: 'alpha', folder: '~/tie', lastUpdated: 5 }),
        rowFixture({ chatId: 'zeta', folder: '~/tie', lastUpdated: 5 }),
      ]);
    renderInRouter();
    const orderB = rowIds();

    expect(orderA).toEqual(orderB);
  });

  it('folders that tie on most-recent activity render in a consistent order regardless of input order', () => {
    const folderLabels = (): (string | null)[] =>
      Array.from(document.querySelectorAll('.folder-head-label')).map((el) => el.textContent);

    useChatStore
      .getState()
      .hydrate([
        rowFixture({ chatId: 'z1', folder: '~/zzz', lastUpdated: 7 }),
        rowFixture({ chatId: 'a1', folder: '~/aaa', lastUpdated: 7 }),
      ]);
    renderInRouter();
    const orderA = folderLabels();
    cleanup();

    useChatStore.getState()._reset();
    useChatStore
      .getState()
      .hydrate([
        rowFixture({ chatId: 'a1', folder: '~/aaa', lastUpdated: 7 }),
        rowFixture({ chatId: 'z1', folder: '~/zzz', lastUpdated: 7 }),
      ]);
    renderInRouter();
    const orderB = folderLabels();

    expect(orderA).toEqual(orderB);
  });

  it('the New chat FAB navigates to /chats/new', () => {
    renderInRouter();
    fireEvent.click(screen.getByTestId('new-chat-fab'));
    // MemoryRouter has no way to assert the URL directly without a Routes tree;
    // assert the button exists and is clickable without throwing.
    expect(screen.getByTestId('new-chat-fab')).toBeInTheDocument();
  });

  // spec/14 § Sidebar §8, § New windows — `+ New chat` and, beside it, the
  // segmented New chat button with its new-window dropdown.
  describe('New chat in new window button (§ New windows)', () => {
    it('is a segmented split button: a caret opens a dropdown holding the new-window action', () => {
      const spy = vi.spyOn(newWindow, 'openNewChatInNewWindow').mockImplementation(() => {});
      renderInRouter();

      const toggle = screen.getByTestId('new-chat-split-toggle');
      expect(toggle).toHaveAttribute('aria-haspopup', 'menu');
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByTestId('new-chat-split-menu')).not.toBeInTheDocument();
      expect(screen.queryByTestId('new-chat-in-new-window')).not.toBeInTheDocument();

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByTestId('new-chat-split-menu')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('new-chat-in-new-window'));
      expect(spy).toHaveBeenCalledTimes(1);
      // Choosing closes the menu.
      expect(screen.queryByTestId('new-chat-split-menu')).not.toBeInTheDocument();
    });

    it('Escape closes the dropdown without acting', () => {
      const spy = vi.spyOn(newWindow, 'openNewChatInNewWindow').mockImplementation(() => {});
      renderInRouter();
      fireEvent.click(screen.getByTestId('new-chat-split-toggle'));
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByTestId('new-chat-split-menu')).not.toBeInTheDocument();
      expect(spy).not.toHaveBeenCalled();
    });

    it('carries no tooltip that restates its label; the + New chat segment shows only the chord', () => {
      renderInRouter();
      expect(screen.getByTestId('new-chat-fab').getAttribute('title')).toBe('Ctrl+N');
      expect(screen.getByTestId('new-chat-split-toggle')).not.toHaveAttribute('title');
      fireEvent.click(screen.getByTestId('new-chat-split-toggle'));
      expect(screen.getByTestId('new-chat-in-new-window')).not.toHaveAttribute('title');
    });

    it('does NOT navigate the current window, unlike the + New chat segment beside it', () => {
      const spy = vi.spyOn(newWindow, 'openNewChatInNewWindow').mockImplementation(() => {});
      const seen: string[] = [];
      function LocationProbe(): null {
        const loc = useLocation();
        seen.push(`${loc.pathname}${loc.search}`);
        return null;
      }
      render(
        <MemoryRouter initialEntries={['/chats/c1']}>
          <Sidebar />
          <LocationProbe />
        </MemoryRouter>,
      );
      expect(seen.at(-1)).toBe('/chats/c1');

      fireEvent.click(screen.getByTestId('new-chat-split-toggle'));
      fireEvent.click(screen.getByTestId('new-chat-in-new-window'));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(seen.at(-1)).toBe('/chats/c1');

      fireEvent.click(screen.getByTestId('new-chat-fab'));
      expect(seen.at(-1)).toMatch(/^\/chats\/new/);
    });

    it('sits on one row: the + New chat segment, then the caret segment', () => {
      renderInRouter();
      const row = screen.getByTestId('new-chat-row');
      const buttons = row.querySelectorAll('button');
      expect(buttons).toHaveLength(2);
      expect(buttons[0]).toBe(screen.getByTestId('new-chat-fab'));
      expect(buttons[1]).toBe(screen.getByTestId('new-chat-split-toggle'));
    });
  });

  // spec/14 § Sidebar §1, § New windows.
  describe('Open sidebar in new window', () => {
    it('clicking the brand-row icon calls openSidebarInNewWindow', () => {
      const spy = vi.spyOn(newWindow, 'openSidebarInNewWindow').mockImplementation(() => {});
      renderInRouter();
      fireEvent.click(screen.getByTestId('sidebar-open-window'));
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // spec/14 § New windows — a window opened via one of the new-window actions
  // renders the sidebar `standalone`: full width, no collapse/open-window
  // controls (nothing to collapse back into, and it already IS the detached
  // window).
  describe('standalone prop (detached sidebar window)', () => {
    it('renders at full width and hides the collapse + open-window buttons', () => {
      renderInRouter({ standalone: true });
      expect(screen.getByTestId('sidebar').style.width).toBe('100%');
      expect(screen.queryByTestId('sidebar-collapse')).not.toBeInTheDocument();
      expect(screen.queryByTestId('sidebar-open-window')).not.toBeInTheDocument();
    });

    it('still renders both New chat buttons', () => {
      renderInRouter({ standalone: true });
      expect(screen.getByTestId('new-chat-fab')).toBeInTheDocument();
      expect(screen.getByTestId('new-chat-split-toggle')).toBeInTheDocument();
    });
  });

  it('bottom nav links to /jobs and /settings', () => {
    renderInRouter();
    const nav = screen.getByTestId('bottom-nav');
    expect(nav.querySelector('a[href="/jobs"]')).toBeTruthy();
    expect(nav.querySelector('a[href="/settings"]')).toBeTruthy();
  });

  it('archive button archives an active chat and reverts + toasts on API failure', async () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'arch1', folder: '~/proj' })]);
    vi.spyOn(api, 'archiveChat').mockRejectedValueOnce(new Error('offline'));
    renderInRouter();
    fireEvent.click(screen.getByTestId('archive-btn-arch1'));
    expect(useChatStore.getState().chats['arch1']?.status).toBe('archived');
    await waitFor(() => {
      expect(useChatStore.getState().chats['arch1']?.status).toBe('active');
    });
    expect(useUiStore.getState().errors[0]?.message).toContain('Archive failed');
  });

  it('archive of a ghost row the server does not know (404) drops the row instead of reverting', async () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'ghost1', folder: '~/proj' })]);
    vi.spyOn(api, 'archiveChat').mockRejectedValueOnce(
      new ApiError(404, 'chat not found: ghost1', { error: 'chat not found: ghost1' }),
    );
    renderInRouter();
    fireEvent.click(screen.getByTestId('archive-btn-ghost1'));
    await waitFor(() => {
      expect(useChatStore.getState().chats['ghost1']).toBeUndefined();
    });
    expect(useUiStore.getState().errors).toHaveLength(0);
  });

  it('archive button un-archives an already-archived row', async () => {
    useChatStore
      .getState()
      .hydrate([rowFixture({ chatId: 'arch2', folder: '~/proj', status: 'archived' })]);
    vi.spyOn(api, 'archiveChat').mockResolvedValue(undefined as never);
    renderInRouter();
    fireEvent.click(screen.getByTestId('archived-toggle'));
    const btn = screen.getByTestId('archive-btn-arch2');
    // An open box for the way back, not the closed Archive glyph.
    expect(btn.querySelector('svg')?.getAttribute('class')).toContain('lucide-package-open');
    fireEvent.click(btn);
    expect(useChatStore.getState().chats['arch2']?.status).toBe('active');
  });

  it('archive-project archives every chat in the folder (after confirming the custom modal)', async () => {
    useChatStore
      .getState()
      .hydrate([
        rowFixture({ chatId: 'p1', folder: '/home/tom/projects/portfolio', lastUpdated: 2 }),
        rowFixture({ chatId: 'p2', folder: '/home/tom/projects/portfolio', lastUpdated: 1 }),
      ]);
    const archiveSpy = vi.spyOn(api, 'archiveChat').mockResolvedValue(undefined as never);
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderInRouter();
    fireEvent.click(screen.getByTestId('folder-archive-/home/tom/projects/portfolio'));
    // Custom modal, not native confirm().
    expect(confirmSpy).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    // Both chats flip to archived and each fires the REST archive.
    await vi.waitFor(() => {
      expect(useChatStore.getState().chats['p1']?.status).toBe('archived');
    });
    expect(useChatStore.getState().chats['p2']?.status).toBe('archived');
    expect(archiveSpy).toHaveBeenCalledWith('p1', true);
    expect(archiveSpy).toHaveBeenCalledWith('p2', true);
    confirmSpy.mockRestore();
  });

  it('a folder header + button starts a new chat preselected to that folder', () => {
    useChatStore
      .getState()
      .hydrate([rowFixture({ chatId: 'nc1', folder: '/home/tom/projects/portfolio' })]);
    const seen: string[] = [];
    function LocationProbe(): null {
      const loc = useLocation();
      seen.push(`${loc.pathname}${loc.search}`);
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar />
        <LocationProbe />
      </MemoryRouter>,
    );
    const btn = screen.getByTestId('folder-new-chat-/home/tom/projects/portfolio');
    expect(btn).toHaveAttribute('aria-label', 'New chat in project portfolio');
    fireEvent.click(btn);
    expect(seen.at(-1)).toBe('/chats/new?folder=%2Fhome%2Ftom%2Fprojects%2Fportfolio');
  });

  it('archive-project is a no-op when the custom modal is dismissed', async () => {
    useChatStore
      .getState()
      .hydrate([rowFixture({ chatId: 'q1', folder: '/home/tom/projects/keep' })]);
    const archiveSpy = vi.spyOn(api, 'archiveChat').mockResolvedValue(undefined as never);
    renderInRouter();
    fireEvent.click(screen.getByTestId('folder-archive-/home/tom/projects/keep'));
    fireEvent.click(await screen.findByTestId('confirm-cancel'));
    await vi.waitFor(() => {
      expect(screen.queryByTestId('confirm-modal')).not.toBeInTheDocument();
    });
    expect(useChatStore.getState().chats['q1']?.status).toBe('active');
    expect(archiveSpy).not.toHaveBeenCalled();
  });

  // archive-all-in-project (spec/14 § Sidebar → Folders): the SECOND header
  // button. The listed rows are not the whole project — groupChats buckets
  // pinned and snoozed chats out before the folder list is built — so the
  // narrow button leaves a project half-archived. These cover the difference.
  it('archive-all-in-project also archives the folder pinned and snoozed chats', async () => {
    useChatStore.getState().hydrate([
      rowFixture({ chatId: 'a1', folder: '/home/tom/projects/all', lastUpdated: 3 }),
      rowFixture({
        chatId: 'a2',
        folder: '/home/tom/projects/all',
        pinned: true,
        pinnedAt: 5,
        disabled: false,
        lastUpdated: 2,
      }),
      rowFixture({
        chatId: 'a3',
        folder: '/home/tom/projects/all',
        snoozedUntil: Date.now() + 60_000,
        lastUpdated: 1,
      }),
    ]);
    const archiveSpy = vi.spyOn(api, 'archiveChat').mockResolvedValue(undefined as never);
    renderInRouter();
    fireEvent.click(screen.getByTestId('folder-archive-all-/home/tom/projects/all'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await vi.waitFor(() => {
      expect(useChatStore.getState().chats['a1']?.status).toBe('archived');
    });
    expect(useChatStore.getState().chats['a2']?.status).toBe('archived');
    expect(useChatStore.getState().chats['a3']?.status).toBe('archived');
    expect(archiveSpy).toHaveBeenCalledWith('a2', true);
    expect(archiveSpy).toHaveBeenCalledWith('a3', true);
  });

  it('the narrow archive-project button still leaves pinned and snoozed chats alone', async () => {
    useChatStore.getState().hydrate([
      rowFixture({ chatId: 'b1', folder: '/home/tom/projects/narrow', lastUpdated: 3 }),
      rowFixture({
        chatId: 'b2',
        folder: '/home/tom/projects/narrow',
        pinned: true,
        pinnedAt: 5,
        disabled: false,
        lastUpdated: 2,
      }),
      rowFixture({
        chatId: 'b3',
        folder: '/home/tom/projects/narrow',
        snoozedUntil: Date.now() + 60_000,
        lastUpdated: 1,
      }),
    ]);
    const archiveSpy = vi.spyOn(api, 'archiveChat').mockResolvedValue(undefined as never);
    renderInRouter();
    fireEvent.click(screen.getByTestId('folder-archive-/home/tom/projects/narrow'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await vi.waitFor(() => {
      expect(useChatStore.getState().chats['b1']?.status).toBe('archived');
    });
    expect(useChatStore.getState().chats['b2']?.status).toBe('active');
    expect(useChatStore.getState().chats['b3']?.status).toBe('active');
    expect(archiveSpy).not.toHaveBeenCalledWith('b2', true);
    expect(archiveSpy).not.toHaveBeenCalledWith('b3', true);
  });

  it('archive-all-in-project never archives a special thread sharing the folder', async () => {
    useChatStore.getState().hydrate([
      rowFixture({ chatId: 'sp1', folder: '/home/tom/projects/spec', lastUpdated: 3 }),
      rowFixture({
        chatId: SPECIAL_THREAD_IDS.speakers,
        folder: '/home/tom/projects/spec',
        lastUpdated: 2,
      }),
      rowFixture({ chatId: 'thread_manager', folder: '/home/tom/projects/spec', lastUpdated: 1 }),
    ]);
    const archiveSpy = vi.spyOn(api, 'archiveChat').mockResolvedValue(undefined as never);
    renderInRouter();
    fireEvent.click(screen.getByTestId('folder-archive-all-/home/tom/projects/spec'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await vi.waitFor(() => {
      expect(useChatStore.getState().chats['sp1']?.status).toBe('archived');
    });
    expect(useChatStore.getState().chats[SPECIAL_THREAD_IDS.speakers]?.status).toBe('active');
    expect(useChatStore.getState().chats['thread_manager']?.status).toBe('active');
    expect(archiveSpy).toHaveBeenCalledTimes(1);
    expect(archiveSpy).toHaveBeenCalledWith('sp1', true);
  });

  it('archive-all-in-project reverts just the failing row and toasts', async () => {
    useChatStore.getState().hydrate([
      rowFixture({ chatId: 'f1', folder: '/home/tom/projects/fail', lastUpdated: 2 }),
      rowFixture({
        chatId: 'f2',
        folder: '/home/tom/projects/fail',
        pinned: true,
        pinnedAt: 5,
        disabled: false,
        lastUpdated: 1,
      }),
    ]);
    vi.spyOn(api, 'archiveChat').mockImplementation((chatId: string) =>
      chatId === 'f2' ? Promise.reject(new Error('offline')) : Promise.resolve(undefined as never),
    );
    renderInRouter();
    fireEvent.click(screen.getByTestId('folder-archive-all-/home/tom/projects/fail'));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await vi.waitFor(() => {
      expect(useUiStore.getState().errors.length).toBeGreaterThan(0);
    });
    expect(useUiStore.getState().errors[0]?.message).toContain('Archive failed');
    // Only the rejected row reverts; the one that succeeded stays archived.
    expect(useChatStore.getState().chats['f2']?.status).toBe('active');
    expect(useChatStore.getState().chats['f1']?.status).toBe('archived');
  });

  it('archive-all-in-project is a no-op when the confirm is dismissed', async () => {
    useChatStore
      .getState()
      .hydrate([rowFixture({ chatId: 'n1', folder: '/home/tom/projects/nope' })]);
    const archiveSpy = vi.spyOn(api, 'archiveChat').mockResolvedValue(undefined as never);
    renderInRouter();
    fireEvent.click(screen.getByTestId('folder-archive-all-/home/tom/projects/nope'));
    fireEvent.click(await screen.findByTestId('confirm-cancel'));
    await vi.waitFor(() => {
      expect(screen.queryByTestId('confirm-modal')).not.toBeInTheDocument();
    });
    expect(useChatStore.getState().chats['n1']?.status).toBe('active');
    expect(archiveSpy).not.toHaveBeenCalled();
  });

  // Whole-project snooze (spec/04 § Snooze → "Whole-project snooze", spec/14
  // § Sidebar → Folders): the folder header's THIRD control. Reaches the same
  // "all in project" set as the wide archive button — pinned and already-
  // snoozed chats included, special threads excluded — with no confirm step,
  // since picking a preset is itself the deliberate act.
  it('snoozing a whole project reaches every chat in it, including pinned and already-snoozed ones', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    useChatStore.getState().hydrate([
      rowFixture({ chatId: 's1', folder: '/home/tom/projects/snz', lastUpdated: 3 }),
      rowFixture({
        chatId: 's2',
        folder: '/home/tom/projects/snz',
        pinned: true,
        pinnedAt: 5,
        disabled: false,
        lastUpdated: 2,
      }),
      rowFixture({
        chatId: 's3',
        folder: '/home/tom/projects/snz',
        snoozedUntil: Date.now() + 60_000,
        lastUpdated: 1,
      }),
      rowFixture({
        chatId: SPECIAL_THREAD_IDS.speakers,
        folder: '/home/tom/projects/snz',
        lastUpdated: 4,
      }),
    ]);
    const snoozeSpy = vi.spyOn(api, 'snoozeChat').mockResolvedValue(undefined as never);
    renderInRouter();
    fireEvent.click(screen.getByTestId('folder-snooze-/home/tom/projects/snz'));
    fireEvent.click(screen.getByTestId('project-snooze-preset-5-minutes'));
    const expected = Date.now() + 5 * 60_000;
    expect(useChatStore.getState().chats['s1']?.snoozedUntil).toBe(expected);
    expect(useChatStore.getState().chats['s2']?.snoozedUntil).toBe(expected);
    expect(useChatStore.getState().chats['s3']?.snoozedUntil).toBe(expected);
    expect(useChatStore.getState().chats[SPECIAL_THREAD_IDS.speakers]?.snoozedUntil).toBeNull();
    expect(snoozeSpy).toHaveBeenCalledWith('s1', expected);
    expect(snoozeSpy).toHaveBeenCalledWith('s2', expected);
    expect(snoozeSpy).toHaveBeenCalledWith('s3', expected);
    expect(snoozeSpy).not.toHaveBeenCalledWith(SPECIAL_THREAD_IDS.speakers, expect.anything());
    vi.useRealTimers();
  });

  it('whole-project snooze reverts just the failing chat and toasts', async () => {
    useChatStore
      .getState()
      .hydrate([
        rowFixture({ chatId: 't1', folder: '/home/tom/projects/fail-snz', lastUpdated: 2 }),
        rowFixture({ chatId: 't2', folder: '/home/tom/projects/fail-snz', lastUpdated: 1 }),
      ]);
    vi.spyOn(api, 'snoozeChat').mockImplementation((chatId: string) =>
      chatId === 't2' ? Promise.reject(new Error('offline')) : Promise.resolve(undefined as never),
    );
    renderInRouter();
    fireEvent.click(screen.getByTestId('folder-snooze-/home/tom/projects/fail-snz'));
    fireEvent.click(await screen.findByTestId('project-snooze-preset-1-hour'));
    await vi.waitFor(() => {
      expect(useUiStore.getState().errors.length).toBeGreaterThan(0);
    });
    expect(useUiStore.getState().errors[0]?.message).toContain('Snooze failed');
    expect(useChatStore.getState().chats['t2']?.snoozedUntil).toBeNull();
    expect(useChatStore.getState().chats['t1']?.snoozedUntil).not.toBeNull();
  });

  it('has no whole-project snooze control on the nameless-folder header', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'no-folder-snz', folder: '' })]);
    renderInRouter();
    expect(document.querySelector('[data-testid="folder-snooze-"]')).toBeNull();
  });

  it('the mic button: a quick tap promotes to a toggle session (no PTT send)', () => {
    vi.useFakeTimers();
    useChatStore.getState().hydrate([rowFixture({ chatId: 'm1' })]);
    renderInRouter();
    const mic = screen.getByTestId('row-mic-m1');
    fireEvent.mouseDown(mic);
    expect(useVoiceStore.getState().note?.chatId).toBe('m1');
    expect(useVoiceStore.getState().note?.gesture).toBe('ptt');
    fireEvent.mouseUp(mic); // released immediately — well under TAP_MS
    expect(useVoiceStore.getState().note?.gesture).toBe('toggle');
    vi.useRealTimers();
  });

  it('the mic button: a long hold sends on release (PTT)', () => {
    vi.useFakeTimers();
    useChatStore.getState().hydrate([rowFixture({ chatId: 'm2' })]);
    renderInRouter();
    const mic = screen.getByTestId('row-mic-m2');
    fireEvent.mouseDown(mic);
    vi.advanceTimersByTime(400); // over TAP_MS
    fireEvent.mouseUp(mic);
    expect(useVoiceStore.getState().note).toBeNull(); // sendVoiceNote() ended it
    vi.useRealTimers();
  });

  it('the mic button: a second tap while already toggled sends immediately', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'm3' })]);
    act(() => {
      useVoiceStore.getState().startNote('m3', 'toggle');
    });
    renderInRouter();
    const mic = screen.getByTestId('row-mic-m3');
    fireEvent.mouseDown(mic);
    expect(useVoiceStore.getState().note).toBeNull();
  });

  it('the mic button: mouseUp with no matching PTT note in flight is a no-op', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'm4' })]);
    renderInRouter();
    const mic = screen.getByTestId('row-mic-m4');
    // No mousedown first — pressAt stays null, so mouseup should just return.
    expect(() => fireEvent.mouseUp(mic)).not.toThrow();
    expect(useVoiceStore.getState().note).toBeNull();
  });

  it('the mic button: mouseLeave after a long hold commits (send), a quick leave promotes to toggle', () => {
    vi.useFakeTimers();
    useChatStore
      .getState()
      .hydrate([rowFixture({ chatId: 'm5' }), rowFixture({ chatId: 'm6', folder: '~/proj2' })]);
    renderInRouter();
    // Long hold then leave (not mouseup) → commits.
    const mic5 = screen.getByTestId('row-mic-m5');
    fireEvent.mouseDown(mic5);
    vi.advanceTimersByTime(400);
    fireEvent.mouseLeave(mic5);
    expect(useVoiceStore.getState().note).toBeNull();

    // Quick leave (under TAP_MS) → promotes to toggle instead of sending.
    const mic6 = screen.getByTestId('row-mic-m6');
    fireEvent.mouseDown(mic6);
    fireEvent.mouseLeave(mic6);
    expect(useVoiceStore.getState().note?.gesture).toBe('toggle');
    vi.useRealTimers();
  });

  it('the mic button: mouseLeave with nothing pressed is a no-op', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'm7' })]);
    renderInRouter();
    expect(() => fireEvent.mouseLeave(screen.getByTestId('row-mic-m7'))).not.toThrow();
  });

  it('the mic button click does not navigate (preventDefault/stopPropagation only)', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'm8' })]);
    renderInRouter();
    expect(() => fireEvent.click(screen.getByTestId('row-mic-m8'))).not.toThrow();
  });

  // E4: the sidebar pin control reflects pinned state (previously a dead marker).
  it('shows the pin control as pinned on pinned rows', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'pin1', pinned: true, pinnedAt: 5 })]);
    renderInRouter();
    const pinBtn = screen.getByTestId('pin-btn-pin1');
    expect(pinBtn).toBeTruthy();
    expect(pinBtn.className).toContain('is-pinned');
    expect(pinBtn.getAttribute('aria-pressed')).toBe('true');
  });

  // E4: clicking the sidebar pin control fires the pin request, flips the row to
  // pinned (so it moves into the Pinned section), and reverts + toasts on failure.
  it('clicking the sidebar pin toggles pin: optimistic flip + REST call, pinned row sorts to Pinned', async () => {
    useChatStore
      .getState()
      .hydrate([rowFixture({ chatId: 'topin', folder: '~/proj', pinned: false })]);
    const spy = vi.spyOn(api, 'pinChat').mockResolvedValue(undefined as never);
    renderInRouter();
    // Not pinned yet → no Pinned section.
    expect(screen.queryByTestId('pinned-section')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pin-btn-topin'));
    expect(spy).toHaveBeenCalledWith('topin', true);
    expect(useChatStore.getState().chats['topin']?.pinned).toBe(true);
    // The now-pinned row shows in the Pinned section.
    await waitFor(() => {
      expect(screen.getByTestId('pinned-section')).toBeInTheDocument();
    });
    expect(screen.getByTestId('pin-btn-topin').className).toContain('is-pinned');
    spy.mockRestore();
  });

  it('sidebar pin reverts + toasts when the REST call fails', async () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'pinfail', folder: '~/proj' })]);
    vi.spyOn(api, 'pinChat').mockRejectedValueOnce(new Error('offline'));
    renderInRouter();
    fireEvent.click(screen.getByTestId('pin-btn-pinfail'));
    expect(useChatStore.getState().chats['pinfail']?.pinned).toBe(true);
    await waitFor(() => {
      expect(useChatStore.getState().chats['pinfail']?.pinned).toBe(false);
    });
    expect(useUiStore.getState().errors.some((e) => e.message.includes('Pin failed'))).toBe(true);
  });

  it('the pin control does not appear on the special Manager row', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_manager',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'manager',
        folder: '/home/tom/.patch/threads/manager',
        activity: 'idle',
        status: 'active',
        pinned: true,
        pinnedAt: 50,
        disabled: false,
        lastUpdated: 1,
      },
    ]);
    renderInRouter();
    expect(screen.queryByTestId('pin-btn-thread_manager')).not.toBeInTheDocument();
  });

  it('formatWhen renders now/minutes/hours/days and an empty string for a zero timestamp', () => {
    const now = Date.now();
    useChatStore
      .getState()
      .hydrate([
        rowFixture({ chatId: 'w-now', folder: '~/w', lastUpdated: now - 1000 }),
        rowFixture({ chatId: 'w-min', folder: '~/w', lastUpdated: now - 5 * 60_000 }),
        rowFixture({ chatId: 'w-hr', folder: '~/w', lastUpdated: now - 3 * 3600_000 }),
        rowFixture({ chatId: 'w-day', folder: '~/w', lastUpdated: now - 2 * 86_400_000 }),
        rowFixture({ chatId: 'w-zero', folder: '~/w', lastUpdated: 0 }),
      ]);
    renderInRouter();
    expect(screen.getByTestId('row-when-w-now').querySelector('.when-time')?.textContent).toBe(
      'now',
    );
    expect(screen.getByTestId('row-when-w-min').querySelector('.when-time')?.textContent).toBe(
      '5m',
    );
    expect(screen.getByTestId('row-when-w-hr').querySelector('.when-time')?.textContent).toBe('3h');
    expect(screen.getByTestId('row-when-w-day').querySelector('.when-time')?.textContent).toBe(
      '2d',
    );
    expect(screen.getByTestId('row-when-w-zero').querySelector('.when-time')?.textContent).toBe('');
  });

  it('strips markdown syntax from titles/previews so the sidebar shows plain text', () => {
    useChatStore.getState().hydrate([
      rowFixture({
        chatId: 'md1',
        folder: '~/proj',
        name: '**Bold** `code` [link](http://x) # H1 > quote - item | a | b | ---',
        preview: 'plain preview text',
      }),
    ]);
    renderInRouter();
    const name = screen.getByTestId('chat-row-md1').querySelector('.name')?.textContent ?? '';
    expect(name).not.toContain('**');
    expect(name).not.toContain('`');
    expect(name).not.toContain('[');
    expect(name).not.toContain('|');
    expect(name).toContain('Bold');
    expect(name).toContain('code');
    expect(name).toContain('link');
  });

  it('archived section: a load failure is reported under the toggle', async () => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'listChatsArchived').mockRejectedValue(new Error('db down'));
    renderInRouter();
    fireEvent.click(screen.getByTestId('archived-toggle'));
    await waitFor(() => {
      expect(screen.getByTestId('archived-load-error')).toHaveTextContent('db down');
    });
  });

  it('folds real archived rows returned by the lazy GET /api/chats?archived=only fetch into the store', async () => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({
      chats: [
        {
          chatId: 'lazy-archived-1',
          daemonId: 'd1',
          permissionMode: 'bypassPermissions' as const,
          name: 'old thing',
          preview: 'a snippet',
          folder: '~/proj',
          activity: 'idle',
          status: 'archived',
          pinned: false,
          pinnedAt: null,
          disabled: false,
          lastUpdated: 5,
        },
      ],
      nextOffset: null,
    });
    renderInRouter();
    fireEvent.click(screen.getByTestId('archived-toggle'));
    await waitFor(() => {
      expect(screen.getByTestId('chat-row-lazy-archived-1')).toBeInTheDocument();
    });
    expect(useChatStore.getState().chats['lazy-archived-1']?.preview).toBe('a snippet');
  });

  // spec/14 §6: an empty lifecycle section costs the sidebar nothing — the count
  // in its icon's tooltip IS the empty state, and opening it grows no "open in
  // main window" head (LifecyclePanel withholds that for a `0` count).
  it('archived section: empty is a 0 on the toggle, with no body', () => {
    seedCounts();
    renderInRouter();
    fireEvent.click(screen.getByTestId('archived-toggle'));
    expect(screen.getByTestId('archived-toggle')).toHaveAttribute(
      'title',
      'Archived · 0 (Ctrl+Shift+A)',
    );
    expect(screen.getByTestId('archived-section')).toBeEmptyDOMElement();
    expect(screen.queryByTestId('archived-open-main')).toBeNull();
    expect(screen.queryByTestId('archived-search')).toBeNull();
  });

  // spec/14 §6: the count is what tells the user whether opening a section is
  // worth the vertical space it takes, so it has to be there BEFORE the click —
  // in the icon's tooltip, since the icon row draws no text of its own. The
  // numbers below are deliberately unequal, and none of them is derivable from
  // the store — nothing is hydrated here — which is the point: a count
  // measured from the loaded rows would read 0 on all five.
  it('every lifecycle row carries its count while COLLAPSED, from the server', () => {
    seedCounts({ hidden: 5, archived: 12, snoozed: 3, deleted: 1, automations: 7 });
    renderInRouter();
    expect(screen.getByTestId('hidden-toggle')).toHaveAttribute('title', 'Hidden · 5');
    expect(screen.getByTestId('archived-toggle')).toHaveAttribute(
      'title',
      'Archived · 12 (Ctrl+Shift+A)',
    );
    expect(screen.getByTestId('snoozed-toggle')).toHaveAttribute('title', 'Snoozed · 3');
    expect(screen.getByTestId('deleted-toggle')).toHaveAttribute('title', 'Deleted · 1');
    expect(screen.getByTestId('automations-toggle')).toHaveAttribute('title', 'Automations · 7');
    // No section is open — the tooltips above are not a side effect of expansion.
    expect(screen.queryByTestId('archived-section')).toBeNull();
    // The count survives a round trip through expand/collapse rather than being
    // swapped for a locally-derived one while open.
    fireEvent.click(screen.getByTestId('archived-toggle'));
    expect(screen.getByTestId('archived-toggle')).toHaveAttribute(
      'title',
      'Archived · 12 (Ctrl+Shift+A)',
    );
    fireEvent.click(screen.getByTestId('archived-toggle'));
    expect(screen.getByTestId('archived-toggle')).toHaveAttribute(
      'title',
      'Archived · 12 (Ctrl+Shift+A)',
    );
  });

  // NO FALLBACK: counts that haven't loaded (or failed to) draw no count
  // segment in the tooltip at all. A placeholder `0` would be indistinguishable
  // from a genuinely empty section — and `0` is exactly what stops the user
  // opening it.
  it("a row's tooltip carries no count segment until the counts have loaded", () => {
    renderInRouter();
    expect(screen.getByTestId('hidden-toggle')).toHaveAttribute('title', 'Hidden');
    expect(screen.getByTestId('archived-toggle')).toHaveAttribute(
      'title',
      'Archived (Ctrl+Shift+A)',
    );
    expect(screen.getByTestId('snoozed-toggle')).toHaveAttribute('title', 'Snoozed');
    expect(screen.getByTestId('deleted-toggle')).toHaveAttribute('title', 'Deleted');
    expect(screen.getByTestId('automations-toggle')).toHaveAttribute('title', 'Automations');
  });

  // spec/14 §5: Channels sits in the same collapsed set, and its size is known
  // client-side — the special-thread rows are always listed. The assertion is
  // against the rows the section actually draws, not a literal, so a third
  // channel would fail here rather than silently under-report.
  it('Channels carries a count while collapsed, matching the rows it expands to', () => {
    renderInRouter();
    const badge = screen.getByTestId('channels-count');
    expect(badge).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('channels-toggle'));
    const rows = screen.getByTestId('channels-list').querySelectorAll('.ch-row');
    expect(badge).toHaveTextContent(String(rows.length));
  });

  it('archived section: a populated section counts its rows and has no search field of its own', () => {
    useChatStore
      .getState()
      .hydrate([
        rowFixture({ chatId: 'a-count-1', folder: '~/proj', status: 'archived' }),
        rowFixture({ chatId: 'a-count-2', folder: '~/proj', status: 'archived' }),
      ]);
    seedCounts({ archived: 2 });
    renderInRouter();
    fireEvent.click(screen.getByTestId('archived-toggle'));
    // The tooltip and the rows agree — the server count is the size of the
    // very list the section expands into (spec/04 § Section counts).
    expect(screen.getByTestId('archived-toggle')).toHaveAttribute(
      'title',
      'Archived · 2 (Ctrl+Shift+A)',
    );
    expect(
      screen.getByTestId('archived-section').querySelectorAll('[data-testid^="chat-row-"]'),
    ).toHaveLength(2);
    // Archived chats are found through the sidebar's one global search field,
    // which lives in the top band, not inside the section.
    expect(screen.queryByTestId('archived-search')).toBeNull();
    expect(screen.getByTestId('archived-section').querySelector('input')).toBeNull();
    expect(screen.getByTestId('chat-search')).toBeInTheDocument();
  });

  // App Updates: "can also open in main window" — LifecyclePanel grows a link
  // to `/lifecycle/:kind` only once there's something a bigger view would
  // show; a `0` or not-yet-known count draws no link (covered by the two
  // "empty is a 0" tests above), so this one pins the positive case.
  it('a populated section grows an "open in main window" link to /lifecycle/:kind', () => {
    useChatStore
      .getState()
      .hydrate([rowFixture({ chatId: 'a-open-1', folder: '~/proj', status: 'archived' })]);
    seedCounts({ archived: 1 });
    renderInRouter();
    fireEvent.click(screen.getByTestId('archived-toggle'));
    const link = screen.getByTestId('archived-open-main');
    expect(link).toHaveAttribute('href', '/lifecycle/archived');
    expect(link).toHaveAttribute('title', 'Open in main window');
  });

  it('marks the active chat row + a read row with is-read (both class branches)', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'active1', folder: '~/proj' })]);
    // Give it a lastSeq below lastReadSeq after a markRead so badge === 'read'.
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'active1',
      role: 'assistant',
      content: 'hi',
      seq: 2,
    });
    useChatStore.getState().markRead('active1');
    useChatStore.getState().setActiveChat('active1');
    renderInRouter({ path: '/chats/active1' });
    const rowEl = screen.getByTestId('chat-row-active1');
    expect(rowEl.className).toContain('active');
    expect(rowEl.className).toContain('is-read');
  });

  it('marks the active channel row (Speakers) with the "active" class, even before it has loaded', () => {
    useChatStore.getState().setActiveChat('thread_speakers');
    renderInRouter({ path: '/chats/thread_speakers' });
    fireEvent.click(screen.getByTestId('channels-toggle'));
    const rowEl = screen.getByTestId('channel-row-thread_speakers');
    expect(rowEl.className).toContain('active');
  });

  it('marks a loaded, active, read channel row with both "active" and "is-read"', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_speakers',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'speakers',
        folder: '/home/tom/.patch/threads/speakers',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 1,
      },
    ]);
    useChatStore.getState().applyEvent({
      type: 'chat.message',
      chatId: 'thread_speakers',
      role: 'assistant',
      content: 'hi',
      seq: 2,
    });
    useChatStore.getState().markRead('thread_speakers');
    useChatStore.getState().setActiveChat('thread_speakers');
    renderInRouter({ path: '/chats/thread_speakers' });
    fireEvent.click(screen.getByTestId('channels-toggle'));
    const rowEl = screen.getByTestId('channel-row-thread_speakers');
    expect(rowEl.className).toContain('active');
    expect(rowEl.className).toContain('is-read');
  });

  it('the mic button: mouseUp is a no-op when the note was cancelled mid-hold (gesture race)', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'race1' })]);
    renderInRouter();
    const mic = screen.getByTestId('row-mic-race1');
    fireEvent.mouseDown(mic);
    expect(useVoiceStore.getState().note?.chatId).toBe('race1');
    // Something external cancels the note mid-hold (e.g. Esc) before release.
    act(() => {
      useVoiceStore.getState().endNote();
    });
    expect(() => fireEvent.mouseUp(mic)).not.toThrow();
  });

  it('the archived-section fetch effect is cancelled cleanly on unmount (no state-after-unmount error)', () => {
    let resolveList!: (v: { chats: unknown[]; nextOffset: number | null }) => void;
    vi.spyOn(api, 'listChatsArchived').mockReturnValue(
      new Promise((r) => {
        resolveList = r;
      }),
    );
    renderInRouter();
    fireEvent.click(screen.getByTestId('archived-toggle'));
    cleanup();
    expect(() => resolveList({ chats: [], nextOffset: null })).not.toThrow();
  });

  // ---- E5: soft-delete + Deleted section + restore ----

  it('deleted chats are hidden from the active list and shown under Deleted (collapsed by default)', () => {
    useChatStore
      .getState()
      .hydrate([
        rowFixture({ chatId: 'd1', folder: '~/proj', status: 'deleted' }),
        rowFixture({ chatId: 'active1', folder: '~/proj', status: 'active' }),
      ]);
    renderInRouter();
    // Active row visible; deleted row not (Deleted section collapsed).
    expect(screen.getByTestId('chat-row-active1')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-row-d1')).not.toBeInTheDocument();
    // Expand Deleted → the deleted row appears with a restore control.
    fireEvent.click(screen.getByTestId('deleted-toggle'));
    expect(screen.getByTestId('chat-row-d1')).toBeInTheDocument();
    expect(screen.getByTestId('restore-btn-d1')).toBeInTheDocument();
  });

  it('deleting a chat via the store moves it out of the active list into Deleted, and restore brings it back', async () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'x1', folder: '~/proj' })]);
    const restoreSpy = vi.spyOn(api, 'restoreChat').mockResolvedValue({ ok: true });
    renderInRouter();
    // Starts active.
    expect(screen.getByTestId('chat-row-x1')).toBeInTheDocument();
    // Soft-delete it (as the chat-header kebab does).
    act(() => {
      useChatStore.getState().setDeleted('x1', true);
    });
    // Left the active list.
    expect(screen.queryByTestId('chat-row-x1')).not.toBeInTheDocument();
    // Appears under Deleted.
    fireEvent.click(screen.getByTestId('deleted-toggle'));
    expect(screen.getByTestId('chat-row-x1')).toBeInTheDocument();
    // Restore → REST call + returns to active list.
    fireEvent.click(screen.getByTestId('restore-btn-x1'));
    expect(restoreSpy).toHaveBeenCalledWith('x1');
    expect(useChatStore.getState().chats['x1']?.status).toBe('active');
    await waitFor(() => {
      expect(screen.getByTestId('chat-row-x1')).toBeInTheDocument();
    });
    restoreSpy.mockRestore();
  });

  it('restore reverts + toasts when the REST call fails', async () => {
    useChatStore
      .getState()
      .hydrate([rowFixture({ chatId: 'x2', folder: '~/proj', status: 'deleted' })]);
    vi.spyOn(api, 'restoreChat').mockRejectedValueOnce(new Error('offline'));
    renderInRouter();
    fireEvent.click(screen.getByTestId('deleted-toggle'));
    fireEvent.click(screen.getByTestId('restore-btn-x2'));
    expect(useChatStore.getState().chats['x2']?.status).toBe('active');
    await waitFor(() => {
      expect(useChatStore.getState().chats['x2']?.status).toBe('deleted');
    });
    expect(useUiStore.getState().errors.some((e) => e.message.includes('Restore failed'))).toBe(
      true,
    );
  });

  it('Deleted section: lazily folds soft-deleted chats into the store on expand', async () => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({ chats: [], nextOffset: null });
    vi.spyOn(api, 'listChatsDeleted').mockResolvedValue({
      chats: [
        {
          chatId: 'lazy-del-1',
          daemonId: 'd1',
          permissionMode: 'bypassPermissions' as const,
          name: 'gone',
          preview: 'a snippet',
          folder: '~/proj',
          activity: 'idle',
          status: 'deleted',
          pinned: false,
          pinnedAt: null,
          disabled: false,
          lastUpdated: 5,
        },
      ],
      nextOffset: null,
    });
    renderInRouter();
    fireEvent.click(screen.getByTestId('deleted-toggle'));
    await waitFor(() => {
      expect(screen.getByTestId('chat-row-lazy-del-1')).toBeInTheDocument();
    });
    expect(useChatStore.getState().chats['lazy-del-1']?.status).toBe('deleted');
  });

  it('Deleted section: surfaces a load-failure error', async () => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({ chats: [], nextOffset: null });
    vi.spyOn(api, 'listChatsDeleted').mockRejectedValue(new Error('db down'));
    renderInRouter();
    fireEvent.click(screen.getByTestId('deleted-toggle'));
    await waitFor(() => {
      expect(screen.getByTestId('deleted-load-error')).toHaveTextContent('db down');
    });
  });

  it('Deleted section: empty is a 0 on the toggle and no body at all', () => {
    seedCounts();
    renderInRouter();
    fireEvent.click(screen.getByTestId('deleted-toggle'));
    expect(screen.getByTestId('deleted-toggle')).toHaveAttribute('title', 'Deleted · 0');
    expect(screen.getByTestId('deleted-section')).toBeEmptyDOMElement();
  });

  it('the Deleted-section fetch effect is cancelled cleanly on unmount', () => {
    let resolveList!: (v: { chats: unknown[]; nextOffset: number | null }) => void;
    vi.spyOn(api, 'listChatsDeleted').mockReturnValue(
      new Promise((r) => {
        resolveList = r;
      }),
    );
    renderInRouter();
    fireEvent.click(screen.getByTestId('deleted-toggle'));
    cleanup();
    expect(() => resolveList({ chats: [], nextOffset: null })).not.toThrow();
  });

  // ---- E6: recent folders ----

  it('recent folders lists ONLY folders not already open above (archived-only surfaces; open folder is excluded); forget removes it', () => {
    useChatStore.getState().hydrate([
      // Only an archived chat in this folder — not shown above, so it surfaces
      // as a recent-folder entry point (a folder with no active chats).
      rowFixture({ chatId: 'arc-only', folder: '/home/tom/proj-archived', status: 'archived' }),
      // An active chat — shown above as an open Folders section, so it must NOT
      // be duplicated into recent folders.
      rowFixture({ chatId: 'act', folder: '/home/tom/proj-active', status: 'active' }),
    ]);
    renderInRouter();
    expect(screen.getByTestId('recent-folders')).toBeInTheDocument();
    expect(screen.getByTestId('recent-folder-/home/tom/proj-archived')).toBeInTheDocument();
    // Already open above → excluded from recent folders (no duplicate).
    expect(screen.queryByTestId('recent-folder-/home/tom/proj-active')).not.toBeInTheDocument();
    // Forget the archived-only folder → it leaves the list.
    fireEvent.click(screen.getByTestId('recent-folder-forget-/home/tom/proj-archived'));
    expect(screen.queryByTestId('recent-folder-/home/tom/proj-archived')).not.toBeInTheDocument();
    expect(useUiStore.getState().forgottenFolders).toContain('/home/tom/proj-archived');
  });

  it('the recents section is headed "Recent projects" — never the word "folders" (spec/14 §4b)', () => {
    useChatStore
      .getState()
      .hydrate([rowFixture({ chatId: 'rf', folder: '/home/tom/x', status: 'archived' })]);
    renderInRouter();
    const head = screen.getByTestId('recent-folders').querySelector('.folder-head');
    expect(head?.textContent).toBe('Recent projects');
    expect(screen.queryByText('Recent folders')).not.toBeInTheDocument();
  });

  it('a recent-folder row starts a new chat in that folder (does not throw / is clickable)', () => {
    // Archived-only so the folder is not open above and thus appears in recent folders.
    useChatStore
      .getState()
      .hydrate([rowFixture({ chatId: 'rf', folder: '/home/tom/x', status: 'archived' })]);
    renderInRouter();
    expect(() =>
      fireEvent.click(screen.getByTestId('recent-folder-start-/home/tom/x')),
    ).not.toThrow();
  });

  it('a root ("/") folder falls back to the raw path as its recent-folder label', () => {
    // Archived-only so it surfaces in recent folders (not open above).
    useChatStore
      .getState()
      .hydrate([rowFixture({ chatId: 'rootc', folder: '/', status: 'archived' })]);
    renderInRouter();
    const start = screen.getByTestId('recent-folder-start-/');
    expect(start.querySelector('.recent-folder-name')?.textContent).toBe('/');
  });

  it('recent-folder labels are just the basename, disambiguated only when two share a name', () => {
    // Two archived-only folders share the basename `portfolio`; a third is
    // unique. The shared pair must grow a parent segment; the unique one stays a
    // plain name (todo: "recent should just show folder name, extra only if
    // needed for disambiguation").
    useChatStore
      .getState()
      .hydrate([
        rowFixture({ chatId: 'p1', folder: '/home/tom/projects/portfolio', status: 'archived' }),
        rowFixture({ chatId: 'p2', folder: '/home/tom/work/portfolio', status: 'archived' }),
        rowFixture({ chatId: 'u1', folder: '/home/tom/code/thing', status: 'archived' }),
      ]);
    renderInRouter();
    const nameOf = (folder: string): string | undefined =>
      screen.getByTestId(`recent-folder-start-${folder}`).querySelector('.recent-folder-name')
        ?.textContent ?? undefined;
    expect(nameOf('/home/tom/projects/portfolio')).toBe('…/projects/portfolio');
    expect(nameOf('/home/tom/work/portfolio')).toBe('…/work/portfolio');
    expect(nameOf('/home/tom/code/thing')).toBe('thing');
  });

  // ---- E2: exactly one Manager, never duplicated into recent folders ----

  // ---- Needs-attention mode (todo: "Add a mode showing just what needs
  // attention and no other chats — i.e. chats that have finished.") ----
  // "Needs attention" = a chat whose badge is `done` (finished, unread) or
  // `permission` (paused, needs yes/no). `working` (still going) and `read`
  // (already seen) are NOT attention.

  it('the view dropdown reads "All chats" by default and "Unread" once selected', () => {
    renderInRouter();
    const trigger = screen.getByTestId('sidebar-view-trigger');
    expect(trigger.textContent).toContain('All chats');
    expect(trigger.className).not.toContain('active');
    selectUnreadView();
    expect(trigger.textContent).toContain('Unread');
    expect(trigger.className).toContain('active');
  });

  it('needs-attention mode shows only done + permission chats, hiding read + working', () => {
    useChatStore.getState().hydrate([
      rowFixture({
        chatId: 'att-done',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'done one',
        folder: '~/pa',
      }), // fresh → done (unread)
      rowFixture({
        chatId: 'att-read',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'read one',
        folder: '~/pa',
      }), // marked read below
      rowFixture({
        chatId: 'att-work',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'work one',
        folder: '~/pb',
        activity: 'running',
      }), // working
      rowFixture({
        chatId: 'att-perm',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'perm one',
        folder: '~/pc',
      }), // permission below
    ]);
    useChatStore.getState().markRead('att-read');
    useChatStore.getState().applyEvent({
      type: 'chat.permission_request',
      chatId: 'att-perm',
      requestId: 'rp',
      seq: 1,
      request: { tool: 'Bash', args: {}, description: 'x' },
    });
    renderInRouter();
    // With the mode off, every chat is visible.
    expect(screen.getByTestId('chat-row-att-read')).toBeInTheDocument();
    expect(screen.getByTestId('chat-row-att-work')).toBeInTheDocument();

    // Turn the mode on → only the two chats needing attention remain.
    selectUnreadView();
    expect(screen.getByTestId('chat-row-att-done')).toBeInTheDocument();
    expect(screen.getByTestId('chat-row-att-perm')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-row-att-read')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-row-att-work')).not.toBeInTheDocument();
  });

  it('needs-attention mode queues rows oldest-waiting first, and a row that updates again sinks to the bottom instead of jumping to the top', () => {
    // Todoist: "needs attention queue - updated things should be at the
    // bottom of the queue".
    useChatStore
      .getState()
      .hydrate([
        rowFixture({ chatId: 'att-first', folder: '~/pa', lastUpdated: 100 }),
        rowFixture({ chatId: 'att-second', folder: '~/pa', lastUpdated: 200 }),
      ]);
    renderInRouter();
    selectUnreadView();
    const rowIds = (): (string | null)[] =>
      Array.from(document.querySelectorAll('[data-testid^="chat-row-"]')).map((el) =>
        el.getAttribute('data-testid'),
      );
    // Oldest-waiting ('att-first') queues ahead of the more recently updated one.
    expect(rowIds().indexOf('chat-row-att-first')).toBeLessThan(
      rowIds().indexOf('chat-row-att-second'),
    );

    // 'att-first' gets updated (host-owned lastUpdated bump, same as a real
    // chat.state event) — still `done`, but now the most recently updated of
    // the two. It must sink to the BACK of the queue, not jump to the front.
    act(() => {
      useChatStore
        .getState()
        .mergeChats([rowFixture({ chatId: 'att-first', folder: '~/pa', lastUpdated: 300 })]);
    });
    expect(rowIds().indexOf('chat-row-att-second')).toBeLessThan(
      rowIds().indexOf('chat-row-att-first'),
    );
  });

  it('needs-attention mode filters pinned chats too, dropping a read pinned row', () => {
    useChatStore.getState().hydrate([
      rowFixture({
        chatId: 'pin-done',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'pd',
        folder: '~/pa',
        pinned: true,
        pinnedAt: 2,
        disabled: false,
      }),
      rowFixture({
        chatId: 'pin-read',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'pr',
        folder: '~/pa',
        pinned: true,
        pinnedAt: 1,
        disabled: false,
      }),
    ]);
    useChatStore.getState().markRead('pin-read');
    renderInRouter();
    selectUnreadView();
    expect(screen.getByTestId('chat-row-pin-done')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-row-pin-read')).not.toBeInTheDocument();
  });

  it('needs-attention mode shows an empty hint when nothing needs attention', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'only-read', folder: '~/pa' })]);
    useChatStore.getState().markRead('only-read');
    renderInRouter();
    selectUnreadView();
    expect(screen.getByTestId('attention-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-row-only-read')).not.toBeInTheDocument();
  });

  it('needs-attention mode holds the row you opened (greyed) until you navigate to a different chat', async () => {
    // localStorage (the read-watermark persistence) is shared across the whole
    // test file's jsdom window, not reset per-test — clear it so an earlier
    // test's persisted watermark can't leak into this chat's fresh badge state.
    window.localStorage.clear();
    useChatStore
      .getState()
      .hydrate([
        rowFixture({ chatId: 'hold-a', daemonId: 'd1', name: 'a', folder: '~/holdfolder' }),
        rowFixture({ chatId: 'hold-b', daemonId: 'd1', name: 'b', folder: '~/holdfolder' }),
      ]);
    renderInRouter();
    selectUnreadView();
    expect(screen.getByTestId('chat-row-hold-a')).toBeInTheDocument();
    expect(screen.getByTestId('chat-row-hold-b')).toBeInTheDocument();

    // Opening hold-a marks it read — it would ordinarily drop out of the
    // needs-attention filter immediately, but stays (greyed) since it's the
    // chat you're now viewing. The row stays mounted throughout (it never
    // drops out of the list first), so its badge only flips to `read` once
    // `useSettledBadge`'s anti-flicker debounce elapses — assert via
    // `waitFor` rather than expecting it synchronously.
    act(() => useChatStore.getState().setActiveChat('hold-a'));
    const rowA = screen.getByTestId('chat-row-hold-a');
    expect(rowA).toBeInTheDocument();
    await waitFor(() => expect(rowA.className).toContain('is-read'));
    expect(screen.getByTestId('chat-row-hold-b')).toBeInTheDocument();

    // Navigating to hold-b releases the hold on hold-a — it disappears —
    // while hold-b is now held in its place.
    act(() => useChatStore.getState().setActiveChat('hold-b'));
    expect(screen.queryByTestId('chat-row-hold-a')).not.toBeInTheDocument();
    const rowB = screen.getByTestId('chat-row-hold-b');
    expect(rowB).toBeInTheDocument();
    await waitFor(() => expect(rowB.className).toContain('is-read'));

    // Navigating off entirely (closing the chat) releases hold-b too.
    act(() => useChatStore.getState().setActiveChat(null));
    expect(screen.queryByTestId('chat-row-hold-b')).not.toBeInTheDocument();
  });

  // Todoist: "a chat you are looking at should show in the needs attention
  // view, even if you clicked a notification etc". A notification/deep-link
  // open routes straight to `setActiveChat`, which marks the chat read as
  // part of activating it — all before the Sidebar has ever rendered with
  // that chat still needing attention. The old hold logic required having
  // WITNESSED that transition across renders, so a chat activated this way
  // never entered the held state and just vanished from the filter.
  it('needs-attention mode holds a chat activated before the sidebar ever saw it needing attention', async () => {
    window.localStorage.clear();
    useChatStore
      .getState()
      .hydrate([rowFixture({ chatId: 'notif-a', daemonId: 'd1', name: 'a', folder: '~/nf' })]);
    // Activate (and thereby mark read) BEFORE the Sidebar ever mounts/renders
    // — the same order a notification or deep link produces.
    act(() => useChatStore.getState().setActiveChat('notif-a'));
    renderInRouter();
    selectUnreadView();
    const row = screen.getByTestId('chat-row-notif-a');
    expect(row).toBeInTheDocument();
    await waitFor(() => expect(row.className).toContain('is-read'));
  });

  // Tom, Patch Updates: "in needs attention it should auto hide the current chat
  // if you send a message and it no longer passes filter. otherwise its stuck
  // there as last chat". Navigating away was the only release, so the LAST chat
  // in the queue could never leave it — you answered it and it sat there.
  it('needs-attention mode releases the held row when you reply to it, even as the last one', async () => {
    window.localStorage.clear();
    useChatStore
      .getState()
      .hydrate([rowFixture({ chatId: 'reply-a', daemonId: 'd1', name: 'a', folder: '~/rf' })]);
    renderInRouter();
    selectUnreadView();
    expect(screen.getByTestId('chat-row-reply-a')).toBeInTheDocument();

    // Open it — held, greyed, still the only row.
    act(() => useChatStore.getState().setActiveChat('reply-a'));
    await waitFor(() =>
      expect(screen.getByTestId('chat-row-reply-a').className).toContain('is-read'),
    );

    // Reply: the chat goes back to `running` (badge `working`), i.e. it is the
    // agent's turn again.
    act(() =>
      useChatStore.getState().applyEvent({
        type: 'chat.state',
        chatId: 'reply-a',
        activity: 'running',
        status: 'active',
        permissionMode: 'bypassPermissions',
        folder: '~/rf',
        lastUpdated: Date.now() + 1000,
      }),
    );
    // It leaves the queue rather than sticking as the last row, and the queue
    // is now genuinely empty.
    expect(screen.queryByTestId('chat-row-reply-a')).not.toBeInTheDocument();
    expect(screen.getByTestId('attention-empty')).toBeInTheDocument();
  });

  it('needs-attention mode hides the other-chats sections (Recent folders, Archived, Deleted)', () => {
    useChatStore
      .getState()
      .hydrate([
        rowFixture({ chatId: 'arc-only', folder: '/home/tom/arch', status: 'archived' }),
        rowFixture({ chatId: 'need', folder: '/home/tom/live' }),
      ]);
    renderInRouter();
    // Present with the mode off.
    expect(screen.getByTestId('archived-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('deleted-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('recent-folders')).toBeInTheDocument();

    selectUnreadView();
    expect(screen.queryByTestId('archived-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('deleted-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recent-folders')).not.toBeInTheDocument();
    // The needs-attention chat still shows.
    expect(screen.getByTestId('chat-row-need')).toBeInTheDocument();
  });

  it('the Manager thread renders exactly once and its folder is not listed under Recent folders', () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'thread_manager',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'manager',
        folder: '/home/tom/.patch/threads/manager',
        activity: 'idle',
        status: 'active',
        pinned: true,
        pinnedAt: 50,
        disabled: false,
        lastUpdated: 1,
      },
      {
        chatId: 'thread_speakers',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'speakers',
        folder: '/home/tom/.patch/threads/speakers',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 1,
      },
    ]);
    renderInRouter();
    // Rendered exactly once (the top slot), never duplicated elsewhere.
    expect(screen.getAllByTestId('chat-row-thread_manager')).toHaveLength(1);
    // No Recent-folders entry for the special-thread folders (E2 + E6).
    expect(
      screen.queryByTestId('recent-folder-/home/tom/.patch/threads/manager'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('recent-folder-/home/tom/.patch/threads/speakers'),
    ).not.toBeInTheDocument();
    // In fact, with only special threads present, there are no recent folders.
    expect(screen.queryByTestId('recent-folders')).not.toBeInTheDocument();
  });

  // patch/todo.md § Features to add — "Current status": the agent's
  // auto-generated status is shown nested under the chat row, and a thread
  // paused on a QUESTION reads distinctly from one that is merely COMPLETE.
  describe('Current status summary', () => {
    function seedStatus(
      chatId: string,
      kind: 'question' | 'report' | 'complete',
      summary: string,
      folder = '~/proj',
      // Every existing caller means a real declared status (`patch_ask_human`/
      // `patch_report`) — only the dedicated false-positive test below passes
      // `false` to model a generated one-shot's guess.
      declared = true,
    ): void {
      // mergeChats (not hydrate) so seeding a second row doesn't wipe the first —
      // hydrate replaces the whole map, mergeChats folds rows in.
      useChatStore.getState().mergeChats([rowFixture({ chatId, name: chatId, folder })]);
      useChatStore.getState().applyEvent({
        type: 'chat.state',
        permissionMode: 'bypassPermissions' as const,
        chatId,
        activity: 'idle',
        lastUpdated: Date.now() + 1000,
        statusSummary: summary,
        statusKind: kind,
        statusDeclared: declared,
      });
    }

    it('renders the summary nested under the row', () => {
      seedStatus('cs-1', 'complete', 'Deployed to staging, nothing outstanding');
      renderInRouter();
      const el = screen.getByTestId('status-summary-cs-1');
      expect(el).toBeInTheDocument();
      expect(el).toHaveTextContent('Deployed to staging, nothing outstanding');
      // It lives INSIDE the chat row (nested), not as a detached element.
      expect(screen.getByTestId('chat-row-cs-1').contains(el)).toBe(true);
    });

    it('marks a question thread distinctly from a complete thread', () => {
      seedStatus('cs-q', 'question', 'Which branch should I deploy?', '~/pa');
      seedStatus('cs-c', 'complete', 'All tests green', '~/pb');
      renderInRouter();
      const q = screen.getByTestId('status-summary-cs-q');
      const c = screen.getByTestId('status-summary-cs-c');
      expect(q.getAttribute('data-kind')).toBe('question');
      expect(q.className).toContain('is-question');
      expect(c.getAttribute('data-kind')).toBe('complete');
      expect(c.className).toContain('is-complete');
      // "needs you" rather than "needs your answer": a question is the chat
      // being blocked on the user, and `patch_ask_human` sets it for work only
      // a person can do in the world, which is not an answer.
      expect(screen.getByLabelText('needs you')).toBeInTheDocument();
    });

    it('marks a report — the state an agent elects for itself — as its own thing', () => {
      seedStatus('cs-r', 'report', 'the backup has been failing since Tuesday', '~/pr');
      renderInRouter();
      const r = screen.getByTestId('status-summary-cs-r');
      expect(r.getAttribute('data-kind')).toBe('report');
      expect(r.className).toContain('is-report');
      expect(r).toHaveTextContent('the backup has been failing since Tuesday');
      expect(screen.getByLabelText('worth seeing')).toBeInTheDocument();
    });

    it('a report counts as needs-attention — it is the whole point of declaring one', () => {
      seedStatus('r-read', 'report', 'found three duplicate charges', '~/pr');
      useChatStore.getState().markRead('r-read');
      renderInRouter();
      selectUnreadView();
      expect(screen.getByTestId('chat-row-r-read')).toBeInTheDocument();
    });

    it('shows no summary element before one is generated', () => {
      useChatStore.getState().hydrate([rowFixture({ chatId: 'cs-none', folder: '~/p' })]);
      renderInRouter();
      expect(screen.queryByTestId('status-summary-cs-none')).not.toBeInTheDocument();
    });

    it('a question thread counts as needs-attention even once read; a complete one does not', () => {
      seedStatus('q-read', 'question', 'Need your API key', '~/pa');
      seedStatus('c-read', 'complete', 'Finished the refactor', '~/pb');
      // Both marked read → their badges are `read`, so ONLY the question keeps
      // them in the needs-attention view (a stopped/complete thread drops out).
      useChatStore.getState().markRead('q-read');
      useChatStore.getState().markRead('c-read');
      renderInRouter();
      selectUnreadView();
      expect(screen.getByTestId('chat-row-q-read')).toBeInTheDocument();
      expect(screen.queryByTestId('chat-row-c-read')).not.toBeInTheDocument();
    });

    // Bug: a GENERATED "question" guess (the one-shot summariser reading any
    // reply with a "?" as blocked on the user) is not the agent declaring
    // itself blocked, so it must not get the indigo/"needs you" treatment, and
    // reading it must let it drop out of needs-attention like any other
    // settled turn — unlike a real declared question, which stays until
    // answered.
    it('a GENERATED question guess reads as complete and drops out of needs-attention once read', () => {
      seedStatus('q-guess', 'question', 'Anything else you need?', '~/pg', false);
      renderInRouter();
      const el = screen.getByTestId('status-summary-q-guess');
      expect(el.getAttribute('data-kind')).toBe('complete');
      expect(el.className).toContain('is-complete');
      expect(el.className).not.toContain('is-question');
      useChatStore.getState().markRead('q-guess');
      selectUnreadView();
      expect(screen.queryByTestId('chat-row-q-guess')).not.toBeInTheDocument();
    });
  });

  // App Updates: "tools should show in its own sidebar on right hand side."
  // Tools used to take over this sidebar's body like the Batch/Manager views;
  // it is now its own right-hand column (spec/14 § Tools panel), so opening it
  // must leave the chat list exactly where it was.
  it('does not host the Tools panel — the chat list survives Tools being open', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'c-keep', folder: '~/p' })]);
    useUiStore.getState().setToolsPanelChatId('c-keep');
    renderInRouter();
    expect(screen.queryByTestId('tools-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-row-c-keep')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-view-menu')).toBeInTheDocument();
  });

  // Todoist: "patch chats flicker when reconnecting". Reconnect races two
  // resync paths — the WS replay and the `['chats']` REST refetch — and the
  // REST snapshot can carry a stale `activity` that briefly disagrees with
  // what the live WS stream already showed — it can flicker through `working`
  // on a reconnect. The badge must hold its last-shown value
  // through a brief stale-then-corrected sequence rather than visibly flip.
  describe('badge settle (reconnect flicker)', () => {
    it('does not flip the badge back and forth when a stale REST snapshot lands mid-reconnect', () => {
      vi.useFakeTimers();
      // WS: chat is genuinely running.
      useChatStore.getState().hydrate([rowFixture({ chatId: 'flick1', activity: 'running' })]);
      renderInRouter();
      const row = screen.getByTestId('chat-row-flick1');
      expect(within(row).getByTestId('badge-working')).toBeInTheDocument();

      // Reconnect: a `hydrate()` REST refetch lands with a stale snapshot
      // (activity briefly reported idle before the host catches up).
      act(() => {
        useChatStore.getState().hydrate([rowFixture({ chatId: 'flick1', activity: 'idle' })]);
      });
      // Immediately after the stale snapshot, the badge must still read
      // `working` — this is the flicker the settle delay exists to prevent.
      expect(within(row).getByTestId('badge-working')).toBeInTheDocument();
      expect(within(row).queryByTestId('badge-read')).not.toBeInTheDocument();

      // Still within the settle window, the WS replay corrects it back.
      act(() => {
        vi.advanceTimersByTime(100); // < BADGE_SETTLE_MS
        useChatStore.getState().mergeChats([rowFixture({ chatId: 'flick1', activity: 'running' })]);
      });
      expect(within(row).getByTestId('badge-working')).toBeInTheDocument();

      // Well past the settle window, it's still just `working` — never having
      // shown `read` in between.
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(within(row).getByTestId('badge-working')).toBeInTheDocument();
      expect(within(row).queryByTestId('badge-read')).not.toBeInTheDocument();
      vi.useRealTimers();
    });

    it('does still update the badge for a change that holds steady past the settle window', () => {
      vi.useFakeTimers();
      useChatStore.getState().hydrate([rowFixture({ chatId: 'flick2', activity: 'running' })]);
      renderInRouter();
      const row = screen.getByTestId('chat-row-flick2');
      expect(within(row).getByTestId('badge-working')).toBeInTheDocument();

      act(() => {
        useChatStore.getState().mergeChats([rowFixture({ chatId: 'flick2', activity: 'errored' })]);
      });
      act(() => {
        vi.advanceTimersByTime(300); // > BADGE_SETTLE_MS
      });
      expect(within(row).getByTestId('badge-errored')).toBeInTheDocument();
      vi.useRealTimers();
    });
  });
});
