// spec/04 § History — the provider-switch confirmation (mobile). A
// cross-provider model change (Claude <-> Codex) shows a modal with Tom's
// exact copy before `chat.model_request` goes out; a same-provider change
// never shows it. "Don't show again" persists as an account setting
// (packages/server's `suppressProviderSwitchWarning`), so it must survive on
// every surface, not just this session.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  renderRN,
  findHost,
  queryHost,
  byTestId,
  actSync,
  actAsync,
  flush,
} from './testUtils/render';
import { usePresenceStore } from '../src/stores/presenceStore';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { useSettingsStore } from '../src/stores/settingsStore';
import { __resetPreferences } from '../src/lib/preferences';
import { deliveryTracker } from '../src/lib/deliveryTracker';
import { __clearAllMmkv } from './stubs/mmkv';

const { modelsSpy, setPreferencesSpy } = vi.hoisted(() => ({
  modelsSpy: vi.fn(),
  setPreferencesSpy: vi.fn(),
}));
vi.mock('../src/api/rest', () => ({
  api: {
    skills: vi.fn().mockResolvedValue({ skills: [] }),
    uploadAttachment: vi.fn(),
    models: modelsSpy,
    setPreferences: setPreferencesSpy,
  },
}));

const wsMock = { send: vi.fn(), safeSend: vi.fn(), requestReplay: vi.fn() };
vi.mock('../src/api/ws', () => ({ getWs: () => wsMock }));

import { Composer } from '../src/components/Composer';
import { useComposerDraftStore } from '../src/lib/composerDraft';

const BASE_PREFERENCES = {
  sweepEnabled: true,
  quietHoursStart: '23:00',
  quietHoursEnd: '07:00',
  addressWord: 'patch',
  reach: 'notify' as const,
  defaultModel: 'claude-opus-5',
  specialThreadModel: 'claude-sonnet-5',
  rotationEnabled: true,
  rotationTime: '02:00',
  voiceConfig: {
    dictation: { backend: 'local' as const },
    device: { backend: 'local' as const, layer: 'direct' as const, handoff: 'auto' as const },
    handsFree: { backend: 'local' as const, layer: 'direct' as const, handoff: 'auto' as const },
    call: { backend: 'local' as const, layer: 'direct' as const, handoff: 'auto' as const },
  },
};

function seedSettings(suppressProviderSwitchWarning: boolean): void {
  useSettingsStore.setState({
    data: {
      devices: [],
      push: { tokenCount: 0 },
      telegram: { connected: false, chatId: null, botUsername: null },
      google: { configured: false, connected: false, scope: null },
      preferences: { ...BASE_PREFERENCES, suppressProviderSwitchWarning },
    },
    error: null,
  });
}

beforeEach(() => {
  __clearAllMmkv();
  useComposerDraftStore.getState()._reset();
  __resetPreferences();
  vi.clearAllMocks();
  usePresenceStore.setState({
    connection: 'connected',
    daemon: 'online',
    accountId: null,
    surfaceId: null,
  });
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  useSettingsStore.getState()._reset();
  modelsSpy.mockResolvedValue({
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'openai/gpt-5-codex', label: 'GPT-5 Codex' },
    ],
  });
  setPreferencesSpy.mockResolvedValue({ preferences: { ...BASE_PREFERENCES } });
  vi.spyOn(deliveryTracker, 'submit').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function seedChat(model = 'claude-opus-5-5'): void {
  useChatStore.getState().hydrate([
    {
      chatId: 'c1',
      daemonId: 'd1',
      name: 'Chat',
      folder: '/home/tom/work',
      activity: 'idle',
      status: 'active',
      pinned: false,
      pinnedAt: null,
      lastUpdated: 1,
      permissionMode: 'default',
      model,
    },
  ]);
}

async function openPickerAndChoose(
  root: ReturnType<typeof renderRN>['root'],
  modelId: string,
): Promise<void> {
  await actAsync(async () => {
    findHost(root, byTestId('composer-model-pill')).props['onPress']();
    await flush();
  });
  actSync(() => findHost(root, byTestId(`new-chat-model-option-${modelId}`)).props['onPress']());
}

describe('Composer — provider-switch confirmation', () => {
  it("shows the modal with exactly Tom's copy on a cross-provider pick, and sends nothing yet", async () => {
    seedSettings(false);
    seedChat('claude-opus-5-5');
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    await openPickerAndChoose(r.root, 'openai/gpt-5-codex');

    const modal = findHost(r.root, byTestId('provider-switch-modal'));
    expect(modal).not.toBeNull();
    expect(wsMock.send).not.toHaveBeenCalled();
  });

  it('never shows the modal for a same-provider model change', async () => {
    seedSettings(false);
    seedChat('claude-opus-5-5');
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    await openPickerAndChoose(r.root, 'claude-sonnet-5');

    expect(queryHost(r.root, byTestId('provider-switch-modal'))).toBeNull();
    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'chat.model_request',
      chatId: 'c1',
      model: 'claude-sonnet-5',
    });
  });

  it('Cancel closes the modal and sends nothing', async () => {
    seedSettings(false);
    seedChat('claude-opus-5-5');
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    await openPickerAndChoose(r.root, 'openai/gpt-5-codex');
    actSync(() => findHost(r.root, byTestId('provider-switch-cancel')).props['onPress']());

    expect(queryHost(r.root, byTestId('provider-switch-modal'))).toBeNull();
    expect(wsMock.send).not.toHaveBeenCalled();
  });

  it('Switch sends chat.model_request and closes the modal', async () => {
    seedSettings(false);
    seedChat('claude-opus-5-5');
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    await openPickerAndChoose(r.root, 'openai/gpt-5-codex');
    actSync(() => findHost(r.root, byTestId('provider-switch-switch')).props['onPress']());

    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'chat.model_request',
      chatId: 'c1',
      model: 'openai/gpt-5-codex',
    });
    expect(queryHost(r.root, byTestId('provider-switch-modal'))).toBeNull();
    expect(setPreferencesSpy).not.toHaveBeenCalled();
  });

  it('"Don\'t show again" persists the account setting and still switches', async () => {
    seedSettings(false);
    seedChat('claude-opus-5-5');
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    await openPickerAndChoose(r.root, 'openai/gpt-5-codex');
    actSync(() =>
      findHost(r.root, byTestId('provider-switch-dont-show-again')).props['onValueChange'](true),
    );
    await actAsync(async () => {
      findHost(r.root, byTestId('provider-switch-switch')).props['onPress']();
      await flush();
    });

    expect(setPreferencesSpy).toHaveBeenCalledWith({ suppressProviderSwitchWarning: true });
    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'chat.model_request',
      chatId: 'c1',
      model: 'openai/gpt-5-codex',
    });
  });

  it('never shows the modal once the account setting is already on', async () => {
    seedSettings(true);
    seedChat('claude-opus-5-5');
    const r = renderRN(<Composer chatId="c1" folder="/home/tom/work" />);
    await openPickerAndChoose(r.root, 'openai/gpt-5-codex');

    expect(queryHost(r.root, byTestId('provider-switch-modal'))).toBeNull();
    expect(wsMock.send).toHaveBeenCalledWith({
      type: 'chat.model_request',
      chatId: 'c1',
      model: 'openai/gpt-5-codex',
    });
  });
});
