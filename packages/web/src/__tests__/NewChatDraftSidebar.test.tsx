// spec/14 § New chat drafts — the two halves of drafts, together.
//
// A new chat you typed into and did not send survives leaving the screen, and
// is listed in the sidebar's Drafts section so you can get back to it. A new
// chat with NO message is not something the user kept: never typed in, or
// typed into and then emptied again (whitespace included) are the same thing,
// so it is never listed and it is collected rather than carried around.
//
// The two pull against each other — "remember what was typed" vs "an emptied
// draft is not a draft" — so they are proved in the same file, against the real
// sidebar rather than the store alone.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NewChatRoute } from '../routes/NewChatRoute.js';
import { Sidebar } from '../components/Sidebar.js';
import { useChatStore } from '../stores/chatStore.js';
import { useDraftStore } from '../stores/draftStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { setModelCatalog, resetModelCatalog } from '../lib/models.js';
import { newChatPath } from '../lib/newChat.js';
import { reportHost, clearHosts } from './presenceHelpers.js';

function renderNewChat(entry = '/chats/new') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route
            path="/chats/new"
            element={
              <>
                <Sidebar />
                <NewChatRoute ws={null} />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The ids the store currently holds, in display order. */
function draftIds(): string[] {
  return useDraftStore.getState().order;
}

describe('new-chat drafts in the sidebar', () => {
  beforeEach(() => {
    resetModelCatalog();
    setModelCatalog({ status: 'ready', models: [{ id: 'claude-opus-5', label: 'Claude Opus 5' }] });
    clearHosts();
    useChatStore.getState()._reset();
    useUiStore.getState().clearToasts();
    usePresenceStore.getState().setConnection('connected');
    usePresenceStore.getState().setHostOnline('d1', true);
    reportHost('d1', { defaultModel: 'claude-opus-5' });
    // The draft store is module-level and outlives a render, and its blob is
    // shared by every test in this file — clear both.
    window.localStorage.clear();
    for (const id of [...useDraftStore.getState().order]) useDraftStore.getState().remove(id);
  });
  afterEach(() => {
    cleanup();
  });

  it('lists a draft once it has text', () => {
    renderNewChat();
    expect(screen.queryByTestId('drafts-section')).toBeNull();

    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: 'something worth keeping' },
    });

    const section = screen.getByTestId('drafts-section');
    expect(section).toBeInTheDocument();
    // The row's title IS the text, so the draft is identifiable at a glance.
    expect(section.textContent).toContain('something worth keeping');
  });

  it('typed then deleted is NOT a draft — the row goes with the text', () => {
    renderNewChat();
    const input = screen.getByTestId('composer-input');

    fireEvent.change(input, { target: { value: 'never mind' } });
    expect(screen.getByTestId('drafts-section')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '' } });
    expect(screen.queryByTestId('drafts-section')).toBeNull();
  });

  it('whitespace-only is NOT a draft — it never gets a row', () => {
    renderNewChat();
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: '    \n ' } });
    expect(screen.queryByTestId('drafts-section')).toBeNull();
  });

  it('an emptied new chat is collected, not carried, when the next one starts', () => {
    renderNewChat();
    const input = screen.getByTestId('composer-input');
    fireEvent.change(input, { target: { value: 'typed' } });
    fireEvent.change(input, { target: { value: '   ' } });
    const emptied = draftIds();
    expect(emptied).toHaveLength(1);

    // What the `+ New chat` button (and the header's New chat icon) does.
    newChatPath();

    expect(draftIds()).toHaveLength(1);
    expect(draftIds()).not.toContain(emptied[0]);
  });

  it('a draft WITH text survives starting another new chat', () => {
    renderNewChat();
    fireEvent.change(screen.getByTestId('composer-input'), { target: { value: 'keep me' } });
    const kept = draftIds()[0]!;

    newChatPath();

    expect(draftIds()).toContain(kept);
    expect(useDraftStore.getState().drafts[kept]!.text).toBe('keep me');
  });

  it('reopening a draft restores its unsent text', () => {
    renderNewChat();
    fireEvent.change(screen.getByTestId('composer-input'), {
      target: { value: 'half a thought' },
    });
    const id = draftIds()[0]!;
    cleanup();

    // Coming back to it — the sidebar row's link, and what a reload lands on.
    renderNewChat(`/chats/new?draft=${id}`);
    expect(screen.getByTestId('composer-input')).toHaveValue('half a thought');
  });

  it('opening a new chat collects blank drafts left behind earlier', () => {
    const stale = useDraftStore.getState().create();
    useDraftStore.getState().update(stale, { text: '   ' });
    expect(draftIds()).toContain(stale);

    renderNewChat();

    expect(draftIds()).not.toContain(stale);
    expect(screen.queryByTestId('drafts-section')).toBeNull();
  });

  it('opening a new chat leaves a real draft from earlier alone', () => {
    const real = useDraftStore.getState().create();
    useDraftStore.getState().update(real, { text: 'from yesterday' });

    renderNewChat();

    expect(draftIds()).toContain(real);
    expect(screen.getByTestId(`draft-row-${real}`)).toBeInTheDocument();
  });
});
