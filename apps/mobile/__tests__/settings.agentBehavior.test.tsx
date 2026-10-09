// Settings → Agent (design/settings-redesign): how chats run on the host picked
// in the switcher. Defaults (Model for new chats — account-wide — and the
// host's Permission mode), Questions (expiry, per host), Chats (Warn before
// switching provider, account-wide) and the three Layers added to Claude Code,
// each opened in a full-screen LayerEditor. Per-host writes go to THAT host
// with `host.settings` (or `host.claude_settings_set`); a host that cannot hear
// them is refused up front, naming it.

import React from 'react';
import { act } from 'react-test-renderer';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AgentPage,
  LayerEditor,
  promptSummary,
  toolsPromptSummary,
} from '../src/components/settings/AgentBehaviorSection';
import {
  renderRN,
  findHost,
  queryHost,
  byTestId,
  textOf,
  actAsync,
  flush,
} from './testUtils/render';
import { api } from '../src/api/rest';
import { __getLastAlert, __clearLastAlert } from './stubs/react-native';
import { routerMock, __resetRouterMock } from './stubs/expo-router';
import { useHostRefusalStore } from '../src/stores/hostRefusalStore';
import { useSettingsStore } from '../src/stores/settingsStore';
import {
  reportHost,
  resetHosts,
  seedSettings,
  settingsFixture,
} from './testUtils/settingsFixtures';

const send = vi.fn();
vi.mock('../src/api/ws', () => ({ getWs: () => ({ send }) }));
vi.mock('../src/api/rest', () => ({
  api: { settings: vi.fn(), setPreferences: vi.fn(), models: vi.fn() },
}));

const CATALOGUE = [
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
];

type Inst = ReturnType<typeof findHost>;
type R = ReturnType<typeof renderRN>;

// Every tree is unmounted after its test: a mounted editor left waiting on a
// host would otherwise settle on the next test's store writes.
const mounted: R[] = [];
function mount(el: React.ReactElement): R {
  const r = renderRN(el);
  mounted.push(r);
  return r;
}

const get = (r: R, id: string): Inst => findHost(r.root, byTestId(id));
const query = (r: R, id: string): Inst | null => queryHost(r.root, byTestId(id));

async function openPicker(r: R, picker: string): Promise<void> {
  await actAsync(() => get(r, picker).props.onPress());
}

async function pick(r: R, picker: string, id: string): Promise<void> {
  await openPicker(r, picker);
  await actAsync(async () => {
    get(r, `${picker}-option-${id}`).props.onPress();
    await flush();
  });
}

/** Render the Agent page and let the model catalogue settle. */
async function renderAgent(): Promise<R> {
  const r = mount(<AgentPage />);
  await flush();
  return r;
}

beforeEach(() => {
  send.mockReset();
  __clearLastAlert();
  __resetRouterMock();
  useHostRefusalStore.getState()._reset();
  useSettingsStore.getState()._reset();
  vi.mocked(api.settings).mockReset().mockResolvedValue(settingsFixture());
  vi.mocked(api.setPreferences)
    .mockReset()
    .mockImplementation(async (patch) => ({
      preferences: { ...settingsFixture().preferences, ...patch },
    }));
  vi.mocked(api.models).mockReset().mockResolvedValue({ models: CATALOGUE });
  resetHosts();
  reportHost('d1', {
    hostName: 'laptop',
    isHomeHost: true,
    harnessToolsPromptDefault: 'Use patch tools.',
    harnessSystemPrompt: '',
    questionExpiry: true,
    questionExpirySeconds: 60,
  });
  seedSettings();
});

afterEach(() => {
  for (const r of mounted.splice(0)) {
    try {
      act(() => r.unmount());
    } catch {
      // already unmounted by the test
    }
  }
  vi.useRealTimers();
});

describe('Agent page: frame', () => {
  // Every row is a shared setting (spec/01 § Settings): nothing here is about
  // one machine, so there is no switcher and no host to be missing.
  it('draws every control with no machine registered, and no switcher', async () => {
    resetHosts();
    const r = await renderAgent();
    expect(get(r, 'default-model')).toBeTruthy();
    expect(get(r, 'permission-default')).toBeTruthy();
    expect(get(r, 'question-expiry-toggle')).toBeTruthy();
    expect(get(r, 'harness-config')).toBeTruthy();
    expect(query(r, 'host-switcher')).toBeNull();
  });

  it('draws no switcher even with two hosts', async () => {
    reportHost('d2', { hostName: 'mac' });
    const r = await renderAgent();
    expect(query(r, 'host-switcher')).toBeNull();
  });
});

describe('Agent page: Model for new chats', () => {
  it('offers the home machine’s catalogue and saves the choice', async () => {
    const r = await renderAgent();
    expect(api.models).toHaveBeenCalledWith('d1');
    expect(textOf(get(r, 'default-model'))).toBe('Opus 5');
    await pick(r, 'default-model', 'claude-sonnet-5');
    expect(api.setPreferences).toHaveBeenCalledWith({ defaultModel: 'claude-sonnet-5' });
    expect(textOf(get(r, 'default-model'))).toBe('Sonnet 5');
  });

  it('keeps a saved model the catalogue no longer offers, so a visit cannot unpin it', async () => {
    seedSettings({ preferences: { ...settingsFixture().preferences, defaultModel: 'old-model' } });
    const r = await renderAgent();
    expect(textOf(get(r, 'default-model'))).toBe('old-model');
    await openPicker(r, 'default-model');
    expect(get(r, 'default-model-option-old-model')).toBeTruthy();
  });

  it('with no home machine says where the list would come from', async () => {
    resetHosts();
    reportHost('a');
    reportHost('b');
    const r = await renderAgent();
    expect(api.models).not.toHaveBeenCalled();
    expect(textOf(get(r, 'default-model-no-host'))).toBe('Make a host home to list models');
  });

  it('a catalogue failure is shown', async () => {
    vi.mocked(api.models).mockRejectedValue(new Error('host offline'));
    const r = await renderAgent();
    expect(textOf(get(r, 'default-model-error'))).toBe(
      'Couldn’t load the model list: host offline',
    );
  });

  it('a failed save is reported and the shown value stays the server’s', async () => {
    vi.mocked(api.setPreferences).mockRejectedValue(new Error('HTTP 400'));
    const r = await renderAgent();
    await pick(r, 'default-model', 'claude-sonnet-5');
    expect(__getLastAlert()).toEqual({
      title: 'Settings failed',
      message: 'HTTP 400',
      buttons: undefined,
    });
    expect(textOf(get(r, 'default-model'))).toBe('Opus 5');
  });

  it('draws a loading affordance until settings load, then the failure', async () => {
    useSettingsStore.getState()._reset();
    const r = await renderAgent();
    expect(get(r, 'agent-defaults-loading')).toBeTruthy();
    expect(query(r, 'default-model')).toBeNull();
    await actAsync(() => useSettingsStore.setState({ error: 'HTTP 502' }));
    expect(textOf(get(r, 'agent-defaults-error'))).toBe('Couldn’t load settings: HTTP 502');
  });
});

describe('Agent page: Permission mode', () => {
  it('shows the shared default and writes a change to the server', async () => {
    seedSettings({
      preferences: { ...settingsFixture().preferences, permissionModeDefault: 'acceptEdits' },
    });
    const r = await renderAgent();
    expect(textOf(get(r, 'permission-default'))).toBe('Accept edits');
    await pick(r, 'permission-default', 'plan');
    expect(api.setPreferences).toHaveBeenCalledWith({ permissionModeDefault: 'plan' });
    expect(send).not.toHaveBeenCalled();
  });

  it('offers exactly the five SDK modes', async () => {
    const r = await renderAgent();
    await openPicker(r, 'permission-default');
    for (const m of ['auto', 'default', 'acceptEdits', 'bypassPermissions', 'plan']) {
      expect(get(r, `permission-default-option-${m}`)).toBeTruthy();
    }
  });

  it('is pressable with no host online — it is the server’s to change', async () => {
    resetHosts();
    const r = await renderAgent();
    expect(get(r, 'permission-default').props.disabled).not.toBe(true);
  });
});

describe('Agent page: Questions', () => {
  it('the toggle writes questionExpiry; seconds are bounded and saved on blur or submit', async () => {
    const r = await renderAgent();
    expect(get(r, 'question-expiry-toggle').props.value).toBe(true);
    await actAsync(async () => {
      get(r, 'question-expiry-toggle').props.onValueChange(false);
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ questionExpiry: false });
    await actAsync(() => get(r, 'question-expiry-seconds').props.onChangeText('2'));
    await actAsync(() => get(r, 'question-expiry-seconds').props.onBlur());
    expect(__getLastAlert()?.title).toBe('Invalid value');
    expect(get(r, 'question-expiry-seconds').props.value).toBe('600');
    await actAsync(() => get(r, 'question-expiry-seconds').props.onChangeText('120'));
    await actAsync(async () => {
      get(r, 'question-expiry-seconds').props.onSubmitEditing();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ questionExpirySeconds: 120 });
  });

  it('a refused seconds write returns the field to the saved value', async () => {
    vi.mocked(api.setPreferences).mockRejectedValue(new Error('HTTP 400'));
    const r = await renderAgent();
    const was = String(settingsFixture().preferences.questionExpirySeconds);
    await actAsync(() => get(r, 'question-expiry-seconds').props.onChangeText('120'));
    await actAsync(async () => {
      get(r, 'question-expiry-seconds').props.onBlur();
      await flush();
    });
    expect(__getLastAlert()?.title).toBe('Question timeout failed');
    expect(get(r, 'question-expiry-seconds').props.value).toBe(was);
  });
});

describe('Agent page: Chats', () => {
  it('Warn before switching provider writes the inverse, suppressProviderSwitchWarning', async () => {
    seedSettings({
      preferences: { ...settingsFixture().preferences, suppressProviderSwitchWarning: false },
    });
    const r = await renderAgent();
    expect(get(r, 'provider-switch-warning').props.value).toBe(true);
    await actAsync(async () => {
      get(r, 'provider-switch-warning').props.onValueChange(false);
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ suppressProviderSwitchWarning: true });
    expect(get(r, 'provider-switch-warning').props.value).toBe(false);
  });

  // spec/15 § Settings tab — the same account preference web's Chats group
  // writes: the provider-level context bar's default expand state.
  it('Provider-level context shows the saved choice and writes a new one', async () => {
    seedSettings({
      preferences: { ...settingsFixture().preferences, providerContextVerbosity: 'summary' },
    });
    const r = await renderAgent();
    expect(get(r, 'provider-context-verbosity-summary').props.accessibilityState.selected).toBe(
      true,
    );
    expect(get(r, 'provider-context-verbosity-full').props.accessibilityState.selected).toBe(false);
    await actAsync(async () => {
      get(r, 'provider-context-verbosity-off').props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ providerContextVerbosity: 'off' });
  });
});

describe('Agent page: Layers added to Claude Code', () => {
  it('summarises each layer, reading the built-in tools text from a host', async () => {
    const r = await renderAgent();
    expect(textOf(get(r, 'tools-summary'))).toBe('Built-in default');
    expect(textOf(get(r, 'system-summary'))).toBe('None');
    expect(textOf(get(r, 'claude-shared-summary'))).toBe('None');
    expect(textOf(get(r, 'claude-darwin-summary'))).toBe('None');
    expect(textOf(get(r, 'claude-linux-summary'))).toBe('None');
  });

  it('says Off / Edited for the tools prompt, and clips the system prompt’s first line', async () => {
    seedSettings({
      preferences: {
        ...settingsFixture().preferences,
        harnessToolsPrompt: '',
        harnessSystemPrompt: 'Be terse.\nAlways.',
        claudeSettings: { shared: '{"model":"opus"}', darwin: '', linux: '' },
      },
    });
    const r = await renderAgent();
    expect(textOf(get(r, 'tools-summary'))).toBe('Off');
    expect(textOf(get(r, 'system-summary'))).toBe('Be terse.');
    expect(textOf(get(r, 'claude-shared-summary'))).toBe('Set');
  });

  it('each Edit opens that layer’s editor', async () => {
    const r = await renderAgent();
    await actAsync(() => get(r, 'claude-darwin-edit').props.onPress());
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/settings/layer',
      params: { layer: 'claude-darwin' },
    });
  });

  it('summary helpers', () => {
    expect(promptSummary(undefined)).toBe('None');
    expect(promptSummary('x'.repeat(60))).toHaveLength(48);
    expect(toolsPromptSummary(null, 'd')).toBe('Built-in default');
    expect(toolsPromptSummary('d', 'd')).toBe('Built-in default');
    expect(toolsPromptSummary('', 'd')).toBe('Off');
    expect(toolsPromptSummary('', '')).toBe('Off');
    expect(toolsPromptSummary('mine', 'd')).toBe('Edited');
  });
});

describe('LayerEditor', () => {
  it('tools: starts from the built-in default; Save is disabled until changed, then writes and returns', async () => {
    const r = mount(<LayerEditor layer="tools" />);
    expect(get(r, 'layer-editor-text').props.value).toBe('Use patch tools.');
    expect(get(r, 'layer-editor-save').props.disabled).toBe(true);
    await actAsync(() => get(r, 'layer-editor-text').props.onChangeText('Mine.'));
    await actAsync(async () => {
      get(r, 'layer-editor-save').props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ harnessToolsPrompt: 'Mine.' });
    expect(routerMock.back).toHaveBeenCalled();
  });

  it('tools: Reset is disabled with no custom prompt; with one it writes null', async () => {
    const r1 = mount(<LayerEditor layer="tools" />);
    expect(get(r1, 'layer-editor-reset').props.disabled).toBe(true);
    seedSettings({
      preferences: { ...settingsFixture().preferences, harnessToolsPrompt: 'Mine.' },
    });
    const r2 = mount(<LayerEditor layer="tools" />);
    await actAsync(async () => {
      get(r2, 'layer-editor-reset').props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ harnessToolsPrompt: null });
  });

  it('an OS override saves into its own part of claudeSettings', async () => {
    const r = mount(<LayerEditor layer="claude-linux" />);
    await actAsync(() => get(r, 'layer-editor-text').props.onChangeText('{"hooks":{}}'));
    await actAsync(async () => {
      get(r, 'layer-editor-save').props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({
      claudeSettings: { shared: '', darwin: '', linux: '{"hooks":{}}' },
    });
  });

  it('a refusal is shown in the server’s own words, and the editor stays', async () => {
    vi.mocked(api.setPreferences).mockRejectedValue(
      Object.assign(new Error('HTTP 400'), {
        body: { error: 'invalid_input', message: 'claudeSettings.shared is not valid JSON' },
      }),
    );
    const r = mount(<LayerEditor layer="claude-shared" />);
    await actAsync(() => get(r, 'layer-editor-text').props.onChangeText('{'));
    await actAsync(async () => {
      get(r, 'layer-editor-save').props.onPress();
      await flush();
    });
    expect(textOf(get(r, 'layer-editor-error'))).toContain('is not valid JSON');
    expect(routerMock.back).not.toHaveBeenCalled();
  });

  it('Cancel returns without writing', async () => {
    const r = mount(<LayerEditor layer="system" />);
    await actAsync(() => get(r, 'layer-editor-cancel').props.onPress());
    expect(api.setPreferences).not.toHaveBeenCalled();
    expect(routerMock.back).toHaveBeenCalled();
  });

  it('says so while settings have not loaded', () => {
    useSettingsStore.getState()._reset();
    const r = mount(<LayerEditor layer="tools" />);
    expect(get(r, 'layer-editor-unavailable')).toBeTruthy();
  });
});
