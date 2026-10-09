// spec/07 § Modes — the surface half. One session, two policies: the
// toggle must reach the open session rather than reopening it, and an utterance
// the host heard but did not send must not be echoed into the chat.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  startVoiceCall,
  setCallMode,
  endVoiceCall,
  __setAudioOpenerForTests,
} from '../lib/voiceController.js';
import { useVoiceStore } from '../stores/voiceStore.js';
import { useChatStore } from '../stores/chatStore.js';
import { usePreferencesStore, DEFAULT_PREFERENCES } from '../stores/preferencesStore.js';
import type {
  AudioSession,
  AudioSessionCallbacks,
  OpenAudioSessionOpts,
} from '../lib/audioSession.js';

let lastCallbacks: AudioSessionCallbacks | undefined;
let lastOpts: OpenAudioSessionOpts | undefined;
const modeSpy = vi.fn();

function stubOpener(opts: OpenAudioSessionOpts): Promise<AudioSession> {
  lastCallbacks = opts.callbacks;
  lastOpts = opts;
  return Promise.resolve({
    sessionId: 'sess-1',
    chatId: opts.chatId,
    setMuted: () => {},
    setSessionMode: (t) => modeSpy(t),
    speak: () => {},
    sendPcm: () => {},
    isMuted: () => false,
    end: () => {},
  });
}

describe('call modes', () => {
  beforeEach(() => {
    __setAudioOpenerForTests(stubOpener);
    modeSpy.mockClear();
    lastCallbacks = undefined;
    lastOpts = undefined;
    useVoiceStore.setState({ call: null, note: null, session: null });
    useChatStore.setState({ chats: {}, timelines: {} });
    usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES, loaded: true });
  });
  afterEach(() => {
    endVoiceCall();
    __setAudioOpenerForTests(null);
  });

  it('opens live by default, and carries the mode and address word into the session', async () => {
    await startVoiceCall('c1');
    expect(useVoiceStore.getState().call?.mode).toBe('call');
    expect(lastOpts?.mode).toBe('call');

    endVoiceCall();
    usePreferencesStore.setState({
      preferences: { ...DEFAULT_PREFERENCES, addressWord: 'jarvis' },
      loaded: true,
    });
    await startVoiceCall('c1', 'hands-free');
    expect(useVoiceStore.getState().call?.mode).toBe('hands-free');
    expect(lastOpts?.mode).toBe('hands-free');
    expect(lastOpts?.addressWord).toBe('jarvis');
  });

  it('carries no address word until the preferences have actually loaded', async () => {
    usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES, loaded: false });
    await startVoiceCall('c1', 'hands-free');
    expect(lastOpts?.addressWord).toBeUndefined();
  });

  it('flipping mode reaches the open session without reopening it', async () => {
    await startVoiceCall('c1', 'hands-free');
    const openedAt = useVoiceStore.getState().call?.startedAt;
    setCallMode('call');
    expect(modeSpy).toHaveBeenCalledWith('call');
    expect(useVoiceStore.getState().call?.mode).toBe('call');
    // Same session: nothing was torn down, so the call is the same call.
    expect(useVoiceStore.getState().call?.startedAt).toBe(openedAt);
    // Flipping to what it already is does nothing at all.
    setCallMode('call');
    expect(modeSpy).toHaveBeenCalledTimes(1);
  });

  it('an unaddressed utterance is shown as heard, and never echoed into the chat', async () => {
    await startVoiceCall('c1', 'hands-free');
    lastCallbacks?.onTranscriptFinal('so then I said render the whole wall', false);
    expect(useVoiceStore.getState().call?.unaddressed).toBe('so then I said render the whole wall');
    expect(useVoiceStore.getState().call?.lastLine).toBe('');
    expect(useChatStore.getState().timelines['c1'] ?? []).toHaveLength(0);
  });

  it('an addressed utterance clears the heard line and lands in the chat', async () => {
    await startVoiceCall('c1', 'hands-free');
    lastCallbacks?.onTranscriptFinal('not for you', false);
    lastCallbacks?.onTranscriptFinal('patch what is agent two doing', true);
    expect(useVoiceStore.getState().call?.unaddressed).toBeNull();
    const timeline = useChatStore.getState().timelines['c1'] ?? [];
    expect(
      timeline.some((e) => 'content' in e && e.content === 'patch what is agent two doing'),
    ).toBe(true);
  });

  it('clears the call state when the audio socket closes', async () => {
    await startVoiceCall('c1');
    expect(useVoiceStore.getState().call).not.toBeNull();
    // The host dropped the session / the network went. Nobody pressed hang up.
    lastCallbacks?.onClose();
    // Left set, the overlay sits there looking live over a dead socket — and a
    // live call defers the post-deploy reload, so the surface silently stops
    // taking updates until someone restarts it (lib/liveUpdate.ts).
    expect(useVoiceStore.getState().call).toBeNull();
    expect(useVoiceStore.getState().session).toBeNull();
  });

  it('a close after the user already hung up is a no-op, not a second teardown', async () => {
    await startVoiceCall('c1');
    const cb = lastCallbacks!;
    endVoiceCall();
    expect(useVoiceStore.getState().call).toBeNull();
    expect(() => cb.onClose()).not.toThrow();
    expect(useVoiceStore.getState().call).toBeNull();
  });
});
