// Sidebar tooltip copy — spec/14 § Copy: a tooltip is a short name of a few
// words, in sentence case, never a sentence explaining the control, and a
// control's accessible label never disagrees with it in case or wording.
//
// The sidebar's row tools had drifted into two houses of style — "Archive this
// project" and "Clear selection" beside "unsnooze", "restore", "discard draft".
// This file pins the resolved case so it can't drift back one control at a time.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar.js';
import { ConfirmModal } from '../components/ConfirmModal.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { useSelectionStore } from '../stores/selectionStore.js';
import { api } from '../api/rest.js';
import type { ChatRow } from '../stores/types.js';

function rowFixture(overrides: Partial<ChatRow> = {}): ChatRow {
  return {
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
    ...overrides,
  } as ChatRow;
}

function renderInRouter(): void {
  render(
    <MemoryRouter>
      <Sidebar />
      <ConfirmModal />
    </MemoryRouter>,
  );
}

/** Sentence case: an initial capital, and no trailing explainer clause. */
function expectSentenceCase(el: HTMLElement, expected: string): void {
  const title = el.getAttribute('title');
  expect(title).toBe(expected);
  expect(title?.[0]).toBe(title?.[0]?.toUpperCase());
  expect(title).not.toContain('—');
}

describe('Sidebar — tooltip copy', () => {
  beforeEach(() => {
    // Sidebar tests share one jsdom window (and its localStorage) across the
    // whole file, so a stale read watermark from a neighbouring test can decide
    // which rows draw. Start each test from a clean one.
    window.localStorage.clear();
    useChatStore.getState()._reset();
    usePresenceStore.getState().setConnection('connected');
    useVoiceStore.setState({ activeDevices: {} });
    useUiStore.getState().setChannelsOpen(false);
    useUiStore.getState().setArchivedOpen(false);
    useUiStore.getState().setDeletedOpen(false);
    useUiStore.getState().setAttentionOnly(false);
    useUiStore.setState({ forgottenFolders: [], errors: [] });
    useUiStore.getState().setSearchQuery('');
    useUiStore.getState().resolveConfirm(false);
    useSelectionStore.setState({ order: [], anchor: null, selected: [] });
    vi.spyOn(api, 'listChatsArchived').mockResolvedValue({ chats: [], nextOffset: null });
    vi.spyOn(api, 'listChatsDeleted').mockResolvedValue({ chats: [], nextOffset: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  });

  it('titles a row’s archive and pin tools in sentence case, matching their labels', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'r1' })]);
    renderInRouter();

    // The accessible label may name what is acted on where the tooltip's
    // context makes that redundant, but never disagrees on case (spec/14 § Copy).
    const archive = screen.getByTestId('archive-btn-r1');
    expectSentenceCase(archive, 'Archive');
    expect(archive).toHaveAttribute('aria-label', 'Archive chat');

    const pin = screen.getByTestId('pin-btn-r1');
    expectSentenceCase(pin, 'Pin');
    expect(pin).toHaveAttribute('aria-label', 'Pin chat');
  });

  it('flips to the sentence-case inverse for an archived / pinned row', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'r2', pinned: true, pinnedAt: 1 })]);
    renderInRouter();
    expectSentenceCase(screen.getByTestId('pin-btn-r2'), 'Unpin');
  });

  it('titles the Deleted section’s restore tool "Restore"', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'd1', status: 'deleted' })]);
    renderInRouter();
    fireEvent.click(screen.getByTestId('deleted-toggle'));

    const restore = screen.getByTestId('restore-btn-d1');
    expectSentenceCase(restore, 'Restore');
    expect(restore).toHaveAttribute('aria-label', 'Restore chat');
  });

  it('titles the selection bar’s controls in sentence case, label matching title', () => {
    useChatStore
      .getState()
      .hydrate([
        rowFixture({ chatId: 'r1', lastUpdated: 200 }),
        rowFixture({ chatId: 'r2', lastUpdated: 100 }),
      ]);
    renderInRouter();
    fireEvent.click(screen.getByTestId('chat-row-r1'), { button: 0 });
    fireEvent.click(screen.getByTestId('chat-row-r2'), { shiftKey: true, button: 0 });

    expectSentenceCase(screen.getByTestId('selection-archive'), 'Archive selected');
    expectSentenceCase(screen.getByTestId('selection-delete'), 'Delete selected');

    const clear = screen.getByTestId('selection-clear');
    expectSentenceCase(clear, 'Clear selection');
    expect(clear).toHaveAttribute('aria-label', 'Clear selection');
  });

  // The mic tooltips were instructions ("Hold to record a voice note"), which
  // teach the gesture rather than name the control (spec/14 § Copy). The
  // Manager row's mic reads the same name as an ordinary row's — spec/14 §
  // Manager's redesign dropped the "Talk" wide-pill variant for a plain icon
  // button, same name and behaviour as everywhere else.
  it('names the row mic the same way everywhere, Manager included', () => {
    useChatStore
      .getState()
      .hydrate([
        rowFixture({ chatId: 'thread_manager', name: 'manager' }),
        rowFixture({ chatId: 'r1' }),
      ]);
    renderInRouter();
    expectSentenceCase(screen.getByTestId('row-mic-thread_manager'), 'Voice note');
    expectSentenceCase(screen.getByTestId('row-mic-r1'), 'Voice note');
  });

  // The Manager row's Call control names itself the same way the composer's
  // own Call button does (Composer.tsx `call-btn`).
  it('names the Manager call control "Call"', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'thread_manager', name: 'manager' })]);
    renderInRouter();
    expectSentenceCase(screen.getByTestId('row-call'), 'Call');
  });

  // "Working — stays open and quiet until it has something to say" described
  // the session mode instead of naming the button; it is a Hands-free session
  // (spec/07 § Session modes), the same name mobile's own button uses.
  it('names the Manager hands-free control "Hands-free"', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'thread_manager', name: 'manager' })]);
    renderInRouter();
    expectSentenceCase(screen.getByTestId('row-handsfree'), 'Hands-free');
  });

  // The two folder-header archive buttons are icon-only and adjacent, so each
  // needs a name — but "Archive all in this project (including pinned and
  // snoozed)" was a parenthetical spec note, not a name.
  it('names both folder archive tools without spelling out what each sweeps up', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'r1', folder: '/proj/x' })]);
    renderInRouter();
    expectSentenceCase(screen.getByTestId('folder-archive-/proj/x'), 'Archive listed');
    expectSentenceCase(screen.getByTestId('folder-archive-all-/proj/x'), 'Archive all');
  });

  // A control with a visible text label needs no tooltip at all (spec/14 §
  // Copy) — the sidebar view dropdown's trigger already names its own state.
  it('gives the labelled sidebar view trigger no tooltip', () => {
    useChatStore.getState().hydrate([rowFixture({ chatId: 'r1' })]);
    renderInRouter();
    const trigger = screen.getByTestId('sidebar-view-trigger');
    expect(trigger).toHaveTextContent('All chats');
    expect(trigger.getAttribute('title')).toBeNull();
  });

  // The Manager row's two-sentence explainer is gone: a row's only tooltip is
  // its own full title, which is the value the ellipsis would otherwise lose.
  it('gives the Manager row its own name as its tooltip, explainer and all gone', () => {
    useChatStore.getState().hydrate([]);
    renderInRouter();
    const empty = screen.getByTestId('manager-row-empty');
    expect(empty).toHaveAttribute('title', 'Manager');
    expect(empty.getAttribute('title')).not.toContain('meta-operator');
  });
});
