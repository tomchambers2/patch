// Settings → Manager and Settings → Voice (design/settings-redesign), plus the
// account-preferences store behind them (GET/PATCH /api/settings, spec/14 §
// `/settings` details). Account-wide rows write a partial PATCH through
// `api.setPreferences` exactly as web does and report a failed write rather
// than swallowing it. Voice's Speaking group is per host (the one picked in
// the switcher) and writes that host with `host.settings`.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react-test-renderer';
import {
  KOKORO_VOICES,
  ManagerPage,
  VoicePage,
  voiceCellStatus,
  writePreferences,
} from '../src/components/settings/PreferenceSections';
import {
  renderRN as renderBase,
  findHost,
  findAllHost,
  queryHost,
  byTestId,
  byLabel,
  textOf,
  actAsync,
  flush,
} from './testUtils/render';
import { api } from '../src/api/rest';
import { __getLastAlert, __clearLastAlert } from './stubs/react-native';
import { useSettingsStore } from '../src/stores/settingsStore';
import { addressWordOrNull } from '../src/lib/preferences';
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

beforeEach(() => {
  vi.mocked(api.settings).mockReset().mockResolvedValue(settingsFixture());
  vi.mocked(api.setPreferences)
    .mockReset()
    .mockImplementation(async (patch) => ({
      preferences: { ...settingsFixture().preferences, ...patch },
    }));
  vi.mocked(api.models).mockReset().mockResolvedValue({ models: CATALOGUE });
  send.mockReset();
  __clearLastAlert();
  useSettingsStore.getState()._reset();
  resetHosts();
  reportHost('home', { hostName: 'laptop', isHomeHost: true });
});

// Every tree is unmounted after its test, so a page left mounted cannot react
// to (and fetch for) the next test's store writes.
const mounted: ReturnType<typeof renderBase>[] = [];
function renderRN(el: React.ReactElement): ReturnType<typeof renderBase> {
  const r = renderBase(el);
  mounted.push(r);
  return r;
}

afterEach(() => {
  for (const r of mounted.splice(0)) {
    try {
      act(() => r.unmount());
    } catch {
      // already unmounted by the test
    }
  }
});

async function pick(r: ReturnType<typeof renderRN>, picker: string, id: string): Promise<void> {
  await actAsync(() => findHost(r.root, byTestId(picker)).props.onPress());
  await actAsync(async () => {
    findHost(r.root, byTestId(`${picker}-option-${id}`)).props.onPress();
    await flush();
  });
}

describe('settings store', () => {
  it('load() keeps the response; a failure lands in `error`, never a stand-in', async () => {
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().data?.preferences.addressWord).toBe('patch');
    vi.mocked(api.settings).mockRejectedValueOnce(new Error('HTTP 500'));
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().error).toBe('HTTP 500');
    // The last good read stays; the failure is reported alongside it.
    expect(useSettingsStore.getState().data).not.toBeNull();
  });

  it('a response with no preferences is an error, not an empty account', async () => {
    vi.mocked(api.settings).mockResolvedValueOnce({
      ...settingsFixture(),
      preferences: undefined,
    } as never);
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().error).toBe('server returned no account preferences');
    expect(useSettingsStore.getState().data).toBeNull();
  });

  it('the address word a quiet call uses follows a Settings edit', async () => {
    seedSettings();
    await useSettingsStore.getState().updatePreferences({ addressWord: 'otto' });
    expect(addressWordOrNull()).toBe('otto');
  });
});

describe('sections before the settings have loaded', () => {
  it('draw a loading affordance, then the failure with a working Retry', async () => {
    const r = renderRN(<ManagerPage />);
    expect(findHost(r.root, byTestId('manager-loading'))).toBeTruthy();
    await actAsync(() => useSettingsStore.setState({ error: 'HTTP 502' }));
    expect(textOf(findHost(r.root, byTestId('manager-error')))).toBe(
      'Couldn’t load settings: HTTP 502',
    );
    await actAsync(async () => {
      findHost(r.root, byLabel('Retry')).props.onPress();
      await flush();
    });
    expect(api.settings).toHaveBeenCalled();
    expect(findHost(r.root, byTestId('manager-watching')).props.value).toBe(true);
  });
});

describe('Voice (per-surface config matrix)', () => {
  it('draws all four surfaces from the account’s saved config', () => {
    seedSettings();
    const r = renderRN(<VoicePage />);
    for (const s of ['dictation', 'device', 'handsFree', 'call']) {
      expect(
        findHost(r.root, byTestId(`voice-${s}-backend-local`)).props.accessibilityState.selected,
      ).toBe(true);
    }
    // Dictation has no front layer.
    expect(queryHost(r.root, byTestId('voice-dictation-layer-direct'))).toBeNull();
    expect(queryHost(r.root, byTestId('voice-call-status'))).toBeNull();
  });

  it('a hosted backend is selectable, written through, and says what "direct" runs as', async () => {
    seedSettings();
    const r = renderRN(<VoicePage />);
    await actAsync(async () => {
      findHost(r.root, byTestId('voice-call-backend-openai')).props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({
      voiceConfig: expect.objectContaining({
        call: { backend: 'openai', layer: 'direct', handoff: 'auto' },
      }),
    });
    expect(textOf(findHost(r.root, byTestId('voice-call-status')))).toMatch(/runs as "light"/);
  });

  it('a cell that does nothing yet is selectable, written through, and says so', async () => {
    seedSettings();
    const r = renderRN(<VoicePage />);
    await actAsync(async () => {
      findHost(r.root, byTestId('voice-device-backend-openai')).props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({
      voiceConfig: expect.objectContaining({
        device: { backend: 'openai', layer: 'direct', handoff: 'auto' },
      }),
    });
    expect(textOf(findHost(r.root, byTestId('voice-device-status')))).toMatch(
      /Not implemented yet/,
    );
  });

  it('changing a layer keeps the backend', async () => {
    seedSettings();
    const r = renderRN(<VoicePage />);
    await actAsync(async () => {
      findHost(r.root, byTestId('voice-handsFree-layer-light')).props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({
      voiceConfig: expect.objectContaining({
        handsFree: { backend: 'local', layer: 'light', handoff: 'auto' },
      }),
    });
  });

  it('the hand-off chips appear only on a hosted backend and keep backend and layer', async () => {
    seedSettings();
    const r = renderRN(<VoicePage />);
    expect(queryHost(r.root, byTestId('voice-call-handoff-always'))).toBeNull();
    await actAsync(async () => {
      findHost(r.root, byTestId('voice-call-backend-gemini')).props.onPress();
      await flush();
    });
    await actAsync(async () => {
      findHost(r.root, byTestId('voice-call-handoff-always')).props.onPress();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenLastCalledWith({
      voiceConfig: expect.objectContaining({
        call: { backend: 'gemini', layer: 'direct', handoff: 'always' },
      }),
    });
  });

  it('every chip is disabled while a write is in flight, and freed when it settles', async () => {
    seedSettings();
    let settle!: () => void;
    vi.mocked(api.setPreferences).mockImplementationOnce(
      (patch) =>
        new Promise((resolve) => {
          settle = () => resolve({ preferences: { ...settingsFixture().preferences, ...patch } });
        }),
    );
    const r = renderRN(<VoicePage />);
    const chips = (): ReturnType<typeof findAllHost> =>
      findAllHost(r.root, (i) => /^voice-\w+-(backend|layer)-\w+$/.test(String(i.props.testID)));
    expect(chips().every((c) => c.props.disabled === false)).toBe(true);
    await actAsync(() => findHost(r.root, byTestId('voice-call-layer-heavy')).props.onPress());
    expect(chips().length).toBeGreaterThan(0);
    expect(chips().every((c) => c.props.disabled === true)).toBe(true);
    await actAsync(async () => {
      settle();
      await flush();
    });
    expect(chips().every((c) => c.props.disabled === false)).toBe(true);
    expect(
      findHost(r.root, byTestId('voice-call-layer-heavy')).props.accessibilityState.selected,
    ).toBe(true);
  });

  it('a failed write is reported, and frees the chips', async () => {
    vi.mocked(api.setPreferences).mockRejectedValue(new Error('nope'));
    seedSettings();
    const r = renderRN(<VoicePage />);
    await actAsync(async () => {
      findHost(r.root, byTestId('voice-dictation-backend-gemini')).props.onPress();
      await flush();
    });
    expect(__getLastAlert()?.title).toBe('Settings failed');
    expect(__getLastAlert()?.message).toBe('nope');
    expect(
      findHost(r.root, byTestId('voice-dictation-backend-local')).props.accessibilityState,
    ).toEqual({ selected: true, disabled: false });
  });

  it('a hosted cell names each host with no key for it as not configured there', () => {
    // Tom's live config, 2026-09-24, on a host holding neither key.
    reportHost('hetzner', { hostName: 'hetzner', voiceKeys: { gemini: false, openai: false } });
    reportHost('home', {
      hostName: 'laptop',
      isHomeHost: true,
      voiceKeys: { gemini: true, openai: false },
    });
    const base = settingsFixture().preferences;
    seedSettings({
      preferences: {
        ...base,
        voiceConfig: {
          dictation: { backend: 'gemini' },
          device: { backend: 'openai', layer: 'light', handoff: 'auto' },
          handsFree: { backend: 'local', layer: 'direct', handoff: 'auto' },
          call: { backend: 'local', layer: 'direct', handoff: 'auto' },
        },
      },
    });
    const r = renderRN(<VoicePage />);
    expect(textOf(findHost(r.root, byTestId('voice-dictation-keys')))).toBe(
      'Not configured on hetzner: GEMINI_API_KEY is missing. Sessions there are refused.',
    );
    expect(textOf(findHost(r.root, byTestId('voice-device-keys')))).toBe(
      'Not configured on laptop, hetzner: OPENAI_REALTIME_API_KEY is missing. Sessions there are refused.',
    );
    expect(queryHost(r.root, byTestId('voice-call-keys'))).toBeNull();
    expect(queryHost(r.root, byTestId('voice-handsFree-keys'))).toBeNull();
  });

  // spec/02 § Provider keys: a key set from Settings → Hosts → Keys applies
  // with no restart, and the host's next report is what clears the line.
  it('clears the line live when the host reports the key has been set', async () => {
    reportHost('hetzner', { hostName: 'hetzner', voiceKeys: { gemini: false, openai: false } });
    const base = settingsFixture().preferences;
    seedSettings({
      preferences: {
        ...base,
        voiceConfig: { ...base.voiceConfig, dictation: { backend: 'gemini' } },
      },
    });
    const r = renderRN(<VoicePage />);
    expect(queryHost(r.root, byTestId('voice-dictation-keys'))).not.toBeNull();
    await actAsync(() =>
      reportHost('hetzner', { hostName: 'hetzner', voiceKeys: { gemini: true, openai: false } }),
    );
    expect(queryHost(r.root, byTestId('voice-dictation-keys'))).toBeNull();
  });

  it('a host that has not reported its keys is not called unconfigured', () => {
    const base = settingsFixture().preferences;
    seedSettings({
      preferences: {
        ...base,
        voiceConfig: { ...base.voiceConfig, dictation: { backend: 'gemini' } },
      },
    });
    const r = renderRN(<VoicePage />);
    expect(queryHost(r.root, byTestId('voice-dictation-keys'))).toBeNull();
  });

  it('states each cell honestly — the same words web uses', () => {
    expect(voiceCellStatus('device', 'gemini', 'light')).toMatch(/for this surface/);
    expect(voiceCellStatus('device', 'openai', 'heavy')).toMatch(/for this surface/);
    expect(voiceCellStatus('call', 'local', 'heavy')).toMatch(/no front model built for local/);
    expect(voiceCellStatus('call', 'openai', 'direct')).toMatch(/runs as "light"/);
    expect(voiceCellStatus('handsFree', 'gemini', 'light')).toMatch(/address word is not enforced/);
    // Every cell that works as configured says nothing.
    for (const backend of ['local', 'gemini', 'openai'] as const) {
      expect(voiceCellStatus('dictation', backend)).toBeNull();
    }
    for (const layer of ['light', 'heavy'] as const) {
      expect(voiceCellStatus('call', 'gemini', layer)).toBeNull();
      expect(voiceCellStatus('call', 'openai', layer)).toBeNull();
      expect(voiceCellStatus('handsFree', 'openai', layer)).toBeNull();
    }
    expect(voiceCellStatus('call', 'local', 'direct')).toBeNull();
  });
});

describe('Manager page', () => {
  it('draws its two groups in order, with the redesign’s labels', () => {
    seedSettings();
    const r = renderRN(<ManagerPage />);
    expect(textOf(findHost(r.root, byTestId('settings-page-title')))).toBe('Manager');
    const manager = findHost(r.root, byTestId('settings-manager'));
    expect(textOf(manager)).toContain('Enabled');
    expect(textOf(manager)).not.toContain('Watching');
    expect(textOf(manager)).toContain('Quiet hours');
    expect(textOf(manager)).toContain('Address word');
    const threads = findHost(r.root, byTestId('settings-special-threads'));
    expect(textOf(threads)).toContain('Start a fresh session daily');
    // No host switcher: nothing here belongs to one machine.
    reportHost('other', { hostName: 'mac' });
    expect(queryHost(renderRN(<ManagerPage />).root, byTestId('host-switcher'))).toBeNull();
  });

  it('Enabled writes sweepEnabled', async () => {
    seedSettings();
    const r = renderRN(<ManagerPage />);
    expect(findHost(r.root, byTestId('manager-watching')).props.value).toBe(true);
    await actAsync(async () => {
      findHost(r.root, byTestId('manager-watching')).props.onValueChange(false);
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ sweepEnabled: false });
    expect(findHost(r.root, byTestId('manager-watching')).props.value).toBe(false);
  });

  it('a failed write is reported and the switch keeps what the server holds', async () => {
    vi.mocked(api.setPreferences).mockRejectedValue(new Error('HTTP 503'));
    seedSettings();
    const r = renderRN(<ManagerPage />);
    await actAsync(async () => {
      findHost(r.root, byTestId('manager-watching')).props.onValueChange(false);
      await flush();
    });
    expect(__getLastAlert()).toEqual({
      title: 'Settings failed',
      message: 'HTTP 503',
      buttons: undefined,
    });
    expect(findHost(r.root, byTestId('manager-watching')).props.value).toBe(true);
  });

  it('quiet hours commit a valid HH:MM on blur, and refuse anything else', async () => {
    seedSettings();
    const r = renderRN(<ManagerPage />);
    const start = (): ReturnType<typeof findHost> =>
      findHost(r.root, byTestId('manager-quiet-start'));
    expect(start().props.value).toBe('23:00');
    await actAsync(() => start().props.onChangeText('22:30'));
    await actAsync(async () => {
      start().props.onBlur();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ quietHoursStart: '22:30' });
    vi.mocked(api.setPreferences).mockClear();
    const end = (): ReturnType<typeof findHost> => findHost(r.root, byTestId('manager-quiet-end'));
    for (const bad of ['25:00', '7:30', '07:60', 'noon']) {
      __clearLastAlert();
      await actAsync(() => end().props.onChangeText(bad));
      await actAsync(() => end().props.onBlur());
      expect(__getLastAlert()).toEqual({
        title: 'Invalid time',
        message: 'Quiet hours end must be a 24-hour time like 07:30.',
        buttons: undefined,
      });
      expect(end().props.value).toBe('07:00');
    }
    // An unchanged value is not re-sent.
    await actAsync(() => end().props.onBlur());
    expect(api.setPreferences).not.toHaveBeenCalled();
  });

  it('address word saves a new word, and an emptied field returns to the saved one', async () => {
    seedSettings();
    const r = renderRN(<ManagerPage />);
    const field = (): ReturnType<typeof findHost> =>
      findHost(r.root, byTestId('manager-address-word'));
    await actAsync(() => field().props.onChangeText('  '));
    await actAsync(() => field().props.onBlur());
    expect(api.setPreferences).not.toHaveBeenCalled();
    expect(field().props.value).toBe('patch');
    await actAsync(() => field().props.onChangeText(' otto '));
    await actAsync(async () => {
      field().props.onBlur();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ addressWord: 'otto' });
  });

  it('offers the special threads’ model from the home machine’s catalogue', async () => {
    seedSettings();
    const r = renderRN(<ManagerPage />);
    await flush();
    expect(api.models).toHaveBeenCalledWith('home');
    expect(textOf(findHost(r.root, byTestId('special-thread-model')))).toBe('Sonnet 5');
    await pick(r, 'special-thread-model', 'claude-opus-5');
    expect(api.setPreferences).toHaveBeenCalledWith({ specialThreadModel: 'claude-opus-5' });
    expect(textOf(findHost(r.root, byTestId('special-thread-model')))).toBe('Opus 5');
  });

  it('special threads’ model: no home machine, and a catalogue failure, are each said', async () => {
    resetHosts();
    reportHost('a');
    reportHost('b');
    seedSettings();
    const r = renderRN(<ManagerPage />);
    await flush();
    expect(api.models).not.toHaveBeenCalled();
    expect(findHost(r.root, byTestId('special-thread-model-no-host'))).toBeTruthy();
    r.unmount();
    reportHost('a', { isHomeHost: true });
    vi.mocked(api.models).mockRejectedValue(new Error('host offline'));
    const r2 = renderRN(<ManagerPage />);
    await flush();
    expect(textOf(findHost(r2.root, byTestId('special-thread-model-error')))).toBe(
      'Couldn’t load the model list: host offline',
    );
  });

  it('rotation switch and time write through; an invalid time is refused', async () => {
    seedSettings();
    const r = renderRN(<ManagerPage />);
    await actAsync(async () => {
      findHost(r.root, byTestId('rotation-enabled')).props.onValueChange(false);
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ rotationEnabled: false });
    await actAsync(() => findHost(r.root, byTestId('rotation-time')).props.onChangeText('03:15'));
    await actAsync(async () => {
      findHost(r.root, byTestId('rotation-time')).props.onBlur();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenCalledWith({ rotationTime: '03:15' });
    vi.mocked(api.setPreferences).mockClear();
    await actAsync(() => findHost(r.root, byTestId('rotation-time')).props.onChangeText('3pm'));
    await actAsync(() => findHost(r.root, byTestId('rotation-time')).props.onBlur());
    expect(api.setPreferences).not.toHaveBeenCalled();
    expect(__getLastAlert()?.message).toBe('Fresh session at must be a 24-hour time like 07:30.');
    expect(findHost(r.root, byTestId('rotation-time')).props.value).toBe('03:15');
  });

  it('writePreferences reports a failure by name', async () => {
    seedSettings();
    vi.mocked(api.setPreferences).mockRejectedValue(new Error('HTTP 401'));
    writePreferences({ reach: 'notify' });
    await flush();
    expect(__getLastAlert()).toEqual({
      title: 'Settings failed',
      message: 'HTTP 401',
      buttons: undefined,
    });
  });
});

describe('Voice page: Speaking (shared, spec/01 § Settings)', () => {
  it('a Kokoro voice and a chat-name interval write the shared setting', async () => {
    seedSettings({
      preferences: {
        ...settingsFixture().preferences,
        kokoroVoice: 'af_heart',
        chatNameInterval: 3,
      },
    });
    const r = renderRN(<VoicePage />);
    const speaking = findHost(r.root, byTestId('settings-voice-speaking'));
    expect(textOf(speaking)).toContain('Say the chat name every');
    expect(textOf(findHost(r.root, byTestId('kokoro-voice')))).toBe(KOKORO_VOICES[0]!.label);
    await pick(r, 'kokoro-voice', 'bm_george');
    expect(api.setPreferences).toHaveBeenLastCalledWith({ kokoroVoice: 'bm_george' });
    const interval = (): ReturnType<typeof findHost> =>
      findHost(r.root, byTestId('chat-name-interval'));
    for (const bad of ['-2', '1.5', 'x', ' ']) {
      __clearLastAlert();
      await actAsync(() => interval().props.onChangeText(bad));
      await actAsync(() => interval().props.onBlur());
      expect(__getLastAlert()?.title).toBe('Invalid value');
    }
    await actAsync(() => interval().props.onChangeText('5'));
    await actAsync(async () => {
      interval().props.onSubmitEditing();
      await flush();
    });
    expect(api.setPreferences).toHaveBeenLastCalledWith({ chatNameInterval: 5 });
    expect(send).not.toHaveBeenCalled();
  });

  it('says each host uses its own default until a voice is chosen', () => {
    seedSettings();
    const r = renderRN(<VoicePage />);
    expect(textOf(findHost(r.root, byTestId('voice-settings')))).toContain(
      'Each host’s Kokoro default',
    );
  });

  it('draws the controls with no host at all — they are the server’s', () => {
    resetHosts();
    seedSettings();
    const r = renderRN(<VoicePage />);
    expect(findHost(r.root, byTestId('kokoro-voice'))).toBeTruthy();
    expect(findHost(r.root, byTestId('chat-name-interval'))).toBeTruthy();
  });
});

describe('Voice page: frame', () => {
  it('draws Engine, Speaking and Voice devices, with surfaces in the design’s order', () => {
    seedSettings();
    const r = renderRN(<VoicePage />);
    expect(textOf(findHost(r.root, byTestId('settings-page-title')))).toBe('Voice');
    const order = findAllHost(r.root, (i) =>
      /^voice-(dictation|handsFree|call|device)$/.test(String(i.props.testID)),
    ).map((i) => i.props.testID);
    expect(order).toEqual(['voice-dictation', 'voice-handsFree', 'voice-call', 'voice-device']);
    expect(textOf(findHost(r.root, byTestId('settings-voice-config')))).toMatch(
      /Dictation.*Hands-free.*Call.*Voice device/,
    );
    expect(findHost(r.root, byTestId('settings-voice-speaking'))).toBeTruthy();
    expect(findHost(r.root, byTestId('settings-voice-devices'))).toBeTruthy();
    expect(findHost(r.root, byTestId('voice-devices-empty'))).toBeTruthy();
  });

  it('Voice devices with no reported host says to add one', () => {
    resetHosts();
    seedSettings();
    const r = renderRN(<VoicePage />);
    expect(textOf(findHost(r.root, byTestId('voice-devices-no-machines')))).toBe(
      'Add a host first',
    );
  });

  it('the engine waits for settings to load', () => {
    const r = renderRN(<VoicePage />);
    expect(findHost(r.root, byTestId('voice-config-loading'))).toBeTruthy();
    expect(queryHost(r.root, byTestId('voice-dictation-backend-local'))).toBeNull();
  });
});
