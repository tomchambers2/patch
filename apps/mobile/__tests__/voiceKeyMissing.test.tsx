// A voice surface configured onto a hosted backend whose key the chat's host
// does not hold (spec/07 § Voice — a config matrix). The host refuses such a
// session itself; the phone, which already knows from `daemon.host.voiceKeys`,
// refuses a voice note or a dictation at the PRESS — before the user has said
// anything — with the host's exact sentence. Nothing records, nothing
// uploads, and nothing quietly runs on local instead.

import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { voiceKeyMissingMessage, DEFAULT_VOICE_CONFIG, type VoiceConfig } from '@patch/wire/audio';
import { findHost, byLabel, renderRN, actAsync } from './testUtils/render';
import { useChatStore } from '../src/stores/chatStore';
import { useUiStore } from '../src/stores/uiStore';
import { useVoiceStore } from '../src/stores/voiceStore';
import { useSettingsStore } from '../src/stores/settingsStore';
import { usePresenceStore } from '../src/stores/presenceStore';
import { __clearAllMmkv } from './stubs/mmkv';
import { reportHost, resetHosts } from './testUtils/settingsFixtures';
import type { SettingsResponse } from '../src/api/rest';
import type * as dictationModule from '../src/lib/dictation';

const { voiceNoteSpy } = vi.hoisted(() => ({ voiceNoteSpy: vi.fn() }));
vi.mock('../src/api/rest', () => ({
  api: {
    voiceNote: voiceNoteSpy,
    skills: vi.fn().mockResolvedValue({ skills: [] }),
    uploadAttachment: vi.fn(),
  },
}));

import { voiceKeyRefusal } from '../src/lib/voiceKeys';
import { startVoiceNote } from '../src/lib/voiceNote';
import { Composer } from '../src/components/Composer';
import { useComposerDraftStore } from '../src/lib/composerDraft';

// Tom's live config, 2026-09-24.
const TOMS_CONFIG: VoiceConfig = {
  dictation: { backend: 'gemini' },
  device: { backend: 'openai', layer: 'light', handoff: 'auto' },
  handsFree: { backend: 'local', layer: 'direct', handoff: 'auto' },
  call: { backend: 'local', layer: 'direct', handoff: 'auto' },
};
const REFUSAL =
  'Dictation is set to gemini, but GEMINI_API_KEY is not set on this host. ' +
  'Switch Dictation to another backend in Settings → Voice.';

function seedConfig(voiceConfig: VoiceConfig): void {
  useSettingsStore.setState({
    data: { preferences: { addressWord: 'patch', voiceConfig } } as unknown as SettingsResponse,
    error: null,
  });
}

function pinChat(chatId: string, daemonId: string): void {
  useChatStore.setState((s) => ({
    chats: { ...s.chats, [chatId]: { ...(s.chats[chatId] ?? {}), daemonId } as never },
  }));
}

beforeEach(() => {
  __clearAllMmkv();
  useComposerDraftStore.getState()._reset();
  useChatStore.getState()._reset();
  useUiStore.setState({ errors: [] });
  useVoiceStore.setState({ voiceNoteChatId: null, voiceNoteState: 'idle' });
  resetHosts();
  usePresenceStore.setState({ daemon: 'online' });
  reportHost('hetzner', { hostName: 'hetzner', voiceKeys: { gemini: false, openai: false } });
  reportHost('mac', { hostName: 'mac', voiceKeys: { gemini: true, openai: true } });
  seedConfig(TOMS_CONFIG);
  pinChat('c1', 'hetzner');
  voiceNoteSpy.mockReset();
});

describe('voiceKeyRefusal', () => {
  it('names the key when the chat’s host lacks it', () => {
    expect(voiceKeyRefusal('c1', 'dictation')).toBe(REFUSAL);
    expect(REFUSAL).toBe(voiceKeyMissingMessage('dictation', 'gemini'));
  });
  it('says nothing for a local surface, a host that has the key, or what it cannot know', () => {
    expect(voiceKeyRefusal('c1', 'call')).toBeNull();
    pinChat('c2', 'mac');
    expect(voiceKeyRefusal('c2', 'dictation')).toBeNull();
    // Unpinned chat, unreported host, config not loaded: the host decides.
    expect(voiceKeyRefusal('unknown', 'dictation')).toBeNull();
    pinChat('c3', 'old');
    reportHost('old', { hostName: 'old' });
    expect(voiceKeyRefusal('c3', 'dictation')).toBeNull();
    useSettingsStore.setState({ data: null, error: null });
    expect(voiceKeyRefusal('c1', 'dictation')).toBeNull();
    seedConfig(DEFAULT_VOICE_CONFIG);
    expect(voiceKeyRefusal('c1', 'dictation')).toBeNull();
  });
});

describe('a voice note on a dictation backend with no key', () => {
  it('is refused at the press with the exact sentence — no recording, no upload', () => {
    startVoiceNote('c1', 'hold');
    expect(useVoiceStore.getState().voiceNoteState).toBe('idle');
    expect(useVoiceStore.getState().voiceNoteChatId).toBeNull();
    expect(useUiStore.getState().errors.map((e) => e.message)).toEqual([`voice note: ${REFUSAL}`]);
    expect(voiceNoteSpy).not.toHaveBeenCalled();
  });
});

describe('composer dictation on a backend with no key', () => {
  it('is refused at the press with the exact sentence — the mic never opens', async () => {
    const factory = vi.fn() as unknown as typeof dictationModule.startDictation;
    const r = renderRN(<Composer chatId="c1" folder="work" dictationFactory={factory} />);
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    expect(factory).not.toHaveBeenCalled();
    expect(useUiStore.getState().errors.map((e) => e.message)).toEqual([`voice: ${REFUSAL}`]);
  });

  it('runs as normal on a host that holds the key', async () => {
    pinChat('c2', 'mac');
    const factory = vi.fn(() => ({
      finish: vi.fn(),
    })) as unknown as typeof dictationModule.startDictation;
    const r = renderRN(<Composer chatId="c2" folder="work" dictationFactory={factory} />);
    await actAsync(() => {
      findHost(r.root, byLabel('Dictate into message')).props['onPress']();
    });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().errors).toEqual([]);
  });
});
