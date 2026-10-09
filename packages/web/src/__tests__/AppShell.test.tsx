// AppShell — three-column layout host: WS lifecycle, global keyboard
// shortcuts, desktop-bridge wiring, voice-overlay keys, focus-follow, and the
// EditorRail↔host event bridge. Exercises AppShell's OWN closures; the
// child routes/components it wires together are covered in their own test
// files (this file mocks or stubs them where their internals would otherwise
// need re-driving through unrelated fetches).

import { composerMicFor, registerComposerMic } from '../lib/composerMic.js';
import type { JSX } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { AppShell } from '../AppShell.js';
import { useChatStore } from '../stores/chatStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useBatchStore } from '../stores/batchStore.js';
import { permissionDeliveryTracker } from '../lib/permissionDeliveryTracker.js';
import { useTerminalStore } from '../stores/terminalStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { getActiveWs } from '../api/ws.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { AUTO_CALL_KEY } from '../routes/MenubarRoute.js';
import { DEFAULT_PREFERENCES } from '../stores/preferencesStore.js';
import type { ChatRow } from '../stores/types.js';

// A minimal fake DiffEditor so the file.write save flow (EditorRail's
// FileDiffPanel) can be driven: a real Monaco can't mount under jsdom. The
// diff editor mount fires `onMount` with a fake editor exposing a controllable
// `getValue`, and typing into the fake "modified" textarea marks the panel
// dirty (mirroring `EditorRailFileWrite.test.tsx`'s established pattern).
// The EditorRail's lazy editor factories first pull in the self-hosted Monaco
// bootstrap (spec/14 § Startup cost — it moved off the entry chunk, so the rail
// now owns triggering it). That module imports the real `monaco-editor`, which
// jsdom cannot evaluate; stub it out alongside the editor wrapper below.
vi.mock('../lib/monaco-loader.js', () => ({
  ensureMonacoLoaded: async () => undefined,
}));

vi.mock('@monaco-editor/react', () => {
  type DiffEditorProps = {
    original: string;
    modified: string;
    options?: { renderSideBySide?: boolean };
    onMount?: (editor: unknown) => void;
  };
  const DiffEditor = ({ original, modified, onMount }: DiffEditorProps): JSX.Element => {
    const fakeMe = {
      _value: modified,
      _listeners: [] as Array<() => void>,
      onDidChangeModelContent(cb: () => void) {
        this._listeners.push(cb);
      },
      getValue() {
        return this._value;
      },
      setValue(v: string) {
        this._value = v;
        for (const l of this._listeners) l();
      },
      onMouseDown() {},
      updateOptions() {},
      deltaDecorations() {
        return [];
      },
    };
    const fakeDiff = { getModifiedEditor: () => fakeMe };
    setTimeout(() => onMount?.(fakeDiff), 0);
    return (
      <div data-testid="mock-diff-editor">
        <pre data-testid="mock-original">{original}</pre>
        <textarea
          data-testid="mock-modified"
          defaultValue={modified}
          onChange={(e) => fakeMe.setValue(e.target.value)}
        />
      </div>
    );
  };
  const Editor = ({
    value,
    onChange,
  }: {
    value?: string;
    onChange?: (v: string | undefined) => void;
  }): JSX.Element => (
    <textarea
      data-testid="mock-editor"
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );
  return { DiffEditor, Editor };
});

const wsSend = vi.fn();
const wsClose = vi.fn();
const wsConnect = vi.fn();
const wsRequestReplay = vi.fn();

vi.mock('../api/ws.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/ws.js')>();
  class MockPatchWs {
    send = wsSend;
    close = wsClose;
    connect = wsConnect;
    requestReplay = wsRequestReplay;
  }
  return { ...actual, PatchWs: MockPatchWs };
});

const startVoiceNote = vi.fn(async (..._args: unknown[]) => {});
const sendVoiceNote = vi.fn();
const cancelVoiceNote = vi.fn();
const startVoiceCall = vi.fn(async (..._args: unknown[]) => {});

const toggleCallMute = vi.fn();
const endVoiceCall = vi.fn();
const promoteNoteToToggle = vi.fn();
const releaseVoiceNoteHold = vi.fn();

vi.mock('../lib/voiceController.js', () => ({
  startVoiceNote: (...args: unknown[]) => startVoiceNote(...args),
  sendVoiceNote: (...args: unknown[]) => sendVoiceNote(...args),
  cancelVoiceNote: (...args: unknown[]) => cancelVoiceNote(...args),
  startVoiceCall: (...args: unknown[]) => startVoiceCall(...args),
  toggleCallMute: (...args: unknown[]) => toggleCallMute(...args),
  endVoiceCall: (...args: unknown[]) => endVoiceCall(...args),
  promoteNoteToToggle: (...args: unknown[]) => promoteNoteToToggle(...args),
  releaseVoiceNoteHold: (...args: unknown[]) => releaseVoiceNoteHold(...args),
}));

const openMostRecentEditDiff = vi.fn(async (..._args: unknown[]) => false);

vi.mock('../lib/openDiff.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/openDiff.js')>();
  return {
    ...actual,
    openMostRecentEditDiff: (...args: unknown[]) => openMostRecentEditDiff(...args),
    openDiffForFile: vi.fn(async () => {}),
  };
});

function makeRow(chatId: string, overrides: Partial<ChatRow> = {}): ChatRow {
  return {
    pendingWake: null,
    todos: [],
    snoozedUntil: null,
    chatId,
    daemonId: 'd1',
    permissionMode: 'bypassPermissions' as const,
    name: chatId,
    folder: '/tmp',
    activity: 'idle',
    status: 'active',
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated: Date.now(),
    lastUserActivity: Date.now(),
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

/** Route fetch by URL; `chats` seeds the cold-start GET /api/chats payload. */
function makeFetch(chats: ChatRow[] = []): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (u === '/api/chats' && (!init || (init.method ?? 'GET') === 'GET')) {
      return json({
        chats: chats.map((c) => ({
          chatId: c.chatId,
          daemonId: 'd1',
          permissionMode: 'bypassPermissions' as const,
          name: c.name,
          preview: c.preview,
          folder: c.folder,
          activity: c.activity,
          status: c.status,
          pinned: c.pinned,
          pinnedAt: c.pinnedAt,
          disabled: false,
          lastUpdated: c.lastUpdated,
        })),
      });
    }
    // The folder roster the sidebar seeds Recent projects from (spec/04
    // § Folders → Folder roster) — loaded at boot alongside GET /api/chats.
    if (u === '/api/chats/folders') return json({ folders: [] });
    // The section totals the collapsed sidebar rows badge (spec/04 § Section
    // counts) — also loaded at boot. Cold storage is empty in these fixtures.
    if (u === '/api/chats/counts') {
      return json({ hidden: 0, archived: 0, snoozed: 0, deleted: 0, automations: 0 });
    }
    if (u.includes('/archive')) return json({ ok: true });
    // One chat by id (spec/01 § HTTP API) — the chat panel asks for this when
    // the route names a chat the roster didn't carry. These fixtures serve only
    // the roster, so any id reaching here is one this server has no record of:
    // 404, exactly as the real route answers. Falling through to the catch-all
    // `{}` below instead makes the panel merge a chat row with no folder and
    // takes the sidebar's grouping down with it.
    const byId = /^\/api\/chats\/([^/?]+)$/.exec(u);
    if (byId && (!init || (init.method ?? 'GET') === 'GET')) {
      return json({ error: `chat not found: ${byId[1]}` }, 404);
    }
    // The shell loads the account preferences at boot (spec/07 § Session modes —
    // the address word a quiet call carries), so /api/settings has to answer.
    if (u === '/api/settings') {
      return json({
        preferences: DEFAULT_PREFERENCES,
      });
    }
    return json({});
  });
}

async function renderShell(
  path: string,
  chats: ChatRow[] = [],
  fetchMock: ReturnType<typeof vi.fn> = makeFetch(chats),
): Promise<ReturnType<typeof render>> {
  vi.stubGlobal('fetch', fetchMock);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <AppShell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(wsConnect).toHaveBeenCalled());
  return utils;
}

describe('AppShell', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useBatchStore.getState()._reset();
    useUiStore.setState({
      sidebarCollapsed: false,
      pendingDiffByChat: {},
      fileDiff: null,
      filePickerOpen: false,
      channelsOpen: false,
      archivedOpen: false,
      cheatSheetOpen: false,
      errors: [],
    });
    useLayoutStore.getState()._reset();
    useVoiceStore.setState({
      incomingCall: null,
      note: null,
      call: null,
      permission: null,
      session: null,
      activeDevices: {},
    });
    vi.clearAllMocks();
    delete (window as unknown as { patch?: unknown }).patch;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete (window as unknown as { patch?: unknown }).patch;
    permissionDeliveryTracker.reset();
    usePresenceStore.setState({ connection: 'offline', daemonOnline: false });
  });

  // Patch Updates: "a bar when something not connected on main screen" — the
  // daemon-offline banner used to render only inside ChatRoute, so Jobs,
  // Settings and New chat showed nothing even though the WS→server link was
  // fine and every host was unreachable (spec/12 § Host-offline UX: "There
  // is no window where the UI says connected while the agent is actually
  // unreachable."). It now lives in AppShell, once, so it reaches every route.
  it('shows the daemon-offline banner on a non-chat route (Jobs) when connected but every host is offline', async () => {
    usePresenceStore.setState({ connection: 'connected', daemonOnline: false, hostsSeeded: true });
    await renderShell('/jobs');
    expect(screen.getByTestId('jobs-route')).toBeInTheDocument();
    expect(screen.getByTestId('daemon-offline-banner')).toBeInTheDocument();
  });

  it('does not show the daemon-offline banner on a non-chat route once a host is online', async () => {
    usePresenceStore.setState({ connection: 'connected', daemonOnline: true });
    await renderShell('/jobs');
    expect(screen.getByTestId('jobs-route')).toBeInTheDocument();
    expect(screen.queryByTestId('daemon-offline-banner')).not.toBeInTheDocument();
  });

  it('renders the bare /menubar route with no sidebar/editor rail', async () => {
    await renderShell('/menubar');
    expect(screen.getByTestId('app-shell-bare')).toBeInTheDocument();
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
  });

  it('renders the bare /voice-overlay route with no sidebar/editor rail', async () => {
    await renderShell('/voice-overlay');
    expect(screen.getByTestId('app-shell-bare')).toBeInTheDocument();
  });

  // spec/14 § Sidebar §1, § New windows — the sidebar detached into its own
  // window is also a bare route: no three-col chat panel/editor rail around
  // it, just the sidebar itself.
  it('renders the bare /sidebar-window route with the standalone sidebar, no chat panel', async () => {
    await renderShell('/sidebar-window');
    expect(screen.getByTestId('app-shell-bare')).toBeInTheDocument();
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
    expect(screen.getByTestId('sidebar-window')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
  });

  // spec/14 § Panes and tabs — "detach into its own window": a single tab
  // popped out is a bare route too, just like the sidebar's own detached
  // window above.
  it('renders the bare /tab-window route with just that one tab, no sidebar', async () => {
    const tab = encodeURIComponent(JSON.stringify({ kind: 'chat', chatId: 'c1' }));
    await renderShell(`/tab-window?tabWindow=1&tab=${tab}`, [
      makeRow('c1', { name: 'popout target' }),
    ]);
    expect(screen.getByTestId('app-shell-bare')).toBeInTheDocument();
    expect(screen.queryByTestId('app-shell')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sidebar')).not.toBeInTheDocument();
    expect(screen.getByTestId('tab-window')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('chat-main')).toBeInTheDocument());
  });

  it('renders the full three-column shell at a normal route, hydrating chats from the cold-start fetch', async () => {
    await renderShell('/', [makeRow('c1')]);
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    await waitFor(() => expect(useChatStore.getState().chats['c1']).toBeDefined());
  });

  it('a cold-start hydrate failure surfaces "failed to load chats: …"', async () => {
    const fetchMock = vi.fn(async () => new Response('boom', { status: 500 }));
    await renderShell('/', [], fetchMock);
    await waitFor(() => {
      expect(
        useUiStore.getState().errors.some((e) => /failed to load chats/i.test(e.message)),
      ).toBe(true);
    });
  });

  it('opens and closes the WS socket across mount/unmount', async () => {
    const { unmount } = await renderShell('/');
    expect(wsConnect).toHaveBeenCalledTimes(1);
    expect(getActiveWs()).not.toBeNull();
    unmount();
    expect(wsClose).toHaveBeenCalledTimes(1);
    expect(getActiveWs()).toBeNull();
  });

  it('clears toasts on route change', async () => {
    useUiStore.getState().pushError('stale error');
    await renderShell('/chats/c-toast', [makeRow('c-toast')]);
    // The mount itself is a route change from nothing → /chats/c-toast, so the
    // stale error (pushed before render) is cleared by the effect.
    await waitFor(() => {
      expect(useUiStore.getState().errors.some((e) => /stale error/i.test(e.message))).toBe(false);
    });
  });

  it('a voice call stays on its chat when you navigate to another', async () => {
    await renderShell('/chats/c-a', [makeRow('c-a'), makeRow('c-b')]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-a'));
    useVoiceStore.setState({
      call: {
        chatId: 'c-a',
        startedAt: Date.now(),
        muted: false,
        lastLine: '',
        speaker: 'YOU',
        agentSpeaking: false,
        transcript: '',
        level: 0,
        mode: 'call',
        unaddressed: null,
        phase: 'listening',
      },
    });
    cleanup();
    await renderShell('/chats/c-b', [makeRow('c-a'), makeRow('c-b')]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-b'));
    expect(useVoiceStore.getState().call?.chatId).toBe('c-a');
  });

  // spec/09 § Chat completion — the desktop doorbell's focused-surface
  // suppression reads this from the server's presence record, which this
  // frame is what populates. It fires on every navigation, voice call active or not.
  it('emits chat.focus_change on navigation, independent of any voice call', async () => {
    await renderShell('/chats/c-nav-a', [makeRow('c-nav-a'), makeRow('c-nav-b')]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-nav-a'));
    expect(wsSend).toHaveBeenCalledWith({ type: 'chat.focus_change', chatId: 'c-nav-a' });

    cleanup();
    await renderShell('/chats/c-nav-b', [makeRow('c-nav-a'), makeRow('c-nav-b')]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-nav-b'));
    expect(wsSend).toHaveBeenCalledWith({ type: 'chat.focus_change', chatId: 'c-nav-b' });
  });

  it('emits chat.focus_change with chatId: null once no chat is open', async () => {
    await renderShell('/chats/c-nav-c', [makeRow('c-nav-c')]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-nav-c'));

    cleanup();
    await renderShell('/');
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBeNull());
    expect(wsSend).toHaveBeenCalledWith({ type: 'chat.focus_change', chatId: null });
  });

  it('auto-opens a voice call stashed in sessionStorage by the menu-bar phone control', async () => {
    sessionStorage.setItem(AUTO_CALL_KEY, 'c-auto');
    await renderShell('/');
    await waitFor(() => expect(startVoiceCall).toHaveBeenCalledWith('c-auto'));
    expect(sessionStorage.getItem(AUTO_CALL_KEY)).toBeNull();
  });

  it('does not auto-open a voice call when one is already active', async () => {
    useVoiceStore.setState({
      call: {
        chatId: 'already',
        startedAt: Date.now(),
        muted: false,
        lastLine: '',
        speaker: 'YOU',
        agentSpeaking: false,
        transcript: '',
        level: 0,
        mode: 'call',
        unaddressed: null,
        phase: 'listening',
      },
    });
    sessionStorage.setItem(AUTO_CALL_KEY, 'c-auto2');
    await renderShell('/');
    expect(startVoiceCall).not.toHaveBeenCalled();
  });

  it('a sessionStorage read failure is swallowed (best-effort) and does not crash', async () => {
    const orig = window.sessionStorage;
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled');
      },
    });
    await renderShell('/');
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    Object.defineProperty(window, 'sessionStorage', { configurable: true, value: orig });
  });

  it('desktop bridge: wires onStartVoiceNote/onStartVoiceCall and unsubscribes on unmount', async () => {
    let noteCb: ((e: { thread: string }) => void) | undefined;
    let callCb: ((e: { thread: string }) => void) | undefined;
    const unsubNote = vi.fn();
    const unsubCall = vi.fn();
    (window as unknown as { patch?: unknown }).patch = {
      onStartVoiceNote: (cb: (e: { thread: string }) => void) => {
        noteCb = cb;
        return unsubNote;
      },
      onStartVoiceCall: (cb: (e: { thread: string }) => void) => {
        callCb = cb;
        return unsubCall;
      },
    };
    const { unmount } = await renderShell('/chats/known', [makeRow('known')]);
    await waitFor(() => expect(useChatStore.getState().chats['known']).toBeDefined());
    noteCb!({ thread: 'manager' });
    expect(startVoiceNote).toHaveBeenCalledWith(SPECIAL_THREAD_IDS.manager, 'toggle');
    callCb!({ thread: 'known' });
    expect(startVoiceCall).toHaveBeenCalledWith('known');
    // An unknown, non-manager thread resolves to undefined → no-op.
    noteCb!({ thread: 'nonexistent' });
    expect(startVoiceNote).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubNote).toHaveBeenCalled();
    expect(unsubCall).toHaveBeenCalled();
  });

  it('desktop bridge: the web panel insets the app so it is a SIDE panel, not an overlay', async () => {
    // spec/14 § Links and the web panel: the embedded panel docks to the right
    // edge and the Patch UI is inset by exactly its width, so the chat and
    // composer stay visible beside it rather than being covered.
    let insetCb: ((e: { width: number }) => void) | undefined;
    const unsub = vi.fn();
    (window as unknown as { patch?: unknown }).patch = {
      onPanelInset: (cb: (e: { width: number }) => void) => {
        insetCb = cb;
        return unsub;
      },
    };
    const { unmount } = await renderShell('/');
    insetCb!({ width: 504 });
    await waitFor(() => expect(document.body.style.paddingRight).toBe('504px'));
    // Closing the panel (inset 0) restores the full-width app.
    insetCb!({ width: 0 });
    await waitFor(() => expect(document.body.style.paddingRight).toBe(''));
    unmount();
    expect(unsub).toHaveBeenCalled();
  });

  // spec/09 § `### desktop` — the whole point of a desktop toast is that it
  // takes you to the chat that raised it. Main can only show/focus the window;
  // it hands the destination back over `patch:navigate` and the SPA routes. The
  // subscription was missing entirely, so every clicked notification left you
  // on whatever chat you were already reading.
  it('desktop bridge: a notification click routes the SPA to the chat it came from', async () => {
    let navCb: ((e: { path: string }) => void) | undefined;
    const unsub = vi.fn();
    (window as unknown as { patch?: unknown }).patch = {
      onNavigate: (cb: (e: { path: string }) => void) => {
        navCb = cb;
        return unsub;
      },
    };
    const { unmount } = await renderShell('/chats/chat-a', [makeRow('chat-a'), makeRow('chat-b')]);
    await waitFor(() => expect(screen.getByTestId('chat-title')).toHaveTextContent('chat-a'));
    act(() => navCb!({ path: '/chats/chat-b' }));
    await waitFor(() => expect(screen.getByTestId('chat-title')).toHaveTextContent('chat-b'));
    unmount();
    expect(unsub).toHaveBeenCalled();
  });

  // The tray's "Version & updates…" rides the same channel (desktop main.ts),
  // so it was dead for exactly the same reason.
  it('desktop bridge: the shell can route to a non-chat page too', async () => {
    let navCb: ((e: { path: string }) => void) | undefined;
    (window as unknown as { patch?: unknown }).patch = {
      onNavigate: (cb: (e: { path: string }) => void) => {
        navCb = cb;
        return () => {};
      },
    };
    await renderShell('/chats/chat-a', [makeRow('chat-a')]);
    act(() => navCb!({ path: '/settings' }));
    await waitFor(() => expect(screen.getByTestId('settings-route')).toBeInTheDocument());
  });

  // spec/09 § Batch check-in — a batch-ready notification click lands on the
  // Batch view, not a chat route: `/batch` is a reserved pseudo-path main.ts
  // sends, not a page the SPA has, so it must not fall into the "unknown
  // route" error path the generic case below guards.
  it('desktop bridge: a "/batch" navigate request opens the Batch view, not a route', async () => {
    let navCb: ((e: { path: string }) => void) | undefined;
    (window as unknown as { patch?: unknown }).patch = {
      onNavigate: (cb: (e: { path: string }) => void) => {
        navCb = cb;
        return () => {};
      },
    };
    await renderShell('/chats/chat-a', [makeRow('chat-a')]);
    await waitFor(() => expect(screen.getByTestId('chat-title')).toHaveTextContent('chat-a'));
    act(() => navCb!({ path: '/batch' }));
    await waitFor(() => expect(useBatchStore.getState().mode).toBe('batch'));
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    // Stays on the chat that was open — the batch is reviewed beside it.
    expect(screen.getByTestId('chat-title')).toHaveTextContent('chat-a');
    expect(useUiStore.getState().errors).toEqual([]);
  });

  // NO FALLBACK: a destination the SPA cannot route is reported, not dropped.
  it('desktop bridge: a path that is not an in-app route raises an error and does not navigate', async () => {
    let navCb: ((e: { path: string }) => void) | undefined;
    (window as unknown as { patch?: unknown }).patch = {
      onNavigate: (cb: (e: { path: string }) => void) => {
        navCb = cb;
        return () => {};
      },
    };
    await renderShell('/chats/chat-a', [makeRow('chat-a')]);
    await waitFor(() => expect(screen.getByTestId('chat-title')).toHaveTextContent('chat-a'));
    act(() => navCb!({ path: 'https://example.com/chats/chat-b' }));
    await waitFor(() =>
      expect(
        useUiStore.getState().errors.some((e) => /page that does not exist/i.test(e.message)),
      ).toBe(true),
    );
    expect(screen.getByTestId('chat-title')).toHaveTextContent('chat-a');
  });

  it('desktop bridge: the panel divider drags live and resets on double-click (spec/14 § Links and the web panel)', async () => {
    let insetCb: ((e: { width: number }) => void) | undefined;
    const resizePanel = vi.fn();
    const resetPanelWidth = vi.fn();
    (window as unknown as { patch?: unknown }).patch = {
      onPanelInset: (cb: (e: { width: number }) => void) => {
        insetCb = cb;
        return () => {};
      },
      resizePanel,
      resetPanelWidth,
    };
    await renderShell('/');
    // No divider while the panel is closed — there is nothing to resize.
    expect(screen.queryByTestId('panel-divider')).not.toBeInTheDocument();

    act(() => insetCb!({ width: 504 }));
    const divider = await screen.findByTestId('panel-divider');
    expect(divider.style.right).toBe('504px');

    // jsdom has no pointer capture; stub it the same way ColumnDivider.test.tsx does.
    (divider as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = vi.fn();
    (divider as unknown as { releasePointerCapture: (id: number) => void }).releasePointerCapture =
      vi.fn();
    fireEvent.pointerDown(divider, { clientX: 500, pointerId: 1 });
    fireEvent(window, new PointerEvent('pointermove', { clientX: 460 }));
    // side="right": dragging LEFT (toward the app) widens the panel.
    expect(resizePanel).toHaveBeenCalledWith(544);
    fireEvent(window, new PointerEvent('pointerup', { pointerId: 1 }));

    fireEvent.doubleClick(divider);
    expect(resetPanelWidth).toHaveBeenCalledTimes(1);

    // Closing the panel removes the divider again.
    act(() => insetCb!({ width: 0 }));
    await waitFor(() => expect(screen.queryByTestId('panel-divider')).not.toBeInTheDocument());
  });

  it('desktop bridge: an unmount while the panel is open clears the inset', async () => {
    let insetCb: ((e: { width: number }) => void) | undefined;
    (window as unknown as { patch?: unknown }).patch = {
      onPanelInset: (cb: (e: { width: number }) => void) => {
        insetCb = cb;
        return () => {};
      },
    };
    const { unmount } = await renderShell('/');
    insetCb!({ width: 400 });
    await waitFor(() => expect(document.body.style.paddingRight).toBe('400px'));
    unmount();
    expect(document.body.style.paddingRight).toBe('');
  });

  it('desktop bridge: no bridge present (browser) is a no-op, no crash', async () => {
    await renderShell('/');
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
  });

  it('desktop bridge: a bridge with neither hook wired is a no-op', async () => {
    (window as unknown as { patch?: unknown }).patch = {};
    await renderShell('/');
    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
  });

  // ---- Global voice-overlay keys ----

  it('Escape cancels an in-flight voice note', async () => {
    await renderShell('/');
    useVoiceStore.setState({
      note: {
        chatId: 'c1',
        gesture: 'toggle',
        transcript: 'hi',
        level: 0,
        sending: false,
        prefix: '',
      },
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(cancelVoiceNote).toHaveBeenCalled();
  });

  it('Escape with no note in flight does not cancel anything', async () => {
    await renderShell('/');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(cancelVoiceNote).not.toHaveBeenCalled();
  });

  it('Enter commits a toggle-gesture voice note', async () => {
    await renderShell('/');
    useVoiceStore.setState({
      note: {
        chatId: 'c1',
        gesture: 'toggle',
        transcript: 'hi',
        level: 0,
        sending: false,
        prefix: '',
      },
    });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(sendVoiceNote).toHaveBeenCalled();
  });

  it('Enter does nothing for a ptt-gesture note (release commits, not Enter)', async () => {
    await renderShell('/');
    useVoiceStore.setState({
      note: {
        chatId: 'c1',
        gesture: 'ptt',
        transcript: 'hi',
        level: 0,
        sending: false,
        prefix: '',
      },
    });
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(sendVoiceNote).not.toHaveBeenCalled();
  });

  it('Escape/Enter are ignored inside an input/textarea when NO note is in flight', async () => {
    await renderShell('/');
    useVoiceStore.setState({ note: null });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(sendVoiceNote).not.toHaveBeenCalled();
    expect(cancelVoiceNote).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  // Tom, patch/todo.md — "voice note … cannot be ended or cancelled". The
  // overlay has no controls of its own, so ⏎/esc are the ONLY way out; bailing
  // on a focused field (the new-chat flow lands the caret in the composer) left
  // the note stuck on screen forever. spec/07: an in-flight note owns both keys
  // wherever focus is.
  it('Enter/Escape still reach an in-flight note from inside a text field', async () => {
    await renderShell('/');
    const input = document.createElement('input');
    document.body.appendChild(input);
    useVoiceStore.setState({
      note: {
        chatId: 'c1',
        gesture: 'toggle',
        transcript: 'hi',
        level: 0,
        sending: false,
        prefix: '',
      },
    });
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(sendVoiceNote).toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(cancelVoiceNote).toHaveBeenCalled();
    document.body.removeChild(input);
  });

  // ---- Global keyboard shortcuts ----

  it('⌃` toggles a terminal tab for the open chat only (spec/14 § Terminal, § Panes and tabs)', async () => {
    useTerminalStore.getState()._reset();
    useLayoutStore.getState()._reset();
    await renderShell('/chats/c-term');
    fireEvent.keyDown(window, { key: '`', ctrlKey: true });
    expect(
      useLayoutStore.getState().findTab({ kind: 'terminal', chatId: 'c-term' }),
    ).not.toBeNull();
    fireEvent.keyDown(window, { key: '`', ctrlKey: true });
    expect(useLayoutStore.getState().findTab({ kind: 'terminal', chatId: 'c-term' })).toBeNull();
  });

  it('⌃` is a no-op off a live chat — there is no folder to root a shell in', async () => {
    useTerminalStore.getState()._reset();
    useLayoutStore.getState()._reset();
    await renderShell('/chats/new');
    fireEvent.keyDown(window, { key: '`', ctrlKey: true });
    expect(useLayoutStore.getState().findTab({ kind: 'terminal', chatId: 'new' })).toBeNull();
    await renderShell('/settings');
    useLayoutStore.getState()._reset();
    fireEvent.keyDown(window, { key: '`', ctrlKey: true });
    expect(useLayoutStore.getState().root).toMatchObject({ type: 'leaf', tabs: [] });
  });

  it('⌘K and ⌘F focus a marked search field, and are no-ops when absent', async () => {
    await renderShell('/');
    // No marked field in this render — no-op, no crash.
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    // Now add one and retry. `data-search-input` is the marker every search
    // field in the app carries (spec/14 § Reserved OS chords).
    const el = document.createElement('input');
    el.setAttribute('data-search-input', 'true');
    document.body.appendChild(el);
    fireEvent.keyDown(window, { key: 'k', metaKey: true });
    expect(document.activeElement).toBe(el);
    el.blur();
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    expect(document.activeElement).toBe(el);
    document.body.removeChild(el);
  });

  it('⌘N navigates to /chats/new; ⌘⇧N navigates + focuses the folder input', async () => {
    await renderShell('/');
    fireEvent.keyDown(window, { key: 'n', metaKey: true });
    await waitFor(() => expect(screen.getByTestId('new-chat-main')).toBeInTheDocument());
    cleanup();
    await renderShell('/');
    // The focus is deferred to the next animation frame, so the input has to
    // exist by the time that frame runs. Hold the frame here rather than racing
    // the real clock with it: a test that only passes while the route mounts
    // faster than one frame is a coin toss, not an assertion.
    const frames: FrameRequestCallback[] = [];
    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        frames.push(cb);
        return frames.length;
      });
    try {
      fireEvent.keyDown(window, { key: 'n', metaKey: true, shiftKey: true });
      await waitFor(() => expect(screen.getByTestId('new-chat-folder-pill')).toBeInTheDocument());
      // Open the picker, so the folder input is in the DOM for the frame.
      fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
      act(() => {
        for (const cb of frames.splice(0)) cb(0);
      });
    } finally {
      raf.mockRestore();
    }
    expect(document.activeElement).toBe(screen.getByTestId('new-chat-folder'));
  });

  it('⌘⇧N with no folder input in the DOM (picker closed) is a harmless no-op', async () => {
    await renderShell('/');
    fireEvent.keyDown(window, { key: 'n', metaKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getByTestId('new-chat-folder-pill')).toBeInTheDocument());
    expect(screen.queryByTestId('new-chat-folder')).not.toBeInTheDocument();
  });

  it('⌘/ toggles the sidebar', async () => {
    await renderShell('/');
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    fireEvent.keyDown(window, { key: '/', metaKey: true });
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  });

  // Tom, Todoist: "patch expand sidebar doesnt work". On the desktop overlay
  // title bar the chevron is a no-drag hole inside `.chat-head`'s drag region,
  // and Electron folds app regions in DOCUMENT order — a hole earlier in the
  // document than the drag rect over it is swallowed (spec/05 § Window chrome).
  // The real-click proof is desktop scripts/smoke-drag-regions.cjs, which runs
  // against the dev harness; this pins the same order in AppShell itself.
  it('the expand chevron comes after the chat header in the document', async () => {
    await renderShell('/chats/c-order', [makeRow('c-order')]);
    act(() => useUiStore.getState().setSidebarCollapsed(true));
    const head = await waitFor(() => {
      const el = document.querySelector('.chat-head');
      expect(el).not.toBeNull();
      return el!;
    });
    const expand = screen.getByTestId('sidebar-expand');
    expect(head.compareDocumentPosition(expand) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('⌘2 toggles Channels', async () => {
    await renderShell('/');
    fireEvent.keyDown(window, { key: '2', metaKey: true });
    expect(useUiStore.getState().channelsOpen).toBe(true);
  });

  it('⌘⇧A toggles Archived', async () => {
    await renderShell('/');
    fireEvent.keyDown(window, { key: 'a', metaKey: true, shiftKey: true });
    expect(useUiStore.getState().archivedOpen).toBe(true);
  });

  it('⌘? toggles the cheat sheet', async () => {
    await renderShell('/');
    fireEvent.keyDown(window, { key: '?', metaKey: true });
    expect(useUiStore.getState().cheatSheetOpen).toBe(true);
    expect(screen.getByTestId('cheat-sheet')).toBeInTheDocument();
  });

  it('⌥E opens the active chat’s Files tab (spec/14 § Panes and tabs)', async () => {
    useLayoutStore.getState()._reset();
    await renderShell('/chats/c-files', [makeRow('c-files')]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-files'));
    fireEvent.keyDown(window, { key: 'e', altKey: true });
    expect(
      useLayoutStore.getState().findTab({ kind: 'page', page: 'files', chatId: 'c-files' }),
    ).not.toBeNull();
  });

  it('⌘P opens the file picker, having opened the Files tab', async () => {
    useLayoutStore.getState()._reset();
    await renderShell('/chats/c-files', [makeRow('c-files')]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-files'));
    fireEvent.keyDown(window, { key: 'p', metaKey: true });
    expect(
      useLayoutStore.getState().findTab({ kind: 'page', page: 'files', chatId: 'c-files' }),
    ).not.toBeNull();
    expect(useUiStore.getState().filePickerOpen).toBe(true);
  });

  it("⌘⇧' opens the file browser", async () => {
    useLayoutStore.getState()._reset();
    await renderShell('/chats/c-files', [makeRow('c-files')]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-files'));
    fireEvent.keyDown(window, { key: "'", code: 'Quote', metaKey: true, shiftKey: true });
    expect(
      useLayoutStore.getState().findTab({ kind: 'page', page: 'files', chatId: 'c-files' }),
    ).not.toBeNull();
  });

  it('⌘1 jumps to the Manager chat when present; is a no-op when absent', async () => {
    await renderShell('/', [makeRow(SPECIAL_THREAD_IDS.manager, { name: 'Manager' })]);
    await waitFor(() =>
      expect(useChatStore.getState().chats[SPECIAL_THREAD_IDS.manager]).toBeDefined(),
    );
    fireEvent.keyDown(window, { key: '1', metaKey: true });
    await waitFor(() =>
      expect(useChatStore.getState().activeChatId).toBe(SPECIAL_THREAD_IDS.manager),
    );
  });

  it('⌘1 with no Manager chat known is a no-op', async () => {
    await renderShell('/', []);
    fireEvent.keyDown(window, { key: '1', metaKey: true });
    expect(useChatStore.getState().activeChatId).toBeNull();
  });

  it('⌘J jumps to the oldest unread chat (skipping archived) or errors when none', async () => {
    const older = makeRow('older-unread', { lastSeq: 5, lastReadSeq: -1, lastUpdated: 100 });
    const newer = makeRow('newer-unread', { lastSeq: 5, lastReadSeq: -1, lastUpdated: 200 });
    const archived = makeRow('archived-unread', {
      lastSeq: 5,
      lastReadSeq: -1,
      lastUpdated: 50,
      status: 'archived',
    });
    await renderShell('/', [older, newer, archived]);
    await waitFor(() => expect(useChatStore.getState().chats['older-unread']).toBeDefined());
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('older-unread'));
  });

  it('⌘J with no unread chats surfaces "no unread chats"', async () => {
    // The cold-start GET /api/chats payload carries no read-state fields — the
    // store always hydrates a FRESH chat as unread (lastSeq 0 > lastReadSeq
    // -1). Patch the row to genuinely "read" (lastReadSeq caught up) directly
    // after hydrate, rather than via the (stripped) REST fixture.
    await renderShell('/', [makeRow('read-chat')]);
    await waitFor(() => expect(useChatStore.getState().chats['read-chat']).toBeDefined());
    useChatStore.setState((s) => ({
      chats: {
        ...s.chats,
        ['read-chat']: { ...s.chats['read-chat']!, lastSeq: 0, lastReadSeq: 0 },
      },
    }));
    fireEvent.keyDown(window, { key: 'j', metaKey: true });
    expect(useUiStore.getState().errors.some((e) => /no unread chats/i.test(e.message))).toBe(true);
  });

  it('⌘↑/⌘↓ step through non-archived chats ordered by recency; ⌘⇧↑/⌘⇧↓ step folders', async () => {
    const a = makeRow('chat-a', { folder: '/proj/a', lastUpdated: 300 });
    const b = makeRow('chat-b', { folder: '/proj/b', lastUpdated: 200 });
    await renderShell('/chats/chat-a', [a, b]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('chat-a'));
    fireEvent.keyDown(window, { key: 'ArrowDown', metaKey: true });
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('chat-b'));
    fireEvent.keyDown(window, { key: 'ArrowUp', metaKey: true });
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('chat-a'));
    fireEvent.keyDown(window, { key: 'ArrowDown', metaKey: true, shiftKey: true });
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('chat-b'));
  });

  it('⌘↓ with no chats at all is a no-op', async () => {
    await renderShell('/', []);
    fireEvent.keyDown(window, { key: 'ArrowDown', metaKey: true });
    expect(useChatStore.getState().activeChatId).toBeNull();
  });

  it('⌘↓ from a chat view with no current chatId in the URL jumps to the most-recent chat', async () => {
    const a = makeRow('nc-a', { lastUpdated: 100 });
    const b = makeRow('nc-b', { lastUpdated: 200 });
    await renderShell('/', [a, b]);
    await waitFor(() => expect(useChatStore.getState().chats['nc-b']).toBeDefined());
    fireEvent.keyDown(window, { key: 'ArrowDown', metaKey: true });
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('nc-b'));
  });

  it('⌘↑ from a chat route whose chatId is unknown (not in the ordered list) jumps to the last chat', async () => {
    const a = makeRow('kc-a', { lastUpdated: 100 });
    const b = makeRow('kc-b', { lastUpdated: 200 });
    await renderShell('/chats/does-not-exist', [a, b]);
    await waitFor(() => expect(useChatStore.getState().chats['kc-b']).toBeDefined());
    fireEvent.keyDown(window, { key: 'ArrowUp', metaKey: true });
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('kc-a'));
  });

  it('⌘⇧↓ from a chat view with no current chatId jumps to the first folder section', async () => {
    const a = makeRow('fc-a', { folder: '/proj/a', lastUpdated: 100 });
    const b = makeRow('fc-b', { folder: '/proj/b', lastUpdated: 200 });
    await renderShell('/', [a, b]);
    await waitFor(() => expect(useChatStore.getState().chats['fc-b']).toBeDefined());
    fireEvent.keyDown(window, { key: 'ArrowDown', metaKey: true, shiftKey: true });
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('fc-b'));
  });

  it('⌘⇧↑ from a chat whose OWN folder is excluded (pinned) still jumps into the eligible folder list', async () => {
    const pinnedRow = makeRow('pinned-chat', {
      folder: '/proj/pinned',
      pinned: true,
      lastUpdated: 50,
    });
    const eligible = makeRow('eligible-chat', { folder: '/proj/eligible', lastUpdated: 100 });
    await renderShell('/chats/pinned-chat', [pinnedRow, eligible]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('pinned-chat'));
    fireEvent.keyDown(window, { key: 'ArrowUp', metaKey: true, shiftKey: true });
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('eligible-chat'));
  });

  it('⌘⇧↑/⌘⇧↓ with no eligible folders (only Manager/Speakers/pinned) is a no-op', async () => {
    // `/` with a Manager chat known redirects straight to it (IndexRedirect),
    // so activeChatId is already 'thread_manager' by the time the shortcut
    // fires — assert it stays there (unchanged), since Manager itself is
    // excluded from folder navigation and no other folder exists.
    await renderShell('/', [makeRow(SPECIAL_THREAD_IDS.manager, { folder: 'manager' })]);
    await waitFor(() =>
      expect(useChatStore.getState().activeChatId).toBe(SPECIAL_THREAD_IDS.manager),
    );
    fireEvent.keyDown(window, { key: 'ArrowUp', metaKey: true, shiftKey: true });
    expect(useChatStore.getState().activeChatId).toBe(SPECIAL_THREAD_IDS.manager);
  });

  it('⌘⌥A archives the focused chat optimistically; a server failure reverts + errors', async () => {
    const row = makeRow('c-archive');
    await renderShell('/chats/c-archive', [row]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-archive'));
    fireEvent.keyDown(window, { key: 'å', code: 'KeyA', metaKey: true, altKey: true });
    expect(useChatStore.getState().chats['c-archive']?.status).toBe('archived');
    await waitFor(() => {
      expect(useUiStore.getState().errors.some((e) => /archive failed/i.test(e.message))).toBe(
        false,
      ); // the default mock succeeds — no error expected here
    });
  });

  // spec/04 § Lifecycle — archiving the chat you are reading moves you on to
  // the next row in the list, whichever control did the archiving.
  it('⌘⌥A opens the next chat in the list', async () => {
    const open = makeRow('c-open', { lastUpdated: 300 });
    const next = makeRow('c-next', { lastUpdated: 200 });
    await renderShell('/chats/c-open', [open, next]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-open'));
    fireEvent.keyDown(window, { key: 'å', code: 'KeyA', metaKey: true, altKey: true });
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-next'));
    expect(useChatStore.getState().chats['c-open']?.status).toBe('archived');
  });

  // spec/14 § Reserved OS chords — ⌘A with a chat open must select the
  // transcript text, not archive the chat out from under the user.
  it('⌘A over an open chat selects text: it does not archive and is not preventDefaulted', async () => {
    const row = makeRow('c-selectall');
    await renderShell('/chats/c-selectall', [row]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-selectall'));
    const evt = new KeyboardEvent('keydown', {
      key: 'a',
      code: 'KeyA',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(evt);
    expect(useChatStore.getState().chats['c-selectall']?.status).not.toBe('archived');
    expect(evt.defaultPrevented).toBe(false);
  });

  // ⌘W is claimed by the page (preventDefault), so the native Window → Close
  // accelerator never sees it. With no tab open it must close the window itself
  // rather than swallow the chord.
  it('⌘W with no tab open closes the window', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    await renderShell('/');
    fireEvent.keyDown(window, { key: 'w', code: 'KeyW', metaKey: true });
    expect(close).toHaveBeenCalledTimes(1);
    close.mockRestore();
  });

  it('⌘⌥A with no focused chat is a no-op', async () => {
    await renderShell('/');
    fireEvent.keyDown(window, { key: 'å', code: 'KeyA', metaKey: true, altKey: true });
    expect(useUiStore.getState().errors.length).toBe(0);
  });

  it('⌘⌥A with a focused chatId no longer present in the store is a no-op', async () => {
    const row = makeRow('c-vanished');
    await renderShell('/chats/c-vanished', [row]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-vanished'));
    // The row disappears from the store (e.g. an archive/delete raced in from
    // elsewhere) while it's still the focused chatId.
    useChatStore.setState((s) => {
      const next = { ...s.chats };
      delete next['c-vanished'];
      return { chats: next };
    });
    fireEvent.keyDown(window, { key: 'å', code: 'KeyA', metaKey: true, altKey: true });
    expect(useUiStore.getState().errors.length).toBe(0);
  });

  it('⌘⌥A reverts and surfaces "archive failed: …" on a server error', async () => {
    const row = makeRow('c-archive-fail');
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u === '/api/chats' && (!init || (init.method ?? 'GET') === 'GET')) {
        return new Response(JSON.stringify({ chats: [row] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u === '/api/chats/folders') {
        return new Response(JSON.stringify({ folders: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u === '/api/chats/counts') {
        return new Response(
          JSON.stringify({ hidden: 0, archived: 0, snoozed: 0, deleted: 0, automations: 0 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/archive')) {
        return new Response(JSON.stringify({ error: 'nope' }), { status: 500 });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    await renderShell('/chats/c-archive-fail', [row], fetchMock);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-archive-fail'));
    fireEvent.keyDown(window, { key: 'å', code: 'KeyA', metaKey: true, altKey: true });
    expect(useChatStore.getState().chats['c-archive-fail']?.status).toBe('archived');
    await waitFor(() => {
      expect(useChatStore.getState().chats['c-archive-fail']?.status).toBe('active');
    });
    expect(
      useUiStore
        .getState()
        .errors.some((e) => /archive failed. try again. nope/i.test(`${e.message} ${e.detail}`)),
    ).toBe(true);
  });

  it('⌘\' with no chat focused surfaces "no chat focused"', async () => {
    await renderShell('/');
    fireEvent.keyDown(window, { key: "'", code: 'Quote', metaKey: true });
    expect(useUiStore.getState().errors.some((e) => /no chat focused/i.test(e.message))).toBe(true);
  });

  it("⌘' opens the last edit diff directly when found", async () => {
    openMostRecentEditDiff.mockResolvedValueOnce(true);
    await renderShell('/chats/c-diff', [makeRow('c-diff')]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-diff'));
    fireEvent.keyDown(window, { key: "'", code: 'Quote', metaKey: true });
    await waitFor(() => expect(openMostRecentEditDiff).toHaveBeenCalledWith('c-diff'));
    expect(useUiStore.getState().errors.length).toBe(0);
  });

  it("⌘' falls back to an already-pending diff when no recent edit is found", async () => {
    openMostRecentEditDiff.mockResolvedValueOnce(false);
    await renderShell('/chats/c-diff2', [makeRow('c-diff2')]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-diff2'));
    // `useShortcuts` re-registers its keydown listener whenever the AppShell
    // render (and thus its `handlers` closure) changes — force a flush so the
    // NEXT keydown fires the closure that actually sees this pendingDiff.
    act(() => {
      useUiStore.getState().setPendingDiff({
        requestId: 'req-x',
        chatId: 'c-diff2',
        tool: 'Edit',
        filePath: 'a.ts',
        original: 'a',
        modified: 'b',
      });
    });
    fireEvent.keyDown(window, { key: "'", code: 'Quote', metaKey: true });
    await waitFor(() =>
      expect(
        useLayoutStore.getState().findTab({ kind: 'file', chatId: 'c-diff2', path: 'a.ts' }),
      ).not.toBeNull(),
    );
  });

  it('⌘\' surfaces "no recent diff to open" when nothing is found and nothing is pending', async () => {
    openMostRecentEditDiff.mockResolvedValueOnce(false);
    await renderShell('/chats/c-diff3', [makeRow('c-diff3')]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-diff3'));
    fireEvent.keyDown(window, { key: "'", code: 'Quote', metaKey: true });
    await waitFor(() => {
      expect(
        useUiStore.getState().errors.some((e) => /no recent diff to open/i.test(e.message)),
      ).toBe(true);
    });
  });

  it('⌘\' surfaces "editor: …" when openMostRecentEditDiff rejects', async () => {
    openMostRecentEditDiff.mockRejectedValueOnce(new Error('disk error'));
    await renderShell('/chats/c-diff4', [makeRow('c-diff4')]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-diff4'));
    fireEvent.keyDown(window, { key: "'", code: 'Quote', metaKey: true });
    await waitFor(() => {
      expect(useUiStore.getState().errors.some((e) => /editor: disk error/i.test(e.message))).toBe(
        true,
      );
    });
  });

  // REGRESSION (Tom — "⌘; errors with transcription failed, stops immediately"):
  // the release used to commit unconditionally, so a chord held for a few
  // milliseconds uploaded a clip no longer than the keypress and the note died
  // on a failed transcription. The release now carries how long the key was
  // down and the gesture layer decides tap vs press-and-hold.
  it('⌘⇧D on an open chat dictates into its composer, not a voice note', async () => {
    await renderShell('/chats/c-ptt', [makeRow('c-ptt')]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-ptt'));
    await waitFor(() => expect(composerMicFor('c-ptt')).toBeDefined());
    const down = vi.fn();
    const up = vi.fn();
    const off = registerComposerMic('c-ptt', { down, up });
    fireEvent.keyDown(window, { key: 'D', code: 'KeyD', metaKey: true, shiftKey: true });
    fireEvent.keyUp(window, { key: 'D', code: 'KeyD' });
    off();
    expect(down).toHaveBeenCalledOnce();
    expect(up).toHaveBeenCalledOnce();
    expect(startVoiceNote).not.toHaveBeenCalled();
    expect(releaseVoiceNoteHold).not.toHaveBeenCalled();
  });

  it('⌘⇧D with no composer for the chat starts a PTT voice note; release defers to the gesture layer', async () => {
    await renderShell('/chats/c-ptt', [makeRow('c-ptt')]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-ptt'));
    act(() => {
      useChatStore.setState({ activeChatId: 'c-nocomposer' });
    });
    fireEvent.keyDown(window, { key: 'D', code: 'KeyD', metaKey: true, shiftKey: true });
    expect(startVoiceNote).toHaveBeenCalledWith('c-nocomposer', 'ptt');
    fireEvent.keyUp(window, { key: 'D', code: 'KeyD' });
    expect(releaseVoiceNoteHold).toHaveBeenCalledTimes(1);
    expect(releaseVoiceNoteHold.mock.calls[0]?.[0]).toBeTypeOf('number');
    expect(sendVoiceNote).not.toHaveBeenCalled();
  });

  it('⌘⇧D (hold) with no focused chat does not start a note', async () => {
    await renderShell('/');
    fireEvent.keyDown(window, { key: 'D', code: 'KeyD', metaKey: true, shiftKey: true });
    expect(startVoiceNote).not.toHaveBeenCalled();
  });

  it('⌃Space starts a global PTT note to Manager when present; release defers to the gesture layer', async () => {
    await renderShell('/', [makeRow(SPECIAL_THREAD_IDS.manager)]);
    await waitFor(() =>
      expect(useChatStore.getState().chats[SPECIAL_THREAD_IDS.manager]).toBeDefined(),
    );
    fireEvent.keyDown(window, { key: ' ', code: 'Space', ctrlKey: true });
    expect(startVoiceNote).toHaveBeenCalledWith(SPECIAL_THREAD_IDS.manager, 'ptt');
    useVoiceStore.setState({
      note: {
        chatId: SPECIAL_THREAD_IDS.manager,
        gesture: 'ptt',
        transcript: '',
        level: 0,
        sending: false,
        prefix: '',
      },
    });
    fireEvent.keyUp(window, { key: ' ', code: 'Space' });
    expect(releaseVoiceNoteHold).toHaveBeenCalledTimes(1);
    expect(releaseVoiceNoteHold.mock.calls[0]?.[0]).toBeTypeOf('number');
    expect(sendVoiceNote).not.toHaveBeenCalled();
  });

  it('⌃Space (hold) with no Manager chat known is a no-op', async () => {
    await renderShell('/', []);
    fireEvent.keyDown(window, { key: ' ', code: 'Space', ctrlKey: true });
    expect(startVoiceNote).not.toHaveBeenCalled();
  });

  // ---- FileEditorTab ↔ host event bridge (sendFileEditorEvent) ----

  it('FileEditorTab send: forwards a permission decision, resolves the inline card, and tears down the diff', async () => {
    await renderShell('/chats/c-bridge', [makeRow('c-bridge')]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-bridge'));
    useUiStore.getState().setPendingDiff({
      requestId: 'req-bridge',
      chatId: 'c-bridge',
      tool: 'Edit',
      filePath: 'a.ts',
      original: 'a',
      modified: 'b',
    });
    useLayoutStore.getState().openTab({ kind: 'file', chatId: 'c-bridge', path: 'a.ts' });
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        ['c-bridge']: [
          { seq: 1, kind: 'permission', tool: 'Edit', requestId: 'req-bridge', at: 0 },
        ],
      },
    }));
    fireEvent.click(await screen.findByTestId('diff-approve'));
    expect(wsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.permission_response',
        requestId: 'req-bridge',
        approve: true,
      }),
    );
    // Resolving tears down the pending diff.
    await waitFor(() =>
      expect(useUiStore.getState().pendingDiffByChat['c-bridge']).toBeUndefined(),
    );
  });

  it('FileEditorTab send: a Deny click sends approve:false', async () => {
    await renderShell('/chats/c-bridge-deny', [makeRow('c-bridge-deny')]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-bridge-deny'));
    useUiStore.getState().setPendingDiff({
      requestId: 'req-deny',
      chatId: 'c-bridge-deny',
      tool: 'Edit',
      filePath: 'a.ts',
      original: 'a',
      modified: 'b',
    });
    useLayoutStore.getState().openTab({ kind: 'file', chatId: 'c-bridge-deny', path: 'a.ts' });
    fireEvent.click(await screen.findByTestId('diff-deny'));
    expect(wsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.permission_response',
        requestId: 'req-deny',
        approve: false,
      }),
    );
  });

  it('FileEditorTab send: a file.write save surfaces a "Saved <path>" notice', async () => {
    await renderShell('/chats/c-save', [makeRow('c-save', { folder: '/tmp/proj' })]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-save'));
    useUiStore.getState().openFileDiff({
      chatId: 'c-save',
      changeSet: [{ path: 'a.ts', original: 'x', modified: 'y' }],
      activeIndex: 0,
    });
    // Save starts disabled until the content is actually edited (dirty).
    const modified = await screen.findByTestId('mock-modified');
    fireEvent.change(modified, { target: { value: 'y edited' } });
    const saveBtn = await screen.findByTestId('file-diff-save');
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    fireEvent.click(saveBtn);
    expect(wsSend).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'file.write', chatId: 'c-save', path: 'a.ts' }),
    );
    await waitFor(() => {
      expect(useUiStore.getState().errors.some((e) => /^Saved a\.ts$/i.test(e.message))).toBe(true);
    });
  });

  it('FileEditorTab send: a permission ws.send failure is held for redelivery, not surfaced as an error', async () => {
    // Tom, Todoist: "questions are timing out after I answer them" — see
    // permissionDeliveryTracker.ts. A file tab's Approve/Deny is exposed to
    // the same silently-dropped send as the inline card and the voice banner.
    await renderShell('/chats/c-sendfail', [makeRow('c-sendfail')]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-sendfail'));
    useUiStore.getState().setPendingDiff({
      requestId: 'req-fail',
      chatId: 'c-sendfail',
      tool: 'Edit',
      filePath: 'a.ts',
      original: 'a',
      modified: 'b',
    });
    useLayoutStore.getState().openTab({ kind: 'file', chatId: 'c-sendfail', path: 'a.ts' });
    // Set up the failure only NOW — the mount already sent its own
    // chat.focus_change frame, which must not be the call that throws.
    wsSend.mockImplementationOnce(() => {
      throw new Error('socket closed');
    });
    fireEvent.click(await screen.findByTestId('diff-approve'));
    await waitFor(() => {
      expect(permissionDeliveryTracker.size()).toBe(1);
    });
    expect(
      useUiStore.getState().errors.some((e) => /send failed: socket closed/i.test(e.message)),
    ).toBe(false);
  });

  // ---- Incoming-call banner wiring (accept / dismiss) ----

  it('accepting an incoming call sends the response, navigates, and starts the voice-call overlay', async () => {
    await renderShell('/', [makeRow('c-incoming')]);
    act(() => {
      useVoiceStore.getState().setIncoming({
        callId: 'call-1',
        chatId: 'c-incoming',
        message: undefined,
        receivedAt: Date.now(),
      });
    });
    fireEvent.click(await screen.findByTestId('incoming-accept'));
    expect(wsSend).toHaveBeenCalledWith({
      type: 'chat.call_response',
      callId: 'call-1',
      response: 'accept',
    });
    expect(useVoiceStore.getState().incomingCall).toBeNull();
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-incoming'));
    expect(startVoiceCall).toHaveBeenCalledWith('c-incoming');
  });

  it('dismissing an incoming call sends a decline response and clears it', async () => {
    await renderShell('/');
    act(() => {
      useVoiceStore.getState().setIncoming({
        callId: 'call-2',
        chatId: 'c-x',
        message: undefined,
        receivedAt: Date.now(),
      });
    });
    fireEvent.click(await screen.findByTestId('incoming-dismiss'));
    expect(wsSend).toHaveBeenCalledWith({
      type: 'chat.call_response',
      callId: 'call-2',
      response: 'decline',
    });
    expect(useVoiceStore.getState().incomingCall).toBeNull();
  });

  // ---- Voice-permission banner wiring ----

  it('responding to a voice-permission request resolves the matching inline card', async () => {
    await renderShell('/chats/c-vp', [makeRow('c-vp')]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-vp'));
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        ['c-vp']: [{ seq: 1, kind: 'permission', tool: 'Edit', requestId: 'req-vp', at: 0 }],
      },
    }));
    act(() => {
      // The voice-permission banner only renders while a voice interaction is
      // in flight (`note !== null || call !== null`).
      useVoiceStore.getState().startNote('c-vp', 'toggle');
      useVoiceStore.getState().setPermission({
        chatId: 'c-vp',
        requestId: 'req-vp',
        summary: 'edit a file',
      });
    });
    fireEvent.click(await screen.findByTestId('voice-permission-approve'));
    expect(wsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.permission_response',
        requestId: 'req-vp',
        approve: true,
      }),
    );
    await waitFor(() => {
      expect(
        useChatStore.getState().timelines['c-vp']?.find((e) => e.requestId === 'req-vp')
          ?.permissionResolved,
      ).toBe('approve');
    });
  });

  it('denying a voice-permission request sends approve:false and resolves the card as denied', async () => {
    await renderShell('/chats/c-vp-deny', [makeRow('c-vp-deny')]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-vp-deny'));
    useChatStore.setState((s) => ({
      timelines: {
        ...s.timelines,
        ['c-vp-deny']: [
          { seq: 1, kind: 'permission', tool: 'Edit', requestId: 'req-vp-deny', at: 0 },
        ],
      },
    }));
    act(() => {
      useVoiceStore.getState().startNote('c-vp-deny', 'toggle');
      useVoiceStore.getState().setPermission({
        chatId: 'c-vp-deny',
        requestId: 'req-vp-deny',
        summary: 'edit a file',
      });
    });
    fireEvent.click(await screen.findByTestId('voice-permission-deny'));
    expect(wsSend).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.permission_response',
        requestId: 'req-vp-deny',
        approve: false,
      }),
    );
    await waitFor(() => {
      expect(
        useChatStore.getState().timelines['c-vp-deny']?.find((e) => e.requestId === 'req-vp-deny')
          ?.permissionResolved,
      ).toBe('deny');
    });
  });

  // patch/todo.md — "shift click is refreshing the window" (spec/14 § Links and
  // the web panel). The router hands a MODIFIED click on an in-app link to the
  // browser, which in Patch's single window is a full same-origin page load:
  // the app appears to refresh and everything in flight is lost.
  it('shift-clicking a sidebar chat row neither navigates nor lets the browser reload the window', async () => {
    await renderShell('/chats/c-a', [makeRow('c-a'), makeRow('c-b')]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-a'));
    const row = await screen.findByTestId('chat-row-c-b');
    // fireEvent returns false when the dispatched event was cancelled — i.e. the
    // click never reaches the browser's own link handling (the page load).
    const notCancelled = fireEvent.click(row, { shiftKey: true, button: 0 });
    expect(notCancelled).toBe(false);
    expect(useChatStore.getState().activeChatId).toBe('c-a');
  });

  it('a plain click on the same row still navigates', async () => {
    await renderShell('/chats/c-a', [makeRow('c-a'), makeRow('c-b')]);
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-a'));
    fireEvent.click(await screen.findByTestId('chat-row-c-b'), { button: 0 });
    await waitFor(() => expect(useChatStore.getState().activeChatId).toBe('c-b'));
  });

  it('a voice-permission ws.send failure still resolves the card and holds the response for redelivery', async () => {
    // Tom, Todoist: "questions are timing out after I answer them" — a send
    // that fails at the moment of the tap used to block resolution and
    // surface an error the user could do nothing useful with. It now
    // resolves like any other answer and lets `permissionDeliveryTracker`
    // redeliver once the link is good.
    await renderShell('/');
    // Wait for the mount's own chat.focus_change frame before arming the
    // failure — it must not be the call that throws.
    await waitFor(() =>
      expect(wsSend).toHaveBeenCalledWith({ type: 'chat.focus_change', chatId: null }),
    );
    wsSend.mockImplementationOnce(() => {
      throw new Error('gone');
    });
    act(() => {
      useVoiceStore.getState().startNote('c-vp2', 'toggle');
      useVoiceStore.getState().setPermission({
        chatId: 'c-vp2',
        requestId: 'req-vp2',
        summary: 'edit a file',
      });
    });
    fireEvent.click(await screen.findByTestId('voice-permission-approve'));
    await waitFor(() => {
      expect(permissionDeliveryTracker.size()).toBe(1);
    });
    expect(
      useUiStore.getState().errors.some((e) => /permission send failed/i.test(e.message)),
    ).toBe(false);
  });
});
