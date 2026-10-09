// The app's top row (Tom, App Updates: "move the <> buttons to the main page,
// left of top bar. patch in line with window controls. < has too much padding on
// right side. put green dot like a superscript next to patch. cluster external
// window and < closer.").
//
// Back / Forward lead the CHAT PANEL header (spec/14 § Chat panel header); the
// sidebar's brand row is the wordmark, its superscript connection dot and the
// two sidebar icons alone (§ Sidebar §1). Which element each control lives in is
// behaviour a jsdom render can settle; where they land on screen is measured in
// e2e/top-bar-chrome.spec.ts, and the spacing rules are locked against the
// stylesheet's source here (jsdom has no cascade — see scrollbarStyles.test.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar.js';
import { ChatHeader } from '../components/ChatHeader.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { api } from '../api/rest.js';
import type { ChatRow } from '../stores/types.js';

const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

function row(): ChatRow {
  return {
    pendingWake: null,
    todos: [],
    snoozedUntil: null,
    chatId: 'c1',
    daemonId: 'd1',
    permissionMode: 'bypassPermissions',
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
  };
}

describe('the sidebar brand row', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    useVoiceStore.setState({ activeDevices: {} });
    useUiStore.setState({ errors: [] });
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({ chats: [], nextOffset: null });
    vi.spyOn(api, 'listChatsDeleted').mockResolvedValue({ chats: [], nextOffset: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('no longer carries Back / Forward — they moved to the chat panel header', () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('sidebar')).toBeInTheDocument();
    expect(screen.queryByTestId('nav-history')).toBeNull();
  });

  it('seats the connection dot inside the wordmark lockup, not in the icon cluster', () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    const dot = screen.getByTestId('conn-dot');
    const lockup = dot.closest('.brand-lockup');
    expect(lockup).not.toBeNull();
    // Same lockup as the wordmark, and after it — a superscript sits on the
    // mark's trailing edge, not in front of it.
    expect(lockup!.querySelector('.brand-mark')?.textContent).toBe('patch');
    expect(dot.previousElementSibling?.className).toContain('brand-mark');
    // And out of the right-hand icon cluster, which is now the two buttons.
    expect(dot.closest('.sb-brand-right')).toBeNull();
  });

  it('still reports the connection state on the dot', () => {
    usePresenceStore.getState().setConnection('reconnecting');
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    const dot = screen.getByTestId('conn-dot');
    expect(dot.className).toContain('offline');
    expect(dot.getAttribute('aria-label')).toBe('connection: reconnecting');
  });
});

describe('the chat panel header', () => {
  beforeEach(() => {
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
  });
  afterEach(cleanup);

  it('leads with Back / Forward alone in the left zone; the title zone has no second line', () => {
    render(
      <MemoryRouter initialEntries={['/chats/c1']}>
        <Routes>
          <Route path="*" element={<ChatHeader row={row()} />} />
        </Routes>
      </MemoryRouter>,
    );
    const nav = screen.getByTestId('nav-history');
    const left = nav.closest('.chat-head-left');
    expect(left).not.toBeNull();
    // The zone carries only the nav controls: a fourth flex child (the crumb,
    // previously) would drag the centred chat name off centre by its own
    // half-width (spec/14 § Chat panel header).
    expect(left!.firstElementChild).toBe(nav);
    expect(left!.querySelector('.chat-head-crumb')).toBeNull();
    // And no folder/host line or usage bar sits under the title any more.
    const title = screen.getByTestId('chat-head').querySelector('.chat-head-title');
    expect(title!.querySelector('.chat-head-crumb')).toBeNull();
    expect(title!.querySelector('.chat-head-subline')).toBeNull();
    // Both controls are real buttons, so the header is walkable by keyboard.
    expect(screen.getByTestId('nav-back').tagName).toBe('BUTTON');
    expect(screen.getByTestId('nav-forward').tagName).toBe('BUTTON');
  });
});

describe('the top row stylesheet', () => {
  it('records the centre-line the desktop shell pins its window controls to', () => {
    // Mirrored by TRAFFIC_LIGHT_POSITION in packages/desktop/src/window-chrome.ts,
    // whose own test reads this file back — that is the guard on the pair.
    expect(css).toMatch(/--overlay-titlebar-lights-centre:\s*\d+px;/);
  });

  it('pads the brand row on the right by the sidebar inset, not the left padding', () => {
    expect(css).toMatch(/\.sb-brand\s*\{[^}]*padding:\s*18px var\(--sb-inset\) 14px 20px;/);
  });

  it('clusters the two sidebar icons at the same pitch the nav pair uses', () => {
    const brandRight = /\.sb-brand-right\s*\{([^}]*)\}/.exec(css);
    const navHistory = /\.nav-history\s*\{([^}]*)\}/.exec(css);
    expect(brandRight).not.toBeNull();
    expect(navHistory).not.toBeNull();
    const gap = (block: string): string => /gap:\s*([^;]+);/.exec(block)?.[1] ?? '';
    expect(gap(brandRight![1]!)).toBe('1px');
    expect(gap(brandRight![1]!)).toBe(gap(navHistory![1]!));
  });

  it('gives the chat header left and action zones the flex share that keeps the name centred', () => {
    expect(css).toMatch(/\.chat-head-left\s*\{[^}]*flex:\s*1 1 0;/);
    // And the title zone  is the part that yields.
    expect(css).toMatch(/\.chat-head-title\s*\{[^\}]*min-width:\s*0;/);
  });

  it('punches the left zone out of the desktop drag region', () => {
    // An element inside a `-webkit-app-region: drag` region takes no clicks at
    // all, so Back / Forward would go dead in the Electron shell without this.
    expect(css).toMatch(/\.overlay-titlebar \.chat-head-left,/);
  });

  it('punches the banner Diagnose button out of the offline banner drag region', () => {
    // `.offline-banner` is a drag region on the desktop shell; a button inside
    // one takes no clicks, so Diagnose did nothing without this.
    expect(css).toMatch(
      /\.overlay-titlebar \.offline-banner,[^{]*\{[^}]*-webkit-app-region:\s*drag;/,
    );
    expect(css).toMatch(
      /\.overlay-titlebar \.banner-diagnose\s*\{[^}]*-webkit-app-region:\s*no-drag;/,
    );
  });

  it('reserves the traffic-light strip for the screenshot annotator toolbar too', () => {
    // The annotator is a full-viewport overlay portalled to <body> (§ Composer),
    // so its toolbar sits at the window's own top-left, same as the brand row —
    // without this it draws its leftmost tool button right under the lights.
    expect(css).toMatch(
      /\.overlay-titlebar \.annotator-toolbar\s*\{[^}]*padding-left:\s*var\(--overlay-titlebar-inset\);/,
    );
  });

  it('makes the Jobs / Settings / editor page head drag the window, with its controls punched out', () => {
    // A window opened onto one of these pages (Tom, Todoist: "patch cant move a
    // new window, cant drag it") has no title bar, and `.route-head` is its top
    // row — without a drag region there is nothing to grab.
    const drag =
      /\.overlay-titlebar \.route-head,\s*\.overlay-titlebar \.job-editor \.route-head\s*\{([^}]*)\}/.exec(
        css,
      );
    expect(drag).not.toBeNull();
    expect(drag![1]).toMatch(/-webkit-app-region:\s*drag;/);
    // And it clears the traffic lights, which otherwise sit on the nav arrows.
    expect(drag![1]).toMatch(/padding-left:\s*var\(--overlay-titlebar-inset\);/);
    const noDrag =
      /\.overlay-titlebar \.route-head ([^{]*)\{[^}]*-webkit-app-region:\s*no-drag;/.exec(css);
    expect(noDrag).not.toBeNull();
    for (const el of ['button', 'a', 'input', 'select']) expect(noDrag![1]).toContain(el);
  });
});
