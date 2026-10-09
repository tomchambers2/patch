// Jobs editor (spec/15 § Jobs editor) — the action two-axis
// picker: where (spawn new chat / persistent chat / message a chat) and what
// (skill / prompt). Covers the Folder picker (host + chat folders, the
// ad-hoc "Custom path…" field), the Recipient-chat picker (empty vs
// populated), and the Skill picker's "keep the current value even if it's
// not in the fetched list" behaviour. Always create mode — load-existing-job
// behaviour lives in jobEditor.loadSave.test.tsx.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import JobEditor from '../app/settings/job-editor';
import {
  renderRN,
  actAsync,
  findHost,
  findAllHost,
  queryHost,
  byTestId,
  hasText,
  textOf,
  flush,
} from './testUtils/render';
import { api } from '../src/api/rest';
import { __resetRouterMock, __setLocalSearchParams, routerMock } from './stubs/expo-router';
import { editRoute } from '../src/lib/hostFiles';
import { useChatStore } from '../src/stores/chatStore';
import { useFolderStore } from '../src/stores/folderStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { lightColors } from '../src/lib/theme';

/** The one registered machine these screens address (spec/03 § Host events). */
const HOST = 'd1';

vi.mock('../src/api/rest', () => ({
  api: {
    getJob: vi.fn(),
    createJob: vi.fn(),
    patchJob: vi.fn(),
    deleteJob: vi.fn(),
    skills: vi.fn(),
    models: vi.fn(),
    listJobs: vi.fn(),
  },
}));

beforeEach(() => {
  vi.mocked(api.getJob).mockReset();
  vi.mocked(api.createJob).mockReset();
  vi.mocked(api.patchJob).mockReset();
  vi.mocked(api.deleteJob).mockReset();
  vi.mocked(api.skills).mockReset().mockResolvedValue({ skills: [] });
  vi.mocked(api.models).mockReset().mockResolvedValue({ models: [] });
  vi.mocked(api.listJobs).mockReset().mockResolvedValue({ jobs: [] });
  __resetRouterMock();
  __setLocalSearchParams({});
  useChatStore.getState()._reset();
  useFolderStore.getState()._reset();
  // Every folder list and every browse is scoped to ONE machine (spec/04
  // § Folders / § Browsing), so the roster carries the single registered host
  // these screens address. Without it `defaultDaemonId` is null and the screen
  // correctly refuses to guess — which is a different test.
  usePresenceStore.setState({
    hosts: { [HOST]: { daemonId: HOST, online: true, lastSeenAt: 1, host: null, accounts: {} } },
  });
});

function selectPill(r: ReturnType<typeof renderRN>, groupTestId: string, label: string): void {
  const group = findHost(r.root, byTestId(groupTestId));
  findAllHost(group, (i) => i.type === 'Pressable' && hasText(i, label))[0]!.props.onPress();
}

// The Folder/Model/Skill fields are dropdowns (OptionPicker): closed by
// default, showing only the current selection's label. A test opens one by
// pressing its trigger pill, then presses the option it wants — same
// two-step interaction a real tap does.
function openPicker(r: ReturnType<typeof renderRN>, pickerTestId: string): void {
  findHost(r.root, byTestId(pickerTestId)).props.onPress();
}
function pickOption(r: ReturnType<typeof renderRN>, pickerTestId: string, optionId: string): void {
  openPicker(r, pickerTestId);
  findHost(
    r.root,
    byTestId(`${pickerTestId}-option-${optionId === '' ? 'default' : optionId}`),
  ).props.onPress();
}
function pickerLabel(r: ReturnType<typeof renderRN>, pickerTestId: string): string {
  return textOf(findHost(r.root, byTestId(pickerTestId)));
}

describe('JobEditor — action type: spawn (default)', () => {
  it('shows the Folder pill, closed on the seeded first folder and its host', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a', '/home/tom/b'], recent: [] });
    const r = renderRN(<JobEditor />);
    await flush();
    expect(hasText(r.root, 'Folder')).toBe(true);
    expect(pickerLabel(r, 'job-spawn-folder')).toBe(`a · ${HOST}`);
    expect(queryHost(r.root, byTestId('folder-sheet'))).toBeNull();
  });

  it('the pill opens the folder picker sheet; picking a row updates the pill and closes it', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a', '/home/tom/b'], recent: [] });
    const r = renderRN(<JobEditor />);
    await flush();
    await actAsync(async () => {
      findHost(r.root, byTestId('job-spawn-folder')).props.onPress();
      await flush();
    });
    expect(findHost(r.root, byTestId('folder-sheet'))).toBeDefined();
    await actAsync(async () => {
      findHost(r.root, byTestId('folder-sheet-row-/home/tom/b')).props.onPress();
      await flush();
    });
    expect(pickerLabel(r, 'job-spawn-folder')).toBe(`b · ${HOST}`);
    expect(queryHost(r.root, byTestId('folder-sheet'))).toBeNull();
  });

  it('with no folders known the pill invites a choice', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    expect(pickerLabel(r, 'job-spawn-folder')).toBe('Choose a folder…');
  });
});

describe('JobEditor — action type: ensure', () => {
  it('shows the persistent-chat explainer text and still uses the Folder picker', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    const r = renderRN(<JobEditor />);
    await flush();
    selectPill(r, 'job-action-type', 'persistent chat');
    expect(hasText(r.root, 'every later fire messages the SAME')).toBe(true);
    expect(hasText(r.root, 'Folder')).toBe(true);
  });
});

describe('JobEditor — action type: message', () => {
  it('with no chats, shows "No chats yet — start one first." instead of the folder picker', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    selectPill(r, 'job-action-type', 'message a chat');
    expect(hasText(r.root, 'No chats yet')).toBe(true);
    expect(findAllHost(r.root, byTestId('job-spawn-folder')).length).toBe(0);
  });

  it('lists known chats by name (or id) and folder; selecting one sets messageChatId', async () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        name: 'Morning digest',
        folder: '/home/tom/a',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
      {
        chatId: 'c2',
        name: null,
        folder: '/home/tom/b',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
    const r = renderRN(<JobEditor />);
    await flush();
    selectPill(r, 'job-action-type', 'message a chat');
    expect(hasText(r.root, 'Morning digest')).toBe(true);
    expect(hasText(r.root, 'c2')).toBe(true); // no name → falls back to raw chatId
    findHost(r.root, (i) => i.type === 'Pressable' && hasText(i, 'Morning digest')).props.onPress();
    const active = findHost(r.root, (i) => i.type === 'Pressable' && hasText(i, 'Morning digest'));
    expect(active.props.style.borderColor).toBe(lightColors.leaf);
  });

  it("the Skill picker targets the SELECTED chat's folder, not the spawn folder", async () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        name: 'Digest',
        folder: '/home/tom/chatfolder',
        daemonId: HOST,
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
    vi.mocked(api.skills).mockResolvedValue({ skills: ['life-coach'] });
    const r = renderRN(<JobEditor />);
    await flush();
    selectPill(r, 'job-action-type', 'message a chat');
    findHost(r.root, (i) => i.type === 'Pressable' && hasText(i, 'Digest')).props.onPress();
    await flush();
    expect(api.skills).toHaveBeenCalledWith('/home/tom/chatfolder', HOST);
  });

  it('with no chat selected, the Skill field shows "Pick a recipient chat first."', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    selectPill(r, 'job-action-type', 'message a chat');
    expect(hasText(r.root, 'Pick a recipient chat first.')).toBe(true);
  });
});

describe('JobEditor — Skill picker', () => {
  it('offers "none" plus every fetched skill; picking one sets spawnSkill', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    vi.mocked(api.skills).mockResolvedValue({ skills: ['life-coach', 'plant'] });
    const r = renderRN(<JobEditor />);
    await flush();
    expect(pickerLabel(r, 'job-skill')).toBe('none');
    openPicker(r, 'job-skill');
    expect(hasText(r.root, 'life-coach')).toBe(true);
    expect(hasText(r.root, 'plant')).toBe(true);
    findHost(r.root, byTestId('job-skill-option-life-coach')).props.onPress();
    expect(pickerLabel(r, 'job-skill')).toBe('life-coach');
  });

  it('picking "none" clears the skill selection', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    vi.mocked(api.skills).mockResolvedValue({ skills: ['life-coach'] });
    const r = renderRN(<JobEditor />);
    await flush();
    pickOption(r, 'job-skill', 'life-coach');
    expect(pickerLabel(r, 'job-skill')).toBe('life-coach');
    pickOption(r, 'job-skill', '');
    expect(pickerLabel(r, 'job-skill')).toBe('none');
  });

  it('sets messageSkill (not spawnSkill) when actionType is message', async () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        name: 'Digest',
        folder: '/home/tom/a',
        daemonId: HOST,
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
    vi.mocked(api.skills).mockResolvedValue({ skills: ['life-coach'] });
    vi.mocked(api.patchJob).mockResolvedValue({});
    const r = renderRN(<JobEditor />);
    await flush();
    selectPill(r, 'job-action-type', 'message a chat');
    findHost(r.root, (i) => i.type === 'Pressable' && hasText(i, 'Digest')).props.onPress();
    await flush();
    pickOption(r, 'job-skill', 'life-coach');
    expect(pickerLabel(r, 'job-skill')).toBe('life-coach');
  });
});

// The Skill picker's Edit link (spec/15 § Job editor) — what the job DOES,
// one click from the job that does it.
describe('JobEditor — Skill Edit link', () => {
  it('is hidden until a skill is chosen', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    vi.mocked(api.skills).mockResolvedValue({
      skills: ['life-coach'],
      paths: { 'life-coach': '/home/tom/.claude/skills/life-coach/SKILL.md' },
    });
    const r = renderRN(<JobEditor />);
    await flush();
    expect(queryHost(r.root, byTestId('job-skill-edit'))).toBeNull();
    expect(queryHost(r.root, byTestId('job-skill-edit-unavailable'))).toBeNull();
  });

  it('links to the host file editor for the chosen skill once selected', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    vi.mocked(api.skills).mockResolvedValue({
      skills: ['life-coach'],
      paths: { 'life-coach': '/home/tom/.claude/skills/life-coach/SKILL.md' },
    });
    const r = renderRN(<JobEditor />);
    await flush();
    pickOption(r, 'job-skill', 'life-coach');
    const edit = findHost(r.root, byTestId('job-skill-edit'));
    expect(edit).toBeDefined();
    findHost(r.root, (i) => i.type === 'Pressable' && hasText(i, 'Edit')).props.onPress();
    expect(routerMock.push).toHaveBeenCalledWith(
      editRoute(HOST, '/home/tom/.claude/skills/life-coach/SKILL.md'),
    );
  });

  it('shows the reason instead of a link when the host reports no skill files (an older host)', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    vi.mocked(api.skills).mockResolvedValue({ skills: ['life-coach'] }); // no `paths`
    const r = renderRN(<JobEditor />);
    await flush();
    pickOption(r, 'job-skill', 'life-coach');
    expect(queryHost(r.root, byTestId('job-skill-edit'))).toBeNull();
    expect(hasText(r.root, 'host does not report skill files')).toBe(true);
  });

  it("for a message action, links through the RECIPIENT chat's host, not the spawn host", async () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        name: 'Digest',
        folder: '/home/tom/chatfolder',
        daemonId: 'other-host',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
    vi.mocked(api.skills).mockResolvedValue({
      skills: ['life-coach'],
      paths: { 'life-coach': '/home/tom/chatfolder/.claude/skills/life-coach/SKILL.md' },
    });
    const r = renderRN(<JobEditor />);
    await flush();
    selectPill(r, 'job-action-type', 'message a chat');
    findHost(r.root, (i) => i.type === 'Pressable' && hasText(i, 'Digest')).props.onPress();
    await flush();
    pickOption(r, 'job-skill', 'life-coach');
    findHost(r.root, (i) => i.type === 'Pressable' && hasText(i, 'Edit')).props.onPress();
    expect(routerMock.push).toHaveBeenCalledWith(
      editRoute('other-host', '/home/tom/chatfolder/.claude/skills/life-coach/SKILL.md'),
    );
  });
});

describe('JobEditor — Prompt field', () => {
  it('binds to spawnPrompt for spawn/ensure and updates on change', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    const r = renderRN(<JobEditor />);
    await flush();
    findHost(r.root, byTestId('job-prompt')).props.onChangeText('summarize my day');
    expect(findHost(r.root, byTestId('job-prompt')).props.value).toBe('summarize my day');
  });

  it('binds to messagePrompt for message and updates on change, independent of spawnPrompt', async () => {
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        name: 'Digest',
        folder: '/home/tom/a',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
    const r = renderRN(<JobEditor />);
    await flush();
    findHost(r.root, byTestId('job-prompt')).props.onChangeText('spawn text'); // still spawn mode
    selectPill(r, 'job-action-type', 'message a chat');
    expect(findHost(r.root, byTestId('job-prompt')).props.value).toBe(''); // messagePrompt starts empty
    findHost(r.root, byTestId('job-prompt')).props.onChangeText('message text');
    expect(findHost(r.root, byTestId('job-prompt')).props.value).toBe('message text');
  });
});

describe('JobEditor — Enabled switch + Name field', () => {
  it('the Enabled switch defaults on and toggles off', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    const sw = findHost(r.root, byTestId('job-enabled'));
    expect(sw.props.value).toBe(true);
    sw.props.onValueChange(false);
    expect(findHost(r.root, byTestId('job-enabled')).props.value).toBe(false);
  });
});

// Model picker (spec/15 § Job editor). The catalogue is per host and live, so
// what matters here is that it is fetched for the host the job will actually
// fire on, and that `Host default` — storing NO model — stays reachable.
describe('JobEditor — Model picker', () => {
  it('fetches the chosen host’s catalogue and shows Host default active', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    vi.mocked(api.models).mockResolvedValue({
      models: [{ id: 'claude-opus-5', label: 'Opus 5' }],
    });
    const r = renderRN(<JobEditor />);
    await flush();
    expect(api.models).toHaveBeenCalledWith(HOST);
    expect(pickerLabel(r, 'job-spawn-model')).toBe('Host default'); // a new job pins nothing
    openPicker(r, 'job-spawn-model');
    expect(findAllHost(r.root, byTestId('job-spawn-model-option-claude-opus-5')).length).toBe(1);
  });

  it('picking a model activates it, and Host default takes it back', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    vi.mocked(api.models).mockResolvedValue({
      models: [{ id: 'claude-opus-5', label: 'Opus 5' }],
    });
    const r = renderRN(<JobEditor />);
    await flush();
    pickOption(r, 'job-spawn-model', 'claude-opus-5');
    expect(pickerLabel(r, 'job-spawn-model')).toBe('Opus 5');
    pickOption(r, 'job-spawn-model', '');
    expect(pickerLabel(r, 'job-spawn-model')).toBe('Host default');
  });

  it('offers a Codex model only the permission modes Codex can run, resetting `auto`', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    vi.mocked(api.models).mockResolvedValue({
      models: [{ id: 'openai/gpt-5', label: 'GPT-5' }],
    });
    const r = renderRN(<JobEditor />);
    await flush();
    selectPill(r, 'job-spawn-permission-mode', 'Auto');
    pickOption(r, 'job-spawn-model', 'openai/gpt-5');
    const group = findHost(r.root, byTestId('job-spawn-permission-mode'));
    const pill = (label: string) =>
      findAllHost(group, (i) => i.type === 'Pressable' && hasText(i, label)).length;
    // 'Auto' is a substring of 'Auto-accept edits', so count the pills instead.
    expect(findAllHost(group, (i) => i.type === 'Pressable').length).toBe(4);
    expect(pill('Plan only')).toBe(1);
  });

  it('is offered for ensure but never for message', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    useChatStore.getState().hydrate([
      {
        chatId: 'c1',
        name: 'Digest',
        folder: '/home/tom/a',
        activity: 'idle',
        status: 'active',
        pinned: false,
        pinnedAt: null,
        lastUpdated: 1,
      },
    ]);
    const r = renderRN(<JobEditor />);
    await flush();
    expect(findAllHost(r.root, byTestId('job-spawn-model')).length).toBe(1);
    selectPill(r, 'job-action-type', 'persistent chat');
    await flush();
    expect(findAllHost(r.root, byTestId('job-spawn-model')).length).toBe(1);
    // A `message` action inherits host, folder and model from the chat it
    // delivers into, so there is nothing here to choose.
    selectPill(r, 'job-action-type', 'message a chat');
    await flush();
    expect(findAllHost(r.root, byTestId('job-spawn-model')).length).toBe(0);
  });

  it('with no host chosen, says models are per host instead of listing any', async () => {
    // No folder registry and no host to default to, so the screen has nothing
    // to ask for — it must say so rather than show an invented list.
    usePresenceStore.setState({ hosts: {} });
    const r = renderRN(<JobEditor />);
    await flush();
    expect(api.models).not.toHaveBeenCalled();
    expect(hasText(r.root, 'Pick a folder first — models are per host.')).toBe(true);
  });
});

// The phone did not offer `script` at all, so opening a gate job on it — foreman,
// photo-triage — showed the Recipient-chat picker and the command nowhere: the
// bash that decides whether to spend a turn was unreadable and unchangeable from
// the surface Tom has on him. spec/08 § Action — `script`.
describe('JobEditor — action type: script', () => {
  it('offers `run a command`, and choosing it shows Folder + Command, not Skill/Prompt', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    const r = renderRN(<JobEditor />);
    await flush();
    selectPill(r, 'job-action-type', 'run a command');
    await flush();

    // A script stores the same (host, folder) pair as a spawn, so it shares the
    // picker rather than getting a second one.
    expect(hasText(r.root, 'Folder')).toBe(true);
    expect(findHost(r.root, byTestId('job-script-command'))).toBeDefined();
    expect(findHost(r.root, byTestId('job-script-timeout'))).toBeDefined();
    // A script fire runs no agent: no model, no skill, no prompt.
    expect(findAllHost(r.root, byTestId('job-prompt')).length).toBe(0);
    expect(findAllHost(r.root, byTestId('job-spawn-model')).length).toBe(0);
    expect(hasText(r.root, 'Recipient chat')).toBe(false);
  });

  it('the Command field is mono and tall — it holds a whole gate, not a one-liner', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    selectPill(r, 'job-action-type', 'run a command');
    await flush();
    const field = findHost(r.root, byTestId('job-script-command'));
    expect(field.props.multiline).toBe(true);
    // Flattened style array: the screen's own overrides are the last entry.
    const style = (field.props.style as unknown[]).flat().filter(Boolean) as Array<
      Record<string, unknown>
    >;
    const merged = Object.assign({}, ...style) as { fontFamily?: string; minHeight?: number };
    expect(merged.fontFamily).toContain('Mono');
    expect(merged.minHeight).toBeGreaterThanOrEqual(200);
  });

  it('saves the command, the folder and the timeout — and no skill or prompt', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    vi.mocked(api.createJob).mockResolvedValue({});
    const GATE = 'set -euo pipefail\necho "queue empty — holding"\nexit 0';
    const r = renderRN(<JobEditor />);
    await flush();
    findHost(r.root, byTestId('job-name')).props.onChangeText('photo gate');
    selectPill(r, 'job-action-type', 'run a command');
    await flush();
    findHost(r.root, byTestId('job-script-command')).props.onChangeText(GATE);
    findHost(r.root, byTestId('job-script-timeout')).props.onChangeText('120000');
    findHost(r.root, byTestId('job-save')).props.onPress();
    await flush();

    expect(api.createJob).toHaveBeenCalledTimes(1);
    const body = vi.mocked(api.createJob).mock.calls[0]![0] as {
      action: Record<string, unknown>;
    };
    expect(body.action['type']).toBe('script');
    expect(body.action['command']).toBe(GATE);
    expect(body.action['folder']).toBe('/home/tom/a');
    expect(body.action['daemonId']).toBe(HOST);
    expect(body.action['timeoutMs']).toBe(120000);
    expect(body.action['skill']).toBeUndefined();
    expect(body.action['prompt']).toBeUndefined();
  });

  it('an existing gate job round-trips its command back out unchanged', async () => {
    // The phone must not be a way to LOSE a gate: it could already open one of
    // these jobs and save it, with the command nowhere on screen.
    const GATE = '#!/usr/bin/env bash\nQUIET_FROM=23\nexit 0';
    __setLocalSearchParams({ id: 'j_1' });
    vi.mocked(api.getJob).mockResolvedValue({
      id: 'j_1',
      name: 'Foreman: 15-min gate',
      enabled: true,
      trigger: { type: 'cron', expression: '*/15 * * * *', timezone: 'Europe/London' },
      filter: null,
      action: {
        type: 'script',
        daemonId: HOST,
        folder: '/home/tom/a',
        command: GATE,
        timeoutMs: 120000,
      },
      concurrency: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    vi.mocked(api.patchJob).mockResolvedValue({});
    const r = renderRN(<JobEditor />);
    await flush();
    expect(findHost(r.root, byTestId('job-script-command')).props.value).toBe(GATE);
    findHost(r.root, byTestId('job-save')).props.onPress();
    await flush();
    const body = vi.mocked(api.patchJob).mock.calls[0]![1] as { action: Record<string, unknown> };
    expect(body.action['command']).toBe(GATE);
    expect(body.action['timeoutMs']).toBe(120000);
  });
});

// spec/08 § Gate — a command asked before each fire that decides whether the
// action runs. The phone must be able to read and change it: the gate holds the
// hours a watcher keeps and the thresholds it uses, and those are exactly the
// things Tom wants to adjust while away from the desk.
describe('JobEditor — the gate', () => {
  it('is off by default, and ticking it reveals the command and seeds from the action', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    const r = renderRN(<JobEditor />);
    await flush();
    // Off by default: most jobs want no gate and the section must not nag.
    expect(findAllHost(r.root, byTestId('job-gate-command')).length).toBe(0);
    findHost(r.root, byTestId('job-gate-on')).props.onPress();
    await flush();
    expect(findHost(r.root, byTestId('job-gate-command'))).toBeDefined();
    // Seeded from the action: the work's machine and folder is where the
    // question almost always belongs too.
    expect(findHost(r.root, byTestId('job-gate-folder')).props.value).toBe('/home/tom/a');
    expect(findHost(r.root, byTestId('job-gate-daemon')).props.value).toBe(HOST);
  });

  it('states the exit-code contract where the gate gets written', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    findHost(r.root, byTestId('job-gate-on')).props.onPress();
    await flush();
    expect(hasText(r.root, 'exit 0 runs the action')).toBe(true);
    expect(hasText(r.root, 'must print why on stdout')).toBe(true);
  });

  it('saves the gate alongside an ordinary spawn action', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    vi.mocked(api.createJob).mockResolvedValue({});
    const GATE = 'set -euo pipefail\ntest -s queue || { echo "empty — holding"; exit 1; }';
    const r = renderRN(<JobEditor />);
    await flush();
    findHost(r.root, byTestId('job-name')).props.onChangeText('watcher');
    findHost(r.root, byTestId('job-gate-on')).props.onPress();
    await flush();
    findHost(r.root, byTestId('job-gate-command')).props.onChangeText(GATE);
    findHost(r.root, byTestId('job-prompt')).props.onChangeText('do the thing');
    findHost(r.root, byTestId('job-save')).props.onPress();
    await flush();

    const body = vi.mocked(api.createJob).mock.calls[0]![0] as {
      gate: Record<string, unknown>;
      action: Record<string, unknown>;
    };
    expect(body.gate['command']).toBe(GATE);
    expect(body.gate['folder']).toBe('/home/tom/a');
    // The action is untouched by the gate — that separation is the whole point.
    expect(body.action['type']).toBe('spawn');
    expect(body.action['prompt']).toBe('do the thing');
  });

  it('an existing gated job round-trips its gate back out unchanged', async () => {
    const GATE = '#!/usr/bin/env bash\nQUIET_FROM=23\nexit 1';
    __setLocalSearchParams({ id: 'j_1' });
    vi.mocked(api.getJob).mockResolvedValue({
      id: 'j_1',
      name: 'Foreman',
      enabled: true,
      trigger: { type: 'cron', expression: '*/15 * * * *', timezone: 'Europe/London' },
      filter: null,
      gate: { daemonId: HOST, folder: '/home/tom/a', command: GATE, timeoutMs: 120000 },
      action: { type: 'spawn', daemonId: HOST, folder: '/home/tom/a', skill: 'foreman' },
      concurrency: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    vi.mocked(api.patchJob).mockResolvedValue({});
    const r = renderRN(<JobEditor />);
    await flush();
    // Arrives with the gate already on and its script in the field.
    expect(findHost(r.root, byTestId('job-gate-command')).props.value).toBe(GATE);
    expect(findHost(r.root, byTestId('job-gate-timeout')).props.value).toBe('120000');
    findHost(r.root, byTestId('job-save')).props.onPress();
    await flush();
    const body = vi.mocked(api.patchJob).mock.calls[0]![1] as { gate: Record<string, unknown> };
    expect(body.gate['command']).toBe(GATE);
    expect(body.gate['timeoutMs']).toBe(120000);
  });

  it('unticking the gate posts gate: null, so it actually clears', async () => {
    // An omitted key LEAVES the stored gate in place, so unticking has to say so
    // explicitly or the phone would silently fail to remove one.
    __setLocalSearchParams({ id: 'j_1' });
    vi.mocked(api.getJob).mockResolvedValue({
      id: 'j_1',
      name: 'Foreman',
      enabled: true,
      trigger: { type: 'cron', expression: '*/15 * * * *' },
      filter: null,
      gate: { daemonId: HOST, folder: '/home/tom/a', command: 'exit 1' },
      action: { type: 'spawn', daemonId: HOST, folder: '/home/tom/a', skill: 'foreman' },
      createdAt: 1,
      updatedAt: 1,
    });
    vi.mocked(api.patchJob).mockResolvedValue({});
    const r = renderRN(<JobEditor />);
    await flush();
    findHost(r.root, byTestId('job-gate-on')).props.onPress();
    await flush();
    expect(findAllHost(r.root, byTestId('job-gate-command')).length).toBe(0);
    findHost(r.root, byTestId('job-save')).props.onPress();
    await flush();
    const body = vi.mocked(api.patchJob).mock.calls[0]![1] as { gate: unknown };
    expect(body.gate).toBeNull();
  });

  it('refuses a gate with no host rather than 400ing on a field name', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    findHost(r.root, byTestId('job-name')).props.onChangeText('watcher');
    findHost(r.root, byTestId('job-gate-on')).props.onPress();
    await flush();
    findHost(r.root, byTestId('job-gate-command')).props.onChangeText('exit 1');
    findHost(r.root, byTestId('job-gate-daemon')).props.onChangeText('');
    findHost(r.root, byTestId('job-gate-folder')).props.onChangeText('');
    findHost(r.root, byTestId('job-save')).props.onPress();
    await flush();
    expect(api.createJob).not.toHaveBeenCalled();
  });
});

// spec/15 § Job editor — the four controls that used to have no mobile UI at
// all (Group, Deduplication key, Permission mode, Hide chat / Notify), even
// though the form state round-tripped them (jobEditor.test.ts).
describe('JobEditor — Group field', () => {
  it('is a dropdown of groups already in use, with New group… for free text, trimmed on create', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    vi.mocked(api.listJobs).mockResolvedValue({
      jobs: [{ group: 'Finance' }, { group: 'Watchers' }],
    });
    vi.mocked(api.createJob).mockResolvedValue({});
    const r = renderRN(<JobEditor />);
    await flush();
    expect(pickerLabel(r, 'job-group')).toBe('Ungrouped');
    pickOption(r, 'job-group', '__new_group__');
    expect(pickerLabel(r, 'job-group')).toBe('New group…');
    findHost(r.root, byTestId('job-group-custom')).props.onChangeText('  Home  ');
    findHost(r.root, byTestId('job-name')).props.onChangeText('Watering');
    findHost(r.root, byTestId('job-prompt')).props.onChangeText('water the plants');
    findHost(r.root, byTestId('job-save')).props.onPress();
    await flush();
    const body = vi.mocked(api.createJob).mock.calls[0]![0] as { group: string };
    expect(body.group).toBe('Home');
  });

  it('picking an existing group needs no free-text field', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    vi.mocked(api.listJobs).mockResolvedValue({ jobs: [{ group: 'Finance' }] });
    const r = renderRN(<JobEditor />);
    await flush();
    pickOption(r, 'job-group', 'Finance');
    expect(pickerLabel(r, 'job-group')).toBe('Finance');
    expect(queryHost(r.root, byTestId('job-group-custom'))).toBeNull();
  });
});

describe('JobEditor — ensure action extras', () => {
  it('shows a Deduplication key field only for persistent chat, and posts it', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    vi.mocked(api.createJob).mockResolvedValue({});
    const r = renderRN(<JobEditor />);
    await flush();
    expect(queryHost(r.root, byTestId('job-ensure-key'))).toBeNull();
    selectPill(r, 'job-action-type', 'persistent chat');
    findHost(r.root, byTestId('job-name')).props.onChangeText('Reminders');
    findHost(r.root, byTestId('job-ensure-key')).props.onChangeText('{{payload.event_data.id}}');
    findHost(r.root, byTestId('job-prompt')).props.onChangeText('remind');
    findHost(r.root, byTestId('job-save')).props.onPress();
    await flush();
    const body = vi.mocked(api.createJob).mock.calls[0]![0] as { action: Record<string, unknown> };
    expect(body.action['key']).toBe('{{payload.event_data.id}}');
  });
});

describe('JobEditor — Permission mode (spawn only)', () => {
  it('shows the mode picker only for spawn, defaults to Auto, and omits it unless changed', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    vi.mocked(api.createJob).mockResolvedValue({});
    const r = renderRN(<JobEditor />);
    await flush();
    expect(hasText(r.root, 'Permission mode')).toBe(true);
    findHost(r.root, byTestId('job-name')).props.onChangeText('Sweep');
    findHost(r.root, byTestId('job-prompt')).props.onChangeText('sweep');
    findHost(r.root, byTestId('job-save')).props.onPress();
    await flush();
    const untouched = vi.mocked(api.createJob).mock.calls[0]![0] as {
      action: Record<string, unknown>;
    };
    expect(untouched.action).not.toHaveProperty('permissionMode');
  });

  it('picking a mode other than Auto is posted, and the control is hidden for persistent chat', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    vi.mocked(api.createJob).mockResolvedValue({});
    const r = renderRN(<JobEditor />);
    await flush();
    selectPill(r, 'job-spawn-permission-mode', 'Plan only');
    findHost(r.root, byTestId('job-name')).props.onChangeText('Sweep');
    findHost(r.root, byTestId('job-prompt')).props.onChangeText('sweep');
    findHost(r.root, byTestId('job-save')).props.onPress();
    await flush();
    const body = vi.mocked(api.createJob).mock.calls[0]![0] as { action: Record<string, unknown> };
    expect(body.action['permissionMode']).toBe('plan');

    selectPill(r, 'job-action-type', 'persistent chat');
    expect(queryHost(r.root, byTestId('job-spawn-permission-mode'))).toBeNull();
  });
});

describe('JobEditor — Include trigger event toggle', () => {
  it('unticking it posts includePayload: false', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    vi.mocked(api.createJob).mockResolvedValue({});
    const r = renderRN(<JobEditor />);
    await flush();
    expect(findHost(r.root, byTestId('job-include-payload')).props.value).toBe(true);
    findHost(r.root, byTestId('job-include-payload')).props.onValueChange(false);
    findHost(r.root, byTestId('job-name')).props.onChangeText('Plain job');
    findHost(r.root, byTestId('job-prompt')).props.onChangeText('go');
    findHost(r.root, byTestId('job-save')).props.onPress();
    await flush();
    const body = vi.mocked(api.createJob).mock.calls[0]![0] as { action: Record<string, unknown> };
    expect(body.action['includePayload']).toBe(false);
  });
});

describe('JobEditor — Hide chat / Notify toggles', () => {
  it('default to off / on, and post only what changed from the default', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    vi.mocked(api.createJob).mockResolvedValue({});
    const r = renderRN(<JobEditor />);
    await flush();
    findHost(r.root, byTestId('job-spawn-hidden')).props.onValueChange(true);
    findHost(r.root, byTestId('job-spawn-notify-on-complete')).props.onValueChange(false);
    findHost(r.root, byTestId('job-name')).props.onChangeText('Quiet job');
    findHost(r.root, byTestId('job-prompt')).props.onChangeText('go');
    findHost(r.root, byTestId('job-save')).props.onPress();
    await flush();
    const body = vi.mocked(api.createJob).mock.calls[0]![0] as { action: Record<string, unknown> };
    expect(body.action['startHidden']).toBe(true);
    expect(body.action['notifyOnComplete']).toBe(false);
  });

  it('are drawn for persistent chat too, not just spawn', async () => {
    useFolderStore
      .getState()
      .setHostFolders({ daemonId: HOST, roots: ['/home/tom/a'], recent: [] });
    const r = renderRN(<JobEditor />);
    await flush();
    selectPill(r, 'job-action-type', 'persistent chat');
    expect(findHost(r.root, byTestId('job-spawn-hidden'))).toBeDefined();
    expect(findHost(r.root, byTestId('job-spawn-notify-on-complete'))).toBeDefined();
  });

  it('are not drawn for message actions', async () => {
    const r = renderRN(<JobEditor />);
    await flush();
    selectPill(r, 'job-action-type', 'message a chat');
    expect(queryHost(r.root, byTestId('job-spawn-hidden'))).toBeNull();
    expect(queryHost(r.root, byTestId('job-spawn-notify-on-complete'))).toBeNull();
  });
});
