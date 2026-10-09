// spec/14 § Pads — the web half: layout kinds, the Pads page, a Pad card in the
// transcript, a Pad open in a pane, New Pad, opening beside the chat, and the
// screen capture.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api, type PadView } from '../api/rest.js';
import { useChatStore } from '../stores/chatStore.js';
import { useLayoutStore, tabKey, isTabDescriptor } from '../stores/layoutStore.js';
import { usePadsStore } from '../stores/padsStore.js';
import { useUiStore } from '../stores/uiStore.js';
import { PadsPage } from '../components/PadsPage.js';
import { PadCard, padIdOfArtifact } from '../components/PadCard.js';
import { PadPane } from '../components/PadPane.js';
import { NewPadPage } from '../components/NewPadPage.js';
import { openPadBesideChat } from '../lib/openPad.js';
import { openArtifact } from '../lib/openArtifact.js';
import { captureDocument } from '../lib/padCapture.js';

const pad = (over: Partial<PadView> = {}): PadView => ({
  id: 'care',
  name: 'Care screens',
  app: 'Dog Log',
  chatId: 'c1',
  device: 'phone',
  createdAt: 1,
  updatedAt: Date.now(),
  pending: 0,
  working: false,
  screens: [{ id: 'home', name: 'Home', path: 'index.html', pending: 0, thumbUrl: null }],
  screensError: null,
  frameUrl: '/api/padx/care/sig/',
  thumbUrl: null,
  thumbError: null,
  ...over,
});

function wrap(ui: Parameters<typeof render>[0]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui as never}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useLayoutStore.getState()._reset();
  useChatStore.getState()._reset();
  usePadsStore.setState({ pads: null, error: null });
  useChatStore
    .getState()
    .applyEvent({ type: 'chat.spawned', daemonId: 'd1', chatId: 'c1', folder: '/x' } as never);
  useChatStore.getState().setName('c1', 'Puppy Care Logging');
});
afterEach(() => vi.restoreAllMocks());

describe('layout: Pad tabs', () => {
  it('keys a pad tab by its id and accepts only well-formed descriptors', () => {
    expect(tabKey({ kind: 'page', page: 'pad', padId: 'care' })).toBe('page:pad:care');
    expect(tabKey({ kind: 'page', page: 'pads' })).toBe('page:pads');
    expect(isTabDescriptor({ kind: 'page', page: 'pad', padId: 'care' })).toBe(true);
    expect(isTabDescriptor({ kind: 'page', page: 'pad' })).toBe(false);
    expect(isTabDescriptor({ kind: 'page', page: 'new-pad', chatId: 'c1' })).toBe(true);
    expect(isTabDescriptor({ kind: 'page', page: 'new-pad', chatId: 3 })).toBe(false);
    expect(isTabDescriptor({ kind: 'page', page: 'pads' })).toBe(true);
  });
});

describe('openPadBesideChat', () => {
  it('opens the chat if needed and puts the pad in its own pane to the left', () => {
    openPadBesideChat('care', 'c1');
    const { root } = useLayoutStore.getState();
    expect(root.type).toBe('split');
    if (root.type !== 'split') return;
    expect(root.direction).toBe('row');
    const [left, right] = root.children.map((c) => c.pane);
    expect(left?.type === 'leaf' && left.tabs[0]?.id).toBe('page:pad:care');
    expect(right?.type === 'leaf' && right.tabs[0]?.id).toBe('chat:c1');
  });
  it('focuses a pad that is already open instead of opening it twice', () => {
    openPadBesideChat('care', 'c1');
    openPadBesideChat('care', 'c1');
    const found = useLayoutStore.getState().findTab({ kind: 'page', page: 'pad', padId: 'care' });
    expect(found).not.toBeNull();
    const count = JSON.stringify(useLayoutStore.getState().root).split('page:pad:care').length - 1;
    // one tab id + one activeTabId reference — never a second tab
    expect(count).toBe(2);
  });
  it('is what a Pad card (a chat.artifact with a /pads/ url) opens', () => {
    openArtifact('/pads/care', 'c1');
    expect(
      useLayoutStore.getState().findTab({ kind: 'page', page: 'pad', padId: 'care' }),
    ).not.toBeNull();
  });
});

describe('PadsPage', () => {
  it('groups pads by app, badges Working or the pending count, and searches', async () => {
    vi.spyOn(api, 'listPads').mockResolvedValue({
      pads: [
        pad(),
        pad({ id: 'w', name: 'Weight', pending: 0, working: true }),
        pad({ id: 'p', name: 'Chat header', app: 'Patch', device: 'desktop', pending: 3 }),
        pad({ id: 'n', name: 'Scratch', app: null }),
      ],
    });
    wrap(<PadsPage />);
    await screen.findByTestId('pads-group-Dog Log');
    expect(screen.getByTestId('pads-group-Patch')).toBeInTheDocument();
    expect(screen.getByTestId('pads-group-No app')).toBeInTheDocument();
    expect(screen.getByTestId('pad-badge-w')).toHaveTextContent('Working');
    expect(screen.getByTestId('pad-badge-p')).toHaveTextContent('3 changes');
    expect(screen.queryByTestId('pad-badge-care')).not.toBeInTheDocument();
    // The owning chat is named on the card.
    expect(
      within(screen.getByTestId('pad-tile-care')).getByText('Puppy Care Logging'),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('pads-search'), { target: { value: 'header' } });
    expect(screen.queryByTestId('pad-tile-care')).not.toBeInTheDocument();
    expect(screen.getByTestId('pad-tile-p')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('pads-search'), { target: { value: 'zzz' } });
    expect(screen.getByTestId('pads-empty')).toBeInTheDocument();
  });

  it('opens a pad beside its chat, and New Pad opens the form', async () => {
    vi.spyOn(api, 'listPads').mockResolvedValue({ pads: [pad()] });
    wrap(<PadsPage />);
    fireEvent.click(await screen.findByTestId('pad-tile-care'));
    expect(
      useLayoutStore.getState().findTab({ kind: 'page', page: 'pad', padId: 'care' }),
    ).not.toBeNull();
    fireEvent.click(screen.getByTestId('pads-new'));
    expect(useLayoutStore.getState().findTab({ kind: 'page', page: 'new-pad' })).not.toBeNull();
  });

  it('shows the failure instead of an empty list when the server errors', async () => {
    vi.spyOn(api, 'listPads').mockRejectedValue(new Error('HTTP 500'));
    wrap(<PadsPage />);
    expect(await screen.findByTestId('pads-error')).toHaveTextContent('HTTP 500');
  });
});

describe('PadCard', () => {
  it('names the pad, its screens and state, and opens it beside the chat', async () => {
    vi.spyOn(api, 'getPad').mockResolvedValue(
      pad({
        pending: 2,
        screens: [
          pad().screens[0]!,
          { id: 'b', name: 'B', path: 'b.html', pending: 0, thumbUrl: null },
        ],
      }),
    );
    wrap(<PadCard padId="care" title="Care screens" chatId="c1" />);
    await screen.findByText('2 screens');
    expect(screen.getByText('2 changes')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pad-card-open'));
    expect(
      useLayoutStore.getState().findTab({ kind: 'page', page: 'pad', padId: 'care' }),
    ).not.toBeNull();
  });
  it('says so when the pad is gone, and cannot be opened', async () => {
    vi.spyOn(api, 'getPad').mockRejectedValue(new Error('no pad "care"'));
    wrap(<PadCard padId="care" title="Care screens" chatId="c1" />);
    expect(await screen.findByTestId('pad-card-error')).toHaveTextContent('no pad "care"');
    expect(screen.getByTestId('pad-card-open')).toBeDisabled();
  });
  it('reads a pad id out of a chat.artifact id', () => {
    expect(padIdOfArtifact('pad-care')).toBe('care');
    expect(padIdOfArtifact('abc123')).toBeNull();
    expect(padIdOfArtifact(undefined)).toBeNull();
  });
});

describe('PadPane', () => {
  it('frames the editor from its signed url under the pad’s name', async () => {
    vi.spyOn(api, 'getPad').mockResolvedValue(pad({ working: true }));
    wrap(<PadPane padId="care" />);
    const frame = await screen.findByTestId('pad-frame');
    expect(frame).toHaveAttribute('src', '/api/padx/care/sig/');
    expect(screen.getByText('Dog Log')).toBeInTheDocument();
    expect(screen.getByText('Working')).toBeInTheDocument();
  });
  it('says why when the pad’s screens cannot be read, instead of a blank frame', async () => {
    vi.spyOn(api, 'getPad').mockResolvedValue(pad({ screensError: 'pad.json is not valid JSON' }));
    wrap(<PadPane padId="care" />);
    expect(await screen.findByTestId('pad-screens-error')).toHaveTextContent('not valid JSON');
    expect(screen.queryByTestId('pad-frame')).not.toBeInTheDocument();
  });
  it('deletes after a confirmation and closes its tab', async () => {
    vi.spyOn(api, 'getPad').mockResolvedValue(pad());
    const del = vi.spyOn(api, 'deletePad').mockResolvedValue(null);
    vi.spyOn(useUiStore.getState(), 'confirm').mockResolvedValue(true);
    openPadBesideChat('care', 'c1');
    wrap(<PadPane padId="care" />);
    fireEvent.click(await screen.findByTestId('pad-delete'));
    await waitFor(() => expect(del).toHaveBeenCalledWith('care'));
    await waitFor(() =>
      expect(
        useLayoutStore.getState().findTab({ kind: 'page', page: 'pad', padId: 'care' }),
      ).toBeNull(),
    );
  });
});

describe('NewPadPage', () => {
  beforeEach(() => {
    useChatStore.getState().setActiveChat('c1');
    vi.spyOn(api, 'padLibrary').mockResolvedValue({
      apps: [
        {
          app: 'Dog Log',
          screens: [
            { padId: 'care', screenId: 'home', name: 'Home', thumbUrl: null, device: 'phone' },
          ],
        },
      ],
    });
  });

  it('offers Blank, Patch and the apps earlier pads captured; Create needs a name and a chat', async () => {
    wrap(<NewPadPage chatId="c1" />);
    await screen.findByTestId('new-pad-based-Dog Log');
    expect(screen.getByTestId('new-pad-based-blank')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('new-pad-based-Patch')).toBeInTheDocument();
    expect(screen.getByTestId('new-pad-create')).toBeDisabled();
    fireEvent.change(screen.getByTestId('new-pad-name'), { target: { value: 'Header' } });
    expect(screen.getByTestId('new-pad-create')).toBeEnabled();
  });

  it('lists an app’s earlier captures to start from, and creates from them', async () => {
    const create = vi
      .spyOn(api, 'createPad')
      .mockResolvedValue(pad({ id: 'new', name: 'Derived' }));
    wrap(<NewPadPage chatId="c1" />);
    fireEvent.click(await screen.findByTestId('new-pad-based-Dog Log'));
    fireEvent.click(await screen.findByTestId('new-pad-lib-care-home'));
    fireEvent.change(screen.getByTestId('new-pad-name'), { target: { value: 'Derived' } });
    fireEvent.click(screen.getByTestId('new-pad-phone'));
    fireEvent.click(screen.getByTestId('new-pad-create'));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![0]).toEqual({
      name: 'Derived',
      app: 'Dog Log',
      device: 'phone',
      chatId: 'c1',
      from: [{ padId: 'care', screenId: 'home' }],
    });
    // …and the new pad opens beside its chat.
    await waitFor(() =>
      expect(
        useLayoutStore.getState().findTab({ kind: 'page', page: 'pad', padId: 'new' }),
      ).not.toBeNull(),
    );
  });

  it('a blank pad sends no screens at all', async () => {
    const create = vi.spyOn(api, 'createPad').mockResolvedValue(pad({ id: 'blank' }));
    wrap(<NewPadPage chatId="c1" />);
    fireEvent.change(await screen.findByTestId('new-pad-name'), { target: { value: 'Scratch' } });
    fireEvent.click(screen.getByTestId('new-pad-create'));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![0]).toEqual({ name: 'Scratch', device: 'desktop', chatId: 'c1' });
  });

  it('reports a failed create instead of opening anything', async () => {
    vi.spyOn(api, 'createPad').mockRejectedValue(
      new Error('chatId "c1" is not a chat on this server'),
    );
    const push = vi.spyOn(useUiStore.getState(), 'pushError');
    wrap(<NewPadPage chatId="c1" />);
    fireEvent.change(await screen.findByTestId('new-pad-name'), { target: { value: 'X' } });
    fireEvent.click(screen.getByTestId('new-pad-create'));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(push.mock.calls[0]![2]).toContain('not a chat');
    expect(
      useLayoutStore.getState().findTab({ kind: 'page', page: 'pad', padId: 'blank' }),
    ).toBeNull();
  });
});

describe('captureDocument', () => {
  it('flattens the styles into one <style>, drops scripts, neutralises links and keeps what is typed', async () => {
    document.head.innerHTML = '<style>.hero{color:rgb(1,2,3)}</style><script>window.x=1</script>';
    document.body.innerHTML =
      '<a href="/jobs">Jobs</a><input id="i"><textarea id="t"></textarea><div class="hero" contenteditable="true">Hi</div>';
    (document.getElementById('i') as HTMLInputElement).value = 'typed';
    (document.getElementById('t') as HTMLTextAreaElement).value = 'long text';
    const html = await captureDocument();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toMatch(/<style>[^<]*\.hero/);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('href="#"');
    expect(html).toContain('value="typed"');
    expect(html).toContain('>long text</textarea>');
    expect(html).not.toContain('contenteditable');
  });

  it('inlines assets a stylesheet or image points at, and fails loudly when one cannot be', async () => {
    document.head.innerHTML = '<style>.bg{background-image:url("/bg.woff2")}</style>';
    document.body.innerHTML = '<img src="/logo.png">';
    const ok = vi.fn(async () => ({
      ok: true,
      status: 200,
      blob: async () => new Blob(['abc'], { type: 'font/woff2' }),
    }));
    vi.stubGlobal('fetch', ok);
    const html = await captureDocument();
    expect(html).toMatch(/url\(["']?data:font\/woff2;base64,/);
    expect(html).toMatch(/<img src="data:/);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 })),
    );
    await expect(captureDocument()).rejects.toThrow(/could not inline .*HTTP 404/);
    vi.unstubAllGlobals();
  });
});
