// /chats/new must be a separate route from /chats/:chatId — registering it
// AFTER would let chatId='new' fall through to ChatRoute. We also verify the
// inline new-chat flow (spec/14 § New chat): editable folder pill + composer,
// no modal/wizard; sending the first message spawns the chat and navigates.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NewChatRoute } from '../routes/NewChatRoute.js';
import { ChatRoute } from '../routes/ChatRoute.js';
import { ErrorToasts } from '../components/ErrorToasts.js';
import {
  setModelCatalog,
  resetModelCatalog,
  getModelCatalog,
  type ModelOption,
} from '../lib/models.js';
import { reportHost, clearHosts } from './presenceHelpers.js';

// What the HOST reports as its last-used model (spec/03 § `daemon.host`). A
// spawn that names no model resolves to exactly this, on the machine.
const ACCOUNT_DEFAULT_MODEL = 'claude-opus-5';

// The picker's list is LIVE (spec/14 § Model selector) — the host reads it
// from Anthropic. These tests seed the loaded catalogue instead of asserting
// against a constant, which is the whole point of the change (a baked-in list
// is what went stale).
const MODEL_OPTIONS: readonly ModelOption[] = [
  { id: ACCOUNT_DEFAULT_MODEL, label: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];
function seedModelCatalog(): void {
  resetModelCatalog();
  setModelCatalog({ status: 'ready', models: MODEL_OPTIONS });
}
import { useChatStore } from '../stores/chatStore.js';
import { useDraftStore } from '../stores/draftStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useLayoutStore } from '../stores/layoutStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { __setAudioOpenerForTests, __setRecorderFactoryForTests } from '../lib/voiceController.js';
import type { VoiceRecording } from '../lib/voiceRecorder.js';
import type { PatchWs } from '../api/ws.js';
import { loadLastNewChat, saveLastNewChat } from '../lib/lastNewChat';

function makeRow(
  chatId: string,
  folder: string,
  lastUpdated: number,
  daemonId = 'd1',
  model: string | null = null,
  jobId: string | null = null,
) {
  return {
    pendingWake: null,
    todos: [],
    snoozedUntil: null,
    chatId,
    daemonId,
    permissionMode: 'bypassPermissions' as const,
    name: null,
    folder,
    activity: 'idle' as const,
    status: 'active' as const,
    pinned: false,
    pinnedAt: null,
    disabled: false,
    lastUpdated,
    lastUserActivity: lastUpdated,
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
    jobId,
    model,
    rateLimitResumingAt: null,
    resumeKind: null,
  };
}

describe('/chats/new', () => {
  beforeEach(() => {
    seedModelCatalog();
    // Start from an empty roster — a host account left signed OUT by one test
    // otherwise blocks every screen that follows it.
    clearHosts();
    localStorage.removeItem('patch.newChat.last.v1');
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    useLayoutStore.getState()._reset();
    // A fully-connected surface: WS up + host online. Voice-start needs the
    // host online (audio can't be queued — spec/12); text sends don't.
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    // The host's own last-used model — what an omitted `model` resolves to.
    reportHost('d1', { defaultModel: ACCOUNT_DEFAULT_MODEL });
  });

  afterEach(() => {
    // Some tests install a fake Electron desktop bridge on window.patch; clear
    // it so the default browser-case tests never see a stale native picker.
    delete (window as unknown as { patch?: unknown }).patch;
  });

  it('renders NewChatRoute on /chats/new (registered before /chats/:chatId)', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
            <Route path="/chats/:chatId" element={<ChatRoute ws={null} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // Inline panel (no modal/wizard): chat header + folder picker pill +
    // auto-focused composer. The folder input lives inside the picker pop-up.
    expect(screen.getByTestId('new-chat-main')).toBeInTheDocument();
    expect(screen.getByTestId('new-chat-folder-pill')).toBeInTheDocument();
    expect(screen.getByTestId('composer-input')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    expect(screen.getByTestId('new-chat-folder')).toBeInTheDocument();
  });

  // spec/14 §8 § New-chat setup row: before the first message the project
  // (folder) and model live INSIDE the chat window, in a row under the "New
  // chat" empty state — not in the header. The header is title + actions only;
  // the folder "moves up" to the header crumb once the chat exists.
  it('puts the folder + model pickers in the chat body under the empty state, not the header', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const head = screen.getByTestId('chat-head');
    const stream = screen.getByTestId('chat-stream');
    const setup = screen.getByTestId('new-chat-setup');
    const pill = screen.getByTestId('new-chat-folder-pill');
    const model = screen.getByTestId('new-chat-model');

    expect(head).not.toContainElement(pill);
    expect(head).not.toContainElement(model);
    expect(stream).toContainElement(setup);
    expect(setup).toContainElement(pill);
    expect(setup).toContainElement(model);
    // Under the empty state, not above it.
    const empty = screen.getByTestId('empty-chat');
    expect(empty.compareDocumentPosition(setup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // The new-chat header exposes Editor only (Call lives in the composer, same
  // as a live chat). A new chat has no session yet, so a click must CREATE
  // the chat in the chosen folder first, then run the action (create-then-act).
  it('header Editor action spawns the chat, navigates, and opens the file browser', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ chatId: 'c-act', folder: '~/x', status: 'pending' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
            <Route path="/chats/:chatId" element={<div data-testid="navigated" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // Choose a folder, then click the Editor action.
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    fireEvent.change(screen.getByTestId('new-chat-folder'), { target: { value: '~/x' } });
    expect(screen.getByTestId('call-btn')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('new-chat-action-editor'));
    await waitFor(() => expect(screen.getByTestId('navigated')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalled(); // chat was created before acting
    await waitFor(() =>
      expect(
        useLayoutStore.getState().findTab({ kind: 'page', page: 'files', chatId: 'c-act' }),
      ).not.toBeNull(),
    );
  });

  // Per-chat model picker (spec/13): the chosen model is forwarded on the
  // POST /api/chats spawn.
  it('spawns the chat with the selected model', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ chatId: 'c-model', folder: '~/x', status: 'pending' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const send = vi.fn();
    const ws = { send } as unknown as PatchWs;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={ws} />} />
            <Route path="/chats/:chatId" element={<div data-testid="navigated" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    fireEvent.change(screen.getByTestId('new-chat-folder'), { target: { value: '~/x' } });
    fireEvent.click(screen.getByTestId('new-chat-model'));
    fireEvent.click(screen.getByTestId('model-option-claude-sonnet-5'));
    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'hello' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(screen.getByTestId('navigated')).toBeInTheDocument());
    const createCall = fetchMock.mock.calls.find(
      (c) => String(c[0]) === '/api/chats' && c[1]?.method === 'POST',
    );
    expect(createCall).toBeDefined();
    const body = JSON.parse(String((createCall![1] as RequestInit).body));
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.folder).toBe('~/x');
  });

  // Guard: acting with no folder yet must open the picker, not create a chat.
  it('header action with no folder opens the picker instead of creating', () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) => new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('new-chat-action-editor'));
    // Picker opened; no chat-create POST fired.
    expect(screen.getByTestId('folder-popup')).toBeInTheDocument();
    const createCalls = fetchMock.mock.calls.filter(
      (c) => String(c[0]).includes('/api/chats') && c[1]?.method === 'POST',
    );
    expect(createCalls).toHaveLength(0);
  });

  // E6: the sidebar Recent folders shortcut opens `/chats/new?folder=<path>`.
  // The folder must be preselected from the query param.
  it('preselects the folder from a ?folder= query param', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new?folder=%2Fhome%2Ftom%2Fmyproj']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // H2: the pill shows the folder's BASENAME, full path on hover (title).
    const label = screen
      .getByTestId('new-chat-folder-pill')
      .querySelector('.folder-pill-label') as HTMLElement;
    expect(label.textContent).toBe('myproj');
    expect(label).toHaveAttribute('title', '/home/tom/myproj');
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    expect((screen.getByTestId('new-chat-folder') as HTMLInputElement).value).toBe(
      '/home/tom/myproj',
    );
  });

  // spec/14 § Empty states — the "Type your first message below…" hint is
  // dropped; the empty state is just the graphic + the "New chat" title.
  it('shows the new-chat empty state with NO hint line', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const emptyChat = screen.getByTestId('empty-chat');
    expect(emptyChat).toBeInTheDocument();
    // The graphic + title remain (title scoped to the empty state — "New chat"
    // also appears as the header h1).
    expect(emptyChat.querySelector('.empty-chat-title')?.textContent).toBe('New chat');
    // The old hint copy and its element are gone.
    expect(screen.queryByText(/type your first message/i)).toBeNull();
    expect(document.querySelector('.empty-chat-hint')).toBeNull();
  });

  it('spawns the chat then delivers the first message and navigates', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ chatId: 'c-new', folder: '~/x', status: 'pending' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const send = vi.fn();
    const ws = { send } as unknown as PatchWs;

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={ws} />} />
            <Route path="/chats/:chatId" element={<div data-testid="navigated" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    fireEvent.change(screen.getByTestId('new-chat-folder'), { target: { value: '~/x' } });
    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'first message' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });

    await waitFor(() => {
      expect(screen.getByTestId('navigated')).toBeInTheDocument();
    });
    // Chat was created via REST, then the first turn was delivered over WS.
    expect(fetchMock).toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.input', chatId: 'c-new', message: 'first message' }),
    );
    // I1-d1: the seq-0 user message is rendered optimistically into the new
    // chat's timeline so the freshly-created transcript shows the user bubble
    // above the assistant reply (not only the assistant). The host never
    // echoes the user's own input live, so without this it would be invisible.
    const timeline = useChatStore.getState().timelines['c-new'];
    expect(timeline).toBeDefined();
    const userMsg = timeline?.find((e) => e.kind === 'message' && e.role === 'user');
    expect(userMsg?.content).toBe('first message');
    // Carries a localId so the persisted seq-0 echo reconciles (not duplicates)
    // it on the next replay.
    expect(userMsg?.localId).toBeDefined();
  });

  // Todoist: "the new message should immediately appear in chat for a new
  // chat. currently it goes blank for a moment, then loads it in." The
  // optimistic message + navigation used to wait for the host's chat.spawned
  // confirmation over WS (or an 800ms timeout) before either happened — and
  // the composer clears on send regardless, so that wait was a blank screen
  // with nothing on it. This `ws` never emits chat.spawned (the host never
  // confirms), which is exactly the case that used to cost the full 800ms:
  // the fix must show the message in the REAL ChatRoute transcript almost
  // immediately, without waiting on that confirmation at all.
  it('shows the sent message in the new chat immediately, without waiting for the host to confirm the spawn', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ chatId: 'c-instant', folder: '~/x', status: 'pending' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    // No `requestReplay` stub needed for the assertion to hold, but ChatRoute
    // calls it on mount, so it must exist.
    const ws = { send: vi.fn(), requestReplay: vi.fn() } as unknown as PatchWs;

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={ws} />} />
            <Route path="/chats/:chatId" element={<ChatRoute ws={ws} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    fireEvent.change(screen.getByTestId('new-chat-folder'), { target: { value: '~/x' } });
    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'immediate message' } });

    const start = Date.now();
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });

    // Well under the 800ms spawn-confirmation window the old code blocked on —
    // this would time out on the pre-fix code, which never even called
    // `addLocalMessage`/`navigate` until that window closed.
    await waitFor(
      () => {
        expect(document.querySelector('.msg-user')).not.toBeNull();
      },
      { timeout: 400, interval: 10 },
    );
    expect(Date.now() - start).toBeLessThan(400);
    expect(document.querySelector('.msg-user')?.textContent).toContain('immediate message');
    // The new chat's route is genuinely up, not a stale /chats/new render.
    expect(screen.getByTestId('chat-main')).toBeInTheDocument();
  });

  // The other half of spec/14 §8 § New-chat setup row: once the first message
  // has spawned the chat, the setup "moves up" — the folder reads as the live
  // chat's title hover and the in-body setup row is gone.
  it('after the first message the folder moves up into the chat title hover', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ chatId: 'c-up', folder: '~/x', status: 'pending' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const ws = { send: vi.fn(), requestReplay: vi.fn() } as unknown as PatchWs;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={ws} />} />
            <Route path="/chats/:chatId" element={<ChatRoute ws={ws} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    fireEvent.change(screen.getByTestId('new-chat-folder'), { target: { value: '~/x' } });
    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'first message' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });

    await waitFor(() =>
      expect(screen.getByTestId('chat-title').getAttribute('title') ?? '').toContain('x'),
    );
    expect(screen.getByTestId('chat-head')).toContainElement(screen.getByTestId('chat-title'));
    expect(screen.queryByTestId('new-chat-setup')).toBeNull();
  });

  it('a voice note STARTS the chat: creates it, navigates, binds the note to the new chatId', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ chatId: 'c-voice', folder: '~/x', status: 'pending' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    // The composer (and its mic) is disabled unless the WS is connected.
    usePresenceStore.getState().setConnection('connected');
    // Inject a fake mic recorder so startVoiceNote records nothing real (notes
    // use the record-and-upload path, not the streaming audio WSS).
    let recorderStarts = 0;
    __setRecorderFactoryForTests(async () => {
      recorderStarts += 1;
      return { onLevel: () => {}, stop: vi.fn(), cancel: vi.fn() } as unknown as VoiceRecording;
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
            <Route path="/chats/:chatId" element={<div data-testid="navigated" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    fireEvent.change(screen.getByTestId('new-chat-folder'), { target: { value: '~/x' } });
    // Press the composer mic on a brand-new chat.
    fireEvent.mouseDown(screen.getByTestId('voice-note-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('navigated')).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalled(); // chat was created
    // The note is bound to the NEW chatId (not 'new'), as a toggle session, and
    // the mic started recording (record-and-upload path).
    await waitFor(() => {
      expect(useVoiceStore.getState().note?.chatId).toBe('c-voice');
    });
    expect(useVoiceStore.getState().note?.gesture).toBe('toggle');
    expect(recorderStarts).toBeGreaterThan(0);
    // Row seeded optimistically so ChatRoute renders immediately (no "not found").
    expect(useChatStore.getState().chats['c-voice']?.folder).toBe('~/x');

    __setRecorderFactoryForTests(null);
    useVoiceStore.getState().endNote();
  });

  it('a call STARTS the chat: creates it, navigates into it, binds the call to the new chatId', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ chatId: 'c-call', folder: '~/x', status: 'pending' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    usePresenceStore.getState().setConnection('connected');
    const opened: string[] = [];
    __setAudioOpenerForTests((async (o: { chatId: string }) => {
      opened.push(o.chatId);
      return { close: vi.fn() };
    }) as never);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
            <Route path="/chats/:chatId" element={<div data-testid="navigated" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    fireEvent.change(screen.getByTestId('new-chat-folder'), { target: { value: '~/x' } });
    fireEvent.click(screen.getByTestId('call-btn'));

    await waitFor(() => expect(screen.getByTestId('navigated')).toBeInTheDocument());
    await waitFor(() => expect(useVoiceStore.getState().call?.chatId).toBe('c-call'));
    await waitFor(() => expect(opened).toEqual(['c-call']));
    expect(useChatStore.getState().chats['c-call']?.folder).toBe('~/x');

    __setAudioOpenerForTests(null);
    useVoiceStore.getState().endCall();
  });

  // ---- Folder picker: simplified dropdown (spec/14 § Sidebar §8) ----
  // Recent rows are one-tap SELECT shortcuts; Browse rows DRILL into subfolders
  // and a distinct "Use this folder" action selects the current directory.

  // Routes settings + folder-browse fetches so the picker can render both its
  // Recent section (from projectFolders) and its Browse tree.
  function stubPickerFetch(opts?: {
    folders?: string[];
    models?: readonly ModelOption[] | 'error';
  }): void {
    const projectFolders = opts?.folders ?? ['/home/tom/projects/portfolio'];
    // The route loads the model catalogue for the chosen machine on mount, so
    // this router has to answer it too. Default is whatever the test seeded, so
    // the load is a no-op rather than an async wipe landing mid-assertion.
    const models = opts?.models ?? getModelCatalog().models;
    const roots = {
      dir: null,
      parent: null,
      entries: [{ name: 'portfolio', path: '/home/tom/projects/portfolio' }],
    };
    const portfolio = {
      dir: '/home/tom/projects/portfolio',
      parent: '/home/tom/projects',
      entries: [{ name: 'patch', path: '/home/tom/projects/portfolio/patch' }],
    };
    const fetchMock = vi.fn(async (path: string) => {
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (path.startsWith('/api/settings')) {
        return json({ projectFolders });
      }
      if (path.startsWith('/api/folders/browse')) {
        return json(path.includes('dir=') ? portfolio : roots);
      }
      if (path.startsWith('/api/models')) {
        if (models === 'error') {
          return new Response(JSON.stringify({ error: 'oauth_unavailable' }), {
            status: 502,
            headers: { 'content-type': 'application/json' },
          });
        }
        return json({ models });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  }

  // Opens the host pill and picks a host from its list.
  function chooseHost(daemonId: string): void {
    fireEvent.click(screen.getByTestId('new-chat-host'));
    fireEvent.click(screen.getByTestId(`host-option-${daemonId}`));
  }

  function renderPicker(): void {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
            <Route path="/chats/:chatId" element={<div data-testid="navigated" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('recent-folder row shows ONLY the NAME when its basename is unique, and one tap selects it', async () => {
    stubPickerFetch();
    renderPicker();
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));

    // The configured folder appears as a recent shortcut once settings load.
    const opt = await screen.findByTestId('folder-option-/home/tom/projects/portfolio');
    // Primary label is the basename. Its basename is unique among the options, so
    // NO extra path line is shown (todo: "recent should just show folder name,
    // extra only if needed for disambiguation"). Full path stays on the tooltip.
    expect(opt.querySelector('.folder-option-name')?.textContent).toBe('portfolio');
    expect(opt.querySelector('.folder-option-path')).toBeNull();
    expect(opt).toHaveAttribute('title', '/home/tom/projects/portfolio');

    // One tap SELECTS and closes the picker (a recent row is a destination).
    fireEvent.click(opt);
    expect(screen.queryByTestId('folder-popup')).not.toBeInTheDocument();
    // H2: pill shows the basename; full path on hover.
    const label = screen
      .getByTestId('new-chat-folder-pill')
      .querySelector('.folder-pill-label') as HTMLElement;
    expect(label.textContent).toBe('portfolio');
    expect(label).toHaveAttribute('title', '/home/tom/projects/portfolio');
  });

  it('clicking the ALREADY-selected recent row deselects it and leaves the picker open', async () => {
    stubPickerFetch();
    renderPicker();
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));

    const opt = await screen.findByTestId('folder-option-/home/tom/projects/portfolio');
    fireEvent.click(opt); // select — closes the picker
    expect(screen.queryByTestId('folder-popup')).not.toBeInTheDocument();
    const pill = screen.getByTestId('new-chat-folder-pill');
    expect(pill.querySelector('.folder-pill-label')?.textContent).toBe('portfolio');

    // Reopen and click the SAME row: it toggles OFF (spec/14 §8). The folder
    // clears back to the placeholder and the pop-up stays open — nothing was
    // picked, so there is nothing to close on.
    fireEvent.click(pill);
    const again = await screen.findByTestId('folder-option-/home/tom/projects/portfolio');
    expect(again).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(again);
    expect(screen.getByTestId('folder-popup')).toBeInTheDocument();
    expect(pill.querySelector('.folder-pill-label')?.textContent).toBe('Choose a folder…');
    const cleared = screen.getByTestId('folder-option-/home/tom/projects/portfolio');
    expect(cleared).toHaveAttribute('aria-selected', 'false');
    expect(cleared.className).not.toContain('selected');
    expect(cleared.querySelector('.folder-option-check')).toBeNull();
    // The ad-hoc path field is emptied too — it mirrors the chosen folder.
    expect((screen.getByTestId('new-chat-folder') as HTMLInputElement).value).toBe('');
  });

  it('deselecting does not let the most-recently-used default silently reselect a folder', async () => {
    // A chat exists in a folder, so the MRU seeding effect is live. Deselect
    // must STICK: re-seeding here would make the toggle look broken.
    useChatStore.setState({
      chats: { c1: makeRow('c1', '/home/tom/projects/portfolio', 500) },
    });
    stubPickerFetch();
    renderPicker();
    const pill = screen.getByTestId('new-chat-folder-pill');
    fireEvent.click(pill);
    const opt = await screen.findByTestId('folder-option-/home/tom/projects/portfolio');
    expect(opt).toHaveAttribute('aria-selected', 'true'); // MRU preselected it
    fireEvent.click(opt); // toggle OFF
    expect(pill.querySelector('.folder-pill-label')?.textContent).toBe('Choose a folder…');
  });

  it('recent-folder rows add a disambiguating parent path ONLY when two basenames collide', async () => {
    // Two configured folders share the basename `portfolio` — the picker must
    // show the extra path so the user can tell them apart.
    const fetchMock = vi.fn(async (path: string) => {
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (path.startsWith('/api/settings')) {
        return json({
          projectFolders: ['/home/tom/projects/portfolio', '/home/tom/work/portfolio'],
        });
      }
      if (path.startsWith('/api/folders/browse')) {
        return json({ dir: null, parent: null, entries: [] });
      }
      throw new Error(`unexpected fetch: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    renderPicker();
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));

    const projectsOpt = await screen.findByTestId('folder-option-/home/tom/projects/portfolio');
    const workOpt = screen.getByTestId('folder-option-/home/tom/work/portfolio');
    // Both still lead with the basename…
    expect(projectsOpt.querySelector('.folder-option-name')?.textContent).toBe('portfolio');
    expect(workOpt.querySelector('.folder-option-name')?.textContent).toBe('portfolio');
    // …but each now carries the minimal disambiguating parent segment.
    expect(projectsOpt.querySelector('.folder-option-path')?.textContent).toBe(
      '…/projects/portfolio',
    );
    expect(workOpt.querySelector('.folder-option-path')?.textContent).toBe('…/work/portfolio');
  });

  it('labels the Recent / Browse / path sections', async () => {
    stubPickerFetch();
    renderPicker();
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    await screen.findByTestId('folder-option-/home/tom/projects/portfolio');
    // The recents section is headed "Recent projects" — user-facing copy calls a
    // folder a project (spec/14 §4b).
    expect(screen.getByText('Recent projects')).toBeInTheDocument();
    expect(screen.queryByText('Recent folders')).not.toBeInTheDocument();
    expect(screen.getByText('Browse')).toBeInTheDocument();
    expect(screen.queryByText('Or type a path')).not.toBeInTheDocument();
  });

  it('puts the path field first in the pop-up and lets it narrow the recents', async () => {
    stubPickerFetch();
    renderPicker();
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    await screen.findByTestId('folder-option-/home/tom/projects/portfolio');
    const popup = screen.getByTestId('folder-popup');
    const input = screen.getByTestId('new-chat-folder');
    expect(popup.firstElementChild).toBe(input);

    fireEvent.change(input, { target: { value: 'zzz-nothing' } });
    expect(screen.queryByTestId('folder-option-/home/tom/projects/portfolio')).toBeNull();
    expect(screen.getByTestId('folder-recent-nomatch')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: 'portf' } });
    expect(screen.getByTestId('folder-option-/home/tom/projects/portfolio')).toBeInTheDocument();
    expect(screen.queryByTestId('folder-recent-nomatch')).toBeNull();
  });

  // ---- Quick project toggles (spec/14 §8 § New-chat setup row) ----
  // The three most recently used projects sit in the setup row itself, so the
  // commonest choice costs ONE click instead of open-pop-up-then-choose.

  it('offers the three most recently used projects as toggles in the setup row, newest first', async () => {
    useChatStore.setState({
      chats: {
        c1: makeRow('c1', '/home/tom/projects/alpha', 100),
        c2: makeRow('c2', '/home/tom/projects/bravo', 300),
        c3: makeRow('c3', '/home/tom/projects/charlie', 200),
        c4: makeRow('c4', '/home/tom/projects/delta', 50),
      },
    });
    stubPickerFetch({ folders: [] });
    renderPicker();

    const setup = screen.getByTestId('new-chat-setup');
    const quicks = await waitFor(() => {
      const found = setup.querySelectorAll('[data-testid^="folder-quick-"]');
      expect(found).toHaveLength(3);
      return found;
    });
    // Newest first, capped at three — `delta` (oldest) is left to the pop-up.
    expect(Array.from(quicks).map((b) => b.textContent)).toEqual(['bravo', 'charlie', 'alpha']);
    expect(screen.queryByTestId('folder-quick-/home/tom/projects/delta')).toBeNull();
    // Full path on the tooltip, as on the pop-up rows.
    expect(quicks[0]).toHaveAttribute('title', '/home/tom/projects/bravo');
    // They live in the setup row, NOT inside the pop-up — that is the point.
    expect(screen.queryByTestId('folder-popup')).not.toBeInTheDocument();
  });

  it('one click on a quick toggle selects that project, and clicking it again deselects', async () => {
    useChatStore.setState({ chats: { c1: makeRow('c1', '/home/tom/projects/alpha', 100) } });
    stubPickerFetch({ folders: [] });
    renderPicker();

    const quick = await screen.findByTestId('folder-quick-/home/tom/projects/alpha');
    const pill = screen.getByTestId('new-chat-folder-pill');
    // MRU already seeded this one, so it reads as pressed from the start.
    expect(quick).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(quick); // toggle OFF — the escape hatch from the MRU default
    expect(pill.querySelector('.folder-pill-label')?.textContent).toBe('Choose a folder…');
    expect(screen.getByTestId('folder-quick-/home/tom/projects/alpha')).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    fireEvent.click(screen.getByTestId('folder-quick-/home/tom/projects/alpha')); // back ON
    expect(pill.querySelector('.folder-pill-label')?.textContent).toBe('alpha');
    expect(screen.getByTestId('folder-quick-/home/tom/projects/alpha')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Selecting from the row never opens the pop-up.
    expect(screen.queryByTestId('folder-popup')).not.toBeInTheDocument();
  });

  // ---- Quick model toggles (spec/14 §8 § New-chat setup row) ----
  // The model gets the same treatment the projects already have: the three
  // most recently used, on their own line, one click each. Recency comes from
  // the model each existing chat resolved to at spawn — the only per-chat
  // record of it — and the line is topped up from the live catalogue.

  function quickModelLabels(): string[] {
    const row = screen.getByTestId('new-chat-quick-models');
    return Array.from(row.querySelectorAll('[data-testid^="model-quick-"]')).map(
      (b) => b.textContent ?? '',
    );
  }

  it('offers the three most recently used models as toggles on their own line, newest first', async () => {
    resetModelCatalog();
    setModelCatalog({
      status: 'ready',
      models: [...MODEL_OPTIONS, { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }],
    });
    useChatStore.setState({
      chats: {
        c1: makeRow('c1', '/home/tom/projects/alpha', 300, 'd1', 'claude-sonnet-5'),
        c2: makeRow('c2', '/home/tom/projects/bravo', 200, 'd1', 'claude-haiku-4-5'),
        c3: makeRow('c3', '/home/tom/projects/charlie', 100, 'd1', ACCOUNT_DEFAULT_MODEL),
        // Oldest — pushed off the end of the three.
        c4: makeRow('c4', '/home/tom/projects/delta', 50, 'd1', 'claude-sonnet-4-6'),
        // No model recorded — contributes nothing.
        c5: makeRow('c5', '/home/tom/projects/echo', 400),
      },
    });
    stubPickerFetch({ folders: [] });
    renderPicker();

    await waitFor(() => {
      expect(quickModelLabels()).toEqual(['Claude Sonnet 5', 'Claude Haiku 4.5', 'Claude Opus 5']);
    });
    expect(screen.queryByTestId('model-quick-claude-sonnet-4-6')).toBeNull();
    // Their own line, separate from the project toggles.
    const setup = screen.getByTestId('new-chat-setup');
    const models = screen.getByTestId('new-chat-quick-models');
    expect(setup).toContainElement(models);
    expect(screen.getByTestId('new-chat-quick')).not.toContainElement(models);
    // No pop-up involved — that is the point of the shortcut.
    expect(screen.queryByTestId('model-popup')).not.toBeInTheDocument();
  });

  it('excludes job-spawned chats from the quick-model recency, so an unattended job cannot bury a hand-picked model', async () => {
    resetModelCatalog();
    setModelCatalog({
      status: 'ready',
      models: [...MODEL_OPTIONS, { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }],
    });
    useChatStore.setState({
      chats: {
        // User-initiated, older.
        c1: makeRow('c1', '/home/tom/projects/alpha', 100, 'd1', 'claude-haiku-4-5'),
        // Job-spawned, newer — must not outrank the hand-picked chat above.
        c2: makeRow('c2', '/home/tom/projects/bravo', 300, 'd1', 'claude-sonnet-4-6', 'job-1'),
      },
    });
    stubPickerFetch({ folders: [] });
    renderPicker();

    await waitFor(() => {
      expect(quickModelLabels()).toEqual(['Claude Haiku 4.5', 'Claude Opus 5', 'Claude Sonnet 5']);
    });
    expect(screen.queryByTestId('model-quick-claude-sonnet-4-6')).toBeNull();
  });

  it('tops the quick models up from the catalogue when fewer than three have been used', async () => {
    useChatStore.setState({
      chats: { c1: makeRow('c1', '/home/tom/projects/alpha', 100, 'd1', 'claude-haiku-4-5') },
    });
    stubPickerFetch({ folders: [] });
    renderPicker();

    // The used one leads; the rest come off the head of the catalogue, in its
    // order, without repeating it.
    await waitFor(() => {
      expect(quickModelLabels()).toEqual(['Claude Haiku 4.5', 'Claude Opus 5', 'Claude Sonnet 5']);
    });
  });

  it('never offers a model the catalogue does not list', async () => {
    useChatStore.setState({
      chats: {
        // Retired since that chat spawned: the pop-up disowns it, so the
        // shortcut row must too rather than becoming a second source.
        c1: makeRow('c1', '/home/tom/projects/alpha', 300, 'd1', 'claude-retired-1'),
        c2: makeRow('c2', '/home/tom/projects/bravo', 200, 'd1', 'claude-sonnet-5'),
      },
    });
    stubPickerFetch({ folders: [] });
    renderPicker();

    await waitFor(() => {
      expect(quickModelLabels()).toEqual(['Claude Sonnet 5', 'Claude Opus 5', 'Claude Haiku 4.5']);
    });
    expect(screen.queryByTestId('model-quick-claude-retired-1')).toBeNull();
  });

  it('shows no quick-model line while the catalogue is unavailable', async () => {
    resetModelCatalog();
    useChatStore.setState({
      chats: { c1: makeRow('c1', '/home/tom/projects/alpha', 100, 'd1', 'claude-sonnet-5') },
    });
    stubPickerFetch({ folders: [], models: 'error' });
    renderPicker();

    // NO FALLBACK: a catalogue that cannot be read offers nothing here, rather
    // than a plausible-looking row the pop-up would disown.
    await waitFor(() => {
      expect(screen.queryByTestId('new-chat-quick-models')).toBeNull();
    });
    fireEvent.click(screen.getByTestId('new-chat-model'));
    expect(screen.getByTestId('model-popup-error')).toBeInTheDocument();
  });

  it('one click on a quick model chooses it, exactly as the pop-up row does', async () => {
    useChatStore.setState({
      chats: { c1: makeRow('c1', '/home/tom/projects/alpha', 100, 'd1', 'claude-sonnet-5') },
    });
    stubPickerFetch({ folders: [] });
    renderPicker();

    const pill = screen.getByTestId('new-chat-model');
    // Nothing chosen yet, so the pill (and the pressed toggle) read the host's
    // own last-used model — exactly what an omitted `model` resolves to.
    expect(pill.querySelector('.model-pill-label')?.textContent).toBe('Claude Opus 5');
    const sonnet = await screen.findByTestId('model-quick-claude-sonnet-5');
    expect(screen.getByTestId(`model-quick-${ACCOUNT_DEFAULT_MODEL}`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(sonnet);
    expect(pill.querySelector('.model-pill-label')?.textContent).toBe('Claude Sonnet 5');
    expect(screen.getByTestId('model-quick-claude-sonnet-5')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByTestId(`model-quick-${ACCOUNT_DEFAULT_MODEL}`)).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // A chat always spawns on some model, so there is no deselect: clicking the
    // chosen one again leaves it chosen (spec/14 § Model selector).
    fireEvent.click(screen.getByTestId('model-quick-claude-sonnet-5'));
    expect(pill.querySelector('.model-pill-label')?.textContent).toBe('Claude Sonnet 5');
    // Selecting from the row never opens the pop-up.
    expect(screen.queryByTestId('model-popup')).not.toBeInTheDocument();
  });

  it('Left/Right arrow keys on the quick-model row select the adjacent model', async () => {
    useChatStore.setState({
      chats: { c1: makeRow('c1', '/home/tom/projects/alpha', 100, 'd1', 'claude-haiku-4-5') },
    });
    stubPickerFetch({ folders: [] });
    renderPicker();

    // ['claude-haiku-4-5', 'claude-opus-5', 'claude-sonnet-5']
    const haiku = await screen.findByTestId('model-quick-claude-haiku-4-5');
    const opus = screen.getByTestId(`model-quick-${ACCOUNT_DEFAULT_MODEL}`);
    const sonnet = screen.getByTestId('model-quick-claude-sonnet-5');
    // The host's last-used model reads as pressed before anything is chosen.
    expect(opus).toHaveAttribute('aria-pressed', 'true');

    opus.focus();
    fireEvent.keyDown(opus, { key: 'ArrowRight' });
    expect(screen.getByTestId('model-quick-claude-sonnet-5')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(document.activeElement).toBe(sonnet);

    // Wraps past the last button back to the first.
    fireEvent.keyDown(sonnet, { key: 'ArrowRight' });
    expect(screen.getByTestId('model-quick-claude-haiku-4-5')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(document.activeElement).toBe(haiku);

    // ArrowLeft wraps the other way.
    fireEvent.keyDown(haiku, { key: 'ArrowLeft' });
    expect(screen.getByTestId('model-quick-claude-sonnet-5')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  // ---- Order stability across a send (Todoist: "the order of the last used
  // workflow/model should not change when you send the message. that screen
  // should stay as is") ----
  // `foldersByRecency`/`modelsByRecency` are LIVE off `projectChats`, so once
  // the chat this send is creating (or any other store update — the host's
  // `chat.spawned` confirmation, a late WS frame) lands with a fresh
  // `lastUpdated`, the live derivation reorders. Reproduce that landing WHILE
  // the panel is still mounted (the POST /api/chats response deliberately
  // never resolves during the assertion) and prove the on-screen order holds.

  function quickFolderLabels(): string[] {
    const setup = screen.getByTestId('new-chat-setup');
    return Array.from(setup.querySelectorAll('[data-testid^="folder-quick-"]')).map(
      (b) => b.textContent ?? '',
    );
  }

  it('does not reorder the quick folder toggles while a send is in flight', async () => {
    useChatStore.setState({
      chats: {
        c1: makeRow('c1', '/home/tom/projects/alpha', 100),
        c2: makeRow('c2', '/home/tom/projects/bravo', 300),
        c3: makeRow('c3', '/home/tom/projects/charlie', 200),
      },
    });
    let resolveCreate: ((r: Response) => void) | undefined;
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u === '/api/chats' && init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          resolveCreate = resolve;
        });
      }
      return new Response(JSON.stringify({ projectFolders: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
            <Route path="/chats/:chatId" element={<div data-testid="navigated" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(quickFolderLabels()).toEqual(['bravo', 'charlie', 'alpha']));

    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'hi' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });

    // The POST is still pending (never resolved), so this is exactly the
    // window between pressing send and navigating away. Simulate a late
    // store update landing in it — an existing chat (alpha) picking up a
    // fresh `lastUpdated`, the same shape of change a `chat.spawned`
    // confirmation makes. Pre-fix this flips the live order to
    // ['alpha', 'bravo', 'charlie'].
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    act(() => {
      useChatStore.setState((s) => ({
        chats: { ...s.chats, c1: { ...s.chats.c1!, lastUpdated: 999999 } },
      }));
    });
    expect(quickFolderLabels()).toEqual(['bravo', 'charlie', 'alpha']);

    // Let the send actually complete — the freeze must not break the flow it
    // is guarding, only stop the row from reshuffling during it.
    resolveCreate?.(
      new Response(JSON.stringify({ chatId: 'c-inflight', folder: '~/x', status: 'pending' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await waitFor(() => expect(screen.getByTestId('navigated')).toBeInTheDocument());
  });

  it('does not reorder the quick model toggles while a send is in flight', async () => {
    useChatStore.setState({
      chats: {
        c1: makeRow('c1', '/home/tom/projects/alpha', 100, 'd1', 'claude-sonnet-5'),
        c2: makeRow('c2', '/home/tom/projects/bravo', 300, 'd1', 'claude-haiku-4-5'),
        c3: makeRow('c3', '/home/tom/projects/charlie', 200, 'd1', ACCOUNT_DEFAULT_MODEL),
      },
    });
    let resolveCreate: ((r: Response) => void) | undefined;
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u === '/api/chats' && init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          resolveCreate = resolve;
        });
      }
      return new Response(JSON.stringify({ projectFolders: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
            <Route path="/chats/:chatId" element={<div data-testid="navigated" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() =>
      expect(quickModelLabels()).toEqual(['Claude Haiku 4.5', 'Claude Opus 5', 'Claude Sonnet 5']),
    );

    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'hi' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Simulate the model this chat used (sonnet) picking up a fresh
    // `lastUpdated` mid-send — pre-fix this flips the live order to lead
    // with sonnet.
    act(() => {
      useChatStore.setState((s) => ({
        chats: { ...s.chats, c1: { ...s.chats.c1!, lastUpdated: 999999 } },
      }));
    });
    expect(quickModelLabels()).toEqual(['Claude Haiku 4.5', 'Claude Opus 5', 'Claude Sonnet 5']);

    resolveCreate?.(
      new Response(JSON.stringify({ chatId: 'c-inflight-2', folder: '~/x', status: 'pending' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await waitFor(() => expect(screen.getByTestId('navigated')).toBeInTheDocument());
  });

  it('resumes live recency tracking after a failed send leaves the screen showing', async () => {
    useChatStore.setState({
      chats: {
        c1: makeRow('c1', '/home/tom/projects/alpha', 100),
        c2: makeRow('c2', '/home/tom/projects/bravo', 300),
      },
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'folder_not_found' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(quickFolderLabels()).toEqual(['bravo', 'alpha']));

    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'hi' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });

    // The create call fails, so the screen stays put (no navigation) and the
    // freeze must release — a later, real recency change is allowed to show.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    act(() => {
      useChatStore.setState((s) => ({
        chats: { ...s.chats, c1: { ...s.chats.c1!, lastUpdated: 999999 } },
      }));
    });
    await waitFor(() => expect(quickFolderLabels()).toEqual(['alpha', 'bravo']));
  });

  // ---- Recent-folder selection rule (spec/04 § Folders) ----
  // Every folder this screen infers from chat history goes through the SAME
  // two exclusions the host registry applies: reserved special threads by
  // chatId, then `isJunkFolder` on the path. Patch's own thread working dirs
  // are not the user's projects, so they must never be offered as one.

  const MANAGER_FOLDER = '/home/tom/.patch/threads/manager';
  const SPEAKERS_FOLDER = '/home/tom/.patch/threads/speakers';

  it('never offers a special thread folder as a picker option', async () => {
    useChatStore.setState({
      chats: {
        thread_manager: makeRow('thread_manager', MANAGER_FOLDER, 900),
        thread_speakers: makeRow('thread_speakers', SPEAKERS_FOLDER, 800),
        c1: makeRow('c1', '/home/tom/projects/alpha', 100),
      },
    });
    stubPickerFetch({ folders: [] });
    renderPicker();
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));

    // The real project is offered...
    expect(await screen.findByTestId('folder-option-/home/tom/projects/alpha')).toBeInTheDocument();
    // ...and patch's internal thread dirs are not.
    expect(screen.queryByTestId(`folder-option-${MANAGER_FOLDER}`)).toBeNull();
    expect(screen.queryByTestId(`folder-option-${SPEAKERS_FOLDER}`)).toBeNull();
  });

  it('never offers a special thread folder as a quick toggle', async () => {
    useChatStore.setState({
      chats: {
        thread_manager: makeRow('thread_manager', MANAGER_FOLDER, 900),
        thread_speakers: makeRow('thread_speakers', SPEAKERS_FOLDER, 800),
        c1: makeRow('c1', '/home/tom/projects/alpha', 100),
      },
    });
    stubPickerFetch({ folders: [] });
    renderPicker();

    const setup = screen.getByTestId('new-chat-setup');
    const quicks = await waitFor(() => {
      const found = setup.querySelectorAll('[data-testid^="folder-quick-"]');
      expect(found).toHaveLength(1);
      return found;
    });
    expect(Array.from(quicks).map((b) => b.textContent)).toEqual(['alpha']);
  });

  // The worst of the three: the MRU default SPAWNS there. A special thread is
  // the most recently updated chat most of the time (it is where automation
  // lands), so an unfiltered MRU silently pointed every new chat at
  // `.patch/threads/manager`.
  it('defaults the folder to the newest real project, not a newer special thread', () => {
    useChatStore.setState({
      chats: {
        // Highest lastUpdated of all — must still lose.
        thread_manager: makeRow('thread_manager', MANAGER_FOLDER, 9000),
        older: makeRow('older', '/home/tom/projects/alpha', 100),
        newest: makeRow('newest', '/home/tom/projects/bravo', 200),
      },
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const label = screen
      .getByTestId('new-chat-folder-pill')
      .querySelector('.folder-pill-label') as HTMLElement;
    expect(label.textContent).toBe('bravo');
    expect(label).toHaveAttribute('title', '/home/tom/projects/bravo');
  });

  // The chatId rule and the path rule are independent (spec/04 § Folders lists
  // both). A junk path reached from an ORDINARY chat — a scratch dir, a
  // dot-directory — is filtered on the same pass.
  it('filters junk paths out of the options even when the chat is not a special thread', async () => {
    useChatStore.setState({
      chats: {
        scratch: makeRow('scratch', '/tmp/scratch', 900),
        dotdir: makeRow('dotdir', '/home/tom/.config/foo', 800),
        c1: makeRow('c1', '/home/tom/projects/alpha', 100),
      },
    });
    stubPickerFetch({ folders: [] });
    renderPicker();
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));

    expect(await screen.findByTestId('folder-option-/home/tom/projects/alpha')).toBeInTheDocument();
    expect(screen.queryByTestId('folder-option-/tmp/scratch')).toBeNull();
    expect(screen.queryByTestId('folder-option-/home/tom/.config/foo')).toBeNull();
  });

  // Registered roots are user designations, not recents, so they bypass the
  // junk filter (spec/04 § Folders — "a root deliberately placed under, say,
  // `/tmp/work` is still shown"). Filtering the merged list instead of just the
  // history-derived part would silently drop a folder the user configured.
  it('keeps a configured project root that the junk filter would otherwise drop', async () => {
    useChatStore.setState({ chats: {} });
    stubPickerFetch({ folders: ['/tmp/work'] });
    renderPicker();
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));

    expect(await screen.findByTestId('folder-option-/tmp/work')).toBeInTheDocument();
  });

  // Todoist: "on a new chat page arrow keys left and right should allow user
  // to choose the folder to work in" — Left/Right cycle the quick-folder
  // toggles like a segmented control, wrapping at either end, and move focus
  // along with the selection so repeated presses keep working.
  it('Left/Right arrow keys on the quick-folder row select the adjacent project', async () => {
    useChatStore.setState({
      chats: {
        c1: makeRow('c1', '/home/tom/projects/alpha', 100),
        c2: makeRow('c2', '/home/tom/projects/bravo', 300),
        c3: makeRow('c3', '/home/tom/projects/charlie', 200),
      },
    });
    stubPickerFetch({ folders: [] });
    renderPicker();

    const alpha = await screen.findByTestId('folder-quick-/home/tom/projects/alpha');
    const bravo = screen.getByTestId('folder-quick-/home/tom/projects/bravo');
    const charlie = screen.getByTestId('folder-quick-/home/tom/projects/charlie');
    const pill = screen.getByTestId('new-chat-folder-pill');
    // MRU seeded `bravo` (most recent) as the start point.
    expect(bravo).toHaveAttribute('aria-pressed', 'true');

    bravo.focus();
    fireEvent.keyDown(bravo, { key: 'ArrowRight' });
    expect(charlie).toHaveAttribute('aria-pressed', 'true');
    expect(bravo).toHaveAttribute('aria-pressed', 'false');
    expect(pill.querySelector('.folder-pill-label')?.textContent).toBe('charlie');
    // Focus follows the selection, so a second press keeps working without
    // needing to re-tab into the row.
    expect(document.activeElement).toBe(charlie);

    // Wraps past the last option back to the first.
    fireEvent.keyDown(charlie, { key: 'ArrowRight' });
    expect(alpha).toHaveAttribute('aria-pressed', 'true');
    expect(document.activeElement).toBe(alpha);

    // ArrowLeft wraps the other way.
    fireEvent.keyDown(alpha, { key: 'ArrowLeft' });
    expect(charlie).toHaveAttribute('aria-pressed', 'true');
    expect(document.activeElement).toBe(charlie);

    // Never opens the pop-up, same as a click.
    expect(screen.queryByTestId('folder-popup')).not.toBeInTheDocument();
  });

  it("choosing a machine offers only that machine's projects, and the spawn goes there", async () => {
    // Two hosts: the MRU chat is on d1, the other project lives on d2.
    usePresenceStore.getState().setHostOnline('d2', true);
    reportHost('d2', { hostName: 'mac' });
    useChatStore.setState({
      chats: {
        c1: makeRow('c1', '/home/tom/projects/alpha', 300, 'd1'),
        c2: makeRow('c2', '/srv/bravo', 200, 'd2'),
      },
    });
    const fetchMock = vi.fn(
      async (_path: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ chatId: 'c-new', folder: '/srv/bravo', status: 'pending' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    renderPicker();

    // Starts on the most recent chat's machine, offering only its project.
    expect(await screen.findByTestId('new-chat-host')).toHaveAttribute('title', 'd1');
    expect(screen.getByTestId('folder-quick-/home/tom/projects/alpha')).toBeInTheDocument();
    expect(screen.queryByTestId('folder-quick-/srv/bravo')).not.toBeInTheDocument();

    chooseHost('d2');
    expect(screen.getByTestId('new-chat-host')).toHaveAttribute('title', 'd2');
    // d1's folder is not a directory on d2, so it is not carried across.
    expect(screen.queryByTestId('folder-quick-/home/tom/projects/alpha')).not.toBeInTheDocument();
    expect(
      screen.getByTestId('new-chat-folder-pill').querySelector('.folder-pill-label')?.textContent,
    ).toBe('Choose a folder…');

    fireEvent.click(screen.getByTestId('folder-quick-/srv/bravo'));
    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'go' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/chats'));
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body).toMatchObject({ daemonId: 'd2', folder: '/srv/bravo' });
    });
  });

  // Todoist: "the folder picker for new chat should change immediately for
  // new host, so it doesn't show inaccessible stuff". The sidebar's Recent
  // folders rows navigate with a bare `navigate('/chats/new?folder=<path>')`
  // — no `?draft=` — so clicking a SECOND row while already sitting on
  // `/chats/new` re-renders the same route element (same draftId, same
  // `NewChatPanel` key) instead of remounting it. The folder/host must still
  // catch up with the new param rather than holding the first click's folder
  // (on its own host) after the picker has moved on to a different one.
  it('catches up with a second ?folder= navigation on the same /chats/new mount', async () => {
    usePresenceStore.getState().setHostOnline('d2', true);
    reportHost('d2', { hostName: 'mac' });
    useChatStore.setState({
      chats: {
        c1: makeRow('c1', '/home/tom/projects/alpha', 300, 'd1'),
        c2: makeRow('c2', '/srv/bravo', 200, 'd2'),
      },
    });
    stubPickerFetch({ folders: [] });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new?folder=%2Fhome%2Ftom%2Fprojects%2Falpha']}>
          <Routes>
            <Route
              path="/chats/new"
              element={
                <>
                  {/* Stands in for the sidebar's second Recent-folders row —
                      a plain in-router navigation to the same path, a
                      different `?folder=`, same as `Sidebar.tsx` does. */}
                  <Link to="/chats/new?folder=%2Fsrv%2Fbravo" data-testid="other-recent-folder">
                    bravo
                  </Link>
                  <NewChatRoute ws={null} />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const pillLabel = (): string | null | undefined =>
      screen.getByTestId('new-chat-folder-pill').querySelector('.folder-pill-label')?.textContent;

    expect(await screen.findByTestId('new-chat-host')).toHaveAttribute('title', 'd1');
    expect(pillLabel()).toBe('alpha');

    fireEvent.click(screen.getByTestId('other-recent-folder'));

    await waitFor(() => expect(screen.getByTestId('new-chat-host')).toHaveAttribute('title', 'd2'));
    expect(pillLabel()).toBe('bravo');
  });

  it("offers a machine's own registered roots once it is chosen", async () => {
    usePresenceStore.getState().setHostOnline('d2', true);
    usePresenceStore.getState().setHostFolders('d2', ['/Users/tom/code'], []);
    useChatStore.setState({ chats: { c1: makeRow('c1', '/home/tom/projects/alpha', 300, 'd1') } });
    stubPickerFetch({ folders: [] });
    renderPicker();

    await screen.findByTestId('new-chat-host');
    chooseHost('d2');
    expect(await screen.findByTestId('folder-quick-/Users/tom/code')).toBeInTheDocument();
  });

  it('lists an offline machine but does not let it be chosen', async () => {
    usePresenceStore.getState().setHostOnline('d2', false);
    reportHost('d2', { hostName: 'mac' });
    useChatStore.setState({ chats: { c1: makeRow('c1', '/home/tom/projects/alpha', 300, 'd1') } });
    stubPickerFetch({ folders: [] });
    renderPicker();

    fireEvent.click(await screen.findByTestId('new-chat-host'));
    const mac = screen.getByTestId('host-option-d2');
    expect(mac).toBeDisabled();
    expect(mac).toHaveTextContent('mac · offline');
  });

  it('the host control is a pill that opens a list and closes on choosing', async () => {
    usePresenceStore.getState().setHostOnline('d2', true);
    reportHost('d2', { hostName: 'mac' });
    useChatStore.setState({ chats: { c1: makeRow('c1', '/home/tom/projects/alpha', 300, 'd1') } });
    stubPickerFetch({ folders: [] });
    renderPicker();

    const pill = await screen.findByTestId('new-chat-host');
    expect(pill).toHaveClass('model-pill');
    expect(screen.queryByTestId('host-popup')).not.toBeInTheDocument();
    fireEvent.click(pill);
    expect(screen.getByTestId('host-popup')).toBeInTheDocument();
    expect(screen.getByTestId('host-option-d1')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByTestId('host-option-d2'));
    expect(screen.queryByTestId('host-popup')).not.toBeInTheDocument();
    expect(screen.getByTestId('new-chat-host')).toHaveTextContent('mac');
  });

  it('shows no machine choice when there is only one machine', async () => {
    useChatStore.setState({ chats: { c1: makeRow('c1', '/home/tom/projects/alpha', 300, 'd1') } });
    stubPickerFetch({ folders: [] });
    renderPicker();

    await screen.findByTestId('folder-quick-/home/tom/projects/alpha');
    expect(screen.queryByTestId('new-chat-machines')).not.toBeInTheDocument();
  });

  it("browses the chosen machine's disk, not the one browsed before", async () => {
    usePresenceStore.getState().setHostOnline('d2', true);
    useChatStore.setState({ chats: { c1: makeRow('c1', '/home/tom/projects/alpha', 300, 'd1') } });
    stubPickerFetch({ folders: [] });
    renderPicker();

    fireEvent.click(await screen.findByTestId('new-chat-folder-pill'));
    await screen.findByTestId('folder-browser');
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    chooseHost('d2');
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));

    const fetchMock = vi.mocked(fetch);
    await waitFor(() => {
      const browsed = fetchMock.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.startsWith('/api/folders/browse'));
      expect(browsed.some((u) => u.includes('daemonId=d1'))).toBe(true);
      expect(browsed.some((u) => u.includes('daemonId=d2'))).toBe(true);
    });
  });

  it('tops the toggles up from the picker list when fewer than three projects have been used', async () => {
    useChatStore.setState({ chats: { c1: makeRow('c1', '/home/tom/projects/alpha', 100) } });
    stubPickerFetch({ folders: ['/home/tom/projects/zeta', '/home/tom/projects/yankee'] });
    renderPicker();

    await waitFor(() => {
      const found = screen
        .getByTestId('new-chat-setup')
        .querySelectorAll('[data-testid^="folder-quick-"]');
      expect(Array.from(found).map((b) => b.textContent)).toEqual(['alpha', 'zeta', 'yankee']);
    });
  });

  it('gives a quick toggle the same disambiguating label its pop-up row would carry', async () => {
    useChatStore.setState({
      chats: {
        c1: makeRow('c1', '/home/tom/projects/portfolio', 200),
        c2: makeRow('c2', '/home/tom/work/portfolio', 100),
      },
    });
    stubPickerFetch({ folders: [] });
    renderPicker();

    const a = await screen.findByTestId('folder-quick-/home/tom/projects/portfolio');
    const b = screen.getByTestId('folder-quick-/home/tom/work/portfolio');
    expect(a.textContent).toBe('…/projects/portfolio');
    expect(b.textContent).toBe('…/work/portfolio');
  });

  it('disables the quick toggles when the host is not signed in, like the pickers beside them', async () => {
    usePresenceStore.getState().setHostAccount({
      type: 'daemon.account',
      daemonId: 'd1',
      backendId: 'claude-code',
      connected: false,
      accountEmail: null,
    });
    useChatStore.setState({ chats: { c1: makeRow('c1', '/home/tom/projects/alpha', 100) } });
    stubPickerFetch({ folders: [] });
    renderPicker();

    expect(await screen.findByTestId('folder-quick-/home/tom/projects/alpha')).toBeDisabled();
    expect(screen.getByTestId('new-chat-folder-pill')).toBeDisabled();
  });

  it('draws no quick toggles when there are no projects to offer', async () => {
    stubPickerFetch({ folders: [] });
    renderPicker();
    await screen.findByTestId('new-chat-folder-pill');
    expect(
      screen.getByTestId('new-chat-setup').querySelectorAll('[data-testid^="folder-quick-"]'),
    ).toHaveLength(0);
  });

  // A machine with no registered project roots browsed as "No subfolders here."
  // — which blames the folder for the machine having none, and offers no way
  // out. The two emptinesses are different problems with different fixes.
  it('an empty browse view points at typing a path, not at registering a root first', async () => {
    const fetchMock = vi.fn(async (path: string) => {
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (path.startsWith('/api/settings')) return json({ projectFolders: [] });
      if (path.startsWith('/api/folders/browse'))
        return json({ dir: null, parent: null, entries: [] });
      if (path.startsWith('/api/folders')) return json({ hosts: [] });
      if (path.startsWith('/api/models')) return json({ models: [] });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    renderPicker();
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    const msg = await screen.findByTestId('folder-browser-no-roots');
    expect(msg).toHaveTextContent('Type a path below to open any folder');
    // It must not misdiagnose it as an empty folder.
    expect(screen.queryByText('No subfolders here.')).not.toBeInTheDocument();
  });

  it('draws NO breadcrumb at the roots view — the "Projects" placeholder is a stray line (spec/14 §8)', async () => {
    stubPickerFetch();
    renderPicker();
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    // Roots view: the tree has loaded, so this is the settled state, not a flash.
    await screen.findByTestId('folder-browser-entry-portfolio');
    // The `Browse` heading alone labels this level. A synthetic "Projects" crumb
    // under it is unexplained text: not clickable, not a heading, says nothing
    // the heading doesn't.
    expect(screen.queryByTestId('folder-browser-crumb')).not.toBeInTheDocument();
    expect(screen.queryByText('Projects')).not.toBeInTheDocument();

    // …but drilling in DOES name the current directory (the crumb has a job then).
    fireEvent.click(screen.getByTestId('folder-browser-entry-portfolio'));
    const crumb = await screen.findByTestId('folder-browser-crumb');
    expect(crumb).toHaveTextContent('portfolio');
  });

  it('the picker empty state reads "No recent projects" (spec/14 §4b)', async () => {
    stubPickerFetch({ folders: [] });
    renderPicker();
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    const empty = await screen.findByTestId('folder-recent-empty');
    expect(empty.querySelector('.folder-recent-empty-title')?.textContent).toBe(
      'No recent projects',
    );
  });

  it('a Browse row DRILLS IN (does not select); "Use this folder" SELECTS the current dir', async () => {
    stubPickerFetch();
    renderPicker();
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));

    // At the roots view there is no "use this folder" — you can't select the
    // synthetic "Projects" root.
    const rootEntry = await screen.findByTestId('folder-browser-entry-portfolio');
    expect(screen.queryByTestId('folder-browser-use')).not.toBeInTheDocument();

    // Clicking a browse row DRILLS IN: the picker stays open, the folder is NOT
    // selected, and the tree descends (the child folder shows up).
    fireEvent.click(rootEntry);
    await screen.findByTestId('folder-browser-entry-patch');
    expect(screen.getByTestId('folder-popup')).toBeInTheDocument();
    expect(screen.getByTestId('new-chat-folder-pill')).toHaveTextContent('Choose a folder…');

    // The breadcrumb now names the current dir, and a distinct SELECT action
    // ("Use …") appears for it.
    expect(screen.getByTestId('folder-browser-crumb')).toHaveTextContent('portfolio');
    const use = screen.getByTestId('folder-browser-use');
    fireEvent.click(use);
    // Now it SELECTS the browsed dir and closes.
    expect(screen.queryByTestId('folder-popup')).not.toBeInTheDocument();
    // H2: pill shows basename; full path on hover.
    const label = screen
      .getByTestId('new-chat-folder-pill')
      .querySelector('.folder-pill-label') as HTMLElement;
    expect(label.textContent).toBe('portfolio');
    expect(label).toHaveAttribute('title', '/home/tom/projects/portfolio');
  });

  it('attaches to a NEW chat: creates the chat FIRST, uploads to the real id (not "new"), then sends', async () => {
    // Regression for "attachment upload failed: chat not found: new": a first
    // message WITH an attachment must create the chat, upload the file to the
    // REAL chatId, then deliver the turn (spec/14 § New chat).
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u === '/api/chats' && init?.method === 'POST') {
        return new Response(JSON.stringify({ chatId: 'c-att', folder: '~/x', status: 'pending' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/attachment')) {
        return new Response(
          JSON.stringify({
            ok: true,
            ref: { id: 'att1', name: 'notes.txt', mimeType: 'text/plain', kind: 'file', url: '/x' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    usePresenceStore.getState().setConnection('connected');
    const send = vi.fn();
    const ws = { send } as unknown as PatchWs;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={ws} />} />
            <Route path="/chats/:chatId" element={<div data-testid="navigated" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    fireEvent.change(screen.getByTestId('new-chat-folder'), { target: { value: '~/x' } });
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [file] } });
    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'look at this' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });

    await waitFor(() => expect(screen.getByTestId('navigated')).toBeInTheDocument());
    const uploadCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/attachment'));
    expect(uploadCall).toBeDefined();
    expect(String(uploadCall?.[0])).toBe('/api/chats/c-att/attachment');
    expect(String(uploadCall?.[0])).not.toContain('/new/');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'chat.input',
        chatId: 'c-att',
        message: 'look at this',
        attachments: [expect.objectContaining({ id: 'att1', kind: 'file' })],
      }),
    );
    const timeline = useChatStore.getState().timelines['c-att'];
    const userMsg = timeline?.find((e) => e.kind === 'message' && e.role === 'user');
    expect(userMsg?.attachments?.[0]?.id).toBe('att1');
  });

  it('G5-d1: a bad folder shows a visible error AND preserves the typed message', async () => {
    // POST /api/chats 400 folder_not_found — must NOT fail silently. The user
    // sees an error, the message they typed is kept (not discarded), and we
    // stay on /chats/new.
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: 'folder_not_found',
            message: 'folder does not exist on the host: /tmp/does-not-exist-g5',
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const send = vi.fn();
    const ws = { send } as unknown as PatchWs;

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route
              path="/chats/new"
              element={
                <>
                  <NewChatRoute ws={ws} />
                  <ErrorToasts />
                </>
              }
            />
            <Route path="/chats/:chatId" element={<div data-testid="navigated" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    fireEvent.change(screen.getByTestId('new-chat-folder'), {
      target: { value: '/tmp/does-not-exist-g5' },
    });
    const composer = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'my first message' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });

    // Visible error surfaced ONCE, as the toast (spec/12 § Principles — one
    // surface per failure).
    await waitFor(() => {
      expect(screen.getByTestId('error-toasts')).toHaveTextContent(/folder does not exist/i);
    });
    expect(screen.queryByTestId('new-chat-error')).not.toBeInTheDocument();
    // The typed message is preserved, not discarded.
    expect(composer.value).toBe('my first message');
    // Did not navigate away — still on /chats/new.
    expect(screen.queryByTestId('navigated')).not.toBeInTheDocument();
    // No chat input was delivered.
    expect(send).not.toHaveBeenCalled();
  });

  it('E1-d6: a refused spawn retracts the ghost row the fanned-out error drew', async () => {
    // The host's refusal goes out as a chat-scoped `chat.error`, which the hub
    // fans to every surface. A surface draws a row for any chatId it has not
    // seen, so the refusal itself manufactures a nameless "New chat" row for a
    // chat that does not exist and never will (it is absent from GET /api/chats).
    // The POST's 400 names that id in `retractChatId`; the caller must drop it.
    const ghostId = '01JGHOSTSPAWN0000000000000';
    useChatStore.getState().applyEvent({
      type: 'chat.error',
      chatId: ghostId,
      error: { code: 'no_model_catalogue', message: 'no model catalogue on d1' },
      seq: -1,
    });
    expect(useChatStore.getState().chats[ghostId]).toBeDefined();

    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: 'no_model_catalogue',
            message: 'no model catalogue on d1',
            retractChatId: ghostId,
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const send = vi.fn();
    const ws = { send } as unknown as PatchWs;

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route
              path="/chats/new"
              element={
                <>
                  <NewChatRoute ws={ws} />
                  <ErrorToasts />
                </>
              }
            />
            <Route path="/chats/:chatId" element={<div data-testid="navigated" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    fireEvent.change(screen.getByTestId('new-chat-folder'), { target: { value: '~/proj' } });
    const composer = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'my first message' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });

    // The failure is still surfaced (the retraction is not a way to hide it).
    await waitFor(() => {
      expect(screen.getByTestId('error-toasts')).toHaveTextContent(/no model catalogue/i);
    });
    // …and the row the refusal drew is gone, without a page reload.
    await waitFor(() => expect(useChatStore.getState().chats[ghostId]).toBeUndefined());
    expect(useChatStore.getState().timelines[ghostId]).toBeUndefined();

    // A late duplicate of the same refusal cannot resurrect it.
    act(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.error',
        chatId: ghostId,
        error: { code: 'no_model_catalogue', message: 'no model catalogue on d1' },
        seq: -1,
      });
    });
    expect(useChatStore.getState().chats[ghostId]).toBeUndefined();
    expect(screen.queryByTestId('navigated')).not.toBeInTheDocument();
    expect(send).not.toHaveBeenCalled();
  });

  it('surfaces a plain Error message (not an ApiError) from a failed chat creation', async () => {
    // A network-level failure (fetch itself rejects) rather than a non-2xx
    // JSON response — exercises the non-ApiError branch of the catch handler.
    const fetchMock = vi.fn(async () => {
      throw new Error('network is down');
    });
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route
              path="/chats/new"
              element={
                <>
                  <NewChatRoute ws={null} />
                  <ErrorToasts />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    fireEvent.change(screen.getByTestId('new-chat-folder'), { target: { value: '~/x' } });
    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'hi' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });

    await waitFor(() => {
      expect(screen.getByTestId('error-toasts')).toHaveTextContent('network is down');
    });
  });

  it('requires a folder before starting a chat (blank folder on send)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route
              path="/chats/new"
              element={
                <>
                  <NewChatRoute ws={null} />
                  <ErrorToasts />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // No folder chosen — mruFolder resolves to '' with no existing chats.
    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'hi' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(screen.getByTestId('error-toasts')).toHaveTextContent(
        'Folder is required before starting a chat.',
      );
    });
    // One surface, not two (spec/12 § Principles).
    expect(screen.queryByTestId('new-chat-error')).not.toBeInTheDocument();
  });

  // spec/12 § Principles — one surface per failure. A failed spawn used to
  // render the SAME verbose message twice: the styled toast at the foot of the
  // window, and an unstyled paragraph pinned at the top of the chat panel. Two
  // copies of one message read as two separate faults. This pins the count.
  it('reports a failed spawn on exactly ONE surface — the toast, and nothing else', async () => {
    const MESSAGE = 'folder does not exist on the host: /tmp/nope';
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'folder_not_found', message: MESSAGE }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route
              path="/chats/new"
              element={
                <>
                  <NewChatRoute ws={null} />
                  <ErrorToasts />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    fireEvent.change(screen.getByTestId('new-chat-folder'), { target: { value: '/tmp/nope' } });
    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'hi' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });

    const SENTENCE = 'That folder isn’t on that machine. Pick another project.';
    await waitFor(() => {
      expect(screen.getByTestId('error-toasts')).toHaveTextContent(SENTENCE);
    });
    // The sentence appears in exactly one place in the whole rendered tree.
    const carriers = Array.from(container.querySelectorAll('*')).filter(
      (el) =>
        Array.from(el.childNodes).some((n) => n.nodeType === 3) && el.textContent === SENTENCE,
    );
    expect(carriers).toHaveLength(1);
    expect(carriers[0]).toHaveClass('msg');
    // And that one place is the STYLED toast, not a bare paragraph.
    expect(carriers[0]?.closest('.error-toast')).not.toBeNull();
    expect(screen.queryByTestId('new-chat-error')).not.toBeInTheDocument();
    // The host's own wording is kept, but only inside the Details disclosure —
    // it is not a second copy of the failure sitting in the open.
    expect(carriers[0]?.textContent).not.toContain(MESSAGE);
    expect(screen.getByTestId('error-toast-detail-text')).toHaveTextContent(MESSAGE);
  });

  it('picks the most-recently-updated folder among existing chats, skipping folderless rows', () => {
    useChatStore.setState({
      chats: {
        // No folder — skipped (the `continue` branch).
        noFolder: makeRow('noFolder', '', 1000),
        // Earliest — becomes the initial "best", then is NOT overtaken by an
        // even-earlier row (exercises the false side of the comparison).
        first: makeRow('first', '/first', 100),
        older: makeRow('older', '/older', 50),
        // Latest — overtakes "first" (the true side of the comparison).
        newest: makeRow('newest', '/newest', 200),
      },
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // The MRU folder ('/newest') seeds the folder pill via the sync effect.
    // H2: the pill shows the basename ('newest'), full path on hover.
    const label = screen
      .getByTestId('new-chat-folder-pill')
      .querySelector('.folder-pill-label') as HTMLElement;
    expect(label.textContent).toBe('newest');
    expect(label).toHaveAttribute('title', '/newest');
  });

  // Paths are scoped to their host (spec/04 § Spawn), and the picker's folder
  // and host are ONE choice (spec/14 §8 — "that pairing is what the spawn sends
  // as `daemonId` + `folder`"). Taking the folder from the most-recent chat
  // while taking the host from the account default paired host-a's path with
  // host-b's id on the wire.
  it('spawns the MRU folder on the host that folder is ON, not the account default', async () => {
    useChatStore.setState({ chats: { m: makeRow('m', '/only-on-host-b', 900, 'host-b') } });
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ chatId: 'c-pair', folder: '/only-on-host-b', status: 'pending' }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
            <Route path="/chats/:chatId" element={<div data-testid="navigated" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'hi' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(screen.getByTestId('navigated')).toBeInTheDocument());
    const call = fetchMock.mock.calls.find(
      (c) => String(c[0]).endsWith('/api/chats') && c[1]?.method === 'POST',
    )!;
    const body = JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body['folder']).toBe('/only-on-host-b');
    expect(body['daemonId']).toBe('host-b');
  });

  it('adopts the MRU folder once the roster hydrates AFTER mount (no chats known yet at mount)', () => {
    // Mounts with no chats — mruFolder resolves to '' and the folder pill
    // starts as the placeholder. Once the roster hydrates (WS replay lands
    // late), the sync effect re-fires with an unedited, still-empty `folder`
    // and adopts the newly-resolved MRU folder.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('new-chat-folder-pill')).toHaveTextContent('Choose a folder…');
    act(() => {
      useChatStore.setState({
        chats: { late: makeRow('late', '/late-hydrated', 500) },
      });
    });
    // H2: basename in the pill, full path on hover.
    const label = screen
      .getByTestId('new-chat-folder-pill')
      .querySelector('.folder-pill-label') as HTMLElement;
    expect(label.textContent).toBe('late-hydrated');
    expect(label).toHaveAttribute('title', '/late-hydrated');
  });

  it('a double-fire send while a chat creation is already in flight is a no-op the second time', async () => {
    let resolveCreate: ((r: Response) => void) | undefined;
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u === '/api/chats' && init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          resolveCreate = resolve;
        });
      }
      // Settings / folder-browse queries fired on mount / picker-open — not
      // under test here, so resolve them with harmless empty bodies.
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    fireEvent.change(screen.getByTestId('new-chat-folder'), { target: { value: '~/x' } });
    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'hi' } });
    // First submit kicks off createChatInFolder, which sets `submitting` and
    // suspends on the still-pending POST /api/chats. (A second text submit
    // can't re-trigger this: the composer clears its value synchronously on
    // send, so a second Enter is a no-op at the composer level before it ever
    // reaches handleSend. Pressing the mic instead calls
    // handleStartVoiceNote → createChatInFolder directly, genuinely
    // re-entering while the first call is still in flight.)
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
    const createCallsBefore = fetchMock.mock.calls.filter(
      (c) => String(c[0]) === '/api/chats' && (c[1] as RequestInit | undefined)?.method === 'POST',
    ).length;
    expect(createCallsBefore).toBe(1);
    // A second, concurrent creation attempt while the first is still in
    // flight must bail out via the `if (submitting) return null;` guard
    // rather than double-firing a second POST.
    fireEvent.mouseDown(screen.getByTestId('voice-note-btn'));
    const createCallsAfter = fetchMock.mock.calls.filter(
      (c) => String(c[0]) === '/api/chats' && (c[1] as RequestInit | undefined)?.method === 'POST',
    ).length;
    expect(createCallsAfter).toBe(1);

    resolveCreate?.(
      new Response(JSON.stringify({ chatId: 'c-race', folder: '~/x', status: 'pending' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await waitFor(() => {
      expect(useChatStore.getState().chats['c-race']).toBeDefined();
    });
  });

  it('keeps body.error as the toast detail when body.message is absent on a failed chat creation', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'folder_not_found' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route
              path="/chats/new"
              element={
                <>
                  <NewChatRoute ws={null} />
                  <ErrorToasts />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    fireEvent.change(screen.getByTestId('new-chat-folder'), { target: { value: '~/x' } });
    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'hi' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(screen.getByTestId('error-toasts')).toHaveTextContent(
        'That folder isn’t on that machine. Pick another project.',
      );
    });
    // The code is not lost — it is the detail, and it is not in the sentence.
    expect(screen.getByTestId('error-toast-detail-text')).toHaveTextContent('folder_not_found');
    expect(document.querySelector('.error-toast .msg')?.textContent).not.toContain(
      'folder_not_found',
    );
  });

  it('says one plain sentence for an unrecognised failure, keeping the raw code as detail', async () => {
    // An empty JSON body on a non-2xx response — rest.ts's ApiError message
    // itself falls back to `HTTP <status>` in this case (no `error` key). That
    // is a code nothing has copy for, so it must NOT be interpolated into the
    // sentence: the user reads English, the code goes in the disclosure.
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({}), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route
              path="/chats/new"
              element={
                <>
                  <NewChatRoute ws={null} />
                  <ErrorToasts />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    fireEvent.change(screen.getByTestId('new-chat-folder'), { target: { value: '~/x' } });
    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'hi' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(document.querySelector('.error-toast .msg')?.textContent).toBe(
        'Couldn’t start the chat. Try again in a moment.',
      );
    });
    expect(document.querySelector('.error-toast .msg')?.textContent).not.toContain('HTTP 400');
    expect(screen.getByTestId('error-toast-detail-text')).toHaveTextContent('HTTP 400');
  });

  // spec/14 § Attachments, spec/15 § Composer → Attachments — a first message
  // WITH an attachment reacts at once: the chat is created, the route moves
  // into it straight away and the message waits there, pending, while its file
  // uploads. It is not held on the new-chat screen until the upload lands.
  it('a first message with an attachment opens the new chat at once, pending, while the file uploads', async () => {
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((r) => (releaseUpload = r));
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u === '/api/chats' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ chatId: 'c-pending', folder: '~/x', status: 'pending' }),
          { status: 202, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('/attachment')) {
        await uploadGate;
        return new Response(
          JSON.stringify({
            ok: true,
            ref: { id: 'att-x', name: 'a.txt', mimeType: 'text/plain', kind: 'file', url: '/x' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.startsWith('/api/settings') || u.includes('/api/folders/browse')) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
            <Route path="/chats/:chatId" element={<div data-testid="navigated" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    fireEvent.change(screen.getByTestId('new-chat-folder'), { target: { value: '~/x' } });
    const file = new File(['a'], 'a.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('composer-file-input'), { target: { files: [file] } });
    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'with a file' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });

    // In the new chat already, with the upload still in flight.
    await waitFor(() => expect(screen.getByTestId('navigated')).toBeInTheDocument());
    const entry = () =>
      useChatStore
        .getState()
        .timelines['c-pending']?.find((e) => e.role === 'user' && e.content === 'with a file');
    expect(entry()?.upload).toEqual({ done: 0, total: 1, failed: false });
    expect(entry()?.localAttachments).toEqual([{ name: 'a.txt', kind: 'file' }]);

    releaseUpload();
    await waitFor(() => expect(entry()?.upload).toBeUndefined());
    expect(entry()?.attachments).toEqual([
      { id: 'att-x', name: 'a.txt', mimeType: 'text/plain', kind: 'file' },
    ]);
    const creates = fetchMock.mock.calls.filter(
      (c) => String(c[0]) === '/api/chats' && (c[1] as RequestInit | undefined)?.method === 'POST',
    );
    expect(creates.length).toBe(1);
  });

  it('delivers the first message with no WS connected (ws=null) — delivery is just left pending', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ chatId: 'c-nows', folder: '~/x', status: 'pending' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
            <Route path="/chats/:chatId" element={<div data-testid="navigated" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    fireEvent.change(screen.getByTestId('new-chat-folder'), { target: { value: '~/x' } });
    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'no ws here' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
    await waitFor(() => {
      expect(screen.getByTestId('navigated')).toBeInTheDocument();
    });
    expect(useChatStore.getState().timelines['c-nows']).toBeDefined();
  });

  it('starting a voice note with no folder chosen does not create a chat or navigate', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route
              path="/chats/new"
              element={
                <>
                  <NewChatRoute ws={null} />
                  <ErrorToasts />
                </>
              }
            />
            <Route path="/chats/:chatId" element={<div data-testid="navigated" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // No folder set — createChatInFolder returns null, handleStartVoiceNote bails.
    fireEvent.mouseDown(screen.getByTestId('voice-note-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('error-toasts')).toHaveTextContent(
        'Folder is required before starting a chat.',
      );
    });
    expect(screen.queryByTestId('navigated')).not.toBeInTheDocument();
    // The settings query fires on mount regardless, but no chat-creation POST
    // was ever made.
    expect(
      fetchMock.mock.calls.some(
        (c) =>
          String(c[0]) === '/api/chats' && (c[1] as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(false);
  });

  // The host's own wording for a spawn it refused — written for whoever wrote
  // the host, which is exactly why the surface must not repeat it verbatim.
  const DAEMON_PARAGRAPH =
    'machine dev-daemon-1 has never read a model catalogue, so it has no last-used model; ' +
    'name a model on the spawn or connect the backend credential on that machine';

  // ---- Zombie-chat guard: WS spawn failure after a 202 response ----
  // When the server accepts the spawn HTTP request (202) but the host then
  // emits chat.error over WS (e.g. no_model_catalogue, which arrives after the
  // 5-second synchronous-error window), the web must NOT navigate into the
  // half-baked chat. Instead it stays on /chats/new, shows the error inline,
  // preserves the typed message, and leaves no orphan chat row in the store.

  it('WS chat.error after 202 keeps user on /chats/new with message intact (no zombie row)', async () => {
    // The server returns 202 (spawn accepted at HTTP level), but the host then
    // emits chat.error over WS before the surface has navigated. This simulates
    // the race where the host's no_model_catalogue rejection slipped past the
    // server's 5-second synchronous-error window.
    const ZOMBIE_CHAT_ID = 'c-zombie';

    // Controlled fetch: resolves only after we call `letFetchComplete()`, so we
    // can inject the WS error into chatStore BEFORE the surface acts on the 202.
    let letFetchComplete!: () => void;
    const fetchControlled = new Promise<Response>((resolve) => {
      letFetchComplete = () =>
        resolve(
          new Response(
            JSON.stringify({ chatId: ZOMBIE_CHAT_ID, folder: '~/x', status: 'pending' }),
            { status: 202, headers: { 'content-type': 'application/json' } },
          ),
        );
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) =>
        String(url) === '/api/chats' ? fetchControlled : new Response('{}', { status: 200 }),
      ),
    );
    const send = vi.fn();
    const ws = { send } as unknown as PatchWs;

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route
              path="/chats/new"
              element={
                <>
                  <NewChatRoute ws={ws} />
                  <ErrorToasts />
                </>
              }
            />
            <Route path="/chats/:chatId" element={<div data-testid="navigated" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    fireEvent.change(screen.getByTestId('new-chat-folder'), { target: { value: '~/x' } });
    const composer = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'my important message' } });

    // Fire the send; handleSend is now suspended inside createChatInFolder
    // awaiting the controlled fetch.
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });

    // Inject the WS chat.error BEFORE the fetch resolves — simulating the
    // host rejecting the spawn over WS while the HTTP response is in flight.
    // In production this race occurs when no_model_catalogue fires before the
    // server's 5-second window closes (or after it closes and the 202 lands).
    act(() => {
      useChatStore.getState().applyEvent({
        type: 'chat.error',
        chatId: ZOMBIE_CHAT_ID,
        error: { code: 'no_model_catalogue', message: DAEMON_PARAGRAPH },
        seq: -1,
      });
    });

    // Now let the fetch resolve with 202. The surface will see the chatId and
    // immediately check chatStore — the error is already there, so it aborts.
    await act(async () => {
      letFetchComplete();
    });

    // Must stay on /chats/new — no navigation to the zombie chat.
    expect(screen.queryByTestId('navigated')).not.toBeInTheDocument();
    expect(screen.getByTestId('new-chat-main')).toBeInTheDocument();

    // The error is shown — once, as the toast (spec/12 § Principles), and as
    // ONE plain sentence: the host's paragraph is replaced, not passed
    // through, and its code never reaches the sentence either.
    await waitFor(() => {
      expect(document.querySelector('.error-toast .msg')?.textContent).toBe(
        'Pick a model before starting the chat.',
      );
    });
    const sentence = document.querySelector('.error-toast .msg')?.textContent ?? '';
    expect(sentence).not.toContain(DAEMON_PARAGRAPH);
    expect(sentence).not.toContain('no_model_catalogue');
    // Kept, not lost: code and the host's own wording live in the disclosure.
    const detail = screen.getByTestId('error-toast-detail-text');
    expect(detail).toHaveTextContent('no_model_catalogue');
    expect(detail).toHaveTextContent(DAEMON_PARAGRAPH);
    expect(screen.queryByTestId('new-chat-error')).not.toBeInTheDocument();

    // The typed message survives (not discarded).
    expect(composer.value).toBe('my important message');

    // No orphan chat row left in the store from the zombie chatId.
    expect(useChatStore.getState().chats[ZOMBIE_CHAT_ID]).toBeUndefined();
    expect(useChatStore.getState().timelines[ZOMBIE_CHAT_ID]).toBeUndefined();
  });

  it('the folder browser "Up" button navigates back to the parent directory', async () => {
    // A stub that distinguishes the roots view from the drilled-in "portfolio"
    // dir, whose parent is the (synthetic) roots view — so "Up" round-trips.
    const roots = {
      dir: null,
      parent: null,
      entries: [{ name: 'portfolio', path: '/home/tom/projects/portfolio' }],
    };
    const portfolio = {
      dir: '/home/tom/projects/portfolio',
      parent: null,
      entries: [{ name: 'patch', path: '/home/tom/projects/portfolio/patch' }],
    };
    const fetchMock = vi.fn(async (path: string) => {
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (path.startsWith('/api/settings')) return json({ projectFolders: [] });
      if (path.startsWith('/api/folders/browse')) {
        return json(path.includes('dir=') ? portfolio : roots);
      }
      throw new Error(`unexpected fetch: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    renderPicker();
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    const rootEntry = await screen.findByTestId('folder-browser-entry-portfolio');
    fireEvent.click(rootEntry);
    const up = await screen.findByTestId('folder-browser-up');
    fireEvent.click(up);
    // Back at the roots view — the "portfolio" entry (not "patch") is shown,
    // and the breadcrumb disappears again (no current dir to name; spec/14 §8).
    await screen.findByTestId('folder-browser-entry-portfolio');
    expect(screen.queryByTestId('folder-browser-crumb')).not.toBeInTheDocument();
  });

  it('pressing Enter in the ad-hoc path input closes the picker without submitting', () => {
    renderPicker();
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    const input = screen.getByTestId('new-chat-folder');
    fireEvent.change(input, { target: { value: '/tmp/typed' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.queryByTestId('folder-popup')).not.toBeInTheDocument();
    // H2: pill shows the basename of the typed path; full path on hover.
    const label = screen
      .getByTestId('new-chat-folder-pill')
      .querySelector('.folder-pill-label') as HTMLElement;
    expect(label.textContent).toBe('typed');
    expect(label).toHaveAttribute('title', '/tmp/typed');
  });

  // ---- The folder picker NEVER browses the surface's own machine ----
  // spec/04 § Browsing: the browsed filesystem is always the HOST's, on every
  // surface including the Electron shell. A folder picked from the user's own
  // Mac is a path the (remote) host does not have, and every chat spawned
  // into it dies with folder_not_found — which is exactly the bug this replaces.

  it('in the desktop shell, the picker still browses the HOST tree — no OS-native dialog', async () => {
    const pickFolder = vi.fn(async () => '/Users/tom/on-my-mac');
    (window as unknown as { patch?: unknown }).patch = { pickFolder };
    stubPickerFetch();
    renderPicker();
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));

    // The daemon-backed tree and the type-a-path field are both present…
    expect(await screen.findByTestId('folder-browser')).toBeInTheDocument();
    expect(screen.getByTestId('new-chat-folder')).toBeInTheDocument();
    // …and there is no native Browse affordance at all.
    expect(screen.queryByTestId('folder-native')).toBeNull();
    expect(screen.queryByTestId('folder-native-browse')).toBeNull();
    // Nothing ever calls into the shell's directory dialog.
    expect(pickFolder).not.toHaveBeenCalled();
  });

  it('drills the host tree and selects the browsed folder', async () => {
    stubPickerFetch();
    renderPicker();
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    fireEvent.click(await screen.findByTestId('folder-browser-entry-portfolio'));
    fireEvent.click(await screen.findByTestId('folder-browser-use'));
    expect(
      screen.getByTestId('new-chat-folder-pill').querySelector('.folder-pill-label')?.textContent,
    ).toBe('portfolio');
  });
});

// Todo "Don't show a default model, just default to last used": the model
// picker no longer offers a synthetic "Default model" row, a fresh new chat
// preselects the model the user last spawned a chat with, and spawning a chat
// remembers its model as the new last-used.
describe('/chats/new model defaulting', () => {
  beforeEach(() => {
    seedModelCatalog();
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    localStorage.removeItem('patch.model.lastUsed');
    localStorage.removeItem('patch.drafts.v1');
    localStorage.removeItem('patch.newChat.last.v1');
    useDraftStore.setState({ drafts: {}, order: [] });
  });

  function renderNewChat(ws: PatchWs | null = null): void {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={ws} />} />
            <Route path="/chats/:chatId" element={<div data-testid="navigated" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('renders no synthetic "Default model" option — only real models', () => {
    renderNewChat();
    fireEvent.click(screen.getByTestId('new-chat-model'));
    expect(screen.queryByText('Default model')).not.toBeInTheDocument();
    const options = screen.getAllByRole('option');
    expect(options.length).toBe(MODEL_OPTIONS.length);
    for (const m of MODEL_OPTIONS) {
      expect(screen.getByTestId(`model-option-${m.id}`)).toBeInTheDocument();
    }
  });

  // spec/14 § Model selector: "there is no synthetic Default model row; the
  // picker preselects the draft's model, else the chosen host's last-used one".
  // The surface holds NO default id of its own — one is exactly what overwrote
  // the machine's last-used model on every spawn.
  it("preselects the chosen HOST's last-used model, not a surface constant", () => {
    renderNewChat();
    fireEvent.click(screen.getByTestId('new-chat-model'));
    expect(screen.getByTestId(`model-option-${ACCOUNT_DEFAULT_MODEL}`)).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('follows the host: a different host preselects ITS last-used model', () => {
    reportHost('d1', { defaultModel: 'claude-haiku-4-5' });
    renderNewChat();
    fireEvent.click(screen.getByTestId('new-chat-model'));
    expect(screen.getByTestId('model-option-claude-haiku-4-5')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId(`model-option-${ACCOUNT_DEFAULT_MODEL}`)).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('spawns with NO model when the user never picked one', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ chatId: 'c-lu', folder: '~/x', status: 'pending' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const send = vi.fn();
    renderNewChat({ send } as unknown as PatchWs);
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    fireEvent.change(screen.getByTestId('new-chat-folder'), { target: { value: '~/x' } });
    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'hello' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(screen.getByTestId('navigated')).toBeInTheDocument());
    const call = fetchMock.mock.calls.find(
      (c) => String(c[0]).endsWith('/api/chats') && c[1]?.method === 'POST',
    )!;
    const body = JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
    // The machine resolves it (spec/03 § chat.spawn_request). Sending the
    // surface's idea of a default here is what clobbered the host's value.
    expect('model' in body).toBe(false);
    expect(body['daemonId']).toBe('d1');
    expect(localStorage.getItem('patch.model.lastUsed')).toBeNull();
  });

  it('sends the model ONLY when the user explicitly picks one', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ chatId: 'c-lu2', folder: '~/x', status: 'pending' }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const send = vi.fn();
    renderNewChat({ send } as unknown as PatchWs);
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    fireEvent.change(screen.getByTestId('new-chat-folder'), { target: { value: '~/x' } });
    const target = MODEL_OPTIONS[MODEL_OPTIONS.length - 1]!.id;
    fireEvent.click(screen.getByTestId('new-chat-model'));
    fireEvent.click(screen.getByTestId(`model-option-${target}`));
    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'hello' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(screen.getByTestId('navigated')).toBeInTheDocument());
    const call = fetchMock.mock.calls.find(
      (c) => String(c[0]).endsWith('/api/chats') && c[1]?.method === 'POST',
    )!;
    const body = JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body['model']).toBe(target);
    // Still nothing persisted browser-side: last-used lives on the machine.
    expect(localStorage.getItem('patch.model.lastUsed')).toBeNull();
  });
});

// Todo "model selector is native, but folder selector is custom styled": the two
// controls sit side by side in the new-chat setup row, so a native <select> next
// to a custom folder pill reads as two different apps. The model control is the
// SAME pill + pop-up shape as the folder picker (spec/14 § Model selector).
describe('/chats/new model picker treatment', () => {
  beforeEach(() => {
    seedModelCatalog();
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    localStorage.removeItem('patch.drafts.v1');
    localStorage.removeItem('patch.newChat.last.v1');
    useDraftStore.setState({ drafts: {}, order: [] });
    usePresenceStore.getState().setHostOnline('d1', true);
    reportHost('d1', { defaultModel: ACCOUNT_DEFAULT_MODEL });
  });

  function renderNewChat(): void {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('is a custom pill button, not a native <select>', () => {
    renderNewChat();
    const model = screen.getByTestId('new-chat-model');
    expect(model.tagName).toBe('BUTTON');
    expect(screen.getByTestId('new-chat-setup').querySelector('select')).toBeNull();
    // Same shape as the folder pill: a label + a caret, opening a listbox.
    expect(model).toHaveAttribute('aria-haspopup', 'listbox');
    expect(model.classList.contains('model-pill')).toBe(true);
    expect(model.querySelector('.model-pill-label')).not.toBeNull();
    expect(model.querySelector('.model-pill-caret')).not.toBeNull();
    const pill = screen.getByTestId('new-chat-folder-pill');
    expect(pill.querySelector('.folder-pill-label')).not.toBeNull();
    expect(pill.querySelector('.folder-pill-caret')).not.toBeNull();
  });

  it('shows the current model label on the pill and toggles its pop-up', () => {
    renderNewChat();
    const model = screen.getByTestId('new-chat-model');
    const current = MODEL_OPTIONS.find((m: ModelOption) => m.id === ACCOUNT_DEFAULT_MODEL)!;
    expect(model.querySelector('.model-pill-label')?.textContent).toBe(current.label);
    expect(screen.queryByTestId('model-popup')).not.toBeInTheDocument();
    expect(model).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(model);
    expect(screen.getByTestId('model-popup')).toBeInTheDocument();
    expect(model).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(model);
    expect(screen.queryByTestId('model-popup')).not.toBeInTheDocument();
  });

  it('selects a model from the pop-up, updates the pill and closes', () => {
    renderNewChat();
    const target = MODEL_OPTIONS[MODEL_OPTIONS.length - 1]!;
    fireEvent.click(screen.getByTestId('new-chat-model'));
    fireEvent.click(screen.getByTestId(`model-option-${target.id}`));
    expect(screen.queryByTestId('model-popup')).not.toBeInTheDocument();
    expect(
      screen.getByTestId('new-chat-model').querySelector('.model-pill-label')?.textContent,
    ).toBe(target.label);
  });

  // The picker used to append the host's code to its own copy
  // ("Couldn’t load models — upstream"), which names the fault to a program and
  // nothing to a person. It now says one sentence and keeps the code one click
  // down (spec/14 § Model selector).
  it('states a catalogue failure in plain English, with the raw code only in Details', () => {
    renderNewChat();
    act(() => setModelCatalog({ status: 'error', models: [], error: 'upstream' }));
    fireEvent.click(screen.getByTestId('new-chat-model'));
    const box = screen.getByTestId('model-popup-error');
    expect(box.querySelector('span')?.textContent).toBe(
      'Couldn’t load the model list for that machine. Try again in a moment.',
    );
    expect(box.querySelector('span')?.textContent).not.toContain('upstream');
    // Kept — collapsed by default, so it is not in anyone's face.
    const details = screen.getByTestId('model-popup-error-detail') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByTestId('model-popup-error-detail-text')).toHaveTextContent('upstream');
  });

  it('turns a known catalogue code into its own sentence, code still kept', () => {
    renderNewChat();
    act(() => setModelCatalog({ status: 'error', models: [], error: 'oauth_unavailable' }));
    fireEvent.click(screen.getByTestId('new-chat-model'));
    const box = screen.getByTestId('model-popup-error');
    expect(box.querySelector('span')?.textContent).toBe(
      'That machine isn’t signed in to Claude. Sign in from Settings → Hosts.',
    );
    expect(screen.getByTestId('model-popup-error-detail-text')).toHaveTextContent(
      'oauth_unavailable',
    );
  });

  it('opens only one pop-up at a time (model closes folder and vice versa)', () => {
    renderNewChat();
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    expect(screen.getByTestId('folder-popup')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('new-chat-model'));
    expect(screen.queryByTestId('folder-popup')).not.toBeInTheDocument();
    expect(screen.getByTestId('model-popup')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('new-chat-folder-pill'));
    expect(screen.queryByTestId('model-popup')).not.toBeInTheDocument();
    expect(screen.getByTestId('folder-popup')).toBeInTheDocument();
  });
});

// The screen you are on when the folder does NOT exist on the host — which is
// exactly when you need a shell to go clone it. The terminal must be reachable
// here, without a folder selected.
describe('/chats/new terminal', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    localStorage.removeItem('patch.drafts.v1');
    localStorage.removeItem('patch.newChat.last.v1');
    useDraftStore.setState({ drafts: {}, order: [] });
  });

  it('offers a terminal with no folder chosen', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('terminal-tab-terminal')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('terminal-tab-terminal'));
    expect(screen.getByTestId('terminal-pane')).toBeInTheDocument();
  });
});

// Todoist 6hhj229445J7cG36: a new chat opens on what the last NEW chat used —
// not on whichever chat was most recently active, and never moving afterwards.
describe('/chats/new — opens on the last new chat', () => {
  beforeEach(() => {
    seedModelCatalog();
    clearHosts();
    localStorage.removeItem('patch.newChat.last.v1');
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    reportHost('d1', { defaultModel: ACCOUNT_DEFAULT_MODEL });
    useDraftStore.setState({ drafts: {}, order: [] });
  });

  function renderNewChat(): void {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/chats/new']}>
          <Routes>
            <Route path="/chats/new" element={<NewChatRoute ws={null} />} />
            <Route path="/chats/:chatId" element={<div data-testid="navigated" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }
  const pillLabel = (): string | null =>
    (screen.getByTestId('new-chat-folder-pill').querySelector('.folder-pill-label') as HTMLElement)
      .textContent;

  it('uses the recorded folder over a newer chat, and ignores chats changing afterwards', () => {
    saveLastNewChat({ daemonId: 'd1', folder: '/home/tom/projects/mine', model: null });
    useChatStore.setState({
      chats: { n: makeRow('n', '/home/tom/projects/newer', 900, 'd1') },
    });
    renderNewChat();
    expect(pillLabel()).toBe('mine');
    act(() => {
      useChatStore.setState({
        chats: {
          n: makeRow('n', '/home/tom/projects/newer', 900, 'd1'),
          h: makeRow('h', '/home/tom/projects/hidden', 5000, 'd1'),
        },
      });
    });
    expect(pillLabel()).toBe('mine');
  });

  it('records the folder and model when a new chat is created, and nothing before', async () => {
    useChatStore.setState({ chats: { m: makeRow('m', '/home/tom/projects/one', 900, 'd1') } });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ chatId: 'c1', folder: '/home/tom/projects/one' }), {
            status: 202,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    renderNewChat();
    expect(loadLastNewChat()).toBeNull();
    const composer = screen.getByTestId('composer-input');
    fireEvent.change(composer, { target: { value: 'hi' } });
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true });
    await waitFor(() => expect(screen.getByTestId('navigated')).toBeInTheDocument());
    expect(loadLastNewChat()).toEqual({
      daemonId: 'd1',
      folder: '/home/tom/projects/one',
      model: null,
    });
  });
});
