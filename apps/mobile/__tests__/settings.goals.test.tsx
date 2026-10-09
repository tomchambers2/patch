// Settings → Goals (spec/14 § `/settings` details — Goals): the judge model, how
// many refusals in a row end a goal's pushing, and the judge prompt, edited in the
// same full-screen editor as the other prompts. Account-wide shared settings.

import React from 'react';
import { act } from 'react-test-renderer';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_GOAL_EVAL_PROMPT } from '@patch/wire';
import { LayerEditor } from '../src/components/settings/AgentBehaviorSection';
import { GoalsPage } from '../src/components/settings/GoalsSection';
import { SETTINGS_PAGES, settingsPage } from '../src/components/settings/pages';
import { renderRN, findHost, byTestId, textOf, actAsync, flush } from './testUtils/render';
import { api } from '../src/api/rest';
import { routerMock, __resetRouterMock } from './stubs/expo-router';
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
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-opus-5', label: 'Opus 5' },
];

type R = ReturnType<typeof renderRN>;
const mounted: R[] = [];
function mount(el: React.ReactElement): R {
  const r = renderRN(el);
  mounted.push(r);
  return r;
}
const get = (r: R, id: string): ReturnType<typeof findHost> => findHost(r.root, byTestId(id));

beforeEach(() => {
  send.mockReset();
  __resetRouterMock();
  useSettingsStore.getState()._reset();
  vi.mocked(api.settings).mockReset().mockResolvedValue(settingsFixture());
  vi.mocked(api.setPreferences)
    .mockReset()
    .mockImplementation(async (patch) => ({
      preferences: { ...settingsFixture().preferences, ...patch },
    }));
  vi.mocked(api.models).mockReset().mockResolvedValue({ models: CATALOGUE });
  resetHosts();
  reportHost('home', { hostName: 'laptop', isHomeHost: true });
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
});

describe('Settings → Goals', () => {
  it('is a page of its own, between Manager and Voice', () => {
    const ids = SETTINGS_PAGES.map((p) => p.id);
    expect(ids.indexOf('goals')).toBe(ids.indexOf('manager') + 1);
    expect(ids.indexOf('voice')).toBe(ids.indexOf('goals') + 1);
    expect(settingsPage('goals')?.title).toBe('Goals');
  });

  it('shows Sonnet 5.5 as the judge model by default, and writes a pick', async () => {
    const r = mount(<GoalsPage />);
    await flush();
    expect(textOf(get(r, 'goal-model'))).toBe('Sonnet 5.5');
    await actAsync(() => get(r, 'goal-model').props.onPress());
    await actAsync(async () => {
      get(r, 'goal-model-option-claude-opus-5').props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ goalModel: 'claude-opus-5' });
  });

  it('writes the refusal limit on blur, and puts back a value that is not a positive whole number', async () => {
    const r = mount(<GoalsPage />);
    expect(get(r, 'goal-refusal-limit').props.value).toBe('3');
    await actAsync(() => get(r, 'goal-refusal-limit').props.onChangeText('0'));
    await actAsync(() => get(r, 'goal-refusal-limit').props.onBlur());
    expect(api.setPreferences).not.toHaveBeenCalled();
    expect(get(r, 'goal-refusal-limit').props.value).toBe('3');

    await actAsync(() => get(r, 'goal-refusal-limit').props.onChangeText('2.5'));
    await actAsync(() => get(r, 'goal-refusal-limit').props.onBlur());
    expect(api.setPreferences).not.toHaveBeenCalled();

    await actAsync(() => get(r, 'goal-refusal-limit').props.onChangeText('5'));
    await actAsync(async () => {
      get(r, 'goal-refusal-limit').props.onBlur();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ goalRefusalLimit: 5 });
  });

  it('says whether the judge prompt is the built-in one, and opens its editor', async () => {
    const r = mount(<GoalsPage />);
    expect(textOf(get(r, 'goal-judge-summary'))).toBe('Built-in default');
    await actAsync(() => get(r, 'goal-judge-edit').props.onPress());
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/settings/layer',
      params: { layer: 'goal-judge' },
    });
  });

  it('shows the first line of a prompt that has been edited', async () => {
    seedSettings({
      preferences: { ...settingsFixture().preferences, goalEvalPrompt: 'Judge harshly.\nAlways.' },
    });
    const r = mount(<GoalsPage />);
    expect(textOf(get(r, 'goal-judge-summary'))).toBe('Judge harshly.');
  });
});

describe('the goal judge prompt editor', () => {
  it('starts from the saved prompt, saves an edit and returns', async () => {
    const r = mount(<LayerEditor layer="goal-judge" />);
    expect(get(r, 'layer-editor-text').props.value).toBe(DEFAULT_GOAL_EVAL_PROMPT);
    expect(get(r, 'layer-editor-save').props.disabled).toBe(true);
    await actAsync(() => get(r, 'layer-editor-text').props.onChangeText('Judge harshly.'));
    await actAsync(async () => {
      get(r, 'layer-editor-save').props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ goalEvalPrompt: 'Judge harshly.' });
    expect(routerMock.back).toHaveBeenCalled();
  });

  it('Reset is disabled on the default, and with an edited prompt writes the default back', async () => {
    const r1 = mount(<LayerEditor layer="goal-judge" />);
    expect(get(r1, 'layer-editor-reset').props.disabled).toBe(true);

    seedSettings({
      preferences: { ...settingsFixture().preferences, goalEvalPrompt: 'Mine.' },
    });
    const r2 = mount(<LayerEditor layer="goal-judge" />);
    await actAsync(async () => {
      get(r2, 'layer-editor-reset').props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ goalEvalPrompt: DEFAULT_GOAL_EVAL_PROMPT });
  });
});
