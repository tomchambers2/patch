// Settings → Memories: Claude Code's own memory on one host — whether it is on
// for chats there, and every entry it has written, to find, read, edit or
// delete.
//
// Entries arrive whole in the host's `claude_settings.list` report and are
// never patched locally: an edit or a delete goes to the host and the list
// settles on its answer. A host older than the entry text sends no `body`,
// which is said rather than shown as an empty memory.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import type { ClaudeMemoryEntry } from '@patch/wire';
import { useUiStore } from '../stores/uiStore.js';
import { usePresenceStore } from '../stores/presenceStore.js';
import { projectLabel } from '../routes/settings/MemoriesPage.js';
import { reportClaudeSettings, reportHost } from './presenceHelpers.js';
import { setActiveWs } from '../api/ws.js';
import {
  fakeWs,
  makeFetch,
  preferencesServer,
  renderSettings,
  resetSettingsState,
} from './settingsHarness.js';
import { usePreferencesStore } from '../stores/preferencesStore.js';

const errors = (): string[] => useUiStore.getState().errors.map((e) => e.message);

const ROLE: ClaudeMemoryEntry = {
  project: '-home-tom-patch',
  projectDir: '/home/tom/patch',
  file: 'user_role.md',
  name: 'User role',
  description: 'Tom is a contractor',
  memoryType: 'user',
  body: 'Tom works for WPP.',
  updatedAt: Date.UTC(2026, 8, 20),
};
const TESTS: ClaudeMemoryEntry = {
  project: '-home-tom-patch',
  projectDir: '/home/tom/patch',
  file: 'feedback_tests.md',
  name: 'Run tests capped',
  description: 'Always cap vitest memory',
  memoryType: 'feedback',
  body: 'Use systemd-run with MemoryMax.',
};
const GARDEN: ClaudeMemoryEntry = {
  project: '-home-tom-garden',
  file: 'project_beds.md',
  name: 'Raised beds',
  description: 'Four beds by the fence',
  memoryType: 'project',
  body: 'Beds are 1.2m wide.',
};

const item = (m: ClaudeMemoryEntry): string => `host-d1-memory-${m.project}-${m.file}`;

async function openPage(
  memories: ClaudeMemoryEntry[] | null,
  memoryEnabled?: boolean,
): Promise<void> {
  reportHost('d1', {
    hostName: 'mac',
    ...(memoryEnabled === undefined ? {} : { harnessMemoryEnabled: memoryEnabled }),
  });
  if (memories) reportClaudeSettings('d1', memories);
  renderSettings('/settings/memories');
  await waitFor(() => expect(screen.getByTestId('settings-memories')).toBeInTheDocument());
}

beforeEach(() => {
  resetSettingsState();
  usePresenceStore.getState().setHostOnline('d1', true);
  vi.stubGlobal('fetch', makeFetch());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setActiveWs(null);
});

describe('Settings → Memories — the switch', () => {
  it('reflects the shared memory setting and writes a change to the server', async () => {
    const server = preferencesServer(() => usePreferencesStore.getState().preferences as never);
    vi.stubGlobal('fetch', makeFetch({}, server.handler));
    await openPage([]);
    const toggle = screen.getByTestId('harness-memory-enabled') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(server.writes).toContainEqual({ harnessMemoryEnabled: true }));
  });
});

describe('Settings → Memories — the entries', () => {
  it('says the host has not sent its memories, rather than showing none', async () => {
    await openPage(null, true);
    expect(screen.getByTestId('host-d1-memory-unreported')).toHaveTextContent(
      'mac hasn’t sent its memories yet',
    );
    expect(screen.queryByTestId('memory-search')).toBeNull();
  });

  it('says there are no memories rather than showing an empty list', async () => {
    await openPage([], true);
    expect(screen.getByTestId('host-d1-memory-empty')).toHaveTextContent('No memories on mac');
  });

  it('groups entries by project folder, biggest first, and opens the first', async () => {
    await openPage([GARDEN, ROLE, TESTS], true);
    const list = screen.getByTestId('host-d1-memory-list');
    const projects = Array.from(list.querySelectorAll('.set-mem-proj .set-label')).map(
      (el) => el.textContent,
    );
    // The folder's last segment; the encoded project name when no folder is known.
    expect(projects).toEqual(['patch', '-home-tom-garden']);
    expect(screen.getByTestId(item(ROLE))).toHaveTextContent('User role');
    expect(screen.getByTestId(item(ROLE))).toHaveTextContent('Tom is a contractor');
    expect(screen.getByTestId('memory-detail')).toHaveTextContent('User role');
    expect(screen.getByTestId('memory-meta')).toHaveTextContent('user · patch · 20 Sept');
    expect(screen.getByTestId('memory-rendered')).toHaveTextContent('Tom works for WPP.');
    expect(screen.queryByTestId('memory-body')).toBeNull();
    expect(screen.getByTestId('memory-search')).toHaveAttribute('placeholder', 'Search 3 memories');
  });

  it('renders the entry text as markdown, and Edit swaps in the raw text', async () => {
    const md: ClaudeMemoryEntry = {
      ...ROLE,
      body: '# Role\n\nTom is **a contractor**\n\n- one\n- two',
    };
    await openPage([md], true);
    const view = screen.getByTestId('memory-rendered');
    expect(view.querySelector('h1')).toHaveTextContent('Role');
    expect(view.querySelector('strong')).toHaveTextContent('a contractor');
    expect(view.querySelectorAll('li')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('memory-edit'));
    expect(screen.queryByTestId('memory-rendered')).toBeNull();
    expect(screen.getByTestId('memory-body')).toHaveValue(md.body);
    fireEvent.blur(screen.getByTestId('memory-body'));
    expect(screen.getByTestId('memory-rendered')).toBeInTheDocument();
  });

  it('clicking an entry opens it', async () => {
    await openPage([ROLE, TESTS, GARDEN], true);
    fireEvent.click(screen.getByTestId(item(GARDEN)));
    expect(screen.getByTestId(item(GARDEN))).toHaveClass('on');
    expect(screen.getByTestId('memory-rendered')).toHaveTextContent('Beds are 1.2m wide.');
    expect(screen.getByTestId('memory-meta')).toHaveTextContent('project · -home-tom-garden');
  });

  it('search matches name, description, text, project and file', async () => {
    await openPage([ROLE, TESTS, GARDEN], true);
    const search = screen.getByTestId('memory-search');
    const shown = (): string[] =>
      [ROLE, TESTS, GARDEN].filter((m) => screen.queryByTestId(item(m))).map((m) => m.file);
    fireEvent.change(search, { target: { value: 'WPP' } });
    expect(shown()).toEqual(['user_role.md']);
    fireEvent.change(search, { target: { value: 'FENCE' } });
    expect(shown()).toEqual(['project_beds.md']);
    fireEvent.change(search, { target: { value: 'garden' } });
    expect(shown()).toEqual(['project_beds.md']);
    fireEvent.change(search, { target: { value: 'feedback_tests' } });
    expect(shown()).toEqual(['feedback_tests.md']);
    fireEvent.change(search, { target: { value: 'nothing like this' } });
    expect(shown()).toEqual([]);
    expect(screen.getByTestId('memory-no-match')).toHaveTextContent('No matches');
    expect(screen.queryByTestId('memory-detail')).toBeNull();
  });

  it('filters by memory type', async () => {
    await openPage([ROLE, TESTS, GARDEN], true);
    expect(screen.getByTestId('memory-filter-All')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByTestId('memory-filter-feedback'));
    expect(screen.getByTestId('memory-filter-feedback')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId(item(TESTS))).toBeInTheDocument();
    expect(screen.queryByTestId(item(ROLE))).toBeNull();
    expect(screen.queryByTestId(item(GARDEN))).toBeNull();
    // The open entry follows the filter rather than showing a hidden one.
    expect(screen.getByTestId('memory-rendered')).toHaveTextContent(
      'Use systemd-run with MemoryMax.',
    );
    fireEvent.click(screen.getByTestId('memory-filter-All'));
    expect(screen.getByTestId(item(ROLE))).toBeInTheDocument();
  });

  it('an edited entry is sent to the host on blur', async () => {
    const { sent } = fakeWs();
    await openPage([ROLE], true);
    fireEvent.click(screen.getByTestId('memory-edit'));
    let body = screen.getByTestId('memory-body');
    // Leaving it unchanged sends nothing.
    fireEvent.blur(body);
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByTestId('memory-edit'));
    body = screen.getByTestId('memory-body');
    fireEvent.change(body, { target: { value: 'Tom works for himself.' } });
    fireEvent.blur(body);
    expect(sent).toEqual([
      {
        type: 'host.claude_memory_set',
        daemonId: 'd1',
        project: ROLE.project,
        file: ROLE.file,
        body: 'Tom works for himself.',
      },
    ]);
  });

  it('⌘↵ saves without leaving the box; a bare ↵ does not', async () => {
    const { sent } = fakeWs();
    await openPage([ROLE], true);
    fireEvent.click(screen.getByTestId('memory-edit'));
    const body = screen.getByTestId('memory-body');
    fireEvent.change(body, { target: { value: 'Line one' } });
    fireEvent.keyDown(body, { key: 'Enter' });
    expect(sent).toEqual([]);
    fireEvent.keyDown(body, { key: 'Enter', metaKey: true });
    expect(sent).toHaveLength(1);
  });

  it('the host’s fresh report replaces what is shown', async () => {
    fakeWs();
    await openPage([ROLE], true);
    fireEvent.click(screen.getByTestId('memory-edit'));
    fireEvent.change(screen.getByTestId('memory-body'), { target: { value: 'typed' } });
    act(() =>
      reportClaudeSettings('d1', [
        { ...ROLE, body: 'Saved on the host.', updatedAt: Date.UTC(2026, 8, 21) },
      ]),
    );
    await waitFor(() =>
      expect(screen.getByTestId('memory-rendered')).toHaveTextContent('Saved on the host.'),
    );
  });

  it('Delete asks first, then sends host.claude_memory_delete naming it', async () => {
    const { sent } = fakeWs();
    await openPage([ROLE], true);
    fireEvent.click(screen.getByTestId(`${item(ROLE)}-remove`));
    expect(await screen.findByTestId('confirm-modal')).toHaveTextContent(
      'Delete “User role” from mac?',
    );
    fireEvent.click(screen.getByTestId('confirm-cancel'));
    await act(async () => {});
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByTestId(`${item(ROLE)}-remove`));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() =>
      expect(sent).toEqual([
        {
          type: 'host.claude_memory_delete',
          daemonId: 'd1',
          project: ROLE.project,
          file: ROLE.file,
        },
      ]),
    );
    // Not patched locally: it goes when the host says so.
    expect(screen.getByTestId(item(ROLE))).toBeInTheDocument();
    act(() => reportClaudeSettings('d1', []));
    await waitFor(() => expect(screen.queryByTestId(item(ROLE))).toBeNull());
  });

  it('a host that sends no entry text says so, instead of an empty editable memory', async () => {
    const { sent } = fakeWs();
    const { body: _body, updatedAt: _at, ...old } = ROLE;
    void _body;
    void _at;
    await openPage([old], true);
    expect(screen.queryByTestId('memory-body')).toBeNull();
    expect(screen.queryByTestId('memory-edit')).toBeNull();
    expect(screen.getByTestId('memory-body-unsupported')).toHaveTextContent(
      'Update mac to read this memory',
    );
    // What the host did send is still shown.
    expect(screen.getByTestId('memory-detail')).toHaveTextContent('Tom is a contractor');
    // It can still be deleted.
    fireEvent.click(screen.getByTestId(`${item(ROLE)}-remove`));
    fireEvent.click(await screen.findByTestId('confirm-ok'));
    await waitFor(() => expect(sent).toHaveLength(1));
  });

  it('an edit aimed at an offline host is refused, naming it', async () => {
    const { sent } = fakeWs();
    usePresenceStore.getState().setHostOnline('d1', false);
    await openPage([ROLE], true);
    fireEvent.click(screen.getByTestId('memory-edit'));
    const body = screen.getByTestId('memory-body');
    fireEvent.change(body, { target: { value: 'x' } });
    fireEvent.blur(body);
    expect(sent).toEqual([]);
    await waitFor(() => expect(errors().some((e) => /mac is offline/.test(e))).toBe(true));
  });

  it('shows the host chosen in the switcher, and only its memories', async () => {
    await openPage([ROLE], true);
    act(() => {
      reportHost('d2', { hostName: 'hetzner', isHomeHost: false, harnessMemoryEnabled: true });
      reportClaudeSettings('d2', [GARDEN]);
    });
    fireEvent.click(await screen.findByTestId('settings-host-d2'));
    await waitFor(() =>
      expect(
        screen.getByTestId(`host-d2-memory-${GARDEN.project}-${GARDEN.file}`),
      ).toBeInTheDocument(),
    );
    expect(within(screen.getByTestId('settings-memories')).queryByTestId(item(ROLE))).toBeNull();
  });
});

describe('projectLabel', () => {
  it('is the folder’s last segment, or the encoded name when no folder is known', () => {
    expect(projectLabel(ROLE)).toBe('patch');
    expect(projectLabel({ ...ROLE, projectDir: '/home/tom/patch/' })).toBe('patch');
    expect(projectLabel({ ...ROLE, projectDir: '/' })).toBe('/');
    expect(projectLabel(GARDEN)).toBe('-home-tom-garden');
  });
});
