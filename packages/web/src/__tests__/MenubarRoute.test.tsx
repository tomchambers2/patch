// Menu-bar tray popover (G4): Manager row + recents + Manager input.
// Deliberately stripped — NO connection-state header / "Open patch" link.
// The Manager input fires a chat.input turn into Manager; mic opens the
// voice-note overlay (spec/14 ## Menu bar surface).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SPECIAL_THREAD_IDS } from '@patch/wire';
import { MenubarRoute } from '../routes/MenubarRoute.js';
import { useChatStore } from '../stores/chatStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { setActiveWs } from '../api/ws.js';
import type { PatchWs } from '../api/ws.js';
import { __setAudioOpenerForTests } from '../lib/voiceController.js';
import type { AudioSession } from '../lib/audioSession.js';

/** A no-op audio session so the controller can be driven without a real WSS. */
function stubSession(chatId: string): AudioSession {
  return {
    sessionId: 'sess-stub',
    chatId,
    setMuted() {},
    setSessionMode() {},
    speak() {},
    sendPcm() {},
    isMuted() {
      return false;
    },
    end() {},
  };
}

const MGR = SPECIAL_THREAD_IDS.manager;

function seedChats(): void {
  useChatStore.getState().hydrate([
    {
      chatId: MGR,
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'Manager',
      folder: 'manager',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 100,
    },
    {
      chatId: 'c-bed',
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'fix layout bug',
      folder: 'bed-planner',
      activity: 'running',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 90,
    },
    {
      chatId: 'c-port',
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: 'manifest write',
      folder: 'portfolio',
      activity: 'awaiting-permission',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 80,
    },
  ]);
}

function renderMenubar() {
  return render(
    <MemoryRouter>
      <MenubarRoute />
    </MemoryRouter>,
  );
}

describe('MenubarRoute', () => {
  beforeEach(() => {
    seedChats();
    useVoiceStore.setState({ note: null, call: null });
    __setAudioOpenerForTests(async (opts) => stubSession(opts.chatId));
  });
  afterEach(() => {
    setActiveWs(null);
    __setAudioOpenerForTests(null);
    vi.restoreAllMocks();
  });

  it('is deliberately stripped — no connection-state header or "Open patch" link', () => {
    renderMenubar();
    expect(screen.queryByTestId('menubar-head')).toBeNull();
    expect(screen.queryByText(/open patch/i)).toBeNull();
    expect(screen.queryByText(/reconnect/i)).toBeNull();
  });

  it('shows the Manager row with phone + mic affordances', () => {
    renderMenubar();
    expect(screen.getByTestId('menubar-manager-row')).toHaveTextContent('Manager');
    expect(screen.getByTestId('menubar-manager-call')).toBeInTheDocument();
    expect(screen.getByTestId('menubar-manager-mic')).toBeInTheDocument();
  });

  it('lists recent chats (excluding Manager) with a mic-btn each', () => {
    renderMenubar();
    expect(screen.getByTestId('menubar-row-c-bed')).toBeInTheDocument();
    expect(screen.getByTestId('menubar-row-c-port')).toBeInTheDocument();
    // Manager is not duplicated in the recents list.
    expect(screen.queryByTestId(`menubar-row-${MGR}`)).toBeNull();
    expect(screen.getByTestId('menubar-mic-c-bed')).toBeInTheDocument();
  });

  it('renders each recent row with name, folder preview and relative time', () => {
    renderMenubar();
    const row = screen.getByTestId('menubar-row-c-bed');
    // Spec/14 menu-bar: status badge, name, folder + one-line preview, relative
    // time, hover-revealed mic-btn. (A CSS grid-collision bug previously
    // squashed the name/preview/time to zero width — guard the content here.)
    expect(row.querySelector('.menubar-name')?.textContent).toBe('fix layout bug');
    expect(row.querySelector('.menubar-preview')?.textContent).toBe('bed-planner');
    expect(row.querySelector('.menubar-when')?.textContent).toBeTruthy();
    expect(row.querySelector('.menubar-status')).toBeTruthy();
    // The recent row carries BOTH classes; the layout must resolve to the flex
    // override (.menubar-row.menubar-recent), not the .menubar-row grid.
    expect(row.classList.contains('menubar-row')).toBe(true);
    expect(row.classList.contains('menubar-recent')).toBe(true);
  });

  it('fires the typed text as a chat.input user turn into Manager on Enter', () => {
    const send = vi.fn();
    setActiveWs({ send } as unknown as PatchWs);
    renderMenubar();
    const input = screen.getByTestId('menubar-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'remind me about the bins' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]![0] as { type: string; chatId: string; message: string };
    expect(sent.type).toBe('chat.input');
    expect(sent.chatId).toBe(MGR);
    expect(sent.message).toBe('remind me about the bins');
    // Input clears after sending.
    expect(input.value).toBe('');
  });

  it('the Manager mic opens the voice-note overlay targeting Manager', () => {
    setActiveWs({ send: vi.fn() } as unknown as PatchWs);
    renderMenubar();
    fireEvent.click(screen.getByTestId('menubar-manager-mic'));
    // The voice note is created synchronously (the async audio session opens
    // afterwards); the overlay targets Manager.
    expect(useVoiceStore.getState().note?.chatId).toBe(MGR);
  });

  it('the Manager phone navigates to the full app + stashes the auto-call intent', () => {
    // The /menubar bare route has no overlay mounted, so (in the browser) the
    // phone control navigates the full app to Manager and stashes an auto-call
    // intent that AppShell consumes on mount (spec/07 ## Overlay surfaces).
    setActiveWs({ send: vi.fn() } as unknown as PatchWs);
    const assign = vi.fn();
    const origLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...origLocation, assign, origin: 'http://localhost', pathname: '/app/menubar' },
    });
    sessionStorage.clear();
    try {
      renderMenubar();
      fireEvent.click(screen.getByTestId('menubar-manager-call'));
      expect(sessionStorage.getItem('patch:auto-call-chat')).toBe(MGR);
      expect(assign).toHaveBeenCalledWith(`http://localhost/app/chats/${MGR}`);
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: origLocation,
      });
      sessionStorage.clear();
    }
  });

  it('the Manager phone uses the desktop bridge startVoiceCall when present, without navigating', () => {
    const startVoiceCall = vi.fn();
    (window as unknown as { patch?: unknown }).patch = { startVoiceCall };
    const origLocation = window.location;
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...origLocation, assign, origin: 'http://localhost', pathname: '/app/menubar' },
    });
    try {
      renderMenubar();
      fireEvent.click(screen.getByTestId('menubar-manager-call'));
      expect(startVoiceCall).toHaveBeenCalledWith('manager');
      expect(assign).not.toHaveBeenCalled();
    } finally {
      delete (window as unknown as { patch?: unknown }).patch;
      Object.defineProperty(window, 'location', { configurable: true, value: origLocation });
    }
  });

  it('the Manager phone still navigates when sessionStorage.setItem throws (best-effort)', () => {
    const origLocation = window.location;
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...origLocation, assign, origin: 'http://localhost', pathname: '/app/menubar' },
    });
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded');
    });
    try {
      renderMenubar();
      expect(() => fireEvent.click(screen.getByTestId('menubar-manager-call'))).not.toThrow();
      expect(assign).toHaveBeenCalledWith(`http://localhost/app/chats/${MGR}`);
    } finally {
      setItemSpy.mockRestore();
      Object.defineProperty(window, 'location', { configurable: true, value: origLocation });
    }
  });

  it('launchFullApp uses the desktop bridge openChat when present', () => {
    const openChat = vi.fn();
    (window as unknown as { patch?: unknown }).patch = { openChat };
    const origLocation = window.location;
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...origLocation, assign, origin: 'http://localhost', pathname: '/app/menubar' },
    });
    try {
      renderMenubar();
      fireEvent.click(screen.getByTestId('menubar-manager-row'));
      expect(openChat).toHaveBeenCalledWith(MGR);
      expect(assign).not.toHaveBeenCalled();
    } finally {
      delete (window as unknown as { patch?: unknown }).patch;
      Object.defineProperty(window, 'location', { configurable: true, value: origLocation });
    }
  });

  it('launchFullApp falls back to window.location.assign for the SPA route in the browser', () => {
    const origLocation = window.location;
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...origLocation, assign, origin: 'http://localhost', pathname: '/app/menubar' },
    });
    try {
      renderMenubar();
      fireEvent.click(screen.getByTestId('menubar-row-c-bed').querySelector('.menubar-row-open')!);
      expect(assign).toHaveBeenCalledWith('http://localhost/app/chats/c-bed');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: origLocation });
    }
  });

  it('baseAppPath falls back to "/app/" when the pathname does not end in "menubar"', () => {
    const origLocation = window.location;
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...origLocation, assign, origin: 'http://localhost', pathname: '/something-else' },
    });
    try {
      renderMenubar();
      fireEvent.click(screen.getByTestId('menubar-row-c-bed').querySelector('.menubar-row-open')!);
      expect(assign).toHaveBeenCalledWith('http://localhost/app/chats/c-bed');
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: origLocation });
    }
  });

  it('a recent row mic starts a voice note targeting that chat', () => {
    setActiveWs({ send: vi.fn() } as unknown as PatchWs);
    renderMenubar();
    fireEvent.click(screen.getByTestId('menubar-mic-c-bed'));
    expect(useVoiceStore.getState().note?.chatId).toBe('c-bed');
  });

  it('excludes archived chats from the recents list and shows at most 5, sorted by recency', () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      chatId: `extra-${i}`,
      daemonId: 'd1',
      permissionMode: 'bypassPermissions' as const,
      name: `chat ${i}`,
      folder: 'f',
      activity: 'idle' as const,
      status: 'active' as const,
      pinned: false,
      pinnedAt: null,
      disabled: false,
      lastUpdated: 1000 + i,
    }));
    useChatStore.getState().hydrate([
      ...rows,
      {
        chatId: 'archived-1',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'old',
        folder: 'f',
        activity: 'idle',
        status: 'archived',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 9999,
      },
    ]);
    renderMenubar();
    expect(screen.queryByTestId('menubar-row-archived-1')).toBeNull();
    // Only the 5 most recent extras show (highest lastUpdated first).
    expect(screen.getByTestId('menubar-row-extra-6')).toBeInTheDocument();
    expect(screen.getByTestId('menubar-row-extra-2')).toBeInTheDocument();
    expect(screen.queryByTestId('menubar-row-extra-1')).toBeNull();
    expect(screen.queryByTestId('menubar-row-extra-0')).toBeNull();
  });

  it('renders an "Untitled" name fallback and the working/permission status classes', () => {
    // mergeChats (not hydrate) — hydrate REPLACES the whole roster, and the
    // beforeEach's seedChats() rows (c-bed/c-port) are needed below too.
    useChatStore.getState().mergeChats([
      {
        chatId: 'c-unnamed',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: null,
        folder: 'f',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: 500,
      },
    ]);
    renderMenubar();
    const row = screen.getByTestId('menubar-row-c-unnamed');
    expect(row.querySelector('.menubar-name')?.textContent).toBe('New chat');
    expect(row.querySelector('.menubar-status')?.className).not.toContain('working');
    expect(row.querySelector('.menubar-status')?.className).not.toContain('permission');
    // Seeded fixtures already cover "running" (working) and "awaiting-permission".
    expect(
      screen.getByTestId('menubar-row-c-bed').querySelector('.menubar-status')?.className,
    ).toContain('working');
    expect(
      screen.getByTestId('menubar-row-c-port').querySelector('.menubar-status')?.className,
    ).toContain('permission');
  });

  it('relativeTime: now/minutes/hours/days buckets', () => {
    const now = Date.now();
    useChatStore.getState().hydrate([
      {
        chatId: 'r-now',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'a',
        folder: 'f',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: now - 1000,
      },
      {
        chatId: 'r-min',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'b',
        folder: 'f',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: now - 5 * 60_000,
      },
      {
        chatId: 'r-hr',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'c',
        folder: 'f',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: now - 5 * 3_600_000,
      },
      {
        chatId: 'r-day',
        daemonId: 'd1',
        permissionMode: 'bypassPermissions' as const,
        name: 'd',
        folder: 'f',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        disabled: false,
        lastUpdated: now - 2 * 86_400_000,
      },
    ]);
    renderMenubar();
    expect(
      screen.getByTestId('menubar-row-r-now').querySelector('.menubar-when')?.textContent,
    ).toBe('now');
    expect(
      screen.getByTestId('menubar-row-r-min').querySelector('.menubar-when')?.textContent,
    ).toMatch(/^\d+m$/);
    expect(
      screen.getByTestId('menubar-row-r-hr').querySelector('.menubar-when')?.textContent,
    ).toMatch(/^\d+h$/);
    expect(
      screen.getByTestId('menubar-row-r-day').querySelector('.menubar-when')?.textContent,
    ).toMatch(/^\d+d$/);
  });

  it('Shift+Enter does not send; Enter with only whitespace does not send', () => {
    const send = vi.fn();
    setActiveWs({ send } as unknown as PatchWs);
    renderMenubar();
    const input = screen.getByTestId('menubar-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'line' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(send).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(send).not.toHaveBeenCalled();
  });

  it('the send button also fires sendToManager', () => {
    const send = vi.fn();
    setActiveWs({ send } as unknown as PatchWs);
    renderMenubar();
    fireEvent.change(screen.getByTestId('menubar-input'), { target: { value: 'via button' } });
    fireEvent.click(screen.getByTestId('menubar-send'));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('pushes an error toast when there is no active WS connection', () => {
    setActiveWs(null);
    useUiStore.getState().clearToasts();
    renderMenubar();
    fireEvent.change(screen.getByTestId('menubar-input'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('menubar-send'));
    expect(useUiStore.getState().errors[0]?.message).toBe('not connected to the server');
  });

  it('pushes an error toast when ws.send throws', () => {
    setActiveWs({
      send: () => {
        throw new Error('socket closed');
      },
    } as unknown as PatchWs);
    useUiStore.getState().clearToasts();
    renderMenubar();
    fireEvent.change(screen.getByTestId('menubar-input'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByTestId('menubar-send'));
    expect(useUiStore.getState().errors[0]?.message).toContain('Send failed');
  });

  describe('menubar-visibility bridge', () => {
    afterEach(() => {
      delete (window as unknown as { patch?: unknown }).patch;
      cleanup();
    });

    it('does nothing when the bridge has no onMenubarVisibility', () => {
      (window as unknown as { patch?: unknown }).patch = {};
      expect(() => renderMenubar()).not.toThrow();
    });

    it('wires foreground()/background() to the active ws based on visibility, and no-ops with no active ws', () => {
      let captured: ((e: { visible: boolean }) => void) | undefined;
      const unsubscribe = vi.fn();
      (window as unknown as { patch?: unknown }).patch = {
        onMenubarVisibility: (cb: (e: { visible: boolean }) => void) => {
          captured = cb;
          return unsubscribe;
        },
      };
      // No active ws yet — must not throw.
      setActiveWs(null);
      const { unmount } = renderMenubar();
      expect(() => captured!({ visible: true })).not.toThrow();

      const foreground = vi.fn();
      const background = vi.fn();
      setActiveWs({ foreground, background } as unknown as PatchWs);
      captured!({ visible: true });
      expect(foreground).toHaveBeenCalledTimes(1);
      captured!({ visible: false });
      expect(background).toHaveBeenCalledTimes(1);

      unmount();
      expect(unsubscribe).toHaveBeenCalled();
    });
  });
});
