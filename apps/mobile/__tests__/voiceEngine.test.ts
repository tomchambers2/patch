// lib/voiceEngine.ts + the voice-config half of lib/preferences.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DEFAULT_VOICE_CONFIG, type VoiceConfig } from '@patch/wire/audio';

const { settingsMock } = vi.hoisted(() => ({ settingsMock: vi.fn() }));
vi.mock('../src/api/rest', () => ({ api: { settings: settingsMock } }));

import {
  callEngineLabel,
  describeVoiceError,
  modeSwitchNeedsNewSession,
} from '../src/lib/voiceEngine';
import {
  __resetPreferences,
  loadPreferences,
  voiceConfigOrNull,
  addressWordOrNull,
} from '../src/lib/preferences';
import { useSettingsStore } from '../src/stores/settingsStore';
import type { SettingsResponse } from '../src/api/rest';

const cfg = (over: Partial<VoiceConfig>): VoiceConfig => ({ ...DEFAULT_VOICE_CONFIG, ...over });

describe('callEngineLabel', () => {
  it('names hosted engines with their layer, per mode', () => {
    const c = cfg({
      call: { backend: 'gemini', layer: 'heavy', handoff: 'auto' },
      handsFree: { backend: 'openai', layer: 'light', handoff: 'auto' },
    });
    expect(callEngineLabel(c, 'call')).toBe('Gemini Live · heavy');
    expect(callEngineLabel(c, 'hands-free')).toBe('OpenAI Realtime · light');
  });
  it('a hosted "direct" runs as light, and says so', () => {
    expect(
      callEngineLabel(
        cfg({ call: { backend: 'openai', layer: 'direct', handoff: 'auto' } }),
        'call',
      ),
    ).toBe('OpenAI Realtime · light');
  });
  it('local, or no config yet, names nothing', () => {
    expect(callEngineLabel(DEFAULT_VOICE_CONFIG, 'call')).toBeNull();
    expect(callEngineLabel(null, 'hands-free')).toBeNull();
  });
});

describe('modeSwitchNeedsNewSession', () => {
  const mixed = cfg({ call: { backend: 'gemini', layer: 'light', handoff: 'auto' } });
  it('only when the two modes are on different engines', () => {
    expect(modeSwitchNeedsNewSession(mixed, 'call', 'hands-free')).toBe(true);
    expect(modeSwitchNeedsNewSession(DEFAULT_VOICE_CONFIG, 'call', 'hands-free')).toBe(false);
    expect(modeSwitchNeedsNewSession(mixed, 'call', 'call')).toBe(false);
    expect(modeSwitchNeedsNewSession(null, 'call', 'hands-free')).toBe(false);
  });
});

describe('describeVoiceError', () => {
  it('names the engine that failed', () => {
    expect(describeVoiceError('gemini_unavailable', 'quota')).toBe('Gemini Live failed — quota');
    expect(describeVoiceError('openai_unavailable', 'quota')).toBe(
      'OpenAI Realtime failed — quota',
    );
    expect(describeVoiceError('voice_config_not_implemented', 'device')).toBe(
      'Not available with this voice setting — device',
    );
    expect(describeVoiceError('kokoro_unavailable', 'down')).toBe('kokoro_unavailable: down');
  });

  it('a silent microphone is already the whole sentence, fix included', () => {
    expect(describeVoiceError('mic_silent', 'Your microphone is sending silence.')).toBe(
      'Your microphone is sending silence.',
    );
  });
});

describe('describeVoiceError — a missing provider key', () => {
  it('is the host sentence as is: the key, this host, and the Settings → Voice fix', () => {
    const message =
      'Call is set to openai, but OPENAI_REALTIME_API_KEY is not set on this host. ' +
      'Switch Call to another backend in Settings → Voice.';
    expect(describeVoiceError('voice_key_missing', message)).toBe(message);
  });
});

describe('voiceConfigOrNull', () => {
  beforeEach(() => {
    __resetPreferences();
    useSettingsStore.setState({ data: null, error: null });
  });
  it('null until loaded; the boot read; then a Settings load wins', async () => {
    expect(voiceConfigOrNull()).toBeNull();
    const boot = cfg({ call: { backend: 'openai', layer: 'heavy', handoff: 'auto' } });
    settingsMock.mockResolvedValueOnce({
      preferences: { addressWord: 'patch', voiceConfig: boot },
    });
    await loadPreferences();
    expect(voiceConfigOrNull()).toEqual(boot);
    expect(addressWordOrNull()).toBe('patch');
    const later = cfg({ dictation: { backend: 'gemini' } });
    useSettingsStore.setState({
      data: {
        preferences: { addressWord: 'hey', voiceConfig: later },
      } as unknown as SettingsResponse,
    });
    expect(voiceConfigOrNull()).toEqual(later);
  });
  it('a response with no preferences is an error, not a default', async () => {
    settingsMock.mockResolvedValueOnce({});
    await expect(loadPreferences()).rejects.toThrow(/no account preferences/);
    expect(voiceConfigOrNull()).toBeNull();
  });
});
