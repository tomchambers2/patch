// Settings → Memories (design/settings-redesign): the picked host's Memory
// switch; its entries searchable, filtered by type and grouped by project with
// counts; and one entry's page — type · project · date, its text saved with
// `host.claude_memory_set`, Delete (asked first) with `host.claude_memory_delete`,
// each settled by the host's fresh snapshot or its refusal.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactTestRenderer } from 'react-test-renderer';
import { DEFAULT_SHARED_SETTINGS, type ClaudeMemoryEntry } from '@patch/wire';
import { MemoriesPage, MemoryDetail } from '../src/components/settings/MemoriesSection';
import { CLAUDE_ACK_TIMEOUT_MS } from '../src/components/settings/accountRows';
import {
  renderRN,
  findHost,
  findAllHost,
  queryHost,
  byTestId,
  textOf,
  actAsync,
} from './testUtils/render';
import { __getLastAlert, __clearLastAlert } from './stubs/react-native';
import { routerMock, __resetRouterMock } from './stubs/expo-router';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useHostRefusalStore } from '../src/stores/hostRefusalStore';
import { pickHost, reportHost, resetHosts, seedSettings } from './testUtils/settingsFixtures';
import { useSettingsStore } from '../src/stores/settingsStore';
import { api } from '../src/api/rest';

const send = vi.fn();
vi.mock('../src/api/ws', () => ({ getWs: () => ({ send }) }));
vi.mock('../src/api/rest', () => ({
  api: {
    setPreferences: vi.fn(async (patch: Record<string, unknown>) => ({
      preferences: { ...DEFAULT_SHARED_SETTINGS, ...patch },
    })),
  },
}));

const nav: ClaudeMemoryEntry = {
  project: '-home-tom-portfolio',
  projectDir: '/home/tom/portfolio',
  file: 'nav.md',
  name: 'Android nav bar',
  description: 'never hide the system bar',
  memoryType: 'feedback',
  body: 'Leave the system navigation bar alone.',
  updatedAt: new Date(2026, 8, 13).getTime(),
};
const phone: ClaudeMemoryEntry = {
  project: '-home-tom-portfolio',
  projectDir: '/home/tom/portfolio',
  file: 'phone.md',
  name: 'Tom’s phone',
  description: 'Android, ntfy for links',
  memoryType: 'user',
  body: 'Android.',
};
const deploy: ClaudeMemoryEntry = {
  project: '-home-tom-portfolio-projects-patch',
  file: 'deploy.md',
  name: 'Deploy order',
  description: 'wire changes ship together',
  memoryType: 'project',
};

let mounted: ReactTestRenderer[] = [];
function render(el: React.ReactElement): ReactTestRenderer {
  const r = renderRN(el);
  mounted.push(r);
  return r;
}

function seed(memories: ClaudeMemoryEntry[], daemonId = 'd1'): void {
  usePresenceStore.getState().setClaudeSettings(daemonId, '{}', memories);
}

beforeEach(() => {
  send.mockReset();
  __clearLastAlert();
  __resetRouterMock();
  useHostRefusalStore.getState()._reset();
  resetHosts();
  reportHost('d1', { hostName: 'laptop', isHomeHost: true, harnessMemoryEnabled: true });
  seed([nav, phone, deploy]);
});
afterEach(() => {
  for (const r of mounted) r.unmount();
  mounted = [];
  vi.useRealTimers();
});

function pressAlert(text: string): void {
  __getLastAlert()!
    .buttons!.find((b) => b.text === text)!
    .onPress?.();
}

function visibleEntries(r: ReactTestRenderer): string[] {
  return findAllHost(r.root, (i) => /^memory-/.test(String(i.props.testID))).map((i) =>
    String(i.props.accessibilityLabel),
  );
}

describe('Memories page', () => {
  it('the Memory switch writes the shared harnessMemoryEnabled (spec/01 § Settings)', async () => {
    seedSettings({ preferences: { ...DEFAULT_SHARED_SETTINGS, harnessMemoryEnabled: true } });
    const r = render(<MemoriesPage />);
    const toggle = findHost(r.root, byTestId('harness-memory-enabled'));
    expect(toggle.props.value).toBe(true);
    await actAsync(() => toggle.props.onValueChange(false));
    expect(api.setPreferences).toHaveBeenCalledWith({ harnessMemoryEnabled: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('says so while settings have not loaded', () => {
    useSettingsStore.getState()._reset();
    const r = render(<MemoriesPage />);
    expect(queryHost(r.root, byTestId('harness-memory-enabled'))).toBeNull();
    expect(textOf(r.root)).toContain('Settings haven’t loaded yet');
  });

  it('groups entries by project, biggest first, with counts', () => {
    const r = render(<MemoriesPage />);
    const groups = findAllHost(r.root, (i) =>
      /^memories-group-[^]*[^t]$/.test(String(i.props.testID)),
    )
      .map((i) => String(i.props.testID))
      .filter((id) => !id.endsWith('-count'));
    expect(groups).toEqual([
      'memories-group-portfolio',
      'memories-group--home-tom-portfolio-projects-patch',
    ]);
    expect(textOf(findHost(r.root, byTestId('memories-group-portfolio-count')))).toBe('2');
    expect(visibleEntries(r)).toEqual(['Android nav bar', 'Tom’s phone', 'Deploy order']);
  });

  it('search says how many there are, and narrows the list', async () => {
    const r = render(<MemoriesPage />);
    const search = findHost(r.root, byTestId('memories-search'));
    expect(search.props.placeholder).toBe('Search 3 memories');
    await actAsync(() => search.props.onChangeText('ntfy'));
    expect(visibleEntries(r)).toEqual(['Tom’s phone']);
    await actAsync(() => findHost(r.root, byTestId('memories-search')).props.onChangeText('zz'));
    expect(textOf(findHost(r.root, byTestId('memories-empty')))).toBe('No matches');
  });

  it('the type chips filter, All first', async () => {
    const r = render(<MemoriesPage />);
    expect(findHost(r.root, byTestId('memories-type-all')).props.accessibilityState.selected).toBe(
      true,
    );
    await actAsync(() => findHost(r.root, byTestId('memories-type-feedback')).props.onPress());
    expect(visibleEntries(r)).toEqual(['Android nav bar']);
    await actAsync(() => findHost(r.root, byTestId('memories-type-reference')).props.onPress());
    expect(visibleEntries(r)).toEqual([]);
  });

  it('tapping an entry opens it', () => {
    const r = render(<MemoriesPage />);
    findHost(r.root, byTestId('memory--home-tom-portfolio-nav.md')).props.onPress();
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/settings/memory',
      params: { daemonId: 'd1', project: '-home-tom-portfolio', file: 'nav.md' },
    });
  });

  it('says when the host has none, or has not sent them yet', () => {
    seed([]);
    let r = render(<MemoriesPage />);
    expect(textOf(findHost(r.root, byTestId('memories-empty')))).toBe('No memories');
    reportHost('d2', { hostName: 'mac', harnessMemoryEnabled: false });
    pickHost('d2');
    r = render(<MemoriesPage />);
    expect(textOf(findHost(r.root, byTestId('memories-unreported')))).toBe(
      'mac hasn’t sent its memories yet',
    );
  });
});

describe('a memory’s page', () => {
  it('shows type · project · date and the text to edit', () => {
    const r = render(<MemoryDetail daemonId="d1" project={nav.project} file="nav.md" />);
    expect(textOf(findHost(r.root, byTestId('settings-page-title')))).toBe('Android nav bar');
    expect(textOf(findHost(r.root, byTestId('memory-meta')))).toBe('feedback · portfolio · 13 Sep');
    expect(findHost(r.root, byTestId('memory-body')).props.value).toBe(nav.body);
    expect(findHost(r.root, byTestId('memory-save')).props.disabled).toBe(true);
  });

  it('Save sends the new text and settles on the host’s fresh snapshot', async () => {
    const r = render(<MemoryDetail daemonId="d1" project={nav.project} file="nav.md" />);
    await actAsync(() => findHost(r.root, byTestId('memory-body')).props.onChangeText('New.'));
    await actAsync(() => findHost(r.root, byTestId('memory-save')).props.onPress());
    expect(send).toHaveBeenCalledWith({
      type: 'host.claude_memory_set',
      daemonId: 'd1',
      project: nav.project,
      file: 'nav.md',
      body: 'New.',
    });
    expect(textOf(findHost(r.root, byTestId('memory-save')))).toBe('Saving…');
    await actAsync(() => seed([{ ...nav, body: 'New.' }, phone, deploy]));
    expect(textOf(findHost(r.root, byTestId('memory-save')))).toBe('Save');
    expect(findHost(r.root, byTestId('memory-save')).props.disabled).toBe(true);
    expect(routerMock.back).not.toHaveBeenCalled();
    expect(queryHost(r.root, byTestId('memory-error'))).toBeNull();
  });

  it('a refusal is shown in the host’s own words', async () => {
    const r = render(<MemoryDetail daemonId="d1" project={nav.project} file="nav.md" />);
    await actAsync(() => findHost(r.root, byTestId('memory-body')).props.onChangeText('New.'));
    await actAsync(() => findHost(r.root, byTestId('memory-save')).props.onPress());
    await actAsync(() =>
      useHostRefusalStore
        .getState()
        .note('claude_settings_invalid', 'host.claude_memory_set: d1 — no such memory'),
    );
    expect(textOf(findHost(r.root, byTestId('memory-error')))).toBe(
      'host.claude_memory_set: d1 — no such memory',
    );
  });

  it('no answer in the window is said as unknown, and heartbeats do not extend it', async () => {
    vi.useFakeTimers();
    const r = render(<MemoryDetail daemonId="d1" project={nav.project} file="nav.md" />);
    await actAsync(() => findHost(r.root, byTestId('memory-body')).props.onChangeText('New.'));
    await actAsync(() => findHost(r.root, byTestId('memory-save')).props.onPress());
    await actAsync(() => vi.advanceTimersByTime(CLAUDE_ACK_TIMEOUT_MS - 1000));
    await actAsync(() => usePresenceStore.getState().setHostOnline('d1', true));
    await actAsync(() => vi.advanceTimersByTime(1000));
    expect(textOf(findHost(r.root, byTestId('memory-error')))).toMatch(
      /^laptop sent no answer in 5s/,
    );
  });

  it('Delete asks first, then goes back once the host has dropped it', async () => {
    const r = render(<MemoryDetail daemonId="d1" project={nav.project} file="nav.md" />);
    await actAsync(() => findHost(r.root, byTestId('memory-delete')).props.onPress());
    expect(__getLastAlert()?.title).toBe('Delete Android nav bar?');
    pressAlert('Cancel');
    expect(send).not.toHaveBeenCalled();
    await actAsync(() => findHost(r.root, byTestId('memory-delete')).props.onPress());
    await actAsync(() => pressAlert('Delete'));
    expect(send).toHaveBeenCalledWith({
      type: 'host.claude_memory_delete',
      daemonId: 'd1',
      project: nav.project,
      file: 'nav.md',
    });
    expect(routerMock.back).not.toHaveBeenCalled();
    await actAsync(() => seed([phone, deploy]));
    expect(routerMock.back).toHaveBeenCalledTimes(1);
  });

  it('an offline host is refused up front, naming it', async () => {
    usePresenceStore.getState().setHostOnline('d1', false);
    const r = render(<MemoryDetail daemonId="d1" project={nav.project} file="nav.md" />);
    await actAsync(() => findHost(r.root, byTestId('memory-body')).props.onChangeText('New.'));
    await actAsync(() => findHost(r.root, byTestId('memory-save')).props.onPress());
    expect(send).not.toHaveBeenCalled();
    expect(__getLastAlert()?.title).toBe('Save memory failed');
    expect(__getLastAlert()?.message).toMatch(/^laptop is offline/);
  });

  it('an entry from a host that predates sending text: its description, and update the host', () => {
    const r = render(<MemoryDetail daemonId="d1" project={deploy.project} file="deploy.md" />);
    expect(queryHost(r.root, byTestId('memory-body'))).toBeNull();
    expect(queryHost(r.root, byTestId('memory-save'))).toBeNull();
    expect(textOf(r.root)).toContain('wire changes ship together');
    expect(textOf(findHost(r.root, byTestId('memory-update')))).toBe(
      'Update laptop to read this memory',
    );
    expect(textOf(findHost(r.root, byTestId('memory-meta')))).toBe(
      'project · -home-tom-portfolio-projects-patch',
    );
  });

  it('an entry the host no longer holds says so', () => {
    const r = render(<MemoryDetail daemonId="d1" project="p" file="gone.md" />);
    expect(textOf(findHost(r.root, byTestId('memory-gone')))).toBe(
      'This memory is no longer on laptop',
    );
  });
});
